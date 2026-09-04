// End-to-end through the framework's OWN mock model.
//
// The double here is `MockLanguageModelV4`, which sits at the provider
// specification boundary: everything above it — usage normalisation, the tool
// loop, `prepareStep`, `repairToolCall`, the object mode — is the real
// framework running for real. Only the wire is faked.
//
// That choice is the point. A hand-written double of `generateText` would have
// let this suite agree with an adapter that never places a cache marker, never
// repairs a call and reads usage out of the wrong field, because the double
// would have been built from the same misunderstanding as the code.

import type {
  ModelGenerationRequest,
  Prompt,
  ToolCallPart,
  ToolResultPart,
} from "@platos/context-providers/application/ports/index.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { startStream } from "./streaming.js";
import { runGeneration } from "./run.js";
import { ANTHROPIC_PLAN, credential } from "./testing.js";

// The two provider-specification shapes this suite constructs, declared here
// rather than imported: `@ai-sdk/provider` is a transitive dependency of the
// framework and not one this package declares, and a test that reached past its
// own manifest into the dependency tree would be a boundary this package's whole
// reason for existing is to hold.
type Count = number | undefined;

type SpecUsage = {
  inputTokens: { total: Count; noCache: Count; cacheRead: Count; cacheWrite: Count };
  outputTokens: { total: Count; text: Count; reasoning: Count };
};

type SpecCallOptions = {
  prompt: readonly { role: string; providerOptions?: unknown }[];
};

/** A usage blob with nothing about caching in it, so the chains must be used. */
function bareUsage(input: number, output: number): SpecUsage {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

function normalisedUsage(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  reasoning?: number,
): SpecUsage {
  return {
    inputTokens: { total: input, noCache: undefined, cacheRead, cacheWrite },
    outputTokens: { total: output, text: output - (reasoning ?? 0), reasoning },
  };
}

function request(overrides: Partial<ModelGenerationRequest> = {}): ModelGenerationRequest {
  const prompt: Prompt = {
    messages: [
      { role: "system", content: [{ kind: "text", text: "rules" }], cacheBreakpoint: true },
      { role: "user", content: [{ kind: "text", text: "hello" }], cacheBreakpoint: false },
    ],
  };
  return {
    session: { sessionId: "s1", plan: ANTHROPIC_PLAN, expiresAt: null },
    credential: credential("sk-live"),
    prompt,
    tools: [],
    executeTool: () => Promise.reject(new Error("no tools in this fixture")),
    output: { kind: "text" },
    sampling: { maxOutputTokens: null, temperature: null },
    maxSteps: 5,
    rewritePrompt: (given) => given,
    abortSignal: null,
    ...overrides,
  };
}

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

describe("streaming", () => {
  function streamingModel(): MockLanguageModelV4 {
    return new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "he" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "llo" });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: bareUsage(80_000, 25),
              providerMetadata: { anthropic: { cacheReadInputTokens: 70_000, cacheCreationInputTokens: 3_000 } },
            });
            controller.close();
          },
        }),
      }),
    });
  }

  it("delivers the tokens and then exactly one terminal event", async () => {
    const started = startStream(request(), streamingModel());

    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error.code);
    const events = [];
    for await (const event of started.value) events.push(event);

    expect(events.filter((event) => event.kind === "text-delta").map((event) => event.text)).toEqual([
      "he",
      "llo",
    ]);
    const terminal = events.filter((event) =>
      event.kind === "finished" || event.kind === "aborted" || event.kind === "failed",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.kind).toBe("finished");
  });

  it("accumulates the SAME exact counts the non-streaming path would", async () => {
    const started = startStream(request(), streamingModel());
    if (!started.ok) throw new Error(started.error.code);
    const events = [];
    for await (const event of started.value) events.push(event);

    const finished = events.find((event) => event.kind === "finished");
    expect(finished?.kind).toBe("finished");
    if (finished?.kind !== "finished") throw new Error("unreachable");
    expect(finished.generation.totalUsage).toEqual({
      inputTokens: 80_000,
      outputTokens: 25,
      cacheReadInputTokens: 70_000,
      cacheWriteInputTokens: 3_000,
    });
    expect(finished.generation.text).toBe("hello");
  });

  it("reports a mid-stream failure as an event, in order with the tokens", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: "par" });
            controller.enqueue({ type: "error", error: new Error("upstream cut the connection") });
            controller.close();
          },
        }),
      }),
    });

    const started = startStream(request(), model);
    if (!started.ok) throw new Error(started.error.code);
    const events = [];
    for await (const event of started.value) events.push(event);

    expect(events[0]).toEqual({ kind: "text-delta", text: "par" });
    expect(events[events.length - 1]?.kind).toBe("failed");
  });

  it("refuses to START on a prompt the wire cannot carry", async () => {
    const prompt: Prompt = {
      messages: [{ role: "tool", content: [{ kind: "text", text: "no" }], cacheBreakpoint: false }],
    };

    const started = startStream(request({ prompt }), streamingModel());

    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    expect(started.error.code).toBe("PROVIDERS_MESSAGE_NOT_REPRESENTABLE");
  });
});

describe("schema-shaped output", () => {
  const PERSON = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
    additionalProperties: false,
  };

  function objectModel(...answers: readonly string[]): MockLanguageModelV4 {
    let issued = 0;
    return new MockLanguageModelV4({
      doGenerate: async () => {
        const text = answers[Math.min(issued, answers.length - 1)] ?? "{}";
        issued += 1;
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: "end_turn" },
          usage: normalisedUsage(1_000 * issued, 10, 100 * issued, 0),
          warnings: [],
        };
      },
    });
  }

  it("returns the object and prices the ONE pass it took", async () => {
    const generated = await runGeneration(
      request({ output: { kind: "object", schema: PERSON, maxPasses: 2 } }),
      objectModel(JSON.stringify({ name: "ada", age: 36 })),
    );

    expect(generated.ok).toBe(true);
    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.object).toEqual({ name: "ada", age: 36 });
    expect(generated.value.steps).toHaveLength(1);
    expect(generated.value.totalUsage).toEqual({
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadInputTokens: 100,
      cacheWriteInputTokens: 0,
    });
  });

  it("prices BOTH passes when the first one was corrected", async () => {
    // A correction pass is paid for whether or not it worked. A total derived
    // from the winning pass alone would under-bill the turn by exactly the pass
    // that went wrong.
    const generated = await runGeneration(
      request({ output: { kind: "object", schema: PERSON, maxPasses: 2 } }),
      objectModel(JSON.stringify({ name: 1, age: "old" }), JSON.stringify({ name: "ada", age: 36 })),
    );

    if (!generated.ok) throw new Error(generated.error.code);
    expect(generated.value.steps).toHaveLength(2);
    expect(generated.value.totalUsage).toEqual({
      inputTokens: 3_000,
      outputTokens: 20,
      cacheReadInputTokens: 300,
      cacheWriteInputTokens: 0,
    });
  });

  it("fails closed when neither pass satisfied the schema", async () => {
    const generated = await runGeneration(
      request({ output: { kind: "object", schema: PERSON, maxPasses: 2 } }),
      objectModel(JSON.stringify({ name: 1, age: "old" })),
    );

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_STRUCTURED_OUTPUT_INVALID");
    expect(generated.error.details.passes).toBe(2);
  });

  it("refuses a pass budget of zero before any material moves", async () => {
    let called = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        called += 1;
        throw new Error("should never be reached");
      },
    });

    const generated = await runGeneration(
      request({ output: { kind: "object", schema: PERSON, maxPasses: 0 } }),
      model,
    );

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_PASS_BUDGET_INVALID");
    expect(called).toBe(0);
  });

  it("refuses a schema that will not compile, under its own code", async () => {
    const generated = await runGeneration(
      request({ output: { kind: "object", schema: { type: "not-a-type" }, maxPasses: 2 } }),
      objectModel("{}"),
    );

    expect(generated.ok).toBe(false);
    if (generated.ok) throw new Error("unreachable");
    expect(generated.error.code).toBe("PROVIDERS_OUTPUT_SCHEMA_INVALID");
  });

  it("streams the raw JSON text and delivers the object once, at the end", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({ type: "text-start", id: "t" });
            controller.enqueue({ type: "text-delta", id: "t", delta: '{"name":"ada",' });
            controller.enqueue({ type: "text-delta", id: "t", delta: '"age":36}' });
            controller.enqueue({ type: "text-end", id: "t" });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: "end_turn" },
              usage: normalisedUsage(2_000, 12, 500, 0),
            });
            controller.close();
          },
        }),
      }),
    });

    const started = startStream(
      request({ output: { kind: "object", schema: PERSON, maxPasses: 2 } }),
      model,
    );
    if (!started.ok) throw new Error(started.error.code);
    const events = [];
    for await (const event of started.value) events.push(event);

    expect(events.filter((event) => event.kind === "text-delta").map((event) => event.text)).toEqual([
      '{"name":"ada",',
      '"age":36}',
    ]);
    const finished = events[events.length - 1];
    expect(finished?.kind).toBe("finished");
    if (finished?.kind !== "finished") throw new Error("unreachable");
    expect(finished.generation.object).toEqual({ name: "ada", age: 36 });
    expect(finished.generation.totalUsage).toEqual({
      inputTokens: 2_000,
      outputTokens: 12,
      cacheReadInputTokens: 500,
      cacheWriteInputTokens: 0,
    });
  });

  it("refuses to START a stream on a pass budget of zero", () => {
    const started = startStream(
      request({ output: { kind: "object", schema: PERSON, maxPasses: 0 } }),
      objectModel("{}"),
    );

    expect(started.ok).toBe(false);
    if (started.ok) throw new Error("unreachable");
    expect(started.error.code).toBe("PROVIDERS_PASS_BUDGET_INVALID");
  });
});
