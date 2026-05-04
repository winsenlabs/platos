/**
 * Phase 3b — Host-aware MCP routing.
 *
 * Two public surfaces share the same agent process:
 *
 *   - `mcp.platos.dev`  — UNAUTHENTICATED, public docs MCP only.
 *                         Anything that would require a scope (platform tier,
 *                         per-entity gateway, OAuth flows) MUST NOT be
 *                         reachable from this hostname. Reject with 403 so
 *                         clients do not try to follow OAuth — this surface
 *                         is intentionally read-only.
 *
 *   - `play.platos.dev` / `test.platos.dev` / direct IP / localhost — full
 *                         agent surface. The docs MCP is still reachable here
 *                         (handy for the in-product "Talk to Platos" agent),
 *                         but scoped tools, tokens, OAuth, etc. all work too.
 *
 * Implementation: a Nest middleware that inspects `req.headers.host`. If the
 * host matches one of the public-only suffixes, set `req.publicMcpOnly = true`
 * and short-circuit any request whose path is not under `/mcp/docs`. The
 * ScopeGuard skips its normal auth checks for `/mcp/docs*` regardless of host,
 * so this only adds a hard wall around the rest of the surface.
 *
 * Local dev / direct IP / unknown hosts behave like the full surface (no
 * `publicMcpOnly` flag) — developers can hit any endpoint without DNS.
 */

import { Injectable, NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";

/**
 * Host suffixes that should expose ONLY the public docs MCP.
 *
 * Suffix-match (not equality) so future leaf subdomains under the public-MCP
 * hostname don't fall through. We never include `platos.dev` itself — that
 * hostname is the marketing site (Vercel) and never points at this agent.
 */
const PUBLIC_MCP_HOST_SUFFIXES = [
  "mcp.platos.dev",
  "mcp-test.platos.dev",
  "mcp.localhost",
];

/**
 * Path prefixes that ARE publicly callable on the public-MCP hostname.
 * Everything else under `/mcp` (or anywhere else for that matter) gets a 403.
 *
 * `/mcp` and `/mcp/docs` are equivalent — the DocsMcpController is mounted
 * at both prefixes (see `apps/agent/src/mcp-docs/docs-mcp.controller.ts`).
 * `/mcp` is the user-facing install URL we publish; `/mcp/docs` is the
 * canonical internal path. Allow-list both so neither hits the 403 fallback.
 *
 * `/api/health` is allowed so uptime monitors and Caddy health probes work.
 */
const PUBLIC_MCP_ALLOWED_PATH_PREFIXES = [
  "/mcp/docs",
  "/mcp",
  "/api/health",
];

/**
 * Strip the optional port suffix and lowercase the host header for a stable
 * comparison. Caddy passes `Host: mcp.platos.dev` (no port) but tests / curl
 * may include the port.
 */
function normalizeHost(rawHost: string | undefined): string {
  if (!rawHost) return "";
  const trimmed = rawHost.trim().toLowerCase();
  // Strip port if present. IPv6 hosts arrive as `[::1]:3100` — leave the
  // brackets as-is, just drop the trailing port.
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close >= 0) return trimmed.slice(0, close + 1);
    return trimmed;
  }
  const colonIdx = trimmed.indexOf(":");
  return colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

/** Pure helper, exported for tests. */
export function isPublicMcpHost(host: string | undefined): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return PUBLIC_MCP_HOST_SUFFIXES.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

/** Pure helper, exported for tests. */
export function isAllowedPublicMcpPath(url: string): boolean {
  // strip query string for matching
  const path = url.split("?")[0] ?? "";
  return PUBLIC_MCP_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * On the public-MCP hostname, rewrite ergonomic top-level paths down to the
 * actual docs-MCP route. This lets the install URL be the clean
 * `https://mcp.platos.dev/mcp` instead of `https://mcp.platos.dev/mcp/docs`,
 * while keeping the agent's internal route layout unchanged.
 *
 * Idempotent — paths that already begin with `/mcp/docs` are returned as-is.
 */
export function rewritePublicMcpPath(path: string): string {
  // `/mcp/docs` (and `/mcp/docs/...`) — already canonical.
  if (path === "/mcp/docs" || path.startsWith("/mcp/docs/") || path.startsWith("/mcp/docs?")) {
    return path;
  }
  // `/mcp` exact — bare install URL. Rewrite to `/mcp/docs`.
  if (path === "/mcp") return "/mcp/docs";
  // `/mcp?...` — query-string-only suffix. Preserve query.
  if (path.startsWith("/mcp?")) return "/mcp/docs" + path.slice(4);
  // `/mcp/...` — anything else under `/mcp`. The likely cases are the SSE
  // transport (`/mcp/sse`, `/mcp/messages?sessionId=...`) and the
  // capabilities probe via GET. Rewrite to `/mcp/docs/...`.
  if (path.startsWith("/mcp/")) return "/mcp/docs/" + path.slice(5);
  return path;
}

@Injectable()
export class HostRouterMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const hostHeader = (req.headers["host"] as string | undefined) ?? "";
    if (!isPublicMcpHost(hostHeader)) {
      // Full agent surface — let everything through.
      next();
      return;
    }

    // Mark the request so downstream code (ScopeGuard, controllers) knows we
    // are on the public-only surface. Right now the gate below already
    // rejects everything that isn't /mcp/docs, but the flag is cheap and
    // useful belt-and-braces for any future controller that wants to behave
    // differently on the two hostnames.
    (req as Request & { publicMcpOnly?: boolean }).publicMcpOnly = true;

    // IMPORTANT: read `req.originalUrl`, not `req.url`. Nest's middleware
    // pipeline runs through Express's app.use chain, but by the time a
    // forRoutes('*') middleware fires, Express may have already mutated
    // `req.url` to be relative to the matched router (observed live:
    // `req.url === "/"` when the actual ingress path was `/mcp/docs`).
    // `req.originalUrl` always holds the full pre-routing path.
    const rawUrl: string = req.originalUrl || req.url || "";
    const queryIdx = rawUrl.indexOf("?");
    const rawPath = queryIdx >= 0 ? rawUrl.slice(0, queryIdx) : rawUrl;

    // The DocsMcpController is mounted at BOTH `/mcp` and `/mcp/docs`
    // (NestJS @Controller(["mcp/docs", "mcp"])), so no URL rewriting is
    // needed — Express's router matches both prefixes natively. We just
    // gate the host: if the request is on the public-MCP hostname, the
    // path must be in the allow list (currently /mcp, /mcp/docs,
    // /api/health). Anything else (including scoped /mcp/platform,
    // /mcp/entity/*, /api/v1/agent/*) gets a 403.
    if (isAllowedPublicMcpPath(rawPath)) {
      next();
      return;
    }

    // 403 Forbidden — NOT 401. We do not want clients on `mcp.platos.dev`
    // to follow an OAuth challenge; this hostname is "public surface,
    // period." A 401 with WWW-Authenticate would invite the MCP client to
    // try DCR + token exchange, which would then fail again — bad UX.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.status(403).json({
      error: "FORBIDDEN_ON_PUBLIC_MCP_HOST",
      message:
        "This hostname only exposes the public Platos docs MCP. " +
        "Use https://test.platos.dev or your self-hosted Platos for scoped tools.",
      allowed: ["/mcp", "/mcp/sse", "/mcp/messages"],
    });
  }
}
