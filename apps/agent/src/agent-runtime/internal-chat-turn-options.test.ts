import { describe, expect, it } from "vitest";
import { internalChatTurnOptions } from "./agent.controller";

describe("internal durable chat callback options", () => {
  it("forwards attachment identities into canonical streaming execution", () => {
    const signal = new AbortController().signal;
    expect(internalChatTurnOptions({
      agentId: "agent-1",
      threadId: "thread-1",
      attachmentIds: ["attachment-1"],
      clientMessageId: "client-1",
    }, signal)).toEqual({
      agentId: "agent-1",
      threadId: "thread-1",
      attachmentIds: ["attachment-1"],
      replyToMessageId: undefined,
      idempotencyKey: "client-1",
      abortSignal: signal,
    });
  });
});
