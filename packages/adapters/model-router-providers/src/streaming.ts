// `stream` — the same generation, delivered as it happens.
//
// THE OUTER RESULT IS WHETHER IT STARTED. Once it has, a failure arrives as a
// `failed` EVENT rather than as a rejection, because a caller that has already
// received tokens needs the failure in the same order as the tokens. A rejection
// out of band leaves it holding a half-written turn with no idea whether more is
// coming.
//
// THE SEQUENCE ALWAYS ENDS IN EXACTLY ONE OF `finished`, `aborted` OR `failed`.
// That is the port's promise and it is what a caller closes a turn on, so every
// exit from the loop below goes through one of the three — including the one
// where this file's own code is what threw.
//
// SCHEMA-SHAPED OUTPUT STREAMS THE RAW JSON TEXT, NOT PARTIAL OBJECTS. The
// framework can hand back a growing partial object, and this deliberately does
// not use it: `GenerationEvent` has no partial-object kind, the extraction
// source streams `textStream` and yields its chunks as tokens, and inventing an
// event the source does not emit would put a surface into the port that nothing
// has ever consumed. The finished object arrives, once, inside `finished`.

import {
  err,
  modelGeneration,
  ok,
  passBudget,
  type GenerationEvent,
  type GenerationStep,
  type ModelGenerationRequest,
  type OutputMode,
  type Result,
  type ToolCallPart,
} from "@platos/context-providers/application/ports/index.js";
import { isStepCount, streamObject, streamText, type LanguageModel, type ModelMessage } from "ai";

import {
  linkAbort,
  prepareStepFor,
  PROMPT_SHAPE_OPTIONS,
  samplingOptions,
  SINGLE_RETRY_LAYER,
} from "./call.js";
import { isAbort, translate, toFinishReason } from "./failure.js";
import { toModelMessages } from "./messages.js";
import { answerFor, spentAcross, toGenerationStep, toToolCall, type FrameworkStep } from "./steps.js";
import { accountingOf, compileOutputSchema, runObjectPasses, type PassOutcome } from "./structured.js";
import { repairCall, toolBridge, type ToolBridge } from "./tools.js";

/**
 * A hand-off between the pass runner and the caller's loop.
 *
 * The schema-shaped path shares its pass loop with the non-streaming one, so the
 * loop cannot yield to a caller directly. Without this the deltas would have to
 * be buffered until the last pass finished, and a "streaming" surface that
 * delivers everything at the end is not one — it is the non-streaming surface
 * with a longer signature. The queue is what makes the sharing honest.
 */
class EventQueue {
  private readonly items: GenerationEvent[] = [];

  private waiting: (() => void) | null = null;

  private closed = false;

  push(event: GenerationEvent): void {
    this.items.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting !== null) waiting();
  }

  async *drain(): AsyncGenerator<GenerationEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

/** What has accumulated since the last step boundary. */
interface OpenStep {
  text: string;
  readonly toolCalls: ToolCallPart[];
}

function newStep(): OpenStep {
  return { text: "", toolCalls: [] };
}

export function startStream(
  request: ModelGenerationRequest,
  model: LanguageModel,
): Result<AsyncIterable<GenerationEvent>> {
  // Everything that can be judged before the first byte is judged here, so a
  // request that was never going to work fails as a value rather than as an
  // event on a sequence the caller has already started rendering.
  const messages = toModelMessages(request.prompt, request.session.plan);
  if (!messages.ok) return err(messages.error);
  const output: OutputMode = request.output;
  if (output.kind === "object") {
    const passes = passBudget(output.maxPasses);
    if (!passes.ok) return err(passes.error);
    const validator = compileOutputSchema(output.schema);
    if (!validator.ok) return err(validator.error);
    return ok(streamObjectEvents(request, output, model, passes.value));
  }
  return ok(streamTextEvents(request, model, messages.value));
}

async function* streamTextEvents(
  request: ModelGenerationRequest,
  model: LanguageModel,
  messages: readonly ModelMessage[],
): AsyncGenerator<GenerationEvent> {
  const link = linkAbort(request.abortSignal);
  const bridge = toolBridge(request.tools, request.executeTool, link.abort);
  const steps: GenerationStep[] = [];
  let open = newStep();
  let text = "";
  let finishReason: string | undefined;

  try {
    const result = streamText({
      model,
      messages: [...messages],
      tools: bridge.tools,
      stopWhen: isStepCount(request.maxSteps),
      prepareStep: prepareStepFor(request.session.plan, request.rewritePrompt),
      repairToolCall: repairCall,
      abortSignal: link.signal,
      ...PROMPT_SHAPE_OPTIONS,
      ...SINGLE_RETRY_LAYER,
      ...samplingOptions(request.sampling),
    });

    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        case "text-delta":
          open.text += chunk.text;
          text += chunk.text;
          yield { kind: "text-delta", text: chunk.text };
          break;
        case "reasoning-delta":
          yield { kind: "reasoning-delta", text: chunk.text };
          break;
        case "tool-call": {
          const call = toToolCall(chunk);
          open.toolCalls.push(call);
          yield { kind: "tool-call", call };
          break;
        }
        case "tool-result":
        case "tool-error": {
          // Both kinds carry the same answer here: the bridge kept the caller's
          // own `ToolResultPart`, failure flag and all, and a tool-error chunk is
          // simply how a failed result reached the model.
          const call: ToolCallPart = {
            kind: "tool-call",
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            input: undefined,
          };
          yield { kind: "tool-result", result: answerFor(call, bridge) };
          break;
        }
        case "source":
          if (chunk.sourceType === "url") {
            yield { kind: "citation", url: chunk.url, title: chunk.title ?? "" };
          }
          break;
        case "file": {
          const bytes = chunk.file.uint8Array;
          yield {
            kind: "content",
            part: { kind: "file", mediaType: chunk.file.mediaType, bytes },
          };
          break;
        }
        case "finish-step": {
          const built = toGenerationStep(
            { ...open, usage: chunk.usage, providerMetadata: chunk.providerMetadata },
            bridge,
            toFinishReason(chunk.finishReason),
          );
          if (!built.ok) {
            yield { kind: "failed", error: built.error };
            return;
          }
          steps.push(built.value);
          yield { kind: "step-finished", step: built.value };
          open = newStep();
          break;
        }
        case "finish":
          finishReason = chunk.finishReason;
          break;
        case "abort":
          yield { kind: "aborted" };
          return;
        case "error":
          yield { kind: "failed", error: translate(chunk.error, link.signal) };
          return;
        default:
          // Start and end markers around a text or reasoning run, tool input
          // deltas, and raw passthrough. The extraction source ignores them too:
          // they carry nothing a caller acts on that the deltas do not already.
          break;
      }
    }

    const fatal = bridge.fatal();
    if (fatal !== null) {
      yield { kind: "failed", error: fatal };
      return;
    }
    const generation = modelGeneration({ text, steps, finishReason: toFinishReason(finishReason) });
    if (!generation.ok) {
      yield { kind: "failed", error: generation.error };
      return;
    }
    yield { kind: "finished", generation: generation.value };
  } catch (thrown) {
    const fatal = bridge.fatal();
    if (fatal !== null) yield { kind: "failed", error: fatal };
    else if (isAbort(thrown, link.signal)) yield { kind: "aborted" };
    else yield { kind: "failed", error: translate(thrown, link.signal) };
  } finally {
    link.release();
  }
}

async function* streamObjectEvents(
  request: ModelGenerationRequest,
  output: Extract<OutputMode, { kind: "object" }>,
  model: LanguageModel,
  maxPasses: number,
): AsyncGenerator<GenerationEvent> {
  const link = linkAbort(request.abortSignal);
  // No tools: the framework's object surface has no tool loop, because a
  // provider in a schema mode is pinned to producing one object. The bridge is
  // still built so the step mapping has one shape rather than two.
  const bridge = toolBridge([], request.executeTool, link.abort);
  const validator = compileOutputSchema(output.schema);
  if (!validator.ok) {
    link.release();
    yield { kind: "failed", error: validator.error };
    return;
  }

  const steps: FrameworkStep[] = [];
  const queue = new EventQueue();

  const passes = runObjectPasses(
    request.prompt,
    validator.value,
    maxPasses,
    request.rewritePrompt,
    async (prompt): Promise<Result<PassOutcome>> => {
      const messages = toModelMessages(prompt, request.session.plan);
      if (!messages.ok) return err(messages.error);
      let raw = "";
      try {
        const result = streamObject({
          model,
          messages: messages.value,
          schema: validator.value.schema,
          abortSignal: link.signal,
          ...PROMPT_SHAPE_OPTIONS,
          ...SINGLE_RETRY_LAYER,
          ...samplingOptions(request.sampling),
        });
        // The RAW JSON text, delta by delta, exactly as the extraction source
        // forwards it. The parsed object arrives once, in `finished`.
        for await (const piece of result.textStream) {
          raw += piece;
          queue.push({ kind: "text-delta", text: piece });
        }
        const object = await result.object;
        const usage = await result.usage;
        const meta = await result.providerMetadata;
        steps.push({
          text: raw,
          usage,
          providerMetadata: meta as Record<string, unknown> | undefined,
          finishReason: "stop",
        });
        return ok({ object, rawText: raw });
      } catch (thrown) {
        if (isAbort(thrown, link.signal)) return err(translate(thrown, link.signal));
        // A model that produced nothing parseable is a PASS that failed, and the
        // loop quotes back what it did produce. The pass was still sent and
        // still billed, so its counts are read off the failure and kept.
        const accounting = accountingOf(thrown);
        steps.push({
          text: accounting.text === "" ? raw : accounting.text,
          usage: accounting.usage as FrameworkStep["usage"],
          providerMetadata: accounting.providerMetadata as FrameworkStep["providerMetadata"],
          finishReason: accounting.finishReason,
        });
        return ok({ object: undefined, rawText: accounting.text === "" ? raw : accounting.text });
      }
    },
    () => spentAcross(steps),
  );

  const settled = passes.then(
    (outcome) => {
      queue.close();
      return outcome;
    },
    (thrown: unknown) => {
      queue.close();
      return err(translate(thrown, link.signal));
    },
  );

  for await (const event of queue.drain()) yield event;
  const outcome = await settled;

  const mapped: GenerationStep[] = [];
  for (const step of steps) {
    const built = toGenerationStep(step, bridge, toFinishReason(step.finishReason));
    if (!built.ok) {
      link.release();
      yield { kind: "failed", error: built.error };
      return;
    }
    mapped.push(built.value);
    yield { kind: "step-finished", step: built.value };
  }

  link.release();
  if (!outcome.ok) {
    yield link.signal.aborted ? { kind: "aborted" } : { kind: "failed", error: outcome.error };
    return;
  }

  const generation = modelGeneration({
    text: outcome.value.text,
    object: outcome.value.object,
    steps: mapped,
    finishReason: "stop",
  });
  yield generation.ok
    ? { kind: "finished", generation: generation.value }
    : { kind: "failed", error: generation.error };
}
