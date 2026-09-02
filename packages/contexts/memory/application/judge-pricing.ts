// Pricing a model call this context made, through `providers`.
//
// Extraction and profile synthesis are both billable work that no turn asked
// for, and the running system prices both against the model's rate card. ADR
// M0.3 §1 row 8 permits `providers`, whose `priceModelUsage` is the published
// surface that resolves the card in force at an instant and charges the four
// rates against it.
//
// THIS CONTEXT WRITES NO LEDGER ROW, and could not: the spend ledger belongs to
// `cost-monitoring`, which is not on this context's allow-list. The priced
// amount travels back on the report so the composition root can attribute it —
// which is the same inversion the ADR uses everywhere a downstream owner must
// not be imported.
//
// A PRICING FAILURE IS NEVER A WORK FAILURE. The memories are already written
// and the spend already happened; failing the sweep would roll back correct work
// because a rate card was missing. The report carries `null`, which is a visible
// "we could not price this" — a zero would be indistinguishable from a call that
// was free.
//
// THE CACHE COUNTS ARE SUBSETS OF THE INPUT COUNT, which is what `providers`
// expects: its `tokenUsage` refuses a draft whose cache reads and writes exceed
// its input tokens. The two vocabularies differ by one word — this context and
// the model SDKs say "creation", the rate card says "write" — and this is the
// one place that translation happens.

import type { Result } from "@platos/kernel";

import type { MemoryDependencies } from "./dependencies.js";
import { NO_JUDGE_USAGE, type JudgeAnswer, type JudgeUsage } from "./ports/index.js";

/** True when the call reported no billable work at all. */
export function isUnbilled(usage: JudgeUsage): boolean {
  return usage.inputTokens <= 0 && usage.outputTokens <= 0;
}

/**
 * Price one judge call. Null when there was nothing to price, or when the card
 * could not be resolved.
 */
export async function priceJudgeAnswer(
  dependencies: MemoryDependencies,
  answer: JudgeAnswer,
): Promise<string | null> {
  const usage = answer.usage ?? NO_JUDGE_USAGE;
  if (isUnbilled(usage)) return null;
  const priced: Result<{ readonly costCents: string }> = await dependencies.providers.priceModelUsage({
    model: answer.model,
    at: dependencies.clock.now(),
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheWriteInputTokens: usage.cacheCreationInputTokens,
    },
  });
  return priced.ok ? priced.value.costCents : null;
}
