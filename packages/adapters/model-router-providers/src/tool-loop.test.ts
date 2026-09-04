// The tool loop: the round trips the port keeps BEHIND it.
//
// Per-step cache placement and per-step usage accumulation live between the
// steps, which is why the loop is the router's and not the caller's. These are
// the cases that hold that arrangement to account.

import type { ToolCallPart, ToolResultPart } from "@platos/context-providers/application/ports/index.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { runGeneration } from "./run.js";
import { generationRequest as request, normalisedUsage } from "./testing.js";

describe("the tool loop", () => {
  function toolModel(): MockLanguageModelV4 {
    let call = 0;
    return new MockLanguageModelV4({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [
              { type: "tool-call", toolCallId: "c1", toolName: "search", input: '{"q":"platos"}' },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: normalisedUsage(1_000, 30, 0, 900),
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "found it" }],
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: normalisedUsage(2_000, 40, 900, 0),
          warnings: [],
        };
      },
    });
  }

  const SEARCH = {
    name: "search",
    description: "search things",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  };

  it("runs the round trip and SUMS the two steps rather than sampling one", async () => {
    // The source's own defect: a whole-turn blob taken from the last step while
    // the totals were accumulated across all of them, disagreeing 14,788 to
    // 39,795. A derived total cannot do that, and this is the assertion that
    // says so in numbers.
    const executed: ToolCallPart[] = [];
    const executeTool = async (call: ToolCallPart): Promise<ToolResultPart> => {
      executed.push(call);
      return { kind: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: { hits: 2 }, failed: false };
    };

    const generated = await runGeneration(
      request({ tools: [SEARCH], executeTool }),
      toolModel(),
    );

    if (!generated.ok) throw new Error(generated.error.code);
    expect(executed).toHaveLength(1);
    expect(executed[0]?.input).toEqual({ q: "platos" });
    expect(generated.value.steps).toHaveLength(2);
    expect(generated.value.steps[0]?.usage.inputTokens).toBe(1_000);
    expect(generated.value.steps[1]?.usage.inputTokens).toBe(2_000);
    expect(generated.value.totalUsage).toEqual({
      inputTokens: 3_000,
      outputTokens: 70,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 900,
    });
    expect(generated.value.text).toBe("found it");
  });

  it("keeps the caller's own tool result, failure flag and all", async () => {
    const executeTool = async (call: ToolCallPart): Promise<ToolResultPart> => ({
      kind: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { why: "upstream down" },
      failed: true,
    });

    const generated = await runGeneration(request({ tools: [SEARCH], executeTool }), toolModel());

    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.steps[0]?.toolResults[0]).toEqual({
      kind: "tool-result",
      toolCallId: "c1",
      toolName: "search",
      output: { why: "upstream down" },
      failed: true,
    });
  });

  it("ends the generation when the caller's executor rejects", async () => {
    const executeTool = () => Promise.reject(new Error("the caller's function is broken"));

    const generated = await runGeneration(request({ tools: [SEARCH], executeTool }), toolModel());

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_TOOL_EXECUTOR_FAILED");
    expect(generated.error.details.toolName).toBe("search");
  });

  it("stops at the step budget rather than running an open-ended loop", async () => {
    const executeTool = async (call: ToolCallPart): Promise<ToolResultPart> => ({
      kind: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: "again",
      failed: false,
    });
    // A model that asks for a tool forever.
    let issued = 0;
    const forever = new MockLanguageModelV4({
      doGenerate: async () => {
        issued += 1;
        return {
          content: [{ type: "tool-call", toolCallId: `c${issued}`, toolName: "search", input: "{}" }],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: normalisedUsage(10, 1, 0, 0),
          warnings: [],
        };
      },
    });

    const generated = await runGeneration(
      request({ tools: [SEARCH], executeTool, maxSteps: 3 }),
      forever,
    );

    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.steps).toHaveLength(3);
    expect(generated.value.totalUsage.inputTokens).toBe(30);
  });

  it("repairs a stringified container instead of bouncing it back to the model", async () => {
    // WORKSTREAM C's case: `calls` arrives as a JSON string. Without the repair
    // the framework rejects the call and the model pays a full-price step to
    // discover its own formatting slip.
    const withArray = {
      name: "execute_tools",
      description: "run several",
      inputSchema: {
        type: "object",
        properties: { calls: { type: "array", items: { type: "object" } } },
        required: ["calls"],
      },
    };
    let issued = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        issued += 1;
        if (issued === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "execute_tools",
                input: JSON.stringify({ calls: '[{"tool":"SEND"}]' }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: normalisedUsage(50, 5, 0, 0),
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: normalisedUsage(60, 5, 0, 0),
          warnings: [],
        };
      },
    });
    const seen: unknown[] = [];
    const executeTool = async (call: ToolCallPart): Promise<ToolResultPart> => {
      seen.push(call.input);
      return { kind: "tool-result", toolCallId: call.toolCallId, toolName: call.toolName, output: "ok", failed: false };
    };

    const generated = await runGeneration(
      request({ tools: [withArray], executeTool }),
      model,
    );

    if (!generated.ok) throw new Error(generated.error.code);
    expect(seen).toEqual([{ calls: [{ tool: "SEND" }] }]);
    // Two model calls, not three: the repair cost no extra round trip.
    expect(issued).toBe(2);
  });
});
