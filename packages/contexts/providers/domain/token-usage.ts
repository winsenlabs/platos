// What a step consumed, and the one arithmetic rule that governs it.
//
// The four counts are NOT independent. `cacheReadTokens` and `cacheWriteTokens`
// are both SUBSETS of `inputTokens` — the provider reports the prompt's total
// size and then says how much of it was served from, or written to, a cache. So
// the tokens billed at the full input rate are what is left after both are
// removed, and a payload whose cache counts exceed its input count is not a
// cheap turn, it is a corrupt reading.
//
// The source enforces exactly this and it is preserved: reject rather than clamp.
// Clamping a negative remainder to zero would turn a provider's malformed usage
// report into a plausible-looking bill.

import { err, ok, type Result } from "@platos/kernel";

import { tokenUsageInvalid } from "./errors.js";

/** What a provider reported. Absent fields are zero, never unknown. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

export interface TokenUsageDraft {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

/** The four counts a card charges for, after the cache subsets are removed. */
export interface BillableTokens {
  /** Input tokens neither read from nor written to a cache. */
  readonly freshInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

function count(value: number | undefined, field: string): Result<number> {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    return err(tokenUsageInvalid(`${field} must be a non-negative safe integer`, { [field]: resolved }));
  }
  return ok(resolved);
}

export function tokenUsage(draft: TokenUsageDraft): Result<TokenUsage> {
  const input = count(draft.inputTokens, "inputTokens");
  if (!input.ok) return err(input.error);
  const output = count(draft.outputTokens, "outputTokens");
  if (!output.ok) return err(output.error);
  const cacheRead = count(draft.cacheReadInputTokens, "cacheReadInputTokens");
  if (!cacheRead.ok) return err(cacheRead.error);
  const cacheWrite = count(draft.cacheWriteInputTokens, "cacheWriteInputTokens");
  if (!cacheWrite.ok) return err(cacheWrite.error);

  if (cacheRead.value + cacheWrite.value > input.value) {
    return err(
      tokenUsageInvalid("cache token counts cannot exceed inputTokens", {
        inputTokens: input.value,
        cacheReadInputTokens: cacheRead.value,
        cacheWriteInputTokens: cacheWrite.value,
      }),
    );
  }
  return ok({
    inputTokens: input.value,
    outputTokens: output.value,
    cacheReadInputTokens: cacheRead.value,
    cacheWriteInputTokens: cacheWrite.value,
  });
}

export const NO_TOKEN_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});

export function billableTokens(usage: TokenUsage): BillableTokens {
  return {
    freshInputTokens: usage.inputTokens - usage.cacheReadInputTokens - usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}
