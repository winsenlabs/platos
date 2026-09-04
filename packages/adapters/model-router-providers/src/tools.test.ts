import type { ToolCallPart, ToolResultPart } from "@platos/context-providers/application/ports/index.js";
import { NoSuchToolError } from "ai";
import { describe, expect, it } from "vitest";

import { repairCall, toolBridge, ToolReportedFailure } from "./tools.js";

const SEARCH = {
  name: "search",
  description: "search things",
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

/** The one option the framework passes that this bridge reads. */
const CALL_OPTIONS = { toolCallId: "c1" } as never;

function answering(output: unknown, failed = false) {
  return async (call: ToolCallPart): Promise<ToolResultPart> => ({
    kind: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output,
    failed,
  });
}

function executeOf(bridge: ReturnType<typeof toolBridge>) {
  const tool = bridge.tools.search as { execute: (input: unknown, options: never) => Promise<unknown> };
  return tool.execute;
}

describe("the tool bridge", () => {
  it("hands the caller a tool call and records what it answered", async () => {
    const seen: ToolCallPart[] = [];
    const bridge = toolBridge(
      [SEARCH],
      async (call) => {
        seen.push(call);
        return { kind: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { n: 1 }, failed: false };
      },
      () => undefined,
    );

    const returned = await executeOf(bridge)({ q: "x" }, CALL_OPTIONS);

    expect(seen[0]).toEqual({ kind: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } });
    expect(returned).toEqual({ n: 1 });
    expect(bridge.resultFor("c1")).toEqual({
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "search",
      output: { n: 1 },
      failed: false,
    });
  });

  it("sanitises the value the framework will embed", async () => {
    const bridge = toolBridge([SEARCH], answering({ big: 7n }), () => undefined);

    expect(await executeOf(bridge)({}, CALL_OPTIONS)).toEqual({ big: "7" });
  });

  it("reports a FAILED result to the model as a failure, and keeps it verbatim", async () => {
    const bridge = toolBridge([SEARCH], answering({ why: "down" }, true), () => undefined);

    await expect(executeOf(bridge)({}, CALL_OPTIONS)).rejects.toBeInstanceOf(ToolReportedFailure);
    expect(bridge.resultFor("c1")).toMatchObject({ failed: true, output: { why: "down" } });
    expect(bridge.fatal()).toBeNull();
  });

  it("treats an executor that REJECTED as a defect, not a result", async () => {
    let aborted = 0;
    const bridge = toolBridge(
      [SEARCH],
      () => Promise.reject(new Error("the caller's function is broken")),
      () => {
        aborted += 1;
      },
    );

    await expect(executeOf(bridge)({}, CALL_OPTIONS)).rejects.toThrow("broken");
    expect(aborted).toBe(1);
    expect(bridge.fatal()?.code).toBe("PROVIDERS_TOOL_EXECUTOR_FAILED");
    expect(bridge.fatal()?.details.toolName).toBe("search");
  });

  it("keeps the FIRST cause when two tools in one step both reject", async () => {
    const bridge = toolBridge(
      [SEARCH, { ...SEARCH, name: "lookup" }],
      (call) => Promise.reject(new Error(`${call.toolName} broke`)),
      () => undefined,
    );
    const lookup = bridge.tools.lookup as { execute: (input: unknown, options: never) => Promise<unknown> };

    await expect(executeOf(bridge)({}, CALL_OPTIONS)).rejects.toThrow();
    await expect(lookup.execute({}, { toolCallId: "c2" } as never)).rejects.toThrow();

    expect(bridge.fatal()?.details.reason).toBe("search broke");
  });

  it("builds one tool per definition and nothing else", () => {
    const bridge = toolBridge([SEARCH, { ...SEARCH, name: "lookup" }], answering(1), () => undefined);

    expect(Object.keys(bridge.tools).sort()).toEqual(["lookup", "search"]);
  });

  it("has no answer for a call that was never run", () => {
    const bridge = toolBridge([SEARCH], answering(1), () => undefined);

    expect(bridge.resultFor("never")).toBeUndefined();
  });
});

describe("repairing a tool call", () => {
  const schemaFor = () => Promise.resolve(SEARCH.inputSchema);
  const arraySchema = {
    type: "object",
    properties: { calls: { type: "array", items: { type: "object" } } },
  };

  it("unwraps a stringified container and keeps every other field of the call", async () => {
    const repaired = await repairCall({
      toolCall: {
        type: "tool-call",
        toolCallId: "c9",
        toolName: "execute_tools",
        input: JSON.stringify({ calls: '[{"tool":"SEND"}]' }),
        providerExecuted: false,
      },
      inputSchema: () => Promise.resolve(arraySchema),
      error: new Error("invalid input"),
    } as never);

    expect(repaired).not.toBeNull();
    // The id is what the framework matches the result against; rebuilding the
    // call from the two fields the repair reads would have dropped it.
    expect(repaired).toMatchObject({ toolCallId: "c9", toolName: "execute_tools", type: "tool-call" });
    expect(JSON.parse((repaired as { input: string }).input)).toEqual({ calls: [{ tool: "SEND" }] });
  });

  it("refuses to repair a tool that does not exist", async () => {
    const repaired = await repairCall({
      toolCall: { type: "tool-call", toolCallId: "c", toolName: "ghost", input: '{"calls":"[]"}' },
      inputSchema: () => Promise.resolve(arraySchema),
      error: new NoSuchToolError({ toolName: "ghost" }),
    } as never);

    expect(repaired).toBeNull();
  });

  it("lets the original failure stand when nothing was repaired", async () => {
    const repaired = await repairCall({
      toolCall: { type: "tool-call", toolCallId: "c", toolName: "search", input: '{"q":"fine"}' },
      inputSchema: schemaFor,
      error: new Error("invalid input"),
    } as never);

    expect(repaired).toBeNull();
  });

  it("lets the original failure stand when the schema will not resolve", async () => {
    const repaired = await repairCall({
      toolCall: { type: "tool-call", toolCallId: "c", toolName: "search", input: '{"q":"x"}' },
      inputSchema: () => Promise.reject(new Error("no schema")),
      error: new Error("invalid input"),
    } as never);

    expect(repaired).toBeNull();
  });
});
