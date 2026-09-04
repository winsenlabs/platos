// From what a generation reported to the `Step` rows that record it.
//
// THIS IS THE MONEY PATH AND IT HAS EXACTLY ONE ENTRY POINT. Every step of every
// turn — the turn's own call and every delegated one — is priced here, by
// `providers`, against the card in force, and the answer is written onto the row
// together with the four rates that produced it. Nothing else in this package
// computes a cost, and `turn-cost.ts` sums what this file wrote.
//
// THE TWO VOCABULARIES AND THE ONE PLACE THEY MEET. `providers` reports
// `cacheWriteInputTokens`; the `Step` column is `cacheCreationInputTokens`. They
// are the same number and the translation happens HERE, once, in
// `toStepUsage` — which is why a rename on either side is a compile error in one
// file rather than a silently-zeroed column in several. The source performs this
// mapping in four places with three different fallback chains, and one of those
// chains uses `||` where it means `??`, so a legitimately reported ZERO falls
// through to whatever stale provider metadata says.
//
// `reasoningTokens` IS CARRIED AND NOT CHARGED. `providers`' own note says it is
// already inside `outputTokens`; adding it to the priced total would bill it
// twice. It is on the row because an operator wants to see how much of an answer
// was thinking, and `priceModelUsage` is never given it.
//
// THE PRICE IS ASKED FOR PER STEP, NOT PER TURN, and that is what makes the
// identity in `turn-cost.ts` hold. A turn priced once against summed tokens
// would round once; the steps would then not add up to it, and no reader could
// tell whether the difference was rounding or a lost step.
//
// A STEP WITH TOKENS AND NO RATE IS REFUSED. `requireExplainedRates` does it and
// `CONVERSATIONS_STEP_RATE_MISSING` is its code. That is deliberately strict:
// a rate card fixture that carried no rates at all left an entire pricing path
// unexecuted in another package this week while every case stayed green,
// because "no rate" and "no tokens" both produce a zero cost. Here the first is
// a refusal and only the second is a zero.

import type { GenerationStep } from "@platos/context-providers";
import { err, moneyFromCentsString, ok, type Result } from "@platos/kernel";

import {
  openStep,
  settleStep,
  stepUsage,
  type ModelPriceId,
  type Step,
  type StepId,
  type StepRate,
  type StepRateBook,
  type StepUsage,
  type TurnId,
} from "../domain/index.js";
import type { ConversationsDependencies } from "./dependencies.js";

/** `providers`' report, in the column names the `Step` row uses. */
export function toStepUsage(step: GenerationStep): Result<StepUsage> {
  return stepUsage({
    inputTokens: step.usage.inputTokens,
    outputTokens: step.usage.outputTokens,
    cacheReadInputTokens: step.usage.cacheReadInputTokens,
    cacheCreationInputTokens: step.usage.cacheWriteInputTokens,
    reasoningTokens: step.reasoningTokens,
  });
}

/**
 * The usage `providers` is asked to price, WITHOUT the reasoning figure.
 *
 * Its own `TokenUsageDraft` has no reasoning field, which is the surface saying
 * the same thing: reasoning is inside the output count and is not a fifth rate.
 */
function toPricingDraft(usage: StepUsage): {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
} {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheCreationInputTokens,
  };
}

interface RateEntry {
  readonly rate: string;
  readonly usdPerToken: string;
  readonly source: string;
  readonly observedAt: Date;
  readonly sourceRef: string | null;
}

/**
 * The four rates as the row stores them.
 *
 * A name `providers` did not report stays NULL rather than becoming a zero rate.
 * A zero rate is a claim that the tokens were free; a null is the truth, and
 * `requireExplainedRates` refuses the row if any of them were charged for.
 */
export function toRateBook(entries: readonly RateEntry[]): StepRateBook {
  const book: Record<string, StepRate | null> = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
  };
  for (const entry of entries) {
    if (!(entry.rate in book)) continue;
    book[entry.rate] = {
      usdPerToken: entry.usdPerToken,
      source: entry.source as StepRate["source"],
      observedAt: entry.observedAt,
      sourceRef: entry.sourceRef,
    };
  }
  return Object.freeze(book) as StepRateBook;
}

export interface StepRecordRequest {
  readonly turnId: TurnId;
  readonly model: string;
  /** One-based. Step 1 is the turn's own call; delegated calls follow. */
  readonly sequence: number;
  readonly generationStep: GenerationStep;
  readonly startedAt: Date;
  readonly completedAt: Date;
}

/**
 * Price one generation step and turn it into a settled `Step`.
 *
 * The order is fixed and each stage can refuse: admit the usage (a negative
 * token count is the provider's bug and is not stored), price it (an unknown
 * rate is `providers`' refusal and is returned unchanged), then settle — which
 * is where the rate-explains-the-charge rule runs. Three refusals, three codes,
 * and no stage can be skipped by a caller because there is no other way to make
 * a `Step` that carries a cost.
 */
export async function recordStep(
  dependencies: ConversationsDependencies,
  request: StepRecordRequest,
): Promise<Result<Step>> {
  const usage = toStepUsage(request.generationStep);
  if (!usage.ok) return err(usage.error);

  const stepId = dependencies.ids.uuid() as unknown as StepId;
  const open = openStep({
    stepId,
    turnId: request.turnId,
    sequence: request.sequence,
    model: request.model,
    startedAt: request.startedAt,
  });

  const priced = await dependencies.providers.priceModelUsage({
    model: request.model,
    usage: toPricingDraft(usage.value),
    at: request.completedAt,
  } as Parameters<ConversationsDependencies["providers"]["priceModelUsage"]>[0]);
  if (!priced.ok) return err(priced.error);

  return settleStep(open, {
    status: request.generationStep.finishReason === "error" ? "FAILED" : "SUCCEEDED",
    usage: usage.value,
    cost: moneyFromCentsString(priced.value.costCents),
    modelPriceId: priced.value.price.modelPriceId as ModelPriceId,
    rates: toRateBook(priced.value.price.rates as readonly RateEntry[]),
    error: null,
    completedAt: request.completedAt,
  });
}

/**
 * Price every step of one generation, in order.
 *
 * FAILS ON THE FIRST REFUSAL rather than pricing what it can and reporting a
 * partial total. A turn whose third step could not be priced has a cost nobody
 * can stand behind, and answering the sum of the other two would be a smaller
 * number presented as a complete one.
 */
export async function recordSteps(
  dependencies: ConversationsDependencies,
  turnId: TurnId,
  model: string,
  steps: readonly GenerationStep[],
  firstSequence: number,
  startedAt: Date,
  completedAt: Date,
): Promise<Result<readonly Step[]>> {
  const recorded: Step[] = [];
  for (const [index, generationStep] of steps.entries()) {
    const step = await recordStep(dependencies, {
      turnId,
      model,
      sequence: firstSequence + index,
      generationStep,
      startedAt,
      completedAt,
    });
    if (!step.ok) return err(step.error);
    recorded.push(step.value);
  }
  return ok(Object.freeze(recorded));
}
