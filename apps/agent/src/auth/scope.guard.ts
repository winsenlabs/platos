import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Inject, Optional } from "@nestjs/common";
import * as crypto from "node:crypto";
import { AuthService } from "./auth.service";
import { env } from "../shared/env";

/**
 * EOBD.40 — parse a W3C traceparent header into its trace-id +
 * parent-span-id components. Returns null if the header is missing or
 * malformed. We accept only version `00` (the only version defined
 * today); future versions are parsed but untrusted — we pass the
 * traceId through so the upstream parent still links, but skip the
 * parent-span-id because its format isn't guaranteed stable.
 *
 * Format:  `00-<32-char-hex-trace-id>-<16-char-hex-span-id>-<2-char-hex-flags>`
 */
function parseTraceparent(
  header: string | string[] | undefined,
): { traceId: string; parentSpanId: string } | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw || typeof raw !== "string") return null;
  const parts = raw.trim().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId] = parts;
  if (!version || !traceId || !spanId) return null;
  if (!/^[0-9a-f]{2}$/i.test(version)) return null;
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return null;
  if (!/^[0-9a-f]{16}$/i.test(spanId)) return null;
  // All-zero trace or span ids are explicitly reserved as "invalid" by
  // the W3C spec — reject so we don't pollute our trace graph.
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId: traceId.toLowerCase(), parentSpanId: spanId.toLowerCase() };
}

/**
 * Full four-axis scope. Every Platos-agent API call must resolve to one of these.
 *
 * - organizationId — trigger.dev Organization.id
 * - projectId      — trigger.dev Project.id
 * - environmentId  — trigger.dev RuntimeEnvironment.id (DEVELOPMENT|STAGING|PREVIEW|PRODUCTION)
 * - userId         — the acting user
 *
 * Optional hints:
 * - entityId       — the entity that minted this session token (Mode 2 only)
 * - userToken      — opaque per-user identity proof forwarded to tool calls
 */
export interface RequestScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  entityId?: string;
  userToken?: string;
  agentId?: string;
  sessionId?: string;
  /** OTel trace context — set by AgentTaskService for the current turn so
   * downstream services (tool executor, provider calls) can attach child
   * spans. Theme E.1. */
  traceId?: string;
  parentSpanId?: string;
  /**
   * Theme CTX.2 — per-turn session context + agent's context mapping.
   * Populated by AgentService.stream() after loading the thread row + agent
   * config so downstream services (tool-executor, WS dispatch) can read the
   * same data without re-querying. Both null/undefined → no context config.
   */
  sessionContext?: Record<string, unknown> | null;
  contextMapping?: {
    promptVars?: string[];
    toolArgInjection?: Record<string, Record<string, string>>;
    envelopeKeys?: string[];
    entityIdsKey?: string;
    // CTX.6 — declared session-context keys + fixed per-tool constants.
    declaredKeys?: string[];
    constants?: Record<string, Record<string, unknown>>;
  } | null;
  /** PRA-AC: stamped at runtime (not from auth token) when the executing agent is a cluster member. */
  clusteringId?: string | null;
  /**
   * LAUNCH-12 — the actual logged-in operator before any Postman override.
   * Set by the WS gateway when an org admin simulates a different `userId`
   * via `postmanUserId`. `userId` then becomes the simulated id; this field
   * preserves the real session user so downstream code (notably
   * `createThread`) can stamp the operator on the row + the conversations
   * list can show it back to them.
   */
  operatorUserId?: string;
}

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Optional() @Inject(AuthService) private readonly authService?: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Already scoped (WebSocket handshake sets this on connection)
    if (request.scope) return true;

    const url: string = request.url || "";

    // Allow health and test endpoints without auth
    if (url.startsWith("/api/health") || url.startsWith("/test/")) return true;

    // EOBD.41 — Prometheus scrape endpoint. Unauthenticated by design;
    // the operator fronts /metrics with a network-level ACL (Caddy,
    // firewall rule) rather than per-scope auth. Matches the pattern
    // used by the rate-limit guard which also exempts /metrics.
    if (url.startsWith("/metrics")) return true;

    // EOBD.95 — session-token mint endpoint. Authed by the entity's
    // serviceSecret in the Authorization header (Bearer scheme) — not
    // by a ScopeGuard auth mode. The controller verifies the secret
    // itself. Bypass ScopeGuard for this path.
    if (url.startsWith("/api/v1/entities/") && url.includes("/session-tokens")) return true;

    // EOBD.89 — public guest-token mint. Unauthenticated by design;
    // the controller gates access by agent.visibility + per-IP +
    // per-agent rate limits.
    if (url.startsWith("/api/v1/public/")) return true;

    // Theme K — Platform MCP. Authed by `Authorization: Bearer
    // <PLATOS_MCP_TOKEN>` on every request; token verification + scope
    // pin happens inside McpPlatformController. Token CRUD sub-routes
    // (tokens, tokens/:id/revoke) still run under the normal ScopeGuard
    // — they're admin actions dispatched by the webapp.
    if (
      url === "/mcp/platform" ||
      url === "/mcp/platform/sse" ||
      url.startsWith("/mcp/platform?") ||
      url === "/mcp/platform/messages" ||
      url.startsWith("/mcp/platform/messages?") ||
      url === "/mcp/platform/events/subscribe" ||
      url.startsWith("/mcp/platform/events/subscribe?")
    ) {
      return true;
    }

    // Phase 3 — public docs MCP. Read-only catalog of `content/{docs,guides}`
    // exposed as MCP resources + a `search_docs` tool. Intentionally
    // unauthenticated so the marketing site, the future "Talk to Platos"
    // agent on play.platos.dev, and any third-party MCP client can call
    // it without a token. Per-IP rate limit is enforced inside the
    // controller.
    //
    // The DocsMcpController is mounted at BOTH `/mcp/docs` (canonical) and
    // `/mcp` (the user-facing install URL — `claude mcp add platos
    // https://mcp.platos.dev/mcp`). Bypass scope auth for both forms +
    // their sub-routes (`/sse`, `/messages?sessionId=...`).
    if (url.startsWith("/mcp/docs")) return true;
    if (
      url === "/mcp" ||
      url.startsWith("/mcp?") ||
      url === "/mcp/sse" ||
      url.startsWith("/mcp/sse?") ||
      url === "/mcp/messages" ||
      url.startsWith("/mcp/messages?")
    ) {
      return true;
    }

    // PIFSP-21 — per-entity MCP Gateway. Self-auths via OAuth 2.1 bearer
    // tokens minted at `/oauth/entity/:entityId/*`. Routes validate the
    // token + pin to the entity inside McpEntityController.
    //
    // BUG-20 follow-up: the `/mcp/entity/*` prefix is shared by two route
    // groups — public MCP protocol endpoints (JSON-RPC, SSE, events) which
    // must bypass and self-auth via OAuth, AND management endpoints
    // (/config, /tokens, /enabled, /tool-acl, /branding, /identity) called
    // from the webapp WITH X-Platos-* scope headers. Only bypass the
    // protocol routes — management routes need the scope guard to populate
    // req.scope from the headers.
    if (url.startsWith("/mcp/entity/")) {
      const path = url.split("?")[0];
      const managementSuffixes = [
        "/tokens",
        "/tool-acl",
        "/config",
        "/branding",
        "/identity",
        "/enabled",
      ];
      const isManagement = managementSuffixes.some((suffix) => path.includes(suffix));
      if (!isManagement) return true;
      // management endpoint — fall through to normal scope extraction
    }

    // Theme K.10 — OAuth 2.1 endpoints. Public by design; each endpoint
    // does its own protocol-level auth (client credentials, PKCE,
    // bearer tokens, webapp-consent HMAC). RFC 8414 metadata under
    // `/.well-known/*` is also unauthenticated.
    //
    // PIFSP-21 — per-entity OAuth endpoints (`/oauth/entity/:entityId/*`)
    // and their metadata (`/.well-known/oauth-authorization-server/entity/*`)
    // fall through the same bypass — every route self-auths.
    if (url.startsWith("/oauth/") || url === "/oauth" || url.startsWith("/.well-known/")) {
      return true;
    }

    // Theme I.10 — OpenAPI spec + Swagger UI are intentionally public so
    // the docs site / agent-connect page can render without auth. The
    // spec is static (no scope-dependent data).
    if (url.startsWith("/api/v1/agent/openapi.json") || url === "/openapi" || url.startsWith("/openapi?")) return true;

    // PPR-25 — `/internal/execute-tool` is called by trigger.dev tasks
    // running inside the worker sandbox. It carries no per-scope context
    // of its own; the HMAC signature + scope-in-body + ToolExecutorService
    // registry lookup is the scope gate. ScopeGuard just lets the call
    // land on the controller, which verifies the HMAC before dispatching.
    if (url.startsWith("/internal/execute-tool")) return true;
    // W.1 — `/internal/batch-turn` follows the same pattern: HMAC-signed
    // callback from the `platos-agent-batch` trigger.dev task so it can
    // invoke AgentTaskService.executeNonStreamingTurn once per batch item.
    if (url.startsWith("/internal/batch-turn")) return true;

    // Admin endpoints authenticated by PLATOS_ADMIN_TOKEN header (e.g. the
    // LiteLLM cost-catalog ingest POSTed by the scheduled trigger.dev task).
    // The endpoint itself re-verifies the token — ScopeGuard just lets it
    // through because the caller has no per-scope context.
    if (url.startsWith("/api/v1/agent/monitoring/cost/catalog")) {
      const expected = env.PLATOS_ADMIN_TOKEN;
      const provided = request.headers["x-platos-admin-token"];
      // BUG-6: timing-safe comparison to prevent timing oracle attacks.
      if (expected && typeof provided === "string" && provided.length === expected.length) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return true;
        } catch { /* length mismatch handled above */ }
      }
    }
    // Theme M.5 / O.1 — scheduled memory-extraction sweep admin endpoint.
    // Cross-scope by design (scans every thread in the monorepo). The
    // controller re-verifies the token with a timing-safe compare.
    if (
      url.startsWith("/api/v1/memory/admin/extraction-sweep") ||
      url.startsWith("/api/v1/platos/memory/admin/extraction-sweep")
    ) {
      const expected = env.PLATOS_ADMIN_TOKEN;
      const provided = request.headers["x-platos-admin-token"];
      // BUG-6: timing-safe comparison to prevent timing oracle attacks.
      if (expected && typeof provided === "string" && provided.length === expected.length) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return true;
        } catch { /* length mismatch handled above */ }
      }
    }
    // LAUNCH-11 — durable compaction callback. Trigger.dev worker POSTs
    // here with the admin token; no per-scope session context. Without
    // this bypass, the global ScopeGuard rejects every callback as
    // unauthorized (LAUNCH-9 review finding 1). The controller re-verifies
    // the token with timing-safe compare and the body carries the scope
    // tuple for the actual compaction work.
    if (url.startsWith("/api/v1/agent/internal/compaction")) {
      const expected = env.PLATOS_ADMIN_TOKEN;
      const provided = request.headers["x-platos-admin-token"];
      if (expected && typeof provided === "string" && provided.length === expected.length) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return true;
        } catch { /* length mismatch handled above */ }
      }
    }

    // EOBD.40 — extract inbound traceparent once, reuse on both auth paths.
    // If present + well-formed, downstream services get the upstream
    // parent rather than starting a new trace. Span-id propagation lets
    // the webapp's request span be the parent of the agent's turn span.
    const traceCtx = parseTraceparent(request.headers["traceparent"]);

    // Path 1: Session token JWT (signed by entity's serviceSecret)
    const sessionToken = request.headers["x-platos-session-token"] as string | undefined;
    if (sessionToken && this.authService) {
      const payload = await this.authService.validateSessionToken(sessionToken);
      if (payload && payload.organizationId && payload.projectId && payload.environmentId) {
        // PIFSP-1 — if token carries agentId, enforce path match.
        const tokenAgentId = (payload as any).agentId as string | undefined;
        const pathAgentId = this.extractAgentIdFromPath(url);
        if (tokenAgentId && pathAgentId && tokenAgentId !== pathAgentId) {
          // Token is scoped to a different agent than the requested path.
          const resp = context.switchToHttp().getResponse();
          resp.status(403).json({
            error: "AGENT_SCOPE_MISMATCH",
            message: `Session token is scoped to agent ${tokenAgentId} but request targets agent ${pathAgentId}`,
          });
          return false;
        }
        request.scope = {
          organizationId: payload.organizationId,
          projectId: payload.projectId,
          environmentId: payload.environmentId,
          userId: payload.userId,
          entityId: payload.entityId,
          userToken: payload.userToken,
          ...(tokenAgentId ? { agentId: tokenAgentId } : {}),
          ...(traceCtx ? { traceId: traceCtx.traceId, parentSpanId: traceCtx.parentSpanId } : {}),
        } satisfies RequestScope;
        // Access key check (if configured for this scope)
        if (this.authService) {
          const providedKey = request.headers["x-platos-api-key"] as string | undefined;
          const origin = (request.headers["origin"] || request.headers["referer"]) as string | undefined;
          const scopeForCheck = {
            organizationId: request.scope.organizationId,
            projectId: request.scope.projectId,
            environmentId: request.scope.environmentId,
          };
          const keyResult = await this.authService.verifyAccessKey(scopeForCheck, providedKey, origin);
          if (keyResult === false) {
            const resp = context.switchToHttp().getResponse();
            resp.status(401).json({ error: "INVALID_ACCESS_KEY", message: "X-Platos-Api-Key is missing or invalid for this scope." });
            return false;
          }
        }
        return true;
      }
      // Invalid / incomplete — fall through to direct headers
    }

    // Path 2: Direct headers — trusted ONLY when the request did not arrive
    // through Caddy. Caddy stamps X-Forwarded-For on every proxied request,
    // so its presence is a reliable signal of external origin. Internal
    // webapp→agent traffic over the Docker network never passes through
    // Caddy and never has this header, so raw headers remain safe for that
    // service-to-service path.
    const viaProxy = !!request.headers["x-forwarded-for"];
    const organizationId = request.headers["x-platos-organization-id"];
    const projectId = request.headers["x-platos-project-id"];
    const environmentId = request.headers["x-platos-environment-id"];
    const userId = request.headers["x-platos-user-id"];
    const userToken = request.headers["x-platos-user-token"];
    const entityId = request.headers["x-platos-entity-id"];

    if (!viaProxy && organizationId && projectId && environmentId && userId) {
      request.scope = {
        organizationId: String(organizationId),
        projectId: String(projectId),
        environmentId: String(environmentId),
        userId: String(userId),
        ...(entityId ? { entityId: String(entityId) } : {}),
        ...(userToken ? { userToken: String(userToken) } : {}),
        // EOBD.40 — propagate inbound traceparent on the direct-header
        // path too (webapp → agent over the Docker network).
        ...(traceCtx ? { traceId: traceCtx.traceId, parentSpanId: traceCtx.parentSpanId } : {}),
      } satisfies RequestScope;
      // Access key check (if configured for this scope)
      if (this.authService) {
        const providedKey = request.headers["x-platos-api-key"] as string | undefined;
        const origin = (request.headers["origin"] || request.headers["referer"]) as string | undefined;
        const scopeForCheck = {
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          environmentId: request.scope.environmentId,
        };
        const keyResult = await this.authService.verifyAccessKey(scopeForCheck, providedKey, origin);
        if (keyResult === false) {
          const resp = context.switchToHttp().getResponse();
          resp.status(401).json({ error: "INVALID_ACCESS_KEY", message: "X-Platos-Api-Key is missing or invalid for this scope." });
          return false;
        }
      }
      return true;
    }

    throw new UnauthorizedException(
      viaProxy
        ? "External requests must use X-Platos-Session-Token (minted by your entity backend). Raw scope headers are rejected when the request arrives through the public proxy."
        : "Authentication required. Provide either X-Platos-Session-Token or all four headers: X-Platos-Organization-Id, X-Platos-Project-Id, X-Platos-Environment-Id, X-Platos-User-Id."
    );
  }

  /** PIFSP-1 — extract agentId from /api/v1/agent/agents/:agentId/* URLs. */
  private extractAgentIdFromPath(url: string): string | null {
    const match = /\/api\/v1\/agent\/agents\/([^/?]+)/.exec(url);
    return match?.[1] ?? null;
  }
}
