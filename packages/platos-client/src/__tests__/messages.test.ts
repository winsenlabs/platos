/**
 * Unit tests for `client.messages` (thumbs up/down SDK rating).
 *
 * Mocks `globalThis.fetch` — we lock down the URL paths, request bodies
 * (rating direction → ±1 mapping), and response unwrapping the SDK ships,
 * not the live agent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatosClient } from "../client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("client.messages", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: PlatosClient;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    client = new PlatosClient({
      baseUrl: "https://play.platos.dev",
      sessionToken: "test-token",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rate('up') — POSTs rating=1 to the message rating endpoint", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ rating: { id: "r1", messageId: "msg_1", rating: 1, comment: null } }),
    );
    const row = await client.messages.rate("msg_1", "up");
    expect(row.rating).toBe(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://play.platos.dev/api/v1/agent/messages/msg_1/rating");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ rating: 1 });
  });

  it("rate('down', { comment }) — POSTs rating=-1 with comment", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ rating: { id: "r2", messageId: "msg_2", rating: -1, comment: "wrong" } }),
    );
    await client.messages.rate("msg_2", "down", { comment: "wrong" });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ rating: -1, comment: "wrong" });
  });

  it("rate() — throws when the server returns an error shape", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ error: "rating must be 1 or -1" }));
    await expect(client.messages.rate("msg_3", "up")).rejects.toThrow(/rating must be/);
  });

  it("unrate() — DELETEs and returns removed flag", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ removed: true }));
    const removed = await client.messages.unrate("msg_4");
    expect(removed).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://play.platos.dev/api/v1/agent/messages/msg_4/rating");
    expect(init.method).toBe("DELETE");
  });

  it("getForMessage() — GETs the user vote + aggregate", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ userRating: { rating: 1 }, aggregate: { ups: 3, downs: 1 } }),
    );
    const state = await client.messages.getForMessage("msg_5");
    expect(state?.aggregate).toEqual({ ups: 3, downs: 1 });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://play.platos.dev/api/v1/agent/messages/msg_5/rating");
    expect(init.method).toBe("GET");
  });

  it("rate() — URL-encodes the messageId", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ rating: { rating: 1 } }));
    await client.messages.rate("msg/with space", "up");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://play.platos.dev/api/v1/agent/messages/msg%2Fwith%20space/rating",
    );
  });
});
