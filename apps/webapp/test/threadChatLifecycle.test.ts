import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope, agentPanel, agentRequest, PlatosAgentApiError } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
  agentPanel: vi.fn(),
  agentRequest: vi.fn(),
  PlatosAgentApiError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("../app/services/platosAgent.server", () => ({
  agentPanel,
  agentRequest,
  agentResponse: vi.fn(),
  PlatosAgentApiError,
}));

import { action, collectedResultThreadId, loader, persistedThreadState, ratingValue } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  userId: "operator",
};

function args(body: Record<string, unknown>): ActionFunctionArgs {
  return {
    request: new Request("https://dashboard.example/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      agentId: "agent-1",
    },
    context: {},
  };
}

function loaderArgs(search = ""): LoaderFunctionArgs {
  return {
    request: new Request(`https://dashboard.example/chat${search}`),
    params: {
      organizationSlug: "org",
      projectParam: "project",
      envParam: "env",
      agentId: "agent-1",
    },
    context: {},
  };
}

describe("Thread chat retained lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope });
  });

  it("reads the persisted nested userRating.rating value used by the UI", () => {
    expect(ratingValue({ userRating: { rating: 1 } })).toBe(1);
    expect(ratingValue({ userRating: { rating: -1 } })).toBe(-1);
    expect(ratingValue({ userRating: null })).toBeNull();
  });

  it("reads canonical nested rating state without mutating it as an operator", async () => {
    agentRequest.mockResolvedValueOnce({ userRating: { messageId: "turn-1", rating: 1 }, aggregate: { ups: 3, downs: 1 } });

    const response = await action(args({ intent: "rating-get", messageId: "turn-1" }));
    const payload = await response.json();

    expect(agentRequest).toHaveBeenCalledOnce();
    expect(agentRequest).toHaveBeenCalledWith("/api/v1/agent/messages/turn-1/rating", { ...scope, agentId: "agent-1" });
    expect(payload).toEqual({ ok: true, ratingState: { userRating: { messageId: "turn-1", rating: 1 }, aggregate: { ups: 3, downs: 1 } } });
  });

  it.each(["rate", "rating-delete"])("denies the operator %s mutation without calling the Agent", async (intent) => {
    const response = await action(args({ intent, messageId: "turn-1", rating: 1 }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Operator principals cannot mutate EndUser ratings",
      code: "RATING_ACTOR_FORBIDDEN",
    });
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("creates and reads back a scoped Thread before returning an ephemeral presign", async () => {
    agentRequest
      .mockResolvedValueOnce({ id: "thread-1", agentId: "agent-1" })
      .mockResolvedValueOnce({ id: "thread-1", agentId: "agent-1" })
      .mockResolvedValueOnce({
        attachmentId: "attachment-1",
        uploadUrl: "https://storage.example/upload?signature=ephemeral",
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        attachment: { id: "attachment-1", originalName: "pixel.png", mimeType: "image/png", bytes: 12 },
      });

    const response = await action(args({ intent: "attachment-presign", filename: "pixel.png", mimeType: "image/png", bytes: 12 }));
    const payload = await response.json();

    expect(agentRequest).toHaveBeenNthCalledWith(1, "/api/v1/agent/threads", scope, { method: "POST", body: { agentId: "agent-1" } });
    expect(agentRequest).toHaveBeenNthCalledWith(2, "/api/v1/agent/threads/thread-1", scope);
    expect(agentRequest).toHaveBeenNthCalledWith(3, "/api/v1/agent/attachments/presigned", scope, {
      method: "POST",
      body: { agentId: "agent-1", threadId: "thread-1", filename: "pixel.png", mimeType: "image/png", bytes: 12 },
    });
    expect(payload.threadId).toBe("thread-1");
    expect(payload.presign.attachmentId).toBe("attachment-1");
    expect(JSON.stringify(payload)).not.toMatch(/storageKey|secretAccessKey|accessKeyId/);
  });

  it("loads the URL-addressed Thread from canonical message and attachment read-back", async () => {
    agentPanel
      .mockResolvedValueOnce({ ok: true, data: { id: "agent-1" } })
      .mockResolvedValueOnce({ ok: true, data: { items: [] } });
    agentRequest.mockImplementation(async (path: string) => {
      if (path === "/api/v1/agent/threads/thread-1") {
        return { id: "thread-1", agentId: "agent-1" };
      }
      if (path === "/api/v1/agent/threads/thread-1/messages?limit=100&offset=0") {
        return {
          total: 2,
          items: [
            { id: "turn-1", turnId: "turn-1", role: "user", content: "win234-marker" },
            { id: "turn-1", turnId: "turn-1", role: "assistant", content: "fixture reply" },
          ],
        };
      }
      if (path === "/api/v1/agent/files/threads/thread-1/attachments?limit=100&offset=0") {
        return {
          items: [{
            id: "attachment-1",
            turnId: "turn-1",
            filename: "win234-marker.txt",
            mimeType: "text/plain",
            bytes: 13,
          }],
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const response = await loader(loaderArgs("?threadId=thread-1"));
    const payload = await response.json();

    expect(payload.persistedThread).toEqual({
      threadId: "thread-1",
      submittedMessage: "win234-marker",
      answer: "fixture reply",
      messageId: "turn-1",
      attachmentIds: "attachment-1",
      uploadedAttachments: [{
        id: "attachment-1",
        name: "win234-marker.txt",
        mimeType: "text/plain",
        bytes: 13,
      }],
    });
    expect(agentRequest.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/agent/threads/thread-1",
      "/api/v1/agent/threads/thread-1/messages?limit=100&offset=0",
      "/api/v1/agent/files/threads/thread-1/attachments?limit=100&offset=0",
    ]);
  });

  it("uses the canonical collected-result Thread instead of a stale supplied fallback", () => {
    expect(collectedResultThreadId({ ok: true, result: { threadId: "thread-canonical" } }))
      .toBe("thread-canonical");
    expect(
      collectedResultThreadId(
        { ok: true, result: { threadId: "thread-recovered" } },
        "thread-wrong-agent",
      ),
    ).toBe("thread-recovered");
  });

  it("reads the newest bounded message page instead of losing a recent Turn behind pagination", async () => {
    agentPanel
      .mockResolvedValueOnce({ ok: true, data: { id: "agent-1" } })
      .mockResolvedValueOnce({ ok: true, data: { items: [] } });
    agentRequest.mockImplementation(async (path: string) => {
      if (path === "/api/v1/agent/threads/thread-1") return { id: "thread-1", agentId: "agent-1" };
      if (path === "/api/v1/agent/threads/thread-1/messages?limit=100&offset=0") {
        return { total: 202, items: Array.from({ length: 100 }, (_, index) => ({ role: "user", content: `old-${index}` })) };
      }
      if (path === "/api/v1/agent/threads/thread-1/messages?limit=100&offset=102") {
        return {
          total: 202,
          items: [
            { id: "turn-latest", turnId: "turn-latest", role: "user", content: "latest-marker" },
            { id: "turn-latest", turnId: "turn-latest", role: "assistant", content: "latest-reply" },
          ],
        };
      }
      if (path === "/api/v1/agent/files/threads/thread-1/attachments?limit=100&offset=0") return { items: [] };
      throw new Error(`Unexpected path: ${path}`);
    });

    const response = await loader(loaderArgs("?threadId=thread-1"));
    const payload = await response.json();

    expect(payload.persistedThread.submittedMessage).toBe("latest-marker");
    expect(payload.persistedThread.answer).toBe("latest-reply");
    expect(agentRequest).toHaveBeenCalledWith(
      "/api/v1/agent/threads/thread-1/messages?limit=100&offset=102",
      scope,
    );
  });

  it("fails loudly instead of truncating more than 100 attachments on the latest Turn", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: {} });
    agentRequest.mockImplementation(async (path: string) => {
      if (path === "/api/v1/agent/threads/thread-1") return { id: "thread-1", agentId: "agent-1" };
      if (path === "/api/v1/agent/threads/thread-1/messages?limit=100&offset=0") {
        return { total: 1, items: [{ id: "turn-1", turnId: "turn-1", role: "user", content: "marker" }] };
      }
      if (path === "/api/v1/agent/files/threads/thread-1/attachments?limit=100&offset=0") {
        return {
          total: 101,
          items: Array.from({ length: 100 }, (_, index) => ({
            id: `attachment-${index}`,
            turnId: "turn-1",
          })),
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const error = await loader(loaderArgs("?threadId=thread-1")).catch((caught) => caught);

    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(409);
  });

  it("rejects a Thread that does not belong to the route Agent before loading its messages", async () => {
    agentPanel.mockResolvedValue({ ok: true, data: {} });
    agentRequest.mockResolvedValueOnce({ id: "thread-1", agentId: "agent-2" });

    const error = await loader(loaderArgs("?threadId=thread-1")).catch((caught) => caught);

    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(404);
    expect(agentRequest).toHaveBeenCalledOnce();
  });

  it("keeps attachment identity separate from the Turn marker during projection", () => {
    const projected = persistedThreadState(
      "thread-1",
      {
        items: [
          { id: "turn-1", turnId: "turn-1", role: "user", content: "message-marker" },
          { id: "turn-1", turnId: "turn-1", role: "assistant", content: "reply" },
        ],
      },
      {
        items: [
          { id: "attachment-current", turnId: "turn-1", filename: "attachment-marker.txt", mimeType: "text/plain", bytes: 4 },
          { id: "attachment-old", turnId: "turn-0", filename: "old.txt", mimeType: "text/plain", bytes: 3 },
        ],
      },
    );

    expect(projected.submittedMessage).toBe("message-marker");
    expect(projected.messageId).toBe("turn-1");
    expect(projected.attachmentIds).toBe("attachment-current");
    expect(projected.uploadedAttachments.map(({ name }) => name)).toEqual(["attachment-marker.txt"]);
  });

  it("rejects malformed attachment metadata without calling the Agent", async () => {
    const response = await action(args({ intent: "attachment-presign", filename: "bad", mimeType: "", bytes: -1 }));
    expect(response.status).toBe(400);
    expect(agentRequest).not.toHaveBeenCalled();
  });

  it("returns a stable error for malformed JSON without reflecting the payload", async () => {
    const requestArgs = args({});
    requestArgs.request = new Request("https://dashboard.example/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"secretAccessKey":"sentinel"',
    });
    const response = await action(requestArgs);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "Invalid request" });
  });

  it("does not reflect upstream details from rating failures", async () => {
    agentRequest.mockRejectedValueOnce(new PlatosAgentApiError(
      503,
      "AGENT_UNAVAILABLE",
      "SENTINEL_UPSTREAM_RATING_CREDENTIAL",
    ));

    const response = await action(args({ intent: "rating-get", messageId: "turn-1" }));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).toContain("Rating service is unavailable");
    expect(serialized).not.toContain("SENTINEL_UPSTREAM_RATING_CREDENTIAL");
  });

  it("does not reflect upstream details from attachment failures", async () => {
    agentRequest.mockRejectedValueOnce(new PlatosAgentApiError(
      503,
      "AGENT_UNAVAILABLE",
      "SENTINEL_UPSTREAM_STORAGE_CREDENTIAL",
    ));

    const response = await action(args({
      intent: "attachment-presign",
      threadId: "thread-1",
      filename: "pixel.png",
      mimeType: "image/png",
      bytes: 12,
    }));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).toContain("Attachment upload is unavailable");
    expect(serialized).not.toContain("SENTINEL_UPSTREAM_STORAGE_CREDENTIAL");
  });
});
