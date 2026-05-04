/**
 * EOBD.107 — LLM provider retry wrapper.
 *
 * The Vercel AI SDK's providers retry some transient errors internally,
 * but their retry policy is per-provider (inconsistent) and doesn't
 * integrate with our backoff + jitter policy. This wrapper catches the
 * four classes of transient failures that are safe to retry:
 *
 *   - 429 rate-limit (honour `Retry-After` when present).
 *   - 503 service-unavailable.
 *   - 502 bad-gateway / 504 gateway-timeout (upstream hiccups).
 *   - ECONNRESET / ETIMEDOUT / fetch AbortError *that didn't come from
 *     our caller's signal* (i.e. pure network flake).
 *
 * Caller-initiated abort (stop button, turn timeout) is NEVER retried —
 * the wrapper checks `signal.aborted` first on every catch and rethrows
 * immediately in that case.
 *
 * NOT wrapped: authentication errors (401/403), client errors (400),
 * token-budget errors (the LLM is definitively rejecting the payload —
 * retrying is cost-negative). These rethrow unchanged.
 *
 * Cost-accounting safety: every retry is a FRESH provider call. The
 * caller records cost ONCE after this wrapper resolves, so a retry
 * chain can't double-charge. Make sure the caller only records cost
 * after this function returns — don't record inside the attempt
 * closure.
 */

export interface LlmRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
  signal?: AbortSignal;
  onRetry?: (ctx: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULT: Required<Omit<LlmRetryOptions, "signal" | "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: 0.2,
};

function isRetryableLlmError(err: unknown): { retry: boolean; retryAfterMs?: number } {
  if (!err || typeof err !== "object") return { retry: false };
  const e = err as any;

  // Caller-abort — never retry.
  if (e?.name === "AbortError") return { retry: false };

  // HTTP-status-shaped errors — ai-sdk providers surface `statusCode`.
  const status: number | undefined = e.statusCode ?? e.status ?? e.response?.status;
  if (status === 429 || status === 503 || status === 502 || status === 504) {
    const retryAfter = e.response?.headers?.get?.("retry-after");
    const retryAfterMs =
      typeof retryAfter === "string" && /^\d+$/.test(retryAfter)
        ? parseInt(retryAfter, 10) * 1000
        : undefined;
    return { retry: true, retryAfterMs };
  }

  // Node network flakes.
  const code: string | undefined = e.code ?? e.cause?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") {
    return { retry: true };
  }

  // Anthropic/OpenAI/Google wrap their provider errors — check `name`.
  const name: string | undefined = e.name;
  if (name === "APIConnectionError" || name === "APIConnectionTimeoutError") {
    return { retry: true };
  }

  return { retry: false };
}

function backoffMs(attempt: number, opts: Required<Omit<LlmRetryOptions, "signal" | "onRetry">>): number {
  const base = opts.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(base, opts.maxDelayMs);
  const rand = 1 + (Math.random() * 2 - 1) * opts.jitter;
  return Math.max(0, Math.floor(capped * rand));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Wrap an LLM provider call with retry-on-transient-errors. Default 3
 * retries with exponential backoff + jitter; honours `Retry-After`.
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  options: LlmRetryOptions = {},
): Promise<T> {
  const cfg = { ...DEFAULT, ...options };
  let lastError: unknown;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted) throw err;
      if (attempt >= cfg.maxRetries) throw err;
      const decision = isRetryableLlmError(err);
      if (!decision.retry) throw err;
      const delay = decision.retryAfterMs ?? backoffMs(attempt, cfg);
      options.onRetry?.({ attempt, delayMs: delay, error: err });
      await sleep(delay, options.signal);
    }
  }
  throw lastError;
}
