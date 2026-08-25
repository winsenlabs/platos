import { describe, expect, it } from "vitest";
import { chatSessionCallbackBody, toUIChunks } from "./chat-session.task";

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function* events(...values: any[]): AsyncGenerator<any> {
  for (const value of values) yield value;
}

describe("platos chat-session SSE conversion", () => {
  it("forwards attachment identities to the scoped Agent callback", () => {
    expect(chatSessionCallbackBody({
      agentId: "agent-1",
      threadId: "thread-1",
      clientMessageId: "client-1",
      attachmentIds: ["attachment-1"],
      scope: {
        organizationId: "organization-1",
        projectId: "project-1",
        environmentId: "environment-1",
        userId: "user-1",
      } as any,
    }, "message")).toMatchObject({
      agentId: "agent-1",
      threadId: "thread-1",
      clientMessageId: "client-1",
      attachmentIds: ["attachment-1"],
      scope: { agentId: "agent-1", threadId: "thread-1" },
    });
  });
  it("forwards message_persisted before terminal finish", async () => {
    const chunks = await collect(toUIChunks(events(
      { type: "meta", thread_id: "thread-1" },
      { type: "message_persisted", messageId: "message-1", threadId: "thread-1" },
      { type: "done" },
    )));

    expect(chunks).toEqual([
      { type: "start" },
      { type: "data-platos-event", data: { type: "meta", thread_id: "thread-1" } },
      {
        type: "data-platos-event",
        data: { type: "message_persisted", messageId: "message-1", threadId: "thread-1" },
      },
      { type: "finish" },
    ]);
  });

  it("ignores events after done so the terminal marker cannot be bypassed", async () => {
    const chunks = await collect(toUIChunks(events(
      { type: "meta", thread_id: "thread-1" },
      { type: "done" },
      { type: "message_persisted", messageId: "late-message" },
    )));

    expect(chunks).toEqual([
      { type: "start" },
      { type: "data-platos-event", data: { type: "meta", thread_id: "thread-1" } },
      { type: "finish" },
    ]);
  });
});
