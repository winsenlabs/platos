/**
 * LAUNCH-2 — retry-fetch with declarative rules.
 *
 * Wraps the global `fetch` so every LLM provider call (Anthropic, OpenAI,
 * Vertex, Groq, Mistral, etc.) honors a per-agent retry policy without each
 * call site reimplementing it. Vercel AI SDK's provider clients all accept a
 * custom `fetch` via their `create*({ fetch })` constructor; we pass the
 * factory result there.
 *
 * Behavior matrix (from RetryRule.trigger):
 *
 *   "rate-limit"        → HTTP 429
 *   "temporary-error"   → HTTP 408 / 500 / 502 / 503 / 504
 *   "auth-error"        → HTTP 401 / 403
 *   "network-error"     → fetch threw (DNS, TCP reset, abort, etc.)
 *
 * Rule.action:
 *   "fail"      → throw immediately, no retries
 *   "retry"     → retry up to retryCount times with exp backoff
 *   "fallback"  → not handled here; consumed by the provider-resolver layer
 *                 (LAUNCH-4) which sees a non-retried error and walks the
 *                 fallback chain
 *
 * Streaming-safety: only retries BEFORE the first byte arrives. Once the
 * caller starts consuming `res.body`, retrying would lose state — we hand
 * back the (possibly-error) response and let the SDK handle it. We detect
 * "first byte arrived" implicitly by returning the response as soon as we
 * decide it isn't a retryable error; the caller owns the body from there.
 *
 * Retry-After: parsed from the response header on every retryable failure
 * (when `waitForRetryAfter: true`). Honors both formats:
 *   Retry-After: <seconds>
 *   Retry-After: <HTTP-date>
 * Capped at 30s to avoid pathological waits (some hosts return 86400).
 */

export type RetryTrigger =
  | "rate-limit"
  | "temporary-error"
  | "auth-error"
  | "network-error";

export type RetryAction = "fail" | "retry" | "fallback";

export interface RetryRule {
  trigger: RetryTrigger;
  action: RetryAction;
  /** Number of retry attempts before giving up. Ignored if action !== "retry". */
  retryCount?: number;
  /** Initial backoff in ms. Doubled on each retry up to 30s. */
  backoffMs?: number;
  /** Multiplier per retry. Default 2 (exponential). 1 = constant. */
  backoffMultiplier?: number;
  /** When true + the response has a Retry-After header, wait that long. */
  waitForRetryAfter?: boolean;
  /**
   * Forwarded to the fallback walker (LAUNCH-4). When `action: "fallback"`,
   * the provider-resolver looks up this label in `agent.modelRoutes[]` and
   * tries that target next. Ignored here.
   */
  fallbackToRouteLabel?: string;
}

export interface RetryConfig {
  rules: RetryRule[];
}

/** Default policy applied when an agent has no `retryConfig` set. */
export const DEFAULT_RETRY_RULES: RetryRule[] = [
  {
    trigger: "rate-limit",
    action: "retry",
    retryCount: 2,
    backoffMs: 500,
    backoffMultiplier: 2,
    waitForRetryAfter: true,
  },
  {
    trigger: "temporary-error",
    action: "retry",
    retryCount: 2,
    backoffMs: 500,
    backoffMultiplier: 2,
    waitForRetryAfter: true,
  },
  {
    trigger: "auth-error",
    action: "fail",
  },
  {
    trigger: "network-error",
    action: "retry",
    retryCount: 1,
    backoffMs: 250,
    backoffMultiplier: 2,
  },
];

const MAX_BACKOFF_MS = 30_000;
const RETRYABLE_TEMPORARY_STATUSES = new Set([408, 500, 502, 503, 504]);
const AUTH_ERROR_STATUSES = new Set([401, 403]);

/**
 * Classify an HTTP status code against our trigger taxonomy. Network errors
 * (no response at all) are classified separately by the caller via try/catch.
 */
function classifyStatus(status: number): RetryTrigger | null {
  if (status === 429) return "rate-limit";
  if (RETRYABLE_TEMPORARY_STATUSES.has(status)) return "temporary-error";
  if (AUTH_ERROR_STATUSES.has(status)) return "auth-error";
  return null;
}

/** Find the first rule matching this trigger. Returns null if no rule covers it. */
function findRule(rules: RetryRule[], trigger: RetryTrigger): RetryRule | null {
  return rules.find((r) => r.trigger === trigger) ?? null;
}

/**
 * Parse the `Retry-After` header. Honors both `<seconds>` and `<HTTP-date>`
 * formats per RFC 7231 §7.1.3. Returns ms-to-wait, or null if unparseable.
 */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  }
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    const delta = date.getTime() - Date.now();
    return delta > 0 ? Math.min(delta, MAX_BACKOFF_MS) : 0;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffFor(rule: RetryRule, attemptNumber: number): number {
  const base = rule.backoffMs ?? 500;
  const mult = rule.backoffMultiplier ?? 2;
  return Math.min(base * Math.pow(mult, attemptNumber - 1), MAX_BACKOFF_MS);
}

/**
 * Build a retry-aware `fetch` from a rule list. The result is a drop-in
 * replacement for global fetch — same input/output types — so it slots into
 * any AI-SDK provider's `create*({ fetch })` option.
 *
 * The factory captures `rules` once; each call gets independent attempt
 * counters. Safe for concurrent invocations across providers.
 */
export function makeRetryFetch(
  rules: RetryRule[] = DEFAULT_RETRY_RULES,
  baseFetch: typeof fetch = fetch,
): typeof fetch {
  return async function retryFetch(input: any, init?: any): Promise<Response> {
    let lastResponse: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      let networkError: unknown = null;
      try {
        res = await baseFetch(input as any, init as any);
      } catch (err) {
        networkError = err;
      }

      if (res && res.ok) return res;

      let trigger: RetryTrigger | null;
      if (networkError) {
        trigger = "network-error";
      } else if (res) {
        trigger = classifyStatus(res.status);
      } else {
        // Should never happen — defensive.
        throw new Error("retryFetch: no response and no error");
      }

      if (!trigger) {
        // 4xx that isn't auth + isn't 408 → not retryable. Hand back the
        // response unchanged so the SDK surfaces the error.
        if (res) return res;
        throw networkError ?? new Error("retryFetch: unclassified failure");
      }

      const rule = findRule(rules, trigger);
      // No rule for this trigger — preserve current behavior: surface the
      // error/response immediately.
      if (!rule || rule.action === "fail") {
        if (res) return res;
        throw networkError ?? new Error(`retryFetch: rule=fail trigger=${trigger}`);
      }

      // action === "fallback" — provider-resolver (LAUNCH-4) handles this by
      // observing the failed response. Hand it back so it can walk the chain.
      if (rule.action === "fallback") {
        if (res) return res;
        throw networkError ?? new Error(`retryFetch: rule=fallback trigger=${trigger}`);
      }

      // action === "retry"
      const maxAttempts = (rule.retryCount ?? 2) + 1; // initial + retries
      if (attempt >= maxAttempts) {
        if (res) return res;
        throw networkError ?? new Error(`retryFetch: exhausted retries trigger=${trigger}`);
      }

      let waitMs = backoffFor(rule, attempt);
      if (rule.waitForRetryAfter && res) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== null) waitMs = retryAfter;
      }

      // Drain the failed response body so the connection can return to the
      // pool — otherwise we leak sockets under sustained 5xx storms.
      if (res) {
        try { await res.arrayBuffer(); } catch { /* ignore */ }
      }

      lastResponse = res;
      lastError = networkError;
      void lastResponse;
      void lastError;

      await sleep(waitMs);
    }
  } as typeof fetch;
}
