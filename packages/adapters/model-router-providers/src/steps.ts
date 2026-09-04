// One model call, in this system's vocabulary.
//
// A `GenerationStep` is the unit `totalUsage` is DERIVED from — the domain's
// `modelGeneration` takes no total and computes one from the steps, precisely so
// the two cannot disagree the way the extraction source's did, at 14,788 against
// 39,795 tokens on one turn. That makes this mapping the place a usage error
// becomes a billing error, and it is why `usage.ts` reads its counts the way it
// does rather than trusting one field.
//
// TOOL RESULTS COME FROM THE CALLER, NOT FROM THE FRAMEWORK. The framework
// reports what it embedded, which for a failed tool is an error part built from
// a thrown value. The caller's own `ToolResultPart` — its `failed` flag and its
// untouched `output` — is kept by the bridge and read back here, so the step
// record says what the tool actually answered rather than what survived being
// serialised for the model.

import {
  err,
  ok,
  tokenUsage,
  type FinishReason,
  type GenerationStep,
  type Result,
  type TokenUsage,
  type ToolCallPart,
  type ToolResultPart,
} from "@platos/context-providers/application/ports/index.js";

import type { ToolBridge } from "./tools.js";
import { readStepCounts, usageDraft, type FrameworkUsage, type ProviderMetadataLike } from "./usage.js";

/** The slice of a finished step this mapping reads. */
export interface FrameworkStep {
  readonly text?: string;
  readonly toolCalls?: readonly { readonly toolCallId: string; readonly toolName: string; readonly input: unknown }[];
  readonly usage?: FrameworkUsage;
  readonly providerMetadata?: ProviderMetadataLike;
  readonly finishReason?: string;
}

export function toToolCall(call: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}): ToolCallPart {
  return {
    kind: "tool-call",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  };
}

/**
 * What a call answered, or a stand-in saying it did not.
 *
 * A call with no recorded answer is a call the framework never executed — the
 * step budget ran out with the call outstanding, or the generation was
 * abandoned mid-step. It is reported as a FAILED result rather than dropped,
 * because a `ToolCallPart` with no matching `ToolResultPart` is exactly the
 * shape `prompt()` refuses, and dropping it would hand the next turn a prompt
 * this system will not accept.
 */
export function answerFor(call: ToolCallPart, bridge: ToolBridge): ToolResultPart {
  const recorded = bridge.resultFor(call.toolCallId);
  if (recorded !== undefined) return recorded;
  return {
    kind: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: { ok: false, error: "the tool was not run" },
    failed: true,
  };
}

export function toGenerationStep(
  step: FrameworkStep,
  bridge: ToolBridge,
  finishReason: FinishReason,
): Result<GenerationStep> {
  const counts = readStepCounts(step.usage, step.providerMetadata);
  const usage = tokenUsage(usageDraft(counts));
  if (!usage.ok) return err(usage.error);

  const toolCalls = (step.toolCalls ?? []).map(toToolCall);
  return ok({
    text: step.text ?? "",
    toolCalls,
    toolResults: toolCalls.map((call) => answerFor(call, bridge)),
    usage: usage.value,
    reasoningTokens: counts.reasoningTokens,
    finishReason,
  });
}

/**
 * What the passes so far have cost, in this system's four counts.
 *
 * Built from the SAME step list the successful path assembles a generation
 * from, so a failed structured turn is priced exactly as a successful one of
 * the same length would be. A reading the domain refuses — cache counts larger
 * than the prompt they came out of — reports as nothing rather than as a
 * plausible number, because a corrupt figure on an error is worse than no
 * figure at all: nobody reconciles it.
 */
export function spentAcross(steps: readonly FrameworkStep[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheWriteInputTokens = 0;
  for (const step of steps) {
    const counts = readStepCounts(step.usage, step.providerMetadata);
    inputTokens += counts.inputTokens;
    outputTokens += counts.outputTokens;
    cacheReadInputTokens += counts.cacheReadInputTokens;
    cacheWriteInputTokens += counts.cacheWriteInputTokens;
  }
  const usage = tokenUsage({ inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens });
  return usage.ok ? usage.value : NO_SPEND;
}

const NO_SPEND: TokenUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
});
