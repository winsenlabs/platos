// Schema-shaped output, end to end: the passes, and what each one costs.

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { runGeneration } from "./run.js";
import { startStream } from "./streaming.js";
import { generationRequest as request, normalisedUsage } from "./testing.js";

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
