/**
 * Phase 3b — host-router middleware tests.
 *
 * Pure unit coverage: simulates Express req/res objects and asserts the
 * middleware's branching. No Nest test bed needed — this middleware is
 * deliberately stateless.
 */

import { describe, expect, it, vi } from "vitest";
import {
  HostRouterMiddleware,
  isAllowedPublicMcpPath,
  isPublicMcpHost,
} from "./host-router.middleware";

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status: (code: number) => MockRes;
  json: (body: unknown) => MockRes;
  setHeader: (k: string, v: string) => void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
  return res;
}

function makeReq(host: string, url: string): { headers: Record<string, string>; url: string; publicMcpOnly?: boolean } {
  return { headers: { host }, url };
}

describe("isPublicMcpHost", () => {
  it("matches mcp.platos.dev exactly", () => {
    expect(isPublicMcpHost("mcp.platos.dev")).toBe(true);
  });
  it("matches mcp.platos.dev with port", () => {
    expect(isPublicMcpHost("mcp.platos.dev:443")).toBe(true);
  });
  it("matches a leaf subdomain of mcp.platos.dev", () => {
    expect(isPublicMcpHost("v2.mcp.platos.dev")).toBe(true);
  });
  it("matches mcp-test.platos.dev", () => {
    expect(isPublicMcpHost("mcp-test.platos.dev")).toBe(true);
  });
  it("matches mcp.localhost", () => {
    expect(isPublicMcpHost("mcp.localhost")).toBe(true);
  });
  it("does NOT match the full agent surface hosts", () => {
    expect(isPublicMcpHost("test.platos.dev")).toBe(false);
    expect(isPublicMcpHost("play.platos.dev")).toBe(false);
    expect(isPublicMcpHost("platos.dev")).toBe(false);
    expect(isPublicMcpHost("localhost")).toBe(false);
    expect(isPublicMcpHost("127.0.0.1")).toBe(false);
    expect(isPublicMcpHost("187.127.142.170")).toBe(false);
  });
  it("ignores case", () => {
    expect(isPublicMcpHost("MCP.Platos.Dev")).toBe(true);
  });
  it("rejects empty / undefined hosts", () => {
    expect(isPublicMcpHost(undefined)).toBe(false);
    expect(isPublicMcpHost("")).toBe(false);
  });
  it("does not match a host that merely contains the suffix as a substring", () => {
    // `evilmcp.platos.dev` would match the suffix check naively — we
    // require the dot boundary to prevent prefix-spoofing.
    expect(isPublicMcpHost("evilmcp.platos.dev")).toBe(false);
  });
});

describe("isAllowedPublicMcpPath", () => {
  it.each([
    "/mcp/docs",
    "/mcp/docs/",
    "/mcp/docs/sse",
    "/mcp/docs/messages?sessionId=abc",
    "/api/health",
    "/api/health/ready",
  ])("allows %s", (url) => {
    expect(isAllowedPublicMcpPath(url)).toBe(true);
  });
  it.each([
    "/mcp/platform",
    "/mcp/entity/abc",
    "/oauth/token",
    "/api/v1/agent/agents",
    "/.well-known/oauth-authorization-server",
    "/",
    "/metrics",
  ])("rejects %s", (url) => {
    expect(isAllowedPublicMcpPath(url)).toBe(false);
  });
});

describe("HostRouterMiddleware.use", () => {
  const mw = new HostRouterMiddleware();

  it("calls next() unchanged when host is the full agent surface", () => {
    const req = makeReq("test.platos.dev", "/mcp/platform");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.publicMcpOnly).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });

  it("calls next() on the public host when path is allow-listed", () => {
    const req = makeReq("mcp.platos.dev", "/mcp/docs");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.publicMcpOnly).toBe(true);
  });

  it("calls next() on the public host for /mcp/docs/sse", () => {
    const req = makeReq("mcp.platos.dev", "/mcp/docs/sse");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.publicMcpOnly).toBe(true);
  });

  it("blocks scoped MCP on the public host with 403 (not 401)", () => {
    const req = makeReq("mcp.platos.dev", "/mcp/platform");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect((res.body as { error?: string }).error).toBe("FORBIDDEN_ON_PUBLIC_MCP_HOST");
  });

  it("blocks the per-entity MCP on the public host with 403", () => {
    const req = makeReq("mcp.platos.dev", "/mcp/entity/abc/tools");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("blocks OAuth endpoints on the public host", () => {
    const req = makeReq("mcp.platos.dev", "/oauth/token");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("blocks the dashboard / on the public host", () => {
    const req = makeReq("mcp.platos.dev", "/");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("attaches CORS + no-store headers on the 403", () => {
    const req = makeReq("mcp.platos.dev", "/mcp/platform");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("treats /api/health on the public host as allowed (uptime probes)", () => {
    const req = makeReq("mcp.platos.dev", "/api/health");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.publicMcpOnly).toBe(true);
  });

  it("on the full surface, does NOT set publicMcpOnly", () => {
    const req = makeReq("test.platos.dev", "/mcp/docs");
    const res = makeRes();
    const next = vi.fn();
    mw.use(req as any, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.publicMcpOnly).toBeUndefined();
  });
});
