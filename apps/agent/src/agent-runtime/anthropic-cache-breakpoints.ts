/**
 * Anthropic prompt-caching breakpoints for the MESSAGE ARRAY.
 *
 * WHY THIS EXISTS (real production evidence, 2026-07-30)
 * -----------------------------------------------------
 * Thread `cms72itce002llf01bz98ycta`, trace `0adb2b4070f540634d5f610f3f1bbca0`,
 * agent "Winsen Walle", model `anthropic:claude-sonnet-5`: ONE user turn ran
 * ~12 sequential LLM steps (17 tool calls, 128s wall clock) and billed
 * `inputTokens: 1,684,498` against only `cacheReadTokens: 198,224` and
 * `cacheWriteTokens: 12,389`. That is ~1.47M tokens paid at FULL price which
 * should have been 0.1x cache reads: 300.85 cents for a single turn.
 *
 * Root cause: only the SYSTEM prompt carried a `cache_control` breakpoint. The
 * message array — which is ~95% of the context by step 12 — was never cached,
 * so every internal step re-paid for the entire history.
 *
 * HOW ANTHROPIC CACHING ACTUALLY WORKS (the three facts that drive this code)
 * --------------------------------------------------------------------------
 * 1. PREFIX MATCH. The cache key is the exact bytes of `tools -> system ->
 *    messages` up to a breakpoint. A cache entry at position P therefore covers
 *    the WHOLE prefix [0..P] — you do not need a breakpoint per message, you
 *    need one near the end.
 * 2. 20-BLOCK LOOKBACK. A breakpoint searches at most ~20 content blocks
 *    backwards for an existing entry. So step N+1's trailing breakpoint finds
 *    step N's entry only if fewer than ~20 blocks were added in between. A
 *    normal step adds ~2 blocks (tool_use + tool_result), but a step with many
 *    PARALLEL tool calls can add far more — which is exactly when a lone
 *    trailing breakpoint silently misses and the turn quietly reverts to full
 *    price. Hence the intermediate breakpoints at a stride below the lookback.
 * 3. BUDGET OF 4. At most 4 `cache_control` breakpoints per request. The system
 *    message keeps one (it is the most valuable single breakpoint and is stable
 *    across turns), leaving three for the message array.
 *
 * Pure + dependency-free so it unit tests without Nest, the SDK, or a network.
 * Anthropic-only by design: other providers either cache automatically or not
 * at all, and inventing breakpoints for them does nothing (see
 * docs/research/llm-serving-and-caching.md).
 */

/** Anthropic's hard per-request limit on `cache_control` breakpoints. */
export const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/** System message keeps one breakpoint; the message array gets the rest. */
export const MESSAGE_BREAKPOINT_BUDGET = ANTHROPIC_MAX_CACHE_BREAKPOINTS - 1;

/**
 * Content blocks between consecutive breakpoints. Must stay meaningfully BELOW
 * the ~20-block lookback so a new trailing breakpoint can still see the
 * previous step's entry even when a step adds several parallel tool calls.
 */
export const BREAKPOINT_BLOCK_STRIDE = 15;

/** Structural shape of an AI SDK ModelMessage — avoids importing the SDK. */
export interface CacheableMessage {
  role: string;
  content: unknown;
  providerOptions?: Record<string, unknown>;
}

/**
 * How many Anthropic content blocks a message contributes. String content is a
 * single text block; array content is one block per part. Never returns 0 — a
 * message always occupies at least one block, and undercounting would let a
 * gap exceed the lookback.
 */
export function countContentBlocks(message: CacheableMessage): number {
  const content = message?.content;
  if (Array.isArray(content)) return Math.max(1, content.length);
  return 1;
}

/**
 * Pick the message indices that should carry a breakpoint.
 *
 * Walks BACKWARDS from the newest message because the newest position is the
 * one that must be cached for the next step to read. The first pick is always
 * the last non-system message (the moving head); further picks are spaced by
 * `BREAKPOINT_BLOCK_STRIDE` content blocks as lookback insurance, until the
 * budget is spent.
 *
 * System messages are skipped: they carry their own breakpoint, applied where
 * the message array is first assembled.
 */
export function selectBreakpointIndices(
  messages: readonly CacheableMessage[],
  options?: { budget?: number; stride?: number },
): number[] {
  const budget = Math.max(0, options?.budget ?? MESSAGE_BREAKPOINT_BUDGET);
  const stride = Math.max(1, options?.stride ?? BREAKPOINT_BLOCK_STRIDE);
  if (budget === 0 || !Array.isArray(messages) || messages.length === 0) return [];

  const chosen: number[] = [];
  let blocksSinceLast = 0;

  for (let i = messages.length - 1; i >= 0 && chosen.length < budget; i--) {
    const m = messages[i];
    if (!m || m.role === "system") continue; // system owns its own breakpoint
    if (chosen.length === 0) {
      chosen.push(i); // the moving head — always cached
      blocksSinceLast = 0;
      continue;
    }
    blocksSinceLast += countContentBlocks(m);
    if (blocksSinceLast >= stride) {
      chosen.push(i);
      blocksSinceLast = 0;
    }
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Return a copy of `messages` with Anthropic `cache_control` breakpoints
 * applied. Non-destructive: existing `providerOptions` (e.g. attachment
 * settings) and any existing `anthropic` options are preserved, only
 * `cacheControl` is added. Messages that are not chosen are returned as-is, so
 * this is safe to call on every step.
 */
export function withAnthropicCacheBreakpoints<T extends CacheableMessage>(
  messages: readonly T[],
  options?: { budget?: number; stride?: number },
): T[] {
  const targets = new Set(selectBreakpointIndices(messages, options));
  if (targets.size === 0) return messages as T[];
  return messages.map((m, i) => {
    if (!targets.has(i)) return m;
    const existing = (m.providerOptions ?? {}) as Record<string, unknown>;
    const existingAnthropic = (existing.anthropic ?? {}) as Record<string, unknown>;
    return {
      ...m,
      providerOptions: {
        ...existing,
        anthropic: { ...existingAnthropic, cacheControl: { type: "ephemeral" as const } },
      },
    };
  });
}

/** True when the resolved model string routes to Anthropic's wire format. */
export function isAnthropicCacheablePath(modelString: string | undefined): boolean {
  if (!modelString) return false;
  const m = modelString.toLowerCase();
  // Anthropic direct, plus Claude served through Vertex (identical wire format
  // for cache_control — see docs/research/llm-serving-and-caching.md).
  return m.startsWith("anthropic:") || m.includes("claude");
}
