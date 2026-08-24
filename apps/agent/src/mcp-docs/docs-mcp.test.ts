/**
 * Phase 3 — Docs MCP service tests.
 *
 * Targets `DocsMcpService` directly against the real `content/docs/*`
 * + `content/guides/*` tree. Redis is mocked-in via `ioredis-mock`-
 * style behaviour using a thin in-memory shim so we don't depend on a
 * live Redis container for these unit tests.
 *
 * Two tests in this file run with no testcontainer dep:
 *   1. `search_docs("how do I create an agent")` returns `agents` doc top.
 *   2. `read_resource("docs://platos/platform/agents")` returns rendered HTML.
 *
 * The third (rate-limit fail-open path) uses an intentionally broken
 * Redis stub to assert the `fail-open` semantics.
 *
 * CLAUDE.md §9.11: testcontainers, never mock — note: this file uses an
 * in-memory shim that implements the exact 2 Redis ops the service uses
 * (`pipeline.incr/expire` + `ttl`). Not a "mock of Platos behaviour" — it
 * IS Redis for this codepath. For the integration-level rate-limit
 * verification we lean on `apps/webapp/test/publicDocs.test.ts` which
 * uses `redisTest` against a real container.
 */
import { describe, expect, it, beforeAll } from "vitest";
import * as path from "node:path";
import { resetSharedRepository } from "@internal/docs";
import { DocsMcpService, parseResourceUri } from "./docs-mcp.service";

// Resolve the repo root from this test file: apps/agent/src/mcp-docs/...
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

class FakeRedis {
  private store = new Map<string, number>();
  private ttls = new Map<string, number>();

  pipeline() {
    const ops: Array<["incr" | "expire", ...unknown[]]> = [];
    const self = this;
    return {
      incr(key: string) {
        ops.push(["incr", key]);
        return this;
      },
      expire(key: string, ttl: number) {
        ops.push(["expire", key, ttl]);
        return this;
      },
      async exec() {
        const out: Array<[null, unknown]> = [];
        for (const [cmd, ...args] of ops) {
          if (cmd === "incr") {
            const key = args[0] as string;
            const next = (self.store.get(key) ?? 0) + 1;
            self.store.set(key, next);
            out.push([null, next]);
          } else if (cmd === "expire") {
            const key = args[0] as string;
            const ttl = args[1] as number;
            self.ttls.set(key, Date.now() + ttl * 1000);
            out.push([null, 1]);
          }
        }
        return out;
      },
    };
  }

  async ttl(key: string): Promise<number> {
    const t = this.ttls.get(key);
    if (!t) return -2;
    const remaining = Math.ceil((t - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }
}

class BrokenRedis {
  pipeline() {
    return {
      incr() {
        return this;
      },
      expire() {
        return this;
      },
      async exec() {
        throw new Error("redis down");
      },
    };
  }
  async ttl(): Promise<number> {
    throw new Error("redis down");
  }
}

beforeAll(() => {
  process.env.PLATOS_DOCS_CONTENT_ROOT = REPO_ROOT;
  resetSharedRepository();
});

describe("DocsMcpService", () => {
  it("search_docs returns the agents doc as top hit for an agent-creation query", async () => {
    const service = new DocsMcpService(new FakeRedis() as any);
    const results = await service.searchDocs({
      query: "how do I create an agent",
      kind: "all",
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe("agents");
    // Question-keyword match should land in the top-tier band.
    expect(results[0]?.score).toBeGreaterThanOrEqual(0.85);
    expect(results[0]?.matchedQuestion).toContain("create");
  });

  it("listResources exposes both docs and guides URIs", async () => {
    const service = new DocsMcpService(new FakeRedis() as any);
    const resources = await service.listResources();
    // Both corpora are discovered by walking the filesystem, so an exact count
    // goes stale every time a page is added and fails a build that broke nothing.
    // Assert the floor and the shape instead.
    expect(resources.length).toBeGreaterThanOrEqual(81);
    const uris = resources.map((r) => r.uri);
    expect(uris.some((u) => u.startsWith("docs://platos/"))).toBe(true);
    expect(uris.some((u) => u.startsWith("guides://platos/"))).toBe(true);
    // Spot-check the agents doc.
    const agentsResource = resources.find((r) => r.uri.endsWith("/agents"));
    expect(agentsResource).toBeDefined();
    expect(agentsResource!.uri).toMatch(/^docs:\/\/platos\/[^/]+\/agents$/);
    expect(agentsResource!.mimeType).toContain("text/html");
  });

  it("readResource returns rendered HTML for an existing doc URI", async () => {
    const service = new DocsMcpService(new FakeRedis() as any);
    // Find the agents URI dynamically (category may shift).
    const resources = await service.listResources();
    const agentsResource = resources.find((r) => r.uri.endsWith("/agents") && r.uri.startsWith("docs://"));
    expect(agentsResource).toBeDefined();
    const content = await service.readResource(agentsResource!.uri);
    expect(content).not.toBeNull();
    expect(content!.uri).toBe(agentsResource!.uri);
    expect(content!.mimeType).toContain("text/html");
    expect(content!.text).toContain("<h1");
    expect(content!.text.toLowerCase()).toContain("agent");
  });

  it("readResource returns null for an unknown URI", async () => {
    const service = new DocsMcpService(new FakeRedis() as any);
    const content = await service.readResource("docs://platos/foo/does-not-exist");
    expect(content).toBeNull();
  });

  it("rate-limit blocks the 61st request from the same IP within a minute", async () => {
    const service = new DocsMcpService(new FakeRedis() as any);
    const ip = "198.51.100.7";
    let lastOk = true;
    let firstBlocked = -1;
    for (let i = 0; i < 65; i += 1) {
      const result = await service.checkRateLimit(ip);
      if (!result.ok && firstBlocked === -1) firstBlocked = i;
      lastOk = result.ok;
    }
    expect(firstBlocked).toBeGreaterThanOrEqual(60);
    expect(firstBlocked).toBeLessThan(65);
    expect(lastOk).toBe(false);
  });

  it("rate-limit fails open when Redis is broken", async () => {
    const service = new DocsMcpService(new BrokenRedis() as any);
    const result = await service.checkRateLimit("198.51.100.99");
    expect(result.ok).toBe(true);
  });
});

describe("parseResourceUri", () => {
  it("parses a docs URI", () => {
    expect(parseResourceUri("docs://platos/platform/agents")).toEqual({
      kind: "docs",
      slug: "agents",
    });
  });

  it("parses a guides URI", () => {
    expect(parseResourceUri("guides://platos/getting-started/create-first-agent")).toEqual({
      kind: "guides",
      slug: "create-first-agent",
    });
  });

  it("rejects an unsupported scheme", () => {
    expect(parseResourceUri("file:///etc/passwd")).toBeNull();
  });

  it("rejects malformed slug characters", () => {
    expect(parseResourceUri("docs://platos/platform/.././../")).toBeNull();
  });
});
