// `generate` — a whole generation, run to completion.
//
// A generation is not one call. It is a call, then the tools the model asked
// for, then another call carrying their results, until the model stops asking or
// the step budget runs out — and for schema-shaped output, possibly once more
// with the first answer's errors quoted back. All of that happens here, behind
// the port, which is what keeps per-step cache placement and per-step usage
// accumulation off every caller.
//
// WHAT COMES BACK IS ASSEMBLED THROUGH `modelGeneration`, WHICH TAKES NO TOTAL.
// The whole-turn figure is derived from the steps by the domain, so it cannot
// disagree with them. The extraction source's did: its detail blob was taken
// from the LAST step while its totals were accumulated across all of them, and
// the two reported 14,788 against 39,795 tokens for one turn.

import {
  err,
  modelGeneration,
  ok,
  passBudget,
  type ModelGeneration,
  type ModelGenerationRequest,
  type OutputMode,
  type Result,
} from "@platos/context-providers/application/ports/index.js";
import { generateObject, generateText, isStepCount, type LanguageModel } from "ai";

import {
  linkAbort,
  prepareStepFor,
  PROMPT_SHAPE_OPTIONS,
  samplingOptions,
  SINGLE_RETRY_LAYER,
} from "./call.js";
import { failed, toFinishReason } from "./failure.js";
import { toModelMessages } from "./messages.js";
import { spentAcross, toGenerationStep, type FrameworkStep } from "./steps.js";
import { accountingOf, compileOutputSchema, runObjectPasses, type PassOutcome } from "./structured.js";
import { repairCall, toolBridge, type ToolBridge } from "./tools.js";

/**
 * Assemble a generation out of the steps the framework reported.
 *
 * The bridge is read for each step's tool results rather than the framework's
 * own, so a failed tool's `failed` flag and untouched output survive into the
 * record. See `steps.ts`.
 */
function assemble(
  steps: readonly FrameworkStep[],
  bridge: ToolBridge,
  text: string,
  object: unknown,
  finishReason: string | undefined,
): Result<ModelGeneration> {
  const mapped: Parameters<typeof modelGeneration>[0]["steps"][number][] = [];
  for (const step of steps) {
    const built = toGenerationStep(step, bridge, toFinishReason(step.finishReason));
    if (!built.ok) return err(built.error);
    mapped.push(built.value);
  }
  return modelGeneration({ text, object, steps: mapped, finishReason: toFinishReason(finishReason) });
}

export async function runGeneration(
  request: ModelGenerationRequest,
  model: LanguageModel,
): Promise<Result<ModelGeneration>> {
  const link = linkAbort(request.abortSignal);
  const bridge = toolBridge(request.tools, request.executeTool, link.abort);
  try {
    const output: OutputMode = request.output;
    return output.kind === "object"
      ? await runObjectGeneration(request, output, model, bridge, link.signal)
      : await runTextGeneration(request, model, bridge, link.signal);
  } finally {
    link.release();
  }
}

async function runTextGeneration(
  request: ModelGenerationRequest,
  model: LanguageModel,
  bridge: ToolBridge,
  signal: AbortSignal,
): Promise<Result<ModelGeneration>> {
  const messages = toModelMessages(request.prompt, request.session.plan);
  if (!messages.ok) return err(messages.error);

  try {
    const result = await generateText({
      model,
      messages: messages.value,
      tools: bridge.tools,
      // The step budget is what bounds an open-ended tool loop, and an unbounded
      // one is how a single user message becomes an open-ended bill.
      stopWhen: isStepCount(request.maxSteps),
      prepareStep: prepareStepFor(request.session.plan, request.rewritePrompt),
      repairToolCall: repairCall,
      abortSignal: signal,
      ...PROMPT_SHAPE_OPTIONS,
      ...SINGLE_RETRY_LAYER,
      ...samplingOptions(request.sampling),
    });
    // The caller's executor broke its contract. That ended the generation, and
    // it is reported as the caller's defect rather than as whatever the
    // framework happened to say about the interrupted call.
    const fatal = bridge.fatal();
    if (fatal !== null) return err(fatal);
    return assemble(result.steps as readonly FrameworkStep[], bridge, result.text, null, result.finishReason);
  } catch (thrown) {
    const fatal = bridge.fatal();
    if (fatal !== null) return err(fatal);
    return failed(thrown, signal);
  }
}

async function runObjectGeneration(
  request: ModelGenerationRequest,
  output: Extract<OutputMode, { kind: "object" }>,
  model: LanguageModel,
  bridge: ToolBridge,
  signal: AbortSignal,
): Promise<Result<ModelGeneration>> {
  // The pass budget is checked HERE as well as in the use case, and it is the
  // same function in both places rather than a second guard with the same code.
  // The port is a public surface: a composition root may hold this adapter and
  // call it without the use case, and a budget checked only above it is a budget
  // not checked at all on that path.
  const passes = passBudget(output.maxPasses);
  if (!passes.ok) return err(passes.error);
  const validator = compileOutputSchema(output.schema);
  if (!validator.ok) return err(validator.error);

  // Every pass's step is kept, not just the winning one. A correction pass is
  // paid for whether or not it worked, and a total derived from one pass would
  // under-bill the turn by exactly the pass that went wrong.
  const steps: FrameworkStep[] = [];

  const outcome = await runObjectPasses(
    request.prompt,
    validator.value,
    passes.value,
    request.rewritePrompt,
    async (prompt): Promise<Result<PassOutcome>> => {
      const messages = toModelMessages(prompt, request.session.plan);
      if (!messages.ok) return err(messages.error);
      try {
        const result = await generateObject({
          model,
          messages: messages.value,
          schema: validator.value.schema,
          abortSignal: signal,
          ...PROMPT_SHAPE_OPTIONS,
          ...SINGLE_RETRY_LAYER,
      ...SINGLE_RETRY_LAYER,
      ...samplingOptions(request.sampling),
        });
        steps.push({
          text: JSON.stringify(result.object),
          usage: result.usage,
          providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
          finishReason: result.finishReason,
        });
        return ok({ object: result.object, rawText: JSON.stringify(result.object) });
      } catch (thrown) {
        // A model that produced no parseable object is a PASS that failed, not
        // a generation that failed: the loop quotes what it did produce back and
        // asks again. An abort is the opposite, and ends the loop at once.
        if (signal.aborted) return failed(thrown, signal);
        // The failed pass was still sent and still billed, so its counts are
        // read off the failure and pushed like any other step. Without this the
        // corrected turn under-bills by exactly the pass that went wrong.
        const accounting = accountingOf(thrown);
        steps.push({
          text: accounting.text,
          usage: accounting.usage as FrameworkStep["usage"],
          providerMetadata: accounting.providerMetadata as FrameworkStep["providerMetadata"],
          finishReason: accounting.finishReason,
        });
        return ok({ object: undefined, rawText: accounting.text });
      }
    },
    () => spentAcross(steps),
  );
  if (!outcome.ok) return err(outcome.error);

  return assemble(steps, bridge, outcome.value.text, outcome.value.object, "stop");
}
