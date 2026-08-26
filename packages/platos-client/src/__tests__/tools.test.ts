/**
 * Unit tests for `client.tools` (issue #2).
 *
 * We mock `globalThis.fetch` rather than instantiating a live agent —
 * the goal is to lock down the URL paths, query-string encoding, and
 * request bodies the SDK ships, not to exercise the server.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlatosClient } from "../client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("client.tools", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let client: PlatosClient;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    client = new PlatosClient({
      baseUrl: "https://platos.example.com",
      sessionToken: "test-token",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("list() — no filter", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ tools: [{ toolId: "t1", toolName: "echo" }] }));
    const tools = await client.tools.list();
    expect(tools).toHaveLength(1);
    expect(tools[0].toolName).toBe("echo");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://platos.example.com/api/v1/agent/tools");
    expect(init.method).toBe("GET");
  });

  it("list({ category }) — passes category in query string", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ tools: [] }));
    await client.tools.list({ category: "communication" });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://platos.example.com/api/v1/agent/tools?category=communication",
    );
  });

  it("search() — builds query string with q, limit, entity", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ tools: [] }));
    await client.tools.search("refund", { limit: 5, entity: "fandesk" });
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/api/v1/agent/tools/search");
    expect(url).toContain("q=refund");
    expect(url).toContain("limit=5");
    expect(url).toContain("entity=fandesk");
  });

  it("matrix() — returns rows array", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        tools: [
          {
            toolId: "t1",
            toolName: "echo",
            description: "",
            category: "debug",
            paramSchema: {},
            entityId: "e1",
            health: { totalCalls: 5, failCount: 0, p95LatencyMs: 42, lastCalledAt: "2026-05-19T00:00:00Z" },
          },
        ],
      }),
    );
    const rows = await client.tools.matrix();
    expect(rows).toHaveLength(1);
    expect(rows[0].health?.totalCalls).toBe(5);
  });

  it("setEnabled() — PATCH with correct path + body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: false }));
    const out = await client.tools.setEnabled("fandesk", "process_refund", false);
    expect(out.enabled).toBe(false);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://platos.example.com/api/v1/agent/tools/fandesk/process_refund/enabled",
    );
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false });
  });

  it("setEnabled() — URL-encodes entity + tool", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ enabled: true }));
    await client.tools.setEnabled("ent/with slash", "tool name", true);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/ent%2Fwith%20slash/tool%20name/enabled");
  });

  it("test() — POST with params body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ status: "ok", elapsedMs: 12 }));
    const result = await client.tools.test("t1", { message: "hi" });
    expect(result.status).toBe("ok");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://platos.example.com/api/v1/agent/tools/t1/test");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ params: { message: "hi" } });
  });
});
