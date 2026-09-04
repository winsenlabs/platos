// What a step cost, read out of a provider's answer.
//
// THIS IS THE MOST DANGEROUS FILE IN THE PACKAGE, and the danger is silent.
// Every provider reports cache tokens somewhere different, and a reader that
// looks in the wrong place does not fail — it reads zero. A zero cache read is a
// perfectly well-formed usage record, so the generation succeeds, the trace
// looks fine, and the bill charges the whole prompt at the full input rate
// while the operator believes caching is on. The extraction source's evidence
// for what that costs is one turn: 1,684,498 input tokens against 198,224 cache
// reads, 300.85 cents, on twelve steps of one user message.
//
// So the chains below are TRANSCRIBED, not re-derived, and the suite beside this
// file pins EXACT numbers per provider rather than shapes. A test that would
// still pass with every count at zero is exactly the test that would have missed
// the failure this file exists to prevent.
//
// WHERE EACH LINK COMES FROM. The source carries the chain at four call sites
// and two of them are longer than the other two. The streaming step reader has
// six links for cache read and four for cache write; the three non-streaming
// readers have five and three. The longer form is the one implemented here,
// because it is a strict superset: the extra links are the provider's RAW
// passthrough shape (`anthropic.usage.cache_read_input_tokens`), which the
// shorter form reaches only when it is absent. A response carrying the raw shape
// and not the normalised one reads ZERO under the shorter chain — the exact
// silent-zero failure above — so implementing the shorter form would have
// preserved a bug rather than a behaviour.
//
// THE `||` IS LOAD-BEARING AND IT IS NOT `??`. A provider that reports a cache
// read of zero has reported nothing useful, and the next shape along should be
// consulted; `??` would stop at the zero and report it as the answer. That is
// the source's semantics and it is kept exactly.
//
// ONE DEPARTURE FROM THE SOURCE, DELIBERATE. The source's chains end in a bare
// `Number(...)`, so a provider that puts a string or a NaN in the last position
// yields NaN, and NaN flows into the bill. Here every link is coerced through
// `finiteCount`, which admits only a non-negative finite number and reads
// anything else as absent. That cannot lose a real count — a real count is a
// non-negative number — and it stops a malformed reading from becoming a
// plausible-looking one.

import type { TokenUsage } from "@platos/context-providers/application/ports/index.js";

/** A provider's metadata blob: vendor key to whatever that vendor put there. */
export type ProviderMetadataLike = Readonly<Record<string, unknown>> | undefined;

/** The normalised usage the framework reports, with every field optional. */
export interface FrameworkUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly inputTokenDetails?:
    | {
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
      }
    | undefined;
  readonly outputTokenDetails?: { readonly reasoningTokens?: number | undefined } | undefined;
}

/**
 * Read one number, or report that there is none.
 *
 * Zero and absent are the SAME answer to this function, because that is what the
 * chain needs: a zero means "this shape carried nothing" and the next shape must
 * be consulted. Distinguishing them would change which link wins.
 */
function finiteCount(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** Walk a dotted path through an unknown blob without throwing on any of it. */
function at(source: unknown, ...path: readonly string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The first link in the chain that carries a number, or zero. */
function firstOf(candidates: readonly unknown[]): number {
  for (const candidate of candidates) {
    const value = finiteCount(candidate);
    if (value > 0) return value;
  }
  return 0;
}

/**
 * Cache-READ tokens, in the six places a provider may report them.
 *
 * The order is the source's streaming reader, link for link:
 *   1  the framework's own normalised `usage.inputTokenDetails.cacheReadTokens`
 *   2  Anthropic RAW passthrough    `anthropic.usage.cache_read_input_tokens`
 *   3  Anthropic normalised         `anthropic.cacheReadInputTokens`
 *   4  OpenAI                       `openai.cachedPromptTokens`
 *   5  Google (direct Gemini)       `google.usageMetadata.cachedContentTokenCount`
 *   6  Vertex (Gemini via Vertex)   `vertex.usageMetadata.cachedContentTokenCount`
 *
 * Vertex has its own key rather than sharing Google's: the same model served
 * through `@ai-sdk/google-vertex` reports under `vertex`, and collapsing the two
 * would zero one of the two routes.
 */
export function cacheReadTokens(usage: FrameworkUsage | undefined, meta: ProviderMetadataLike): number {
  return firstOf([
    at(usage, "inputTokenDetails", "cacheReadTokens"),
    at(meta, "anthropic", "usage", "cache_read_input_tokens"),
    at(meta, "anthropic", "cacheReadInputTokens"),
    at(meta, "openai", "cachedPromptTokens"),
    at(meta, "google", "usageMetadata", "cachedContentTokenCount"),
    at(meta, "vertex", "usageMetadata", "cachedContentTokenCount"),
  ]);
}

/**
 * Cache-WRITE tokens, in the four places a provider may report them.
 *
 * Shorter than the read chain and that is not an omission: only Anthropic and
 * Vertex bill a cache WRITE at all. OpenAI's prefix cache and Google's implicit
 * cache have no write to charge for, so there is no key of theirs to read.
 *
 * Read and write are separate all the way through because `RATE_NAMES` in
 * `price-card.ts` charges four rates, and a surface that added them would have
 * made a cached turn indistinguishable from an uncached one on the bill.
 */
export function cacheWriteTokens(usage: FrameworkUsage | undefined, meta: ProviderMetadataLike): number {
  return firstOf([
    at(usage, "inputTokenDetails", "cacheWriteTokens"),
    at(meta, "anthropic", "usage", "cache_creation_input_tokens"),
    at(meta, "anthropic", "cacheCreationInputTokens"),
    at(meta, "vertex", "cacheCreationInputTokens"),
  ]);
}

/**
 * Reasoning tokens, in the four places a provider may report them.
 *
 * REPORTED AND NOT PRICED. They are already inside `outputTokens` and
 * `RATE_NAMES` charges four rates, not five; adding them to the bill would
 * charge for the same tokens twice. They are read so a trace can show them.
 */
export function reasoningTokens(usage: FrameworkUsage | undefined, meta: ProviderMetadataLike): number {
  return firstOf([
    at(usage, "outputTokenDetails", "reasoningTokens"),
    at(meta, "openai", "reasoningTokens"),
    at(meta, "google", "usageMetadata", "thoughtsTokenCount"),
    at(meta, "vertex", "usageMetadata", "thoughtsTokenCount"),
  ]);
}

/** Every count one step reported, before the domain's arithmetic rule is applied. */
export interface StepCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly reasoningTokens: number;
}

/**
 * Read one step's counts.
 *
 * `inputTokens` is NOT chained: every provider reports a prompt total and the
 * framework normalises it, so there is one place to look. The cache figures are
 * chained because there is not.
 *
 * THE ONE CORRECTION APPLIED HERE. `tokenUsage` refuses a reading whose cache
 * counts exceed its input count, on the grounds that such a payload is corrupt
 * rather than cheap. A provider that reports a cache read and omits the prompt
 * total would produce exactly that refusal and fail a turn that was otherwise
 * fine, so when the total is absent it is taken as the sum of what the cache
 * figures already prove was in the prompt. That is the smallest number
 * consistent with the reading, so it never inflates a bill, and it is applied
 * only when the provider reported no total at all.
 */
export function readStepCounts(usage: FrameworkUsage | undefined, meta: ProviderMetadataLike): StepCounts {
  const cacheRead = cacheReadTokens(usage, meta);
  const cacheWrite = cacheWriteTokens(usage, meta);
  const reported = finiteCount(usage?.inputTokens);
  return {
    inputTokens: Math.max(reported, cacheRead + cacheWrite),
    outputTokens: finiteCount(usage?.outputTokens),
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    reasoningTokens: reasoningTokens(usage, meta),
  };
}

/** The four counts a `TokenUsage` is built from, as a draft. */
export function usageDraft(counts: StepCounts): Omit<TokenUsage, never> {
  return {
    inputTokens: counts.inputTokens,
    outputTokens: counts.outputTokens,
    cacheReadInputTokens: counts.cacheReadInputTokens,
    cacheWriteInputTokens: counts.cacheWriteInputTokens,
  };
}
