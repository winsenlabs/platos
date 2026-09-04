import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { linkAbort, PROMPT_SHAPE_OPTIONS, prepareStepFor, samplingOptions, SINGLE_RETRY_LAYER } from "./call.js";
import { ANTHROPIC_PLAN } from "./testing.js";

describe("joining the deadlines", () => {
  it("carries the caller's abort through to the joined signal", () => {
    const caller = new AbortController();
    const link = linkAbort(caller.signal);

    caller.abort();

    expect(link.signal.aborted).toBe(true);
  });

  it("is already aborted when the caller's signal was", () => {
    const caller = new AbortController();
    caller.abort();

    expect(linkAbort(caller.signal).signal.aborted).toBe(true);
  });

  it("can be pulled from this side, which is how a broken executor stops a turn", () => {
    const link = linkAbort(null);

    link.abort();

    expect(link.signal.aborted).toBe(true);
  });

  it("never aborts on its own when the caller set no deadline", () => {
    expect(linkAbort(null).signal.aborted).toBe(false);
  });

  it("detaches, so a caller signal reused across generations does not accumulate listeners", () => {
    const caller = new AbortController();
    const link = linkAbort(caller.signal);

    link.release();
    caller.abort();

    expect(link.signal.aborted).toBe(false);
  });
});

describe("the sampling controls", () => {
  it("omits what the caller left to the provider", () => {
    expect(samplingOptions({ maxOutputTokens: null, temperature: null })).toEqual({});
  });

  it("keeps a temperature of ZERO, which is a real setting and not an absence", () => {
    expect(samplingOptions({ maxOutputTokens: null, temperature: 0 })).toEqual({ temperature: 0 });
  });

  it("carries both when both are set", () => {
    expect(samplingOptions({ maxOutputTokens: 512, temperature: 0.7 })).toEqual({
      maxOutputTokens: 512,
      temperature: 0.7,
    });
  });
});

describe("the shared call options", () => {
  it("keeps the system prompt inside the message array", () => {
    // `ai@7` defaults this off, and the domain carries the system prompt as a
    // MESSAGE precisely so it can hold a cache breakpoint.
    expect(PROMPT_SHAPE_OPTIONS).toEqual({ allowSystemInMessages: true });
  });

  it("leaves exactly ONE retry layer in force, the transport's", () => {
    // Two stacked policies multiply: three transport passes times three
    // framework retries is nine calls to a provider that is already struggling.
    expect(SINGLE_RETRY_LAYER).toEqual({ maxRetries: 0 });
  });
});

describe("the per-step hook", () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ];

  it("hands back the rewritten array", () => {
    const prepare = prepareStepFor(ANTHROPIC_PLAN, (prompt) => ({
      messages: prompt.messages.map((message) => ({ ...message, cacheBreakpoint: message.role === "user" })),
    }));

    const prepared = prepare({ messages });

    expect(prepared.messages?.[1]).toMatchObject({
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("leaves the framework's array alone when it cannot be read back", () => {
    const prepare = prepareStepFor(ANTHROPIC_PLAN, (prompt) => prompt);

    const prepared = prepare({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: {}, providerExecuted: true }],
        },
      ],
    });

    expect(prepared).toEqual({});
  });
});
