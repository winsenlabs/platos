// What one step consumed, and what a whole turn consumed.
//
// THE COLUMNS ARE THE VOCABULARY. `Step` carries `inputTokens`,
// `outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens` and
// `reasoningTokens`, and this file is those five with the rules the column types
// cannot state: non-negative, integral, and — the one that matters —
// `inputTokens` is the WHOLE input, of which the two cache figures are parts.
//
// CACHE READ AND CACHE WRITE STAY SEPARATE ALL THE WAY THROUGH. Four distinct
// rates are charged (`providers`' `RATE_NAMES` is `input`, `output`,
// `cacheRead`, `cacheWrite`), and a cached step and an uncached step that
// flattened to one input figure would be indistinguishable on the bill. So they
// are never summed here, and the fresh-input figure a rate is applied to is
// derived rather than stored: `fresh = input - cacheRead - cacheWrite`, floored
// at zero because a provider that reports a cache figure larger than its own
// input total has reported something this system cannot charge for twice.
//
// A TURN'S USAGE IS DERIVED FROM ITS STEPS AND IS NEVER PASSED IN. That is the
// single most consequential line in this file, and it is a bug fix rather than a
// preference. The extraction source reports a turn's usage from the framework's
// own running total AND stores per-step figures it accumulates separately, and
// the two disagree — 14,788 against 39,795 on the same turn — because one counts
// the sub-agent steps and the other does not. There is no way to tell which is
// right from the outside, so this context refuses to have two numbers: the
// per-step rows are the record, and the turn total is `sumStepUsage` over them.
// A caller cannot supply a total, because there is no parameter to supply it to.
//
// `reasoningTokens` IS TRACKED AND NOT CHARGED. Providers that bill reasoning do
// so inside `outputTokens`; the separate column exists so an operator can see
// how much of an answer was thinking. Adding it to the priced total would double
// charge, and `step-cost.ts` says so where the arithmetic is.

import { err, ok, type Result } from "@platos/kernel";

import { stepUsageInvalid } from "./errors.js";

export interface StepUsage {
  /** The whole input, cache reads and cache writes included. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens written INTO the cache on this step. Charged at the write rate. */
  readonly cacheCreationInputTokens: number;
  /** Tokens served FROM the cache on this step. Charged at the read rate. */
  readonly cacheReadInputTokens: number;
  /** Reported for visibility. Never added to the priced total; see above. */
  readonly reasoningTokens: number;
}

export interface StepUsageDraft {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * The four figures a rate is applied to.
 *
 * `freshInput` is the derived one and the reason this type exists: charging the
 * raw `inputTokens` at the input rate bills cached tokens twice, once at the
 * cache rate and once at full price.
 */
export interface BillableStepTokens {
  readonly freshInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
}

export const NO_STEP_USAGE: StepUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningTokens: 0,
});

const FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "reasoningTokens",
] as const;

/** Admit a usage report, or refuse it by the field that is wrong. */
export function stepUsage(draft: StepUsageDraft): Result<StepUsage> {
  const admitted: Record<string, number> = {};
  for (const field of FIELDS) {
    const value = draft[field] ?? 0;
    if (!Number.isInteger(value) || value < 0) return err(stepUsageInvalid(field, value));
    admitted[field] = value;
  }
  return ok(
    Object.freeze({
      inputTokens: admitted.inputTokens ?? 0,
      outputTokens: admitted.outputTokens ?? 0,
      cacheCreationInputTokens: admitted.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: admitted.cacheReadInputTokens ?? 0,
      reasoningTokens: admitted.reasoningTokens ?? 0,
    }),
  );
}

/**
 * Split a usage report into the four figures the four rates charge.
 *
 * The floor at zero is deliberate and is not defensive noise: a provider whose
 * cache figures exceed its own input total has reported an inconsistency, and
 * the two honest responses are to refuse the step or to charge nothing extra.
 * Charging nothing extra keeps the turn running, which is the behaviour the
 * running system needs, and the raw columns still hold what was reported so the
 * inconsistency is visible in the row rather than smoothed away.
 */
export function billableStepTokens(usage: StepUsage): BillableStepTokens {
  const cached = usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  return {
    freshInputTokens: Math.max(0, usage.inputTokens - cached),
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheCreationInputTokens,
  };
}

/** Every token the step touched, cache figures included exactly once. */
export function totalStepTokens(usage: StepUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * A turn's usage: the sum of its steps and nothing else.
 *
 * There is deliberately no variant of this that takes a pre-computed total. See
 * the header: two numbers for one turn is the defect this shape exists to make
 * unrepresentable.
 */
export function sumStepUsage(usages: readonly StepUsage[]): StepUsage {
  return usages.reduce<StepUsage>(
    (total, usage) =>
      Object.freeze({
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
        cacheCreationInputTokens: total.cacheCreationInputTokens + usage.cacheCreationInputTokens,
        cacheReadInputTokens: total.cacheReadInputTokens + usage.cacheReadInputTokens,
        reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
      }),
    NO_STEP_USAGE,
  );
}
