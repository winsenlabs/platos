// What a caller asks a model for, and what comes back.
//
// THE ROUND TRIPS BELONG TO THE PROVIDER SIDE OF THE SEAM, and that is the one
// decision in this file worth arguing about, so here is the argument.
//
// A turn is not one call. It is a call, then the tools the model asked for,
// then another call carrying their results, until the model stops asking or the
// step budget runs out. Two places could own that loop.
//
//   If the CALLER owned it, `conversations` would re-implement per-step cache
//   placement, per-step usage accumulation and tool-call repair — and the first
//   of those is worth about three times the price of a turn (`prompt-cache.ts`).
//   A surface that handed back one step at a time would have quietly deleted
//   that saving, because the saving lives in what happens BETWEEN steps.
//
//   So the ROUTER owns it, driven by a `ToolExecutor` the caller supplies. The
//   caller still decides what a tool is and what running one means — it hands
//   in a function — and `providers` never learns anything about tools beyond
//   their names and their JSON Schema. That keeps `tools` off this context's
//   dependency list, which ADR M0.3 §1 row 4 permits exactly two entries on.
//
// USAGE IS SUMMED, NOT SAMPLED. `totalUsage` is the sum of the per-step figures
// and is computed here, once, from the same array the caller can read. The
// source learned this the hard way: its whole-turn detail blob was taken from
// the LAST step while its totals were accumulated across all of them, and the
// two disagreed by 14,788 against 39,795 tokens on the same turn. A total that
// is derived cannot drift from the steps it is derived from.
//
// REASONING TOKENS ARE REPORTED AND NOT PRICED. They are already inside
// `outputTokens`, and `RATE_NAMES` in `price-card.ts` charges four rates, not
// five. Carrying them separately is for the trace; adding them to the bill
// would charge for the same tokens twice.

import { err, ok, type DomainError, type Result } from "@platos/kernel";

import { stepBudgetInvalid, toolNameDuplicated } from "./errors.js";
import type { ContentPart, ToolCallPart, ToolResultPart } from "./prompt.js";
import { tokenUsage, type TokenUsage } from "./token-usage.js";

/**
 * A tool's input contract, as a JSON Schema document.
 *
 * A plain readonly object and not a validator instance: a schema has to survive
 * being handed to a provider, logged, and compared, and every validator library
 * that could stand in for it is a dependency this layer may not have.
 */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaDocument;
}

/**
 * Reject two tools sharing a name before the request is sent.
 *
 * A provider given two definitions of one name keeps one of them, without
 * saying which, and the model then calls a tool whose schema the caller did not
 * expect. Refusing here turns an undebuggable wrong answer into a named
 * refusal.
 */
export function toolCatalogue(tools: readonly ToolDefinition[]): Result<readonly ToolDefinition[]> {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) return err(toolNameDuplicated(tool.name));
    seen.add(tool.name);
  }
  return ok(Object.freeze([...tools]));
}

/** Why a step stopped. */
export const FINISH_REASONS = [
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "aborted",
  "error",
  "other",
] as const;

export type FinishReason = (typeof FINISH_REASONS)[number];

/** Text, or an object shaped by a schema the caller supplies. */
export type OutputMode =
  | { readonly kind: "text" }
  | {
      readonly kind: "object";
      readonly schema: JsonSchemaDocument;
      /**
       * How many times to ask. The source asks exactly twice: once, and once
       * more with the validation errors appended. One is a legitimate setting
       * for a caller that would rather fail than pay for a second pass.
       */
      readonly maxPasses: number;
    };

export const TEXT_OUTPUT: OutputMode = Object.freeze({ kind: "text" });

/**
 * The two sampling controls the running system actually sets.
 *
 * Null means "the provider's default", which is not the same as zero: a
 * temperature of zero is a real, deliberate setting. Nothing here invents a
 * default, because a default chosen in this layer would silently override an
 * operator's provider-side configuration.
 */
export interface SamplingLimits {
  readonly maxOutputTokens: number | null;
  readonly temperature: number | null;
}

export const NO_SAMPLING_LIMITS: SamplingLimits = Object.freeze({
  maxOutputTokens: null,
  temperature: null,
});

/** One model call inside a generation. */
export interface GenerationStep {
  readonly text: string;
  readonly toolCalls: readonly ToolCallPart[];
  readonly toolResults: readonly ToolResultPart[];
  readonly usage: TokenUsage;
  /** Already inside `usage.outputTokens`. Reported, never charged. */
  readonly reasoningTokens: number;
  readonly finishReason: FinishReason;
}

/** Everything one `generate` call produced. */
export interface ModelGeneration {
  readonly text: string;
  /** Present only when the caller asked for `{ kind: "object" }` output. */
  readonly object: unknown | null;
  readonly steps: readonly GenerationStep[];
  /** The sum of every step's usage. Derived, so it cannot disagree with them. */
  readonly totalUsage: TokenUsage;
  readonly finishReason: FinishReason;
}

/**
 * A step budget: a whole number, at least one.
 *
 * Zero is refused rather than treated as unlimited. An unbounded tool loop is
 * the failure mode that turns one user message into an open-ended bill, and the
 * source pins its own default at twenty for that reason.
 */
export function stepBudget(maxSteps: number): Result<number> {
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1) return err(stepBudgetInvalid(maxSteps));
  return ok(maxSteps);
}

/**
 * Add up the steps.
 *
 * Goes back through `tokenUsage`, so the summed figure is subject to the same
 * arithmetic rule as every individual one: the cache counts are subsets of the
 * input count, and a sum that violates that is rejected rather than clamped.
 */
export function sumStepUsage(steps: readonly GenerationStep[]): Result<TokenUsage> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  for (const step of steps) {
    inputTokens += step.usage.inputTokens;
    outputTokens += step.usage.outputTokens;
    cacheReadInputTokens += step.usage.cacheReadInputTokens;
    cacheWriteInputTokens += step.usage.cacheWriteInputTokens;
  }
  return tokenUsage({ inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens });
}

/**
 * Assemble the answer, deriving the total rather than accepting one.
 *
 * There is deliberately no parameter for `totalUsage`. A caller cannot supply a
 * total that disagrees with the steps, because it cannot supply one at all.
 */
export function modelGeneration(draft: {
  readonly text: string;
  readonly object?: unknown;
  readonly steps: readonly GenerationStep[];
  readonly finishReason: FinishReason;
}): Result<ModelGeneration> {
  const totalUsage = sumStepUsage(draft.steps);
  if (!totalUsage.ok) return err(totalUsage.error);
  return ok({
    text: draft.text,
    object: draft.object ?? null,
    steps: Object.freeze([...draft.steps]),
    totalUsage: totalUsage.value,
    finishReason: draft.finishReason,
  });
}

/**
 * What a streaming generation emits, in order.
 *
 * The taxonomy is the source's chunk set, minus the parts of it that carry no
 * information a caller acts on (a provider's start/end markers around a text
 * run, which the source explicitly ignores too). `failed` carries a domain
 * error rather than throwing, for the same reason every method here returns a
 * `Result`: a caller forbidden from importing the SDK cannot catch its errors.
 */
export type GenerationEvent =
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "reasoning-delta"; readonly text: string }
  | { readonly kind: "tool-call"; readonly call: ToolCallPart }
  | { readonly kind: "tool-result"; readonly result: ToolResultPart }
  | { readonly kind: "content"; readonly part: ContentPart }
  | { readonly kind: "citation"; readonly url: string; readonly title: string }
  | { readonly kind: "step-finished"; readonly step: GenerationStep }
  | { readonly kind: "finished"; readonly generation: ModelGeneration }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly error: DomainError };
