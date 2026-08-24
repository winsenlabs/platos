import type { ActionFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireEnvironmentScope, agentRequest, PlatosAgentApiError } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
  agentRequest: vi.fn(),
  PlatosAgentApiError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));

vi.mock("../app/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("../app/services/platosAgent.server", () => ({
  agentPanel: vi.fn(),
  agentRequest,
  agentResponse: vi.fn(),
  PlatosAgentApiError,
}));

import { action } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agents.$agentId.chat/route";

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

describe("Thread chat retained lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireEnvironmentScope.mockResolvedValue({ scope });
  });

  it("POSTs a rating and returns only canonical GET read-back state", async () => {
    agentRequest
      .mockResolvedValueOnce({ rating: { id: "internal-mutation-result" } })
      .mockResolvedValueOnce({ userRating: { messageId: "turn-1", rating: 1 }, aggregate: { ups: 3, downs: 1 } });

    const response = await action(args({ intent: "rate", messageId: "turn-1", rating: 1 }));
    const payload = await response.json();

    expect(agentRequest).toHaveBeenNthCalledWith(1, "/api/v1/agent/messages/turn-1/rating", { ...scope, agentId: "agent-1" }, {
      method: "POST",
      body: { rating: 1 },
    });
    expect(agentRequest).toHaveBeenNthCalledWith(2, "/api/v1/agent/messages/turn-1/rating", { ...scope, agentId: "agent-1" });
    expect(payload).toEqual({ ok: true, ratingState: { userRating: { messageId: "turn-1", rating: 1 }, aggregate: { ups: 3, downs: 1 } } });
    expect(JSON.stringify(payload)).not.toContain("internal-mutation-result");
  });

  it("DELETEs a rating and confirms the empty canonical GET read-back", async () => {
    agentRequest
      .mockResolvedValueOnce({ removed: true })
      .mockResolvedValueOnce({ userRating: null, aggregate: { ups: 2, downs: 1 } });

    const response = await action(args({ intent: "rating-delete", messageId: "turn-1" }));

    expect(agentRequest).toHaveBeenNthCalledWith(1, "/api/v1/agent/messages/turn-1/rating", { ...scope, agentId: "agent-1" }, { method: "DELETE" });
    expect(await response.json()).toEqual({ ok: true, ratingState: { userRating: null, aggregate: { ups: 2, downs: 1 } } });
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
});
