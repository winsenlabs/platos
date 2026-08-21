import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: { PLATOS_AGENT_API_URL: "http://agent.internal:3100" },
}));

import { action } from "../app/routes/api.v1.public.agents.$agentId.chat.stream";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public embed streaming proxy", () => {
  it("keeps the browser on a same-origin URL and forwards the session token internally", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("event: token\ndata: hello\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const request = new Request("https://dashboard.example/api/v1/public/agents/agent-1/chat/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Platos-Session-Token": "platform-session-token",
      },
      body: JSON.stringify({ message: "Hello" }),
    });

    const response = await action({
      request,
      params: { agentId: "agent-1" },
      context: {},
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://agent.internal:3100/api/v1/agent/agents/agent-1/chat/stream?message=Hello",
      expect.objectContaining({
        method: "GET",
        headers: { "X-Platos-Session-Token": "platform-session-token" },
      }),
    );
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toContain("data: hello");
  });

  it("rejects a missing guest session before contacting the agent", async () => {
    const response = await action({
      request: new Request("https://dashboard.example/api/v1/public/agents/agent-1/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello" }),
      }),
      params: { agentId: "agent-1" },
      context: {},
    });

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
