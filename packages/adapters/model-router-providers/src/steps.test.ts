import type { ToolCallPart, ToolResultPart } from "@platos/context-providers/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { answerFor, toGenerationStep, toToolCall } from "./steps.js";
import { toolBridge, type ToolBridge } from "./tools.js";

const SEARCH = { name: "search", description: "s", inputSchema: { type: "object" } };

function bridgeHolding(...results: readonly ToolResultPart[]): ToolBridge {
  const held = new Map(results.map((result) => [result.toolCallId, result]));
  return {
    tools: {},
    resultFor: (id: string) => held.get(id),
    fatal: () => null,
  };
}

const CALL: ToolCallPart = { kind: "tool-call", toolCallId: "c1", toolName: "search", input: { q: 1 } };

describe("a tool call's answer", () => {
  it("is the caller's own result when there is one", () => {
    const answer: ToolResultPart = {
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "search",
      output: { hits: 3 },
      failed: false,
    };

    expect(answerFor(CALL, bridgeHolding(answer))).toBe(answer);
  });

  it("is a FAILED stand-in for a call that was never run", () => {
    // A `ToolCallPart` with no matching `ToolResultPart` is exactly the shape
    // `prompt()` refuses, so dropping it would hand the next turn a prompt this
    // system will not accept.
    const answer = answerFor(CALL, bridgeHolding());

    expect(answer).toEqual({
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "search",
      output: { ok: false, error: "the tool was not run" },
      failed: true,
    });
  });
});

describe("mapping a step", () => {
  it("pairs every call with an answer, so the pair can go back in a prompt", () => {
    const step = toGenerationStep(
      {
        text: "done",
        toolCalls: [{ toolCallId: "c1", toolName: "search", input: { q: 1 } }],
        usage: { inputTokens: 10, outputTokens: 2 },
      },
      bridgeHolding(),
      "tool-calls",
    );

    expect(step.ok).toBe(true);
    if (!step.ok) throw new Error("unreachable");
    expect(step.value.toolCalls).toHaveLength(1);
    expect(step.value.toolResults).toHaveLength(1);
    expect(step.value.toolResults[0]?.toolCallId).toBe("c1");
  });

  it("refuses a reading whose cache counts exceed the prompt it reports", () => {
    // The domain rejects rather than clamps: clamping a negative remainder to
    // zero would turn a provider's malformed usage report into a plausible bill.
    const step = toGenerationStep(
      { usage: { inputTokens: 10 }, providerMetadata: { anthropic: { cacheReadInputTokens: 40 } } },
      bridgeHolding(),
      "stop",
    );

    // The input total is lifted to the smallest figure consistent with the
    // reading, so this is admissible rather than a refusal.
    if (!step.ok) throw new Error("unreachable");
    expect(step.value.usage).toEqual({
      inputTokens: 40,
      outputTokens: 0,
      cacheReadInputTokens: 40,
      cacheWriteInputTokens: 0,
    });
  });

  it("reads an empty step as empty rather than as missing", () => {
    const step = toGenerationStep({}, bridgeHolding(), "stop");

    if (!step.ok) throw new Error("unreachable");
    expect(step.value.text).toBe("");
    expect(step.value.toolCalls).toEqual([]);
    expect(step.value.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it("carries a tool call through unchanged", () => {
    expect(toToolCall({ toolCallId: "c9", toolName: "t", input: { a: 1 } })).toEqual({
      kind: "tool-call",
      toolCallId: "c9",
      toolName: "t",
      input: { a: 1 },
    });
  });

  it("reads a real bridge's record, not only a stand-in", async () => {
    const bridge = toolBridge(
      [SEARCH],
      async (call) => ({ kind: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: "yes", failed: false }),
      () => undefined,
    );
    const tool = bridge.tools.search as { execute: (input: unknown, options: never) => Promise<unknown> };
    await tool.execute({}, { toolCallId: "c1" } as never);

    expect(answerFor(CALL, bridge)).toMatchObject({ output: "yes", failed: false });
  });
});
