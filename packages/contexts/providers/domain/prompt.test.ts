import { describe, expect, it } from "vitest";

import {
  countContentBlocks,
  prompt,
  promptMessage,
  textPart,
  type ContentPart,
  type PromptMessage,
} from "./prompt.js";

function message(role: PromptMessage["role"], content: readonly ContentPart[]): PromptMessage {
  const built = promptMessage({ role, content });
  if (!built.ok) throw new Error(`fixture is not a valid message: ${built.error.code}`);
  return built.value;
}

const CALL: ContentPart = { kind: "tool-call", toolCallId: "call-1", toolName: "search", input: { q: "x" } };
const ANSWER: ContentPart = {
  kind: "tool-result",
  toolCallId: "call-1",
  toolName: "search",
  output: { hits: 2 },
  failed: false,
};

describe("one message", () => {
  it("refuses a message with no content parts", () => {
    const built = promptMessage({ role: "user", content: [] });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_PROMPT_CONTENT_EMPTY");
    expect(built.error.details).toEqual({ role: "user" });
  });

  it("refuses an IMAGE part whose media type is blank, naming the part", () => {
    // The failure the extraction source shipped: a part built without a media
    // type failed the whole turn at the provider. The fixture reaches the branch
    // because the part really is an image with a really-blank media type.
    const built = promptMessage({
      role: "user",
      content: [{ kind: "image", mediaType: "   ", bytes: Uint8Array.of(1, 2, 3) }],
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_MEDIA_TYPE_MISSING");
    expect(built.error.details).toEqual({ role: "user", part: "image" });
  });

  it("refuses a FILE part whose media type is blank, and says so is a file", () => {
    const built = promptMessage({
      role: "user",
      content: [textPart("here"), { kind: "file", mediaType: "", bytes: Uint8Array.of(9) }],
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.details).toEqual({ role: "user", part: "file" });
  });

  it("accepts a media part that declares one, and keeps the bytes untouched", () => {
    const bytes = Uint8Array.of(137, 80, 78, 71);
    const built = promptMessage({
      role: "user",
      content: [{ kind: "image", mediaType: "image/png", bytes }, textPart("what is this")],
    });
    if (!built.ok) throw new Error(`unreachable: ${built.error.code}`);
    expect(built.value.content).toHaveLength(2);
    const first = built.value.content[0];
    if (first?.kind !== "image") throw new Error("unreachable");
    expect(first.bytes).toBe(bytes);
    expect(first.mediaType).toBe("image/png");
  });

  it("defaults a message to carrying no cache breakpoint", () => {
    expect(message("user", [textPart("hi")]).cacheBreakpoint).toBe(false);
  });
});

describe("a whole prompt", () => {
  it("refuses an empty message list", () => {
    const built = prompt([]);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_PROMPT_EMPTY");
  });

  it("accepts a tool result that answers a call asked for earlier", () => {
    const built = prompt([
      message("user", [textPart("find x")]),
      message("assistant", [CALL]),
      message("tool", [ANSWER]),
    ]);
    expect(built.ok).toBe(true);
  });

  it("refuses a tool result with no matching call, naming both id and tool", () => {
    const built = prompt([message("user", [textPart("find x")]), message("tool", [ANSWER])]);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_TOOL_RESULT_UNMATCHED");
    expect(built.error.details).toEqual({ toolCallId: "call-1", toolName: "search" });
  });

  it("refuses the SAME call answered twice, which is a different fault", () => {
    const built = prompt([
      message("assistant", [CALL]),
      message("tool", [ANSWER]),
      message("tool", [ANSWER]),
    ]);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_TOOL_RESULT_UNMATCHED");
  });

  it("refuses the same call id ASKED twice, under its own code", () => {
    // Distinct from the unmatched case on purpose: one is a caller replaying a
    // result, the other is a caller reusing an id. A single code could not tell
    // an operator which of the two they had.
    const built = prompt([message("assistant", [CALL]), message("assistant", [CALL])]);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_TOOL_CALL_DUPLICATED");
    expect(built.error.details).toEqual({ toolCallId: "call-1" });
  });

  it("matches on the id and NOT on order within one message", () => {
    const second: ContentPart = { ...CALL, toolCallId: "call-2" } as ContentPart;
    const answerSecond: ContentPart = { ...ANSWER, toolCallId: "call-2" } as ContentPart;
    const built = prompt([
      message("assistant", [CALL, second]),
      message("tool", [answerSecond, ANSWER]),
    ]);
    expect(built.ok).toBe(true);
  });
});

describe("counting content blocks", () => {
  it("counts one block per part", () => {
    expect(countContentBlocks(message("user", [textPart("a"), textPart("b"), textPart("c")]))).toBe(3);
  });

  it("never returns zero, because undercounting widens a cache gap", () => {
    expect(countContentBlocks(message("user", [textPart("only")]))).toBe(1);
  });
});
