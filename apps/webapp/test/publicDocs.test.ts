/**
 * Phase 3 — public docs API smoke tests.
 *
 * Targets the route loaders directly. The repository is the
 * `@internal/docs` shared instance, which on first access discovers
 * `content/docs/` + `content/guides/` by walking up from cwd. In CI the
 * test runner's cwd is `apps/webapp`; the resolver steps up to repo root
 * automatically.
 *
 * CLAUDE.md §9.11: testcontainers, never mock — we use real Redis (via
 * `redisTest`) for the rate-limit guard.
 */

import { redisTest } from "@internal/testcontainers";
import { describe, expect, beforeAll, beforeEach } from "vitest";
import * as path from "node:path";
import { resetSharedRepository } from "@internal/docs";

// Resolve repo root from this test file (`apps/webapp/test/...`) once so
// the repository singleton always sees the real content tree.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

beforeAll(() => {
  process.env.PLATOS_DOCS_CONTENT_ROOT = REPO_ROOT;
});

beforeEach(() => {
  // Tests share a process; flush the docs singleton so each test starts
  // from a known state. The rate-limit singleton is per-test-file via
  // dynamic import below.
  resetSharedRepository();
});

function setRedisEnv(opts: {
  host: string;
  port: number;
  password?: string;
  username?: string;
}) {
  process.env.RATE_LIMIT_REDIS_HOST = opts.host;
  process.env.RATE_LIMIT_REDIS_PORT = String(opts.port);
  if (opts.password) process.env.RATE_LIMIT_REDIS_PASSWORD = opts.password;
  else delete process.env.RATE_LIMIT_REDIS_PASSWORD;
  if (opts.username) process.env.RATE_LIMIT_REDIS_USERNAME = opts.username;
  else delete process.env.RATE_LIMIT_REDIS_USERNAME;
  process.env.RATE_LIMIT_REDIS_TLS_DISABLED = "true";
  process.env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED = "0";
}

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  const merged = { ...headers };
  if (!merged["x-forwarded-for"]) merged["x-forwarded-for"] = `127.0.0.1:${Math.random()}`;
  return new Request(url, { method: "GET", headers: merged });
}

describe.skipIf(process.env.GITHUB_ACTIONS)("public docs API", () => {
  redisTest("GET /api/v1/public/docs returns 47 items", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.docs._index");
    const res = await mod.loader({
      request: makeRequest("http://localhost/api/v1/public/docs"),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.kind).toBe("docs");
    expect(body.count).toBe(47);
    expect(Array.isArray(body.items)).toBe(true);
    // Every item has the public summary fields.
    for (const item of body.items) {
      expect(typeof item.slug).toBe("string");
      expect(typeof item.title).toBe("string");
      expect(typeof item.category).toBe("string");
      expect(Array.isArray(item.questions)).toBe(true);
    }
  });

  redisTest("GET /api/v1/public/docs/agents returns the agents doc with HTML", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.docs.$slug");
    const res = await mod.loader({
      request: makeRequest("http://localhost/api/v1/public/docs/agents"),
      params: { slug: "agents" },
      context: {},
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("agents");
    expect(body.frontmatter.title).toBe("Agents");
    expect(body.markdown.length).toBeGreaterThan(100);
    expect(body.html).toContain("<h1");
    expect(body.html).toContain("Agents");
  });

  redisTest("GET /api/v1/public/docs/does-not-exist returns 404", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.docs.$slug");
    const res = await mod.loader({
      request: makeRequest("http://localhost/api/v1/public/docs/does-not-exist"),
      params: { slug: "does-not-exist" },
      context: {},
    } as any);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });

  redisTest("GET /api/v1/public/guides returns 28 items", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.guides._index");
    const res = await mod.loader({
      request: makeRequest("http://localhost/api/v1/public/guides"),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("guides");
    expect(body.count).toBe(28);
  });

  redisTest("GET /api/v1/public/search ranks the agents doc top for a versioning query", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.search");
    const res = await mod.loader({
      request: makeRequest(
        "http://localhost/api/v1/public/search?q=" + encodeURIComponent("how do I version + roll back an agent"),
      ),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.results[0].slug).toBe("agents");
    expect(body.results[0].score).toBeGreaterThanOrEqual(0.85);
    expect(body.results[0].matchedQuestion).toBeTruthy();
  });

  redisTest("OPTIONS preflight returns 204 with CORS headers", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.docs._index");
    const res = await mod.loader({
      request: new Request("http://localhost/api/v1/public/docs", {
        method: "OPTIONS",
        headers: { Origin: "https://platos.dev" },
      }),
      params: {},
      context: {},
    } as any);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  redisTest("rate limit: 65th request from same IP gets 429", async ({ redisOptions }) => {
    setRedisEnv({
      host: redisOptions.host ?? "localhost",
      port: redisOptions.port ?? 6379,
      password: redisOptions.password,
      username: redisOptions.username,
    });
    const mod = await import("~/routes/api.v1.public.docs._index");
    const ip = "10.0.0.42";
    let last: Response | null = null;
    let firstRejectIdx = -1;
    for (let i = 0; i < 70; i += 1) {
      const res = await mod.loader({
        request: makeRequest("http://localhost/api/v1/public/docs", {
          "x-forwarded-for": ip,
        }),
        params: {},
        context: {},
      } as any);
      if (res.status === 429 && firstRejectIdx === -1) firstRejectIdx = i;
      last = res;
      // Drain body to free the response.
      try {
        await res.text();
      } catch {
        // ignored
      }
    }
    expect(firstRejectIdx).toBeGreaterThan(0);
    expect(firstRejectIdx).toBeLessThan(70);
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });
});
