// Streaming: the same generation, delivered as it happens.
//
// The property every case here turns on is the port's promise that the sequence
// ends in EXACTLY ONE of `finished`, `aborted` or `failed`. A caller that has
// already rendered tokens closes its turn on that event and on nothing else.

import type { Prompt } from "@platos/context-providers/application/ports/index.js";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { startStream } from "./streaming.js";
import { bareUsage, generationRequest as request } from "./testing.js";

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
