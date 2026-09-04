// End-to-end through the framework's OWN mock model.
//
// See `testing.ts` for what the double is and why it is that one. This file and
// its three siblings -- `tool-loop.test.ts`, `object-output.test.ts` and
// `stream.test.ts` -- were split by CONCERN rather than left as one suite, for
// the reason ADR M0.3 §6 gives: the extraction source keeps this behaviour in a
// 7,121-line service, and a 700-line test file is the same shape one layer down.

import type {
  Prompt,
  ToolCallPart,
  ToolResultPart,
} from "@platos/context-providers/application/ports/index.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { runGeneration } from "./run.js";
import { startStream } from "./streaming.js";
import {
  bareUsage,
  generationRequest as request,
  normalisedUsage,
  type SpecCallOptions,
} from "./testing.js";

describe("a one-step text generation", () => {
  it("reports the provider's exact counts, and derives the total from the steps", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "hi there" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: normalisedUsage(100_000, 500, 90_000, 4_000, 120),
        warnings: [],
      }),
    });

    const generated = await runGeneration(request(), model);

    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.text).toBe("hi there");
    expect(generated.value.steps).toHaveLength(1);
    expect(generated.value.steps[0]?.usage).toEqual({
      inputTokens: 100_000,
      outputTokens: 500,
      cacheReadInputTokens: 90_000,
      cacheWriteInputTokens: 4_000,
    });
    expect(generated.value.steps[0]?.reasoningTokens).toBe(120);
    expect(generated.value.totalUsage).toEqual({
      inputTokens: 100_000,
      outputTokens: 500,
      cacheReadInputTokens: 90_000,
      cacheWriteInputTokens: 4_000,
    });
    expect(generated.value.finishReason).toBe("stop");
  });

  it("reads Anthropic's provider metadata when the framework normalised nothing", async () => {
    // The dangerous case. Nothing is on `inputTokenDetails`, so a reader that
    // consults only the normalised field reports zero cache tokens — a
    // well-formed record, a successful turn, and the whole prompt billed at the
    // full input rate.
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: bareUsage(120_000, 40),
        providerMetadata: {
          anthropic: { usage: { cache_read_input_tokens: 96_000, cache_creation_input_tokens: 8_000 } },
        },
        warnings: [],
      }),
    });

    const generated = await runGeneration(request(), model);

    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.totalUsage).toEqual({
      inputTokens: 120_000,
      outputTokens: 40,
      cacheReadInputTokens: 96_000,
      cacheWriteInputTokens: 8_000,
    });
  });

  it("reads OpenAI's provider metadata", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: bareUsage(70_000, 20),
        providerMetadata: { openai: { cachedPromptTokens: 64_000, reasoningTokens: 900 } },
        warnings: [],
      }),
    });

    const generated = await runGeneration(request(), model);

    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.totalUsage.cacheReadInputTokens).toBe(64_000);
    // OpenAI bills no cache WRITE, so there is no key of theirs to read.
    expect(generated.value.totalUsage.cacheWriteInputTokens).toBe(0);
    expect(generated.value.steps[0]?.reasoningTokens).toBe(900);
  });

  it("reads Vertex's metadata under its own key, not Google's", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: { unified: "stop", raw: "STOP" },
        usage: bareUsage(30_000, 15),
        providerMetadata: {
          vertex: { usageMetadata: { cachedContentTokenCount: 25_000 }, cacheCreationInputTokens: 1_500 },
        },
        warnings: [],
      }),
    });

    const generated = await runGeneration(request(), model);

    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.totalUsage.cacheReadInputTokens).toBe(25_000);
    expect(generated.value.totalUsage.cacheWriteInputTokens).toBe(1_500);
  });
});

describe("the cache breakpoints between steps", () => {
  it("re-places the markers on every step, including the ones the framework added", async () => {
    const rewritePrompt = vi.fn((given: Prompt): Prompt => ({
      messages: given.messages.map((message, index) => ({
        ...message,
        cacheBreakpoint: message.role !== "system" && index === given.messages.length - 1,
      })),
    }));
    const executeTool = async (call: ToolCallPart): Promise<ToolResultPart> => ({
      kind: "tool-result",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: "ok",
      failed: false,
    });
    let issued = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        issued += 1;
        if (issued === 1) {
          return {
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: "{}" }],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: normalisedUsage(10, 1, 0, 0),
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: normalisedUsage(10, 1, 0, 0),
          warnings: [],
        };
      },
    });

    await runGeneration(
      request({
        tools: [{ name: "search", description: "s", inputSchema: { type: "object" } }],
        executeTool,
        rewritePrompt,
      }),
      model,
    );

    // Called for each step, and the second call saw MORE messages than the
    // first: the assistant tool-call message and the tool result the framework
    // appended. Without that the marker goes stale at step one and every later
    // step re-pays full price for the whole history.
    expect(rewritePrompt.mock.calls.length).toBeGreaterThanOrEqual(2);
    const first = rewritePrompt.mock.calls[0]?.[0].messages.length ?? 0;
    const last = rewritePrompt.mock.calls[rewritePrompt.mock.calls.length - 1]?.[0].messages.length ?? 0;
    expect(last).toBeGreaterThan(first);
  });

  it("sends the system message's marker on an explicit-breakpoint route", async () => {
    const seen: SpecCallOptions[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seen.push(options as unknown as SpecCallOptions);
        return {
          content: [{ type: "text", text: "ok" }],
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: normalisedUsage(10, 1, 0, 0),
          warnings: [],
        };
      },
    });

    await runGeneration(request(), model);

    const system = seen[0]?.prompt[0];
    expect(system?.role).toBe("system");
    expect(system?.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });
});

describe("the failures", () => {
  it("returns a domain error rather than letting a vendor error escape", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("upstream exploded");
      },
    });

    const generated = await runGeneration(request(), model);

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_PROVIDER_REQUEST_FAILED");
    expect(generated.error.message).toBe("Provider request failed.");
  });

  it("names an abandoned generation under its own code, not as an outage", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });

    const generated = await runGeneration(request({ abortSignal: controller.signal }), model);

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_GENERATION_ABORTED");
  });

  it("refuses a prompt the wire cannot carry before any material moves", async () => {
    let called = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        called += 1;
        throw new Error("should never be reached");
      },
    });
    const prompt: Prompt = {
      messages: [
        {
          role: "system",
          content: [{ kind: "image", mediaType: "image/png", bytes: new Uint8Array([1]) }],
          cacheBreakpoint: false,
        },
      ],
    };

    const generated = await runGeneration(request({ prompt }), model);

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_MESSAGE_NOT_REPRESENTABLE");
    expect(called).toBe(0);
  });
});
