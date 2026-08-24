import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: { PLATOS_AGENT_API_URL: "http://agent.internal:3100" },
}));

import { action } from "../app/routes/api.v1.public.agents.$agentId.chat.stream";
import { action as guestTokenAction } from "../app/routes/api.v1.public.guest-token";
import { loader as embedLoader } from "../app/routes/embed.$agentId";

const environmentId = "11111111-1111-4111-8111-111111111111";

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

  it("requires an Environment UUID on public embed URLs", async () => {
    await expect(embedLoader({
      request: new Request("https://dashboard.example/embed/agent-1"),
      params: { agentId: "agent-1" },
      context: {},
    })).rejects.toMatchObject({ status: 404 });

    const response = await embedLoader({
      request: new Request(`https://dashboard.example/embed/agent-1?environmentId=${environmentId}`),
      params: { agentId: "agent-1" },
      context: {},
    });

    await expect(response.json()).resolves.toEqual({ agentId: "agent-1", environmentId });
  });

  it("forwards both Agent and Environment identity when minting a guest token", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ token: "guest-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const request = new Request("https://dashboard.example/api/v1/public/guest-token", {
      method: "POST",
      body: new URLSearchParams({ agentId: "agent-1", environmentId }),
    });

    const response = await guestTokenAction({ request, params: {}, context: {} });

    expect(fetch).toHaveBeenCalledWith(
      "http://agent.internal:3100/api/v1/public/guest-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ agentId: "agent-1", environmentId }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects malformed guest-token Environment identity before proxying", async () => {
    const request = new Request("https://dashboard.example/api/v1/public/guest-token", {
      method: "POST",
      body: new URLSearchParams({ agentId: "agent-1", environmentId: "dev" }),
    });

    const response = await guestTokenAction({ request, params: {}, context: {} });

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});
