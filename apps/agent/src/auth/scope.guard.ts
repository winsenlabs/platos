import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, Inject, Optional } from "@nestjs/common";
import * as crypto from "node:crypto";
import { AuthService } from "./auth.service";
import { env } from "../shared/env";

/**
 * SECURITY (2026-07-16 audit — OWASP API5 BFLA, deny-by-default function-level
 * authz). Throw 403 unless the caller is an operator (the webapp control-plane
 * or a platform-signed token). Fails CLOSED: an undefined/end-user principal is
 * rejected. Call at the TOP of any handler that exposes cross-user data,
 * secrets, budgets, files, entity management, or monitoring — surfaces that an
 * entity-minted widget/SDK/guest token must never reach.
 */
export function requireOperator(scope: Pick<RequestScope, "principal">): void {
  if (scope?.principal !== "operator") {
    throw new ForbiddenException({
      error: "OPERATOR_ONLY",
      message:
        "This endpoint requires an operator (control-plane) credential. End-user / entity / guest tokens are not permitted.",
    });
  }
}

/** Public MCP protocol transports self-authenticate in their controllers.
 * Keep this matcher method-aware and exact because the same route prefixes
 * also contain operator-only management endpoints. */
export function isPublicMcpTransport(methodValue: unknown, urlValue: unknown): boolean {
  const method = typeof methodValue === "string" ? methodValue.toUpperCase() : "";
  const url = typeof urlValue === "string" ? urlValue : "";
  const pathname = url.split("?", 1)[0];
  if (
    (method === "POST" && pathname === "/mcp/platform") ||
    (method === "GET" && pathname === "/mcp/platform/sse") ||
    (method === "POST" && pathname === "/mcp/platform/messages") ||
    (method === "GET" && pathname === "/mcp/platform/events/subscribe")
  ) {
    return true;
  }
  const entityProtocol = pathname.match(
    /^\/mcp\/entity\/[^/]+(?:\/(sse|messages|events\/subscribe))?$/,
  );
  if (!entityProtocol) return false;
  const suffix = entityProtocol[1];
  return (
    (!suffix && method === "POST") ||
    (suffix === "sse" && method === "GET") ||
    (suffix === "messages" && method === "POST") ||
    (suffix === "events/subscribe" && method === "GET")
  );
}

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
  /**
   * Channel-native identity claims from a validated NON-GUEST session token
   * (copied verbatim from `SessionPayload.userIdentities`). Lets
   * ConversationService.resolveEndUser link this turn to a canonical
   * PlatosEndUser across channels (link-not-merge). NEVER populated from a
   * guest token, and NEVER from the direct-header path.
   */
  userIdentities?: Array<{ channel: string; handle: string; verified?: boolean }>;
  agentId?: string;
  sessionId?: string;
  /**
   * SECURITY (2026-07-16 audit C1/H1) — trust tier of the caller.
   *   "operator"  — the webapp/control-plane: a platform-signed session token
   *                 without an entity bearer authorization (and not a guest),
   *                 OR the trusted internal
   *                 direct-header path (webapp→agent over the Docker network,
   *                 never through Caddy).
   *   "end-user"  — a platform-signed token bound to an active entity
   *                 McpBearerToken, or an anonymous public guest. MUST NOT reach operator surfaces
   *                 (other users' data, secrets, budgets, monitoring).
   * `requireOperator(scope)` enforces this. Undefined is treated as end-user
   * (fail closed).
   */
  principal?: "operator" | "end-user";
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
   * Subagent-spawning depth of the CURRENT turn. Root turns are 0/undefined; a
   * turn spawned by `spawn_agent` runs at depth ≥ 1. Runtime-stamped ONLY — set
   * by the `/internal/subagent-turn` callback from the HMAC-verified payload,
   * NEVER from a client token. `buildMetaTools` reads it to enforce the depth
   * cap (a depth-2 grandchild may not spawn). See docs/subagent-spawning-spec.md.
   */
  spawnDepth?: number;
  /**
   * IDENTITY-CORE §B.3 (G3) — server-stamped, pre-resolved end-user EXTERNAL id
   * ({{endUserId}}). Runtime-stamped ONLY (like `spawnDepth`) — set by
   * `/internal/batch-turn` from the HMAC-verified payload, NEVER from a client
   * token. When present (`!== undefined`), `resolveOriginEndUserId`
   * short-circuits and returns it verbatim — the parent already resolved +
   * §C-gated this value, INCLUDING a deliberate `null` (gated closed). The
   * explicit `null` is a signal, not an absence: it must be preserved across
   * every hop and stamped UNCONDITIONALLY, or a gated-closed batch item would
   * fall through to the fresh-per-item thread path and silently resolve a live
   * walleId (fail-OPEN hazard G3). `undefined` = not a batch item; run the
   * normal thread-based resolution.
   */
  resolvedEndUserId?: string | null;
  /**
   * LAUNCH-12 — the actual logged-in operator before any Postman override.
   * Set by the WS gateway when an org admin simulates a different `userId`
   * via `postmanUserId`. `userId` then becomes the simulated id; this field
   * preserves the real session user so downstream code (notably
   * `createThread`) can stamp the operator on the row + the conversations
   * list can show it back to them.
   */
  operatorUserId?: string;
  /** Opaque Redis-bound handle for one Postman turn's untrusted context. */
  sessionContextHandle?: string;
  /**
   * WIN-133 — plaintext identity an ENTITY SIGNED FOR, and the only provenance
   * allowed to reach `turns_v1.user_display_name` / `.user_email`.
   *
   * Set here and in the WS gateway, both times copied verbatim from a validated
   * `SessionPayload.userMeta`. Never from a Thread row, a Postgres `User` row,
   * or a socket payload.
   *
   * It exists BESIDE `sessionContext.user` rather than being read out of it,
   * because that bag is a prompt-substitution surface with three other writers:
   * `AgentService.stream` merges a base layer read straight out of the `User`
   * table so `{{user.name}}` always resolves, and the WS gateway merges a
   * caller-supplied `sessionContextOverride`. Both are legitimate for a prompt
   * and neither is a signature — reading identity out of the merged bag put the
   * OPERATOR'S real name and email into the analytical store on every dashboard
   * turn, a class of identity the erasure sweep addresses only by end-user key
   * and therefore can never reach.
   */
  signedUserMeta?: { name?: string; email?: string };
}

@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Optional() @Inject(AuthService) private readonly authService?: AuthService) {}

  /**
   * Access-key lifecycle is a control-plane operation. The webapp sends it
   * over the trusted direct-header channel and deliberately never retains the
   * raw bearer after its one-time browser reveal. Keep this exception exact:
   * it applies only to the lifecycle routes and only from Path 2 below, which
   * rejects requests that arrived through the public proxy.
   */
  private isDirectAccessKeyLifecycleRequest(request: {
    method?: unknown;
    originalUrl?: unknown;
    url?: unknown;
  }): boolean {
    const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
    const url =
      typeof request.originalUrl === "string"
        ? request.originalUrl
        : typeof request.url === "string"
          ? request.url
          : "";
    const pathname = url.split("?", 1)[0];

    return (
      (pathname === "/api/v1/agent/access-key" &&
        (method === "GET" || method === "POST" || method === "DELETE")) ||
      (pathname === "/api/v1/agent/access-key/origins" && method === "POST")
    );
  }

  /**
   * The webapp calls the agent over the private Docker network with this
   * server-only token. It must keep working after an Environment API key is
   * created: that key is browser-generated, revealed once, and deliberately
   * unavailable to loaders. Runtime callers without this token still require
   * the Environment AccessKey when one is configured.
   */
  private hasValidControlPlaneAuth(request: { headers?: Record<string, unknown> }): boolean {
    // Read directly instead of through the complete config proxy: this guard
    // is deliberately usable in lightweight test harnesses before unrelated
    // runtime integrations (Redis/credential root keys) are configured.
    const expected = process.env.PLATOS_INTERNAL_AUTH_TOKEN?.trim();
    const provided = request.headers?.["x-platos-internal-auth"];
    if (!expected || typeof provided !== "string" || provided.length !== expected.length) {
      return false;
    }
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }

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

    // Entity session-token mint endpoint. The controller validates the clean
    // `plt_ent_` McpBearerToken and canonical Entity ancestry itself.
    if (url.startsWith("/api/v1/entities/") && url.includes("/session-tokens")) return true;

    // EOBD.89 — public guest-token mint. Unauthenticated by design;
    // the controller gates access by agent.visibility + per-IP +
    // per-agent rate limits.
    if (url.startsWith("/api/v1/public/")) return true;

    // Connect reimagining — inbound channel webhooks (Slack / Telegram /
    // WhatsApp / Discord). No per-scope session context: the caller is the
    // provider, not a Platos user. Auth is TWO-FACTOR and happens IN the
    // controller, not here — (1) a timing-safe compare of the URL
    // `:webhookSecret` against the connection row, then (2) the Chat SDK
    // adapter verifies the provider signature (Slack HMAC / WhatsApp
    // X-Hub-Signature-256 / Discord Ed25519 / Telegram secret_token) using the
    // decrypted connection credentials. ScopeGuard just lets the request land.
    if (url.startsWith("/api/v1/channels/inbound/")) return true;

    // Connect v3 — marketplace channel apps (Slack-first). Two PUBLIC
    // surfaces, each self-authenticating IN the controller (never here):
    //   /api/v1/channels/oauth/:appId/{install,callback} — the OAuth V2
    //     install dance. CSRF-guarded by a single-use 256-bit `state` nonce
    //     minted into Redis on /install and GETDEL-verified (== this appId)
    //     on /callback; the app's client secret is decrypted only to POST
    //     oauth.v2.access and never leaves the server.
    //   /api/v1/channels/apps/:appId/events — the one Slack Events API request
    //     URL per app. Every POST is verified by the Slack v0 signature
    //     (HMAC-SHA256 over `v0:<ts>:<rawBody>` with the app's DECRYPTED
    //     signing secret, timing-safe) + a stale-timestamp reject.
    //   /api/v1/channels/link/{:nonce,callback} — Phase C hosted account
    //     linking (Sign in with Slack / OIDC). GET-only; auth is IN the
    //     controller — a single-use Redis nonce (bound to team+user), a second
    //     OIDC `nonce` bound into the id_token, and a userInfo-authoritative
    //     team_id/user_id + email_verified match. The caller is a browser
    //     mid-flow, not a Platos user.
    // The caller is Slack (or a browser mid-install/mid-link), not a Platos
    // user, so there is no per-scope session context. ScopeGuard just lets it
    // land. (The operator-only MANAGEMENT surface lives at
    // /api/v1/agent/channel-apps and is NOT bypassed — it runs under normal
    // scope extraction below.)
    if (
      url.startsWith("/api/v1/channels/oauth/") ||
      url.startsWith("/api/v1/channels/apps/") ||
      url.startsWith("/api/v1/channels/link/")
    ) {
      return true;
    }

    // Theme K — Platform MCP. Authed by `Authorization: Bearer
    // <PLATOS_MCP_TOKEN>` on every request; token verification + scope
    // pin happens inside McpPlatformController. Token CRUD sub-routes
    // (tokens, tokens/:id/revoke) still run under the normal ScopeGuard
    // — they're admin actions dispatched by the webapp.
    if (isPublicMcpTransport(request.method, url)) return true;

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
    // Every other /mcp/entity route is management and falls through to the
    // normal ScopeGuard path. In particular, inject-context must never inherit
    // the protocol bypass.

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
    // Subagent spawning — `/internal/subagent-turn` is the per-turn callback
    // from the `platos.agent.subrun` trigger.dev task. Same HMAC-signed,
    // scope-in-body pattern as batch-turn, but it threads the CHILD thread id
    // through so multi-turn history accumulates on one thread. The controller
    // verifies the HMAC before running the turn.
    if (url.startsWith("/internal/subagent-turn")) return true;

    // WIN-132 — callback-only custom task execution. This route has no user
    // session; its controller performs the timing-safe internal-token check and
    // rejects every other auth path before parsing or executing the body.
    if (url.split("?", 1)[0] === "/api/v1/agent/internal/platos-tasks/execute") {
      return true;
    }

    // Internal callbacks authenticated by PLATOS_INTERNAL_AUTH_TOKEN (e.g. the
    // LiteLLM cost-catalog ingest POSTed by the scheduled trigger.dev task).
    // The endpoint itself re-verifies the token — ScopeGuard just lets it
    // through because the caller has no per-scope context.
    // PRIVACY — hard erasure self-authenticates with an organization-bound,
    // admin-tier `plt_mcp_` credential in ErasureController. ScopeGuard must let
    // the request reach that controller, but it must not accept any deployment
    // secret as authorization for irreversible erasure.
    if (url.startsWith("/api/v1/agent/admin/privacy")) return true;

    if (url.startsWith("/api/v1/agent/monitoring/cost/catalog")) {
      const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
      const provided = request.headers["x-platos-internal-auth"];
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
      const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
      const provided = request.headers["x-platos-internal-auth"];
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
    // REFACTOR (control-plane + trigger substrate) — the durable-execution
    // callbacks (durable-turn / employee-run / skill-run) use the same
    // admin-token gate + scope-in-body pattern as compaction.
    if (
      url.startsWith("/api/v1/agent/internal/compaction") ||
      url.startsWith("/api/v1/agent/internal/durable-turn") ||
      url.startsWith("/api/v1/agent/internal/chat/stream-turn") ||
      url.startsWith("/api/v1/agent/internal/chat/reap-sessions") ||
      url.startsWith("/api/v1/agent/internal/employee-run") ||
      url.startsWith("/api/v1/agent/internal/skill-run") ||
      url.startsWith("/api/v1/agent/internal/budget-alert") ||
      // Subagent report-back — the `platos.agent.subrun` task POSTs the child's
      // result here (admin-token gated + scope-in-body); the controller
      // re-verifies the token AND that the body's scope owns the parent
      // agent/thread before waking a durable parent turn.
      url.startsWith("/api/v1/agent/internal/subagent-report") ||
      // Managed-cloud maintenance-task callbacks — same admin-token gate +
      // scope-in-body. These run as scheduled trigger.dev tasks on Trigger
      // Cloud and reach the agent through the public proxy; each controller
      // re-verifies the token with a timing-safe compare.
      url.startsWith("/api/v1/agent/monitoring/dlq/drain") ||
      url.startsWith("/api/v1/agent/monitoring/cost/reconcile") ||
      url.startsWith("/api/v1/agent/monitoring/budget/email") ||
      url.startsWith("/api/v1/agent/monitoring/approvals/expiry-sweep") ||
      url.startsWith("/api/v1/agent/evals/sample") ||
      url.startsWith("/api/v1/agent/evals/run") ||
      url.startsWith("/api/v1/agent/attachments/retention") ||
      // memory-extraction sweep callback (platos.memory.extract task). Note
      // the non-/agent prefix — served by the memory module's own controller;
      // needs its own Caddy route (/api/v1/memory/* → agent) or it lands on
      // the webapp and 401s with the trigger-style problem+json.
      url.startsWith("/api/v1/memory/admin/extraction-sweep")
    ) {
      const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
      const provided = request.headers["x-platos-internal-auth"];
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

    // Path 1: platform-signed scoped JWT. Entity end-user tokens carry a
    // persisted McpBearerToken authorization ID that AuthService revalidates.
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
        // Surface JWT-supplied user identity hints to the agent prompt
        // via sessionContext.user.{name,email}. The runtime later merges
        // this with the User row from DB (entity-authed users like
        // marketing-widget visitors don't have a `User` row, so the JWT
        // is the only source of name/email for them). Empty when the
        // entity backend didn't include userMeta in the JWT.
        const userMeta = payload.userMeta;
        // WIN-133 — the signed values, isolated first. `sessionContext` is
        // derived FROM this rather than the other way round, so the prompt bag
        // and the projection's identity source cannot come apart.
        const signedUserMeta =
          userMeta && (userMeta.name || userMeta.email)
            ? {
                ...(userMeta.name ? { name: userMeta.name } : {}),
                ...(userMeta.email ? { email: userMeta.email } : {}),
              }
            : undefined;
        const sessionContextFromToken = signedUserMeta ? { user: { ...signedUserMeta } } : undefined;

        // Carry verified-identity claims onto the scope so downstream
        // ConversationService.resolveEndUser can link this turn to a canonical
        // PlatosEndUser across channels. NON-GUEST only: the guest-token flow
        // (EOBD.89) mints tokens for anonymous visitors who must never assert
        // an identity — the same isGuest gate that decides operator tier.
        // Entity-authorized end-user tokens ARE the primary source. Copied
        // verbatim from the validated platform-signed payload.
        const tokenUserIdentities =
          (payload as any).isGuest !== true &&
          Array.isArray(payload.userIdentities) &&
          payload.userIdentities.length > 0
            ? payload.userIdentities
            : undefined;

        request.scope = {
          organizationId: payload.organizationId,
          projectId: payload.projectId,
          environmentId: payload.environmentId,
          userId: payload.userId,
          entityId: payload.entityId,
          userToken: payload.userToken,
          // Operator ONLY when the platform token is neither guest nor backed
          // by an entity McpBearerToken. `iss` alone cannot distinguish the
          // control plane now that every scoped token uses platform signing.
          principal:
            payload.authorizationId === undefined && (payload as any).isGuest !== true
              ? "operator"
              : "end-user",
          ...(tokenAgentId ? { agentId: tokenAgentId } : {}),
          ...(tokenUserIdentities ? { userIdentities: tokenUserIdentities } : {}),
          ...(sessionContextFromToken
            ? { sessionContext: sessionContextFromToken }
            : {}),
          // WIN-133 — the same values, kept apart from the prompt bag so the
          // analytical projection can tell a signature from a merge. See
          // RequestScope.signedUserMeta.
          ...(signedUserMeta ? { signedUserMeta } : {}),
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
            userId: request.scope.userId,
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
    const requestedAgentId = request.headers["x-platos-agent-id"];

    if (!viaProxy && organizationId && projectId && environmentId && userId) {
      let validatedAgentId: string | undefined;
      if (requestedAgentId) {
        const controlPlaneAuthenticated = this.hasValidControlPlaneAuth(request);
        const validPin =
          controlPlaneAuthenticated &&
          this.authService &&
          await this.authService.validateOperatorAgentPin(
            {
              organizationId: String(organizationId),
              projectId: String(projectId),
              environmentId: String(environmentId),
            },
            String(requestedAgentId),
          );
        if (!validPin) {
          const resp = context.switchToHttp().getResponse();
          resp.status(403).json({
            error: "INVALID_AGENT_SCOPE",
            message: "The requested Agent is not bound to the authenticated control-plane scope.",
          });
          return false;
        }
        validatedAgentId = String(requestedAgentId);
      }
      request.scope = {
        organizationId: String(organizationId),
        projectId: String(projectId),
        environmentId: String(environmentId),
        userId: String(userId),
        // Trusted internal path (webapp→agent over the Docker network, never
        // through Caddy — enforced by the !viaProxy guard above). This IS the
        // control-plane, so it authorizes operator surfaces.
        principal: "operator",
        ...(validatedAgentId ? { agentId: validatedAgentId } : {}),
        ...(entityId ? { entityId: String(entityId) } : {}),
        ...(userToken ? { userToken: String(userToken) } : {}),
        // EOBD.40 — propagate inbound traceparent on the direct-header
        // path too (webapp → agent over the Docker network).
        ...(traceCtx ? { traceId: traceCtx.traceId, parentSpanId: traceCtx.parentSpanId } : {}),
      } satisfies RequestScope;
      // Access key checks protect ordinary direct-header runtime requests. The
      // exact AccessKey lifecycle routes are operator-authorized by their
      // controller/service and cannot require raw bearer material that the
      // dashboard intentionally discards after the one-time reveal.
      if (
        this.authService &&
        !this.isDirectAccessKeyLifecycleRequest(request) &&
        !this.hasValidControlPlaneAuth(request)
      ) {
        const providedKey = request.headers["x-platos-api-key"] as string | undefined;
        const origin = (request.headers["origin"] || request.headers["referer"]) as string | undefined;
        const scopeForCheck = {
          organizationId: request.scope.organizationId,
          projectId: request.scope.projectId,
          environmentId: request.scope.environmentId,
          userId: request.scope.userId,
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
        ? "External requests must use X-Platos-Session-Token (minted from an active entity bearer). Raw scope headers are rejected when the request arrives through the public proxy."
        : "Authentication required. Provide either X-Platos-Session-Token or all four headers: X-Platos-Organization-Id, X-Platos-Project-Id, X-Platos-Environment-Id, X-Platos-User-Id."
    );
  }

  /** PIFSP-1 — extract agentId from /api/v1/agent/agents/:agentId/* URLs. */
  private extractAgentIdFromPath(url: string): string | null {
    const match = /\/api\/v1\/agent\/agents\/([^/?]+)/.exec(url);
    return match?.[1] ?? null;
  }
}
