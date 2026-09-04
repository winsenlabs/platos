// The caller's tools, on the framework's tool loop.
//
// The port keeps the loop BEHIND it — the router runs the round trips, driven by
// a `ToolExecutor` the caller supplies — so that per-step cache placement and
// per-step usage accumulation are not pushed onto every caller. This file is the
// bridge: a `ToolDefinition` list in, a tool set the framework will call out, and
// a record of what each call answered.
//
// THREE THINGS IT HAS TO GET RIGHT, and each of them was a real failure.
//
//   1. A TOOL THAT FAILED IS A RESULT, NOT AN ERROR. The port says so, because
//      the model is often able to recover from a tool that failed and cannot
//      recover from a turn that died. So a failed result is reported to the
//      model AS a failure — it throws, which is how the framework embeds an
//      error part the model can read — while the caller's own `ToolResultPart`,
//      failure flag and all, is kept verbatim for the step record.
//
//   2. AN EXECUTOR THAT REJECTED IS A DEFECT, NOT A RESULT. The port says that
//      too, and it is a different situation with a different owner: the caller's
//      function broke its own contract. It ends the generation under
//      `PROVIDERS_TOOL_EXECUTOR_FAILED` rather than being reported to the model,
//      which would otherwise burn a step per rejection on a bug the model cannot
//      possibly fix.
//
//   3. A STRINGIFIED INPUT IS REPAIRED IN PLACE. See
//      `domain/tool-input-repair.ts` for the trace: three consecutive full-price
//      steps lost to a model emitting an array parameter as a JSON string. The
//      pure repair is the domain's; what belongs here is the one vendor fact —
//      WHICH of the framework's error classes is repairable. An unknown tool is
//      not, and repairing it would put a call to a tool that does not exist back
//      on the wire.

import {
  embeddableToolResult,
  type JsonValue,
} from "./json-value.js";
import {
  repairToolCallInput,
  toolExecutorFailed,
  type DomainError,
  type JsonSchemaDocument,
  type ToolCallPart,
  type ToolDefinition,
  type ToolExecutor,
  type ToolResultPart,
} from "@platos/context-providers/application/ports/index.js";
import { jsonSchema, NoSuchToolError, dynamicTool, type ToolSet } from "ai";

/**
 * Thrown out of a tool whose result said it failed.
 *
 * A distinct class so the framework's error part carries something a reader can
 * recognise, and so a genuine defect inside this file is never mistaken for a
 * tool reporting a business failure.
 */
export class ToolReportedFailure extends Error {
  public readonly toolName: string;

  constructor(toolName: string, detail: string) {
    super(detail);
    this.name = "ToolReportedFailure";
    this.toolName = toolName;
  }
}

/** Everything one generation's tool loop accumulates. */
export interface ToolBridge {
  readonly tools: ToolSet;
  /** The caller's own answers, by call id, in the order they were produced. */
  readonly resultFor: (toolCallId: string) => ToolResultPart | undefined;
  /** Set once when the caller's executor rejected. Ends the generation. */
  readonly fatal: () => DomainError | null;
}

function detailOf(output: unknown): string {
  try {
    return JSON.stringify(embeddableToolResult(output));
  } catch {
    return "the tool reported a failure";
  }
}

function reasonOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}

/**
 * Build the tool set and the record that goes with it.
 *
 * `abort` is called when the caller's executor rejects, so the generation stops
 * on the step that broke rather than running its remaining budget out. The
 * framework has no other way to be told "stop, and not because the model said
 * so": every alternative is a signal the model would be shown.
 *
 * Every tool is DYNAMIC. This context learns a tool's name and its JSON Schema
 * and nothing else — which is exactly what keeps `tools` off its dependency
 * list — so there is no compile-time input type to bind, and a statically typed
 * tool would be a lie about knowledge this package does not have.
 */
export function toolBridge(
  definitions: readonly ToolDefinition[],
  execute: ToolExecutor,
  abort: () => void,
): ToolBridge {
  const results = new Map<string, ToolResultPart>();
  let fatal: DomainError | null = null;

  const tools: ToolSet = {};
  for (const definition of definitions) {
    tools[definition.name] = dynamicTool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: async (input: unknown, options: { toolCallId: string }): Promise<JsonValue> => {
        const call: ToolCallPart = {
          kind: "tool-call",
          toolCallId: options.toolCallId,
          toolName: definition.name,
          input,
        };
        let answer: ToolResultPart;
        try {
          answer = await execute(call);
        } catch (thrown) {
          // The caller's function broke its own contract. Record it once — a
          // later tool in the same step must not overwrite the first cause —
          // and stop the generation.
          fatal ??= toolExecutorFailed(definition.name, reasonOf(thrown));
          abort();
          throw thrown instanceof Error ? thrown : new Error(reasonOf(thrown));
        }
        results.set(options.toolCallId, answer);
        if (answer.failed) throw new ToolReportedFailure(definition.name, detailOf(answer.output));
        return embeddableToolResult(answer.output);
      },
    });
  }

  return {
    tools,
    resultFor: (toolCallId: string) => results.get(toolCallId),
    fatal: () => fatal,
  };
}

/** The repair hook's arguments, as the framework hands them over. */
interface RepairRequest {
  readonly toolCall: { readonly toolName: string; readonly input: string };
  readonly inputSchema: (options: { toolName: string }) => PromiseLike<unknown>;
  readonly error: unknown;
}

/**
 * Repair a tool call the model got the shape of wrong, or let the failure stand.
 *
 * Returning null is the "let it stand" answer, and it is the answer for every
 * case this cannot improve: an unknown tool, a schema that will not resolve, an
 * input that was already right. A repair that changed nothing would put the same
 * rejected call back on the wire and cost the step twice.
 */
export function repairCall(request: RepairRequest): Promise<{ input: string } | null> {
  return (async () => {
    try {
      // An INPUT that is wrong is repairable; a tool that does not exist is not.
      // The class check rather than the error's name string: a name comparison
      // silently stops matching the day the framework renames one.
      if (NoSuchToolError.isInstance(request.error)) return null;
      const schema = await request.inputSchema({ toolName: request.toolCall.toolName });
      const repaired = repairToolCallInput(request.toolCall.input, schema as JsonSchemaDocument);
      if (repaired === null) return null;
      return { ...request.toolCall, input: repaired };
    } catch {
      // A repair that itself failed must not replace the model's error with
      // this one. The provider's own report is the honest answer.
      return null;
    }
  })();
}
