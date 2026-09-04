import type { Prompt, PromptMessage } from "@platos/context-providers/application/ports/index.js";
import { describe, expect, it } from "vitest";

import {
  EPHEMERAL_CACHE_CONTROL,
  fromModelMessages,
  rewriteWireMessages,
  toModelMessages,
} from "./messages.js";
import { ANTHROPIC_PLAN as ANTHROPIC, OPENAI_PLAN as OPENAI } from "./testing.js";

function say(
  role: PromptMessage["role"],
  content: PromptMessage["content"],
  cacheBreakpoint = false,
): PromptMessage {
  return { role, content, cacheBreakpoint };
}

const BYTES = new Uint8Array([1, 2, 3]);

describe("mapping a prompt onto the wire", () => {
  it("flattens a system message to a string, which is what every provider takes", () => {
    const source: Prompt = {
      messages: [say("system", [{ kind: "text", text: "one" }, { kind: "text", text: "two" }])],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    expect(mapped.ok).toBe(true);
    if (!mapped.ok) throw new Error("unreachable");
    expect(mapped.value[0]).toEqual({ role: "system", content: "one\ntwo" });
  });

  it("keeps an image and a file apart, both carrying their bytes", () => {
    const source: Prompt = {
      messages: [
        say("user", [
          { kind: "text", text: "look" },
          { kind: "image", mediaType: "image/png", bytes: BYTES },
          { kind: "file", mediaType: "application/pdf", bytes: BYTES },
        ]),
      ],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (!mapped.ok) throw new Error("unreachable");
    expect(mapped.value[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", image: BYTES, mediaType: "image/png" },
        { type: "file", data: BYTES, mediaType: "application/pdf" },
      ],
    });
  });

  it("marks a failed tool result as an error output, so the model is told", () => {
    const source: Prompt = {
      messages: [
        say("assistant", [{ kind: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } }]),
        say("tool", [
          { kind: "tool-result", toolCallId: "c1", toolName: "search", output: { why: "down" }, failed: true },
        ]),
      ],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (!mapped.ok) throw new Error("unreachable");
    expect(mapped.value[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "error-json", value: { why: "down" } },
        },
      ],
    });
  });

  it("sends a successful tool result as an ordinary json output", () => {
    const source: Prompt = {
      messages: [
        say("assistant", [{ kind: "tool-call", toolCallId: "c1", toolName: "search", input: {} }]),
        say("tool", [{ kind: "tool-result", toolCallId: "c1", toolName: "search", output: [1], failed: false }]),
      ],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (!mapped.ok) throw new Error("unreachable");
    const tool = mapped.value[1] as { content: { output: unknown }[] };
    expect(tool.content[0]?.output).toEqual({ type: "json", value: [1] });
  });

  it("sanitises a tool result on the way out", () => {
    const source: Prompt = {
      messages: [
        say("assistant", [{ kind: "tool-call", toolCallId: "c1", toolName: "t", input: {} }]),
        say("tool", [
          { kind: "tool-result", toolCallId: "c1", toolName: "t", output: { n: 5n }, failed: false },
        ]),
      ],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (!mapped.ok) throw new Error("unreachable");
    const tool = mapped.value[1] as { content: { output: { value: unknown } }[] };
    expect(tool.content[0]?.output.value).toEqual({ n: "5" });
  });
});

describe("the refusals", () => {
  it("refuses a media part in a system message rather than dropping it", () => {
    const source: Prompt = {
      messages: [say("system", [{ kind: "image", mediaType: "image/png", bytes: BYTES }])],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) throw new Error("unreachable");
    expect(mapped.error.code).toBe("PROVIDERS_MESSAGE_NOT_REPRESENTABLE");
    expect(mapped.error.details).toEqual({ role: "system", part: "image" });
  });

  it("refuses an image in an assistant message, which the wire has no place for", () => {
    const source: Prompt = {
      messages: [say("assistant", [{ kind: "image", mediaType: "image/png", bytes: BYTES }])],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) throw new Error("unreachable");
    expect(mapped.error.details).toEqual({ role: "assistant", part: "image" });
  });

  it("refuses a tool call in a user message", () => {
    const source: Prompt = {
      messages: [say("user", [{ kind: "tool-call", toolCallId: "c", toolName: "t", input: {} }])],
    };

    expect(toModelMessages(source, ANTHROPIC).ok).toBe(false);
  });

  it("refuses anything but a tool result in a tool message", () => {
    const source: Prompt = { messages: [say("tool", [{ kind: "text", text: "hi" }])] };

    const mapped = toModelMessages(source, ANTHROPIC);

    expect(mapped.ok).toBe(false);
    if (mapped.ok) throw new Error("unreachable");
    expect(mapped.error.details).toEqual({ role: "tool", part: "text" });
  });

  it("names the FIRST unrepresentable message, so the assembler can be found", () => {
    const source: Prompt = {
      messages: [
        say("system", [{ kind: "image", mediaType: "image/png", bytes: BYTES }]),
        say("tool", [{ kind: "text", text: "also wrong" }]),
      ],
    };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (mapped.ok) throw new Error("unreachable");
    expect(mapped.error.details.role).toBe("system");
  });
});

describe("the cache marker", () => {
  it("emits the ephemeral marker on a marked message for a route that honours one", () => {
    const source: Prompt = { messages: [say("user", [{ kind: "text", text: "hi" }], true)] };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (!mapped.ok) throw new Error("unreachable");
    expect(mapped.value[0]).toMatchObject({ providerOptions: EPHEMERAL_CACHE_CONTROL });
  });

  it("emits nothing on an unmarked message", () => {
    const source: Prompt = { messages: [say("user", [{ kind: "text", text: "hi" }])] };

    const mapped = toModelMessages(source, ANTHROPIC);

    if (!mapped.ok) throw new Error("unreachable");
    expect(mapped.value[0]).not.toHaveProperty("providerOptions");
  });

  it("emits nothing at all on a route that honours no explicit marker", () => {
    // The SYSTEM message is the case this exists for: the domain's placement
    // deliberately never touches it, so a prompt assembled for one provider and
    // re-routed to another would otherwise carry a marker the new provider
    // counts against a budget it never agreed to.
    const source: Prompt = {
      messages: [
        say("system", [{ kind: "text", text: "rules" }], true),
        say("user", [{ kind: "text", text: "hi" }], true),
      ],
    };

    const mapped = toModelMessages(source, OPENAI);

    if (!mapped.ok) throw new Error("unreachable");
    expect(mapped.value[0]).not.toHaveProperty("providerOptions");
    expect(mapped.value[1]).not.toHaveProperty("providerOptions");
  });
});

describe("reading the wire back", () => {
  it("round-trips every part kind it can express", () => {
    const source: Prompt = {
      messages: [
        say("system", [{ kind: "text", text: "rules" }], true),
        say("user", [
          { kind: "text", text: "look" },
          { kind: "image", mediaType: "image/png", bytes: BYTES },
          { kind: "file", mediaType: "application/pdf", bytes: BYTES },
        ]),
        say("assistant", [
          { kind: "text", text: "thinking" },
          { kind: "reasoning", text: "why" },
          { kind: "tool-call", toolCallId: "c1", toolName: "search", input: { q: 1 } },
        ]),
        say("tool", [
          { kind: "tool-result", toolCallId: "c1", toolName: "search", output: { hit: true }, failed: false },
        ]),
      ],
    };

    const wire = toModelMessages(source, ANTHROPIC);
    if (!wire.ok) throw new Error("unreachable");
    const read = fromModelMessages(wire.value);

    expect(read).toEqual(source);
  });

  it("reads a failed tool result back as failed", () => {
    const source: Prompt = {
      messages: [
        say("assistant", [{ kind: "tool-call", toolCallId: "c1", toolName: "t", input: {} }]),
        say("tool", [{ kind: "tool-result", toolCallId: "c1", toolName: "t", output: "boom", failed: true }]),
      ],
    };

    const wire = toModelMessages(source, ANTHROPIC);
    if (!wire.ok) throw new Error("unreachable");
    const read = fromModelMessages(wire.value);

    expect(read?.messages[1]?.content[0]).toMatchObject({ failed: true, output: "boom" });
  });

  it("refuses a part it has no word for, rather than approximating one", () => {
    // A provider-executed tool call. Rebuilding the message without the flag
    // would send a call the provider already ran back to the provider.
    const read = fromModelMessages([
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c", toolName: "t", input: {}, providerExecuted: true },
        ],
      },
    ]);

    expect(read).toBeNull();
  });

  it("refuses a file the provider holds by reference rather than by bytes", () => {
    const read = fromModelMessages([
      { role: "user", content: [{ type: "file", data: new URL("https://x/y.pdf"), mediaType: "application/pdf" }] },
    ]);

    expect(read).toBeNull();
  });

  it("reads a bare string user message, which the framework also accepts", () => {
    const read = fromModelMessages([{ role: "user", content: "hello" }]);

    expect(read?.messages[0]).toEqual({
      role: "user",
      content: [{ kind: "text", text: "hello" }],
      cacheBreakpoint: false,
    });
  });
});

describe("moving the markers between steps", () => {
  it("puts the marker where the rewrite says, and nowhere else", () => {
    const wire = toModelMessages(
      {
        messages: [
          say("system", [{ kind: "text", text: "rules" }]),
          say("user", [{ kind: "text", text: "one" }]),
          say("assistant", [{ kind: "text", text: "two" }]),
        ],
      },
      ANTHROPIC,
    );
    if (!wire.ok) throw new Error("unreachable");

    // A rewrite that marks the LAST message, which is what placement does.
    const rewritten = rewriteWireMessages(wire.value, ANTHROPIC, (source) => ({
      messages: source.messages.map((message, index) => ({
        ...message,
        cacheBreakpoint: index === source.messages.length - 1,
      })),
    }));

    expect(rewritten).not.toBeNull();
    expect(rewritten?.[0]).not.toHaveProperty("providerOptions");
    expect(rewritten?.[1]).not.toHaveProperty("providerOptions");
    expect(rewritten?.[2]).toMatchObject({ providerOptions: EPHEMERAL_CACHE_CONTROL });
  });

  it("leaves the framework's own array alone when it cannot be read back", () => {
    const rewritten = rewriteWireMessages(
      [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "c", toolName: "t", input: {}, providerExecuted: true }] }],
      ANTHROPIC,
      (source) => source,
    );

    expect(rewritten).toBeNull();
  });
});
