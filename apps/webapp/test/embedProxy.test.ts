import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: { PLATOS_AGENT_API_URL: "http://agent.internal:3100" },
}));

import {
  action,
  action as ratingAction,
  loader as ratingLoader,
} from "../app/routes/api.v1.public.agents.$agentId.chat.stream";
import { action as guestTokenAction } from "../app/routes/api.v1.public.guest-token";
import { loader as embedLoader } from "../app/routes/embed.$agentId";
import { serializePublicGuestSession } from "../app/services/publicGuestSession.server";

const environmentId = "11111111-1111-4111-8111-111111111111";

async function guestCookie() {
  return (await serializePublicGuestSession(
    "platform-session-token",
    "agent-1",
    environmentId,
    Math.floor(Date.now() / 1_000) + 1_800,
  )).split(";", 1)[0];
}

function publicStreamUrl(messageId?: string) {
  const url = new URL("https://dashboard.example/api/v1/public/agents/agent-1/chat/stream");
  url.searchParams.set("environmentId", environmentId);
  if (messageId) url.searchParams.set("messageId", messageId);
  return url.toString();
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("public embed streaming proxy", () => {
  it("keeps the browser on a same-origin URL and forwards only the HttpOnly guest session internally", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("event: token\ndata: hello\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const cookie = await guestCookie();
    const request = new Request(publicStreamUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: "https://dashboard.example",
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
      request: new Request(publicStreamUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://dashboard.example" },
        body: JSON.stringify({ message: "Hello" }),
      }),
      params: { agentId: "agent-1" },
      context: {},
    });

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a malformed Agent identity before contacting the agent", async () => {
    const response = await action({
      request: new Request(`https://dashboard.example/api/v1/public/agents/bad%20agent/chat/stream?environmentId=${environmentId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await guestCookie(),
          Origin: "https://dashboard.example",
        },
        body: JSON.stringify({ message: "Hello" }),
      }),
      params: { agentId: "bad agent" },
      context: {},
    });

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a stable stream failure without reflecting upstream token details", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("SENTINEL_UPSTREAM_SESSION_CREDENTIAL", { status: 503 }));
    const response = await action({
      request: new Request(publicStreamUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await guestCookie(),
          Origin: "https://dashboard.example",
        },
        body: JSON.stringify({ message: "Hello" }),
      }),
      params: { agentId: "agent-1" },
      context: {},
    });
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("Streaming failed");
    expect(serialized).not.toContain("SENTINEL_UPSTREAM_SESSION_CREDENTIAL");
    expect(serialized).not.toContain("platform-session-token");
  });

  it("returns a stable stream failure when transport is unavailable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("SENTINEL_TRANSPORT_DETAILS"));
    const response = await action({
      request: new Request(publicStreamUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: await guestCookie(),
          Origin: "https://dashboard.example",
        },
        body: JSON.stringify({ message: "Hello" }),
      }),
      params: { agentId: "agent-1" },
      context: {},
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Streaming failed" });
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

    await expect(response.json()).resolves.toEqual({
      agentId: "agent-1",
      environmentId,
      messageId: "",
      threadId: "",
    });
  });

  it("rejects a malformed embed Agent identity", async () => {
    await expect(embedLoader({
      request: new Request(`https://dashboard.example/embed/bad?environmentId=${environmentId}`),
      params: { agentId: "bad agent" },
      context: {},
    })).rejects.toMatchObject({ status: 404 });
  });

  it("forwards both Agent and Environment identity when minting a guest token", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      token: "guest-token",
      guestId: "guest-1",
      expiresAt: 1_800,
      agentId: "agent-1",
      environmentId,
      tokenHash: "SENTINEL_UNEXPECTED_TOKEN_HASH",
    }), {
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
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("guest-token");
    expect(serialized).not.toContain("guest-1");
    expect(serialized).not.toContain("SENTINEL_UNEXPECTED_TOKEN_HASH");
    expect(response.headers.get("Set-Cookie")).toContain("__Secure-platos_public_guest_");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).toContain("Secure");
    expect(response.headers.get("Set-Cookie")).toContain("SameSite=None");
    expect(response.headers.get("Set-Cookie")).toContain("Partitioned");
  });

  it("forwards only bounded guest rating GET, POST, and DELETE operations through the HttpOnly session cookie", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ userRating: null, aggregate: { ups: 0, downs: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rating: { messageId: "message-1", rating: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ removed: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const cookie = await guestCookie();
    const params = { agentId: "agent-1" };

    const getResponse = await ratingLoader({
      request: new Request(publicStreamUrl("message-1"), {
        headers: { Cookie: cookie },
      }),
      params,
      context: {},
    });
    const postResponse = await ratingAction({
      request: new Request(publicStreamUrl("message-1"), {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://dashboard.example" },
        body: JSON.stringify({ rating: 1 }),
      }),
      params,
      context: {},
    });
    const deleteResponse = await ratingAction({
      request: new Request(publicStreamUrl("message-1"), {
        method: "DELETE",
        headers: { Cookie: cookie, "Content-Type": "application/json", Origin: "https://dashboard.example" },
      }),
      params,
      context: {},
    });

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(fetch).toHaveBeenNthCalledWith(1,
      "http://agent.internal:3100/api/v1/agent/messages/message-1/rating",
      expect.objectContaining({
        method: "GET",
        headers: { "X-Platos-Session-Token": "platform-session-token" },
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      "http://agent.internal:3100/api/v1/agent/messages/message-1/rating",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Platos-Session-Token": "platform-session-token",
        },
        body: JSON.stringify({ rating: 1 }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(3,
      "http://agent.internal:3100/api/v1/agent/messages/message-1/rating",
      expect.objectContaining({
        method: "DELETE",
        headers: { "X-Platos-Session-Token": "platform-session-token" },
      }),
    );
  });

  it("rejects missing guest rating sessions and malformed rating payloads before proxying", async () => {
    const params = { agentId: "agent-1" };
    const missing = await ratingLoader({
      request: new Request(publicStreamUrl("message-1")),
      params,
      context: {},
    });
    const cookie = await guestCookie();
    const malformed = await ratingAction({
      request: new Request(publicStreamUrl("message-1"), {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://dashboard.example",
        },
        body: JSON.stringify({ rating: 0 }),
      }),
      params,
      context: {},
    });

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and non-JSON cookie-authenticated mutations", async () => {
    const cookie = await guestCookie();
    const crossOrigin = await ratingAction({
      request: new Request(publicStreamUrl("message-1"), {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({ rating: 1 }),
      }),
      params: { agentId: "agent-1" },
      context: {},
    });
    const nonJson = await action({
      request: new Request(publicStreamUrl(), {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "text/plain",
          Origin: "https://dashboard.example",
        },
        body: JSON.stringify({ message: "Hello" }),
      }),
      params: { agentId: "agent-1" },
      context: {},
    });

    expect(crossOrigin.status).toBe(403);
    expect(nonJson.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
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

  it("returns a stable guest-token failure without reflecting upstream details", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      error: "SENTINEL_UPSTREAM_GUEST_CREDENTIAL",
      tokenHash: "SENTINEL_TOKEN_HASH",
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    const request = new Request("https://dashboard.example/api/v1/public/guest-token", {
      method: "POST",
      body: new URLSearchParams({ agentId: "agent-1", environmentId }),
    });

    const response = await guestTokenAction({ request, params: {}, context: {} });
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("Guest session unavailable");
    expect(serialized).not.toContain("SENTINEL_UPSTREAM_GUEST_CREDENTIAL");
    expect(serialized).not.toContain("SENTINEL_TOKEN_HASH");
  });

  it("returns a stable guest-token failure when transport is unavailable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("SENTINEL_TRANSPORT_DETAILS"));
    const request = new Request("https://dashboard.example/api/v1/public/guest-token", {
      method: "POST",
      body: new URLSearchParams({ agentId: "agent-1", environmentId }),
    });

    const response = await guestTokenAction({ request, params: {}, context: {} });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Guest session unavailable" });
  });
});
