// The inference double, and the rate card it prices against.
//
// IT IS ITS OWN FILE BECAUSE IT IS THE ONLY DOUBLE THAT HANDLES MONEY, and the
// money path is the one this programme has watched go dead twice. The rules it
// keeps:
//
//   FOUR NAMED RATES, ALWAYS PRESENT, AS `Decimal(24, 12)` STRINGS. A fixture
//   with no `rates` key made every cost zero in another package this week and
//   left every pricing branch unexecuted while the suite stayed green. These
//   rates are real numbers, they differ from each other, and cache read is a
//   TENTH of fresh input — so a test that swapped two of them would come out
//   with a different total rather than the same one.
//
//   THE INVARIANT `providers` ENFORCES IS ENFORCED HERE TOO.
//   `cacheRead + cacheWrite <= inputTokens`: both cache counts are SUBSETS of
//   the input total, not additions to it, and a double that let them exceed it
//   would certify a usage report the real thing refuses.
//
//   THE ARITHMETIC IS THE REAL ONE, IN BIGINTS. `providers` computes
//   `microCents = round(sum(tokens x picoUsdPerToken) / 10_000)` with a
//   half-up at the end. Copying that here rather than approximating in floats
//   is what lets a test assert an EXACT cent string instead of a shape.
//
// `runModelGeneration` DRIVES THE TOOL LOOP, because that is what the real port
// does: the caller supplies `executeTool` and the implementation calls it. A
// double that never called it would leave the whole tool half of the turn
// untested, including the not-offered guard.

import { err, ok } from "@platos/kernel";
import type { GenerationStep, ToolCallPart } from "@platos/context-providers";

import { repositoryUnavailable } from "../../domain/index.js";
import type { ProvidersPeer } from "../dependencies.js";

/** Pico-USD per token, per rate. Deliberately four different magnitudes. */
export const TEST_RATES = Object.freeze({
  input: 3_000_000n,
  output: 15_000_000n,
  cacheRead: 300_000n,
  cacheWrite: 3_750_000n,
});

const PICO_USD_PER_MICRO_CENT = 10_000n;

/** `Decimal(24, 12)` USD per token, as the column stores it. */
function usdPerToken(pico: bigint): string {
  const whole = pico / 1_000_000_000_000n;
  const fraction = (pico % 1_000_000_000_000n).toString().padStart(12, "0");
  return `${whole}.${fraction}`;
}

/** The arithmetic `providers/domain/cost.ts` performs, reproduced exactly. */
export function priceTestUsage(charged: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): string {
  const pico =
    BigInt(charged.input) * TEST_RATES.input +
    BigInt(charged.output) * TEST_RATES.output +
    BigInt(charged.cacheRead) * TEST_RATES.cacheRead +
    BigInt(charged.cacheWrite) * TEST_RATES.cacheWrite;
  const microCents = (pico + PICO_USD_PER_MICRO_CENT / 2n) / PICO_USD_PER_MICRO_CENT;
  const whole = microCents / 1_000_000n;
  const fraction = (microCents % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

export class InMemoryProviders implements ProvidersPeer {
  readonly name = "providers" as const;

  /** What the model answers, and what it asks for on the way. */
  text = "the answer";
  toolCalls: ToolCallPart[] = [];
  steps: GenerationStep[] | null = null;
  finishReason: GenerationStep["finishReason"] = "stop";

  /** Every generation request, so a suite can assert the catalogue and budget. */
  readonly generated: { model: string; maxSteps: number; toolNames: string[] }[] = [];
  /** Every pricing request, so a suite can assert the translated usage shape. */
  readonly priced: { model: string; usage: Record<string, number> }[] = [];
  /** Every tool result the executor answered with. */
  readonly toolResults: unknown[] = [];

  /** Set to drop the rate card, to prove the rate guard is reachable. */
  omitRates = false;
  private failure: string | null = null;

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  /** One step with the usage a caller names. The default is deliberately non-zero. */
  step(usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningTokens?: number;
  } = {}): GenerationStep {
    return {
      text: this.text,
      toolCalls: [],
      toolResults: [],
      usage: {
        inputTokens: usage.inputTokens ?? 1_000,
        outputTokens: usage.outputTokens ?? 200,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
      },
      reasoningTokens: usage.reasoningTokens ?? 0,
      finishReason: this.finishReason,
    };
  }

  runModelGeneration: ProvidersPeer["runModelGeneration"] = async (command) => {
    this.generated.push({
      model: command.model,
      maxSteps: command.maxSteps,
      toolNames: command.tools.map((tool) => tool.name),
    });
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));

    for (const call of this.toolCalls) {
      this.toolResults.push(await command.executeTool(call));
    }

    const steps = this.steps ?? [this.step()];
    return ok({
      generation: {
        text: this.text,
        object: null,
        steps,
        totalUsage: {
          inputTokens: steps.reduce((total, step) => total + step.usage.inputTokens, 0),
          outputTokens: steps.reduce((total, step) => total + step.usage.outputTokens, 0),
          cacheReadInputTokens: steps.reduce(
            (total, step) => total + step.usage.cacheReadInputTokens,
            0,
          ),
          cacheWriteInputTokens: steps.reduce(
            (total, step) => total + step.usage.cacheWriteInputTokens,
            0,
          ),
        },
        finishReason: this.finishReason,
      },
      plan: {} as never,
      providerKey: {} as never,
    });
  };

  streamModelGeneration: ProvidersPeer["streamModelGeneration"] = async () =>
    err(repositoryUnavailable("this double does not stream"));

  priceModelUsage: ProvidersPeer["priceModelUsage"] = async (query) => {
    const usage = query.usage;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadInputTokens ?? 0;
    const cacheWrite = usage.cacheWriteInputTokens ?? 0;
    this.priced.push({
      model: query.model,
      usage: { input, output, cacheRead, cacheWrite },
    });
    if (this.failure !== null) return err(repositoryUnavailable(this.failure));
    if (cacheRead + cacheWrite > input) {
      return err(repositoryUnavailable("cache token counts cannot exceed inputTokens"));
    }

    const fresh = input - cacheRead - cacheWrite;
    const costCents = priceTestUsage({ input: fresh, output, cacheRead, cacheWrite });
    const observedAt = new Date(0);
    const rates = this.omitRates
      ? []
      : [
          { rate: "input", usdPerToken: usdPerToken(TEST_RATES.input), source: "LITELLM", observedAt, sourceRef: null },
          { rate: "output", usdPerToken: usdPerToken(TEST_RATES.output), source: "LITELLM", observedAt, sourceRef: null },
          { rate: "cacheRead", usdPerToken: usdPerToken(TEST_RATES.cacheRead), source: "LITELLM", observedAt, sourceRef: null },
          { rate: "cacheWrite", usdPerToken: usdPerToken(TEST_RATES.cacheWrite), source: "LITELLM", observedAt, sourceRef: null },
        ];

    return ok({
      price: {
        modelPriceId: "price-1",
        modelKey: query.model,
        provider: "anthropic",
        modelName: query.model,
        effectiveFrom: observedAt,
        rates: rates as never,
      },
      costCents,
      currency: "USD",
      charged: { input: fresh, output, cacheRead, cacheWrite },
    });
  };
}
