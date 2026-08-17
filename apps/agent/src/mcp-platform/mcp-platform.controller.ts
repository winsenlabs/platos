import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { Request, Response } from "express";
import * as crypto from "node:crypto";
import {
  PlatosMCPTokenService,
  MCPTokenForbiddenError,
} from "./token.service";
import type { VerifiedToken, PlatosMCPTokenTier } from "./token.service";
import {
  McpRouter,
  type JsonRpcRequest,
  type McpApprovalGate,
} from "./mcp-router";
import { MCPPermissionGatewayService } from "./permission-gateway.service";
import { buildPlatformToolHandlers } from "./tools";
import { MacroRecordingState } from "./tools/macros";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";
import { AgentCrudService } from "../agent-runtime/agent-crud.service";
import { ConversationService } from "../memory/conversation.service";
import { AgentTaskService } from "../agent-runtime/agent-task.service";
import { RatingService } from "../evals/rating.service";
import { AuthService } from "../auth/auth.service";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { EntityMcpDiscoveryService } from "../tool-gateway/mcp-transport/entity-mcp-discovery.service";
import { SkillRegistryService } from "../skills/skill-registry.service";
import { SkillImporterService } from "../skills/skill-importer.service";
import { MemoryService } from "../memory/memory.service";
import { MemoryExtractionService } from "../memory/memory-extraction.service";
import { KnowledgeGraphService } from "../memory/knowledge-graph.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { ProviderKeyService } from "../providers/provider-key.service";
import { ScopedEnvService } from "../providers/scoped-env.service";
import { MonitoringApprovalsService } from "../monitoring/approvals.service";
import { BudgetService } from "../monitoring/budget.service";
import { EvalService } from "../evals/eval.service";
import { GoldenSetService } from "../evals/golden-set.service";
import { CostService } from "../monitoring/cost.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { SpansService } from "../monitoring/spans.service";
import { McpEventsService } from "./events.service";
import type Redis from "ioredis";
import { REDIS_TOKEN } from "../shared/redis.provider";
import { OAuthService } from "../oauth/oauth.service";
// MCPF-W1 — extra deps for the new entity-management tools.
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
// Connect channels.* — evict the channels runtime cache after mutations
// (resolved lazily via ModuleRef; a direct import in the constructor would
// require importing ChannelsModule → DI cycle with AgentRuntimeModule).
import { ChannelRuntimeService } from "../channels/channel-runtime.service";
// MCPF-W6 — monitoring + settings/admin tool dependencies.
import { TraceService } from "../monitoring/trace.service";
import { ProviderHealthService } from "../auth/provider-health.service";
import { OrganizationService } from "../admin/organization.service";
import { EnvironmentService } from "../admin/environment.service";
import { AgentClusterService } from "../agent-runtime/agent-cluster.service";

/**
 * Theme K.4 — Platform MCP controller.
 *
 * Two transports, both over the same JSON-RPC core:
 *
 *   1. Streamable HTTP — `POST /mcp/platform` with `Authorization:
 *      Bearer <token>`. Response is returned inline on the POST body.
 *      This is what Claude Code's `--transport http` uses.
 *
 *   2. SSE — the legacy MCP transport Claude Desktop defaults to.
 *      Client opens `GET /mcp/platform/sse`; server mints a sessionId
 *      and emits `event: endpoint\ndata: /mcp/platform/messages?
 *      sessionId=<id>` as the first SSE frame. Client POSTs JSON-RPC
 *      requests to that URL; response is pushed back on the SSE
 *      stream as `event: message\ndata: <json>`. Keepalive pings
 *      every 30s (required so Caddy/NGINX idle timeouts don't kill
 *      the stream).
 */
@Controller("mcp/platform")
export class McpPlatformController {
  private router: McpRouter | null = null;
  private readonly sessions = new Map<string, SseSession>();
  /**
   * K.17 — in-memory macro recording state. Lives on the controller
   * singleton so the MCP router's record-hook + the `macros.*` tool
   * handlers share the same map. If the agent process restarts mid-
   * recording the state is lost. TODO(K.17.2) Redis-backed persistence.
   */
  private readonly macroState = new MacroRecordingState();

  constructor(
    private readonly tokenService: PlatosMCPTokenService,
    private readonly permissionGateway: MCPPermissionGatewayService,
    private readonly agentCrud: AgentCrudService,
    private readonly conversation: ConversationService,
    private readonly agentTask: AgentTaskService,
    private readonly rating: RatingService,
    // K.5 entities.* + entities.wire_test
    private readonly auth: AuthService,
    private readonly toolExecutor: ToolExecutorService,
    // MCP-connected-entity (design Commit 5) — outbound tools/list discovery,
    // kicked by entities.register / entities.refresh_discovery.
    private readonly entityMcpDiscovery: EntityMcpDiscoveryService,
    // K.7 skills.*
    private readonly skillRegistry: SkillRegistryService,
    private readonly skillImporter: SkillImporterService,
    // K.8 control plane
    private readonly memory: MemoryService,
    // MCPF-W2 — memories.extract_now wraps this service's `extractFromThread`.
    private readonly memoryExtraction: MemoryExtractionService,
    private readonly graph: KnowledgeGraphService,
    private readonly providers: ProviderRegistryService,
    private readonly providerKeys: ProviderKeyService,
    // MCPF-W3 — providers.test_credentials + providers.rotate_key need scoped-env access.
    private readonly scopedEnv: ScopedEnvService,
    private readonly approvals: MonitoringApprovalsService,
    private readonly budgets: BudgetService,
    private readonly evals: EvalService,
    private readonly cost: CostService,
    private readonly toolAudit: ToolAuditService,
    private readonly safetyEvents: SafetyEventService,
    // K.14 orchestration composites.
    private readonly goldenSet: GoldenSetService,
    // K.15 — event bus + notification routing.
    private readonly events: McpEventsService,
    // K.16 — reflection tools (explain_turn timeline via SpansService).
    private readonly spans: SpansService,
    // K.10 — accept OAuth-issued bearers (plt_oa_*) alongside plt_mcp_*.
    private readonly oauth: OAuthService,
    // MCPF-W1 — entity-management tool dependencies.
    private readonly toolRegistry: ToolRegistryService,
    private readonly bearerTokens: McpBearerTokenService,
    private readonly messageCrypto: MessageCryptoService,
    // MCPF-W6 — monitoring + settings/admin tool dependencies.
    private readonly traces: TraceService,
    private readonly providerHealth: ProviderHealthService,
    private readonly orgs: OrganizationService,
    private readonly envs: EnvironmentService,
    private readonly clusters: AgentClusterService,
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    // Lazy resolution of ChannelRuntimeService (see invalidateChannelRuntime).
    private readonly moduleRef: ModuleRef,
  ) {}

  private getRouter(): McpRouter {
    if (this.router) return this.router;
    const router = new McpRouter(
      {
        buildScope: (token, userId) => ({
          organizationId: token.scope.organizationId,
          projectId: token.scope.projectId,
          environmentId: token.scope.environmentId,
          userId: userId ?? token.mintedByUserId,
        }),
      },
      this.permissionGateway,
    );
    router.registerAll(
      buildPlatformToolHandlers({
        agentCrud: this.agentCrud,
        conversation: this.conversation,
        agentTask: this.agentTask,
        rating: this.rating,
        auth: this.auth,
        toolExecutor: this.toolExecutor,
        // MCP-connected-entity (design Commit 5) — kicks tools/list discovery
        // for entities.register / entities.refresh_discovery on mcp entities.
        entityMcpDiscovery: this.entityMcpDiscovery,
        // MCPF-W1 — entity-management deps.
        toolRegistry: this.toolRegistry,
        bearerTokens: this.bearerTokens,
        messageCrypto: this.messageCrypto,
        skillRegistry: this.skillRegistry,
        skillImporter: this.skillImporter,
        memory: this.memory,
        // MCPF-W2 — memories.extract_now.
        memoryExtraction: this.memoryExtraction,
        graph: this.graph,
        providers: this.providers,
        providerKeys: this.providerKeys,
        // MCPF-W3 — providers.test_credentials / rotate_key + oauth.* tools.
        scopedEnv: this.scopedEnv,
        oauth: this.oauth,
        approvals: this.approvals,
        budgets: this.budgets,
        evals: this.evals,
        cost: this.cost,
        toolAudit: this.toolAudit,
        safetyEvents: this.safetyEvents,
        // K.14 orchestration composites.
        goldenSet: this.goldenSet,
        prisma: this.prisma,
        // K.17 macros — share the in-memory recording state with the
        // router's record-hook + pass a back-ref so `macros.replay`
        // re-dispatches each step through the same router.
        macroState: this.macroState,
        getRouter: () => router,
        // K.15 event bus + notifications.
        events: this.events,
        // K.16 reflection — explain_turn joins spans into the timeline.
        spans: this.spans,
        // MCPF-W6 — monitoring + settings/admin.
        traces: this.traces,
        providerHealth: this.providerHealth,
        orgs: this.orgs,
        envs: this.envs,
        clusters: this.clusters,
        // Connect channels.* — evict the runtime's cached Chat instance after
        // update/delete/rotate so credential + routing changes take effect
        // immediately (not after the 10-min TTL). Best-effort: the runtime is
        // resolved lazily (strict:false searches the whole container) and a
        // resolution failure must never fail the tool call.
        invalidateChannelRuntime: (connectionId: string) => {
          try {
            this.moduleRef
              .get(ChannelRuntimeService, { strict: false })
              ?.invalidate(connectionId);
          } catch {
            // ChannelsModule absent — the runtime TTL bounds staleness.
          }
        },
        // Connect v3 — evict the runtime's cached decrypted bot token(s) for an
        // app after channel_apps.update / delete / revoke so credential /
        // install changes take effect immediately (not after the 10-min TTL).
        // Same lazy ModuleRef pattern; best-effort.
        invalidateChannelApp: (appId: string) => {
          try {
            this.moduleRef
              .get(ChannelRuntimeService, { strict: false })
              ?.invalidateApp(appId);
          } catch {
            // ChannelsModule absent — the runtime TTL bounds staleness.
          }
        },
      }),
    );
    // K.17 — attach recorder so the router captures successful tool
    // calls into any in-progress recording for the token.
    router.setMacroRecorder(this.macroState);

    // MCP approval-UI — wire the approval gate when
    // `MCP_INTERACTIVE_APPROVALS=true`. Gate-absent path keeps the
    // legacy auto-approve behaviour so existing OSS deployments
    // upgrade without a config change.
    const approvalsEnabled =
      String(process.env["MCP_INTERACTIVE_APPROVALS"] ?? "").toLowerCase() === "true" ||
      process.env["MCP_INTERACTIVE_APPROVALS"] === "1";
    if (approvalsEnabled) {
      const ttlSeconds = Math.max(
        60,
        Number.parseInt(process.env["MCP_APPROVAL_TTL_SECONDS"] ?? "3600", 10) || 3600,
      );
      const approvals = this.approvals;
      const gate: McpApprovalGate = {
        get: (scope, approvalId) =>
          approvals.getById(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            approvalId,
          ),
        create: (input) =>
          approvals.createMcpApproval({
            scope: {
              organizationId: input.scope.organizationId,
              projectId: input.scope.projectId,
              environmentId: input.scope.environmentId,
            },
            toolName: input.toolName,
            args: input.args,
            requestHash: input.requestHash,
            requestedByUserId: input.requestedByUserId ?? null,
            requestedByMcpTokenId: input.requestedByMcpTokenId ?? null,
            timeoutSeconds: input.timeoutSeconds ?? ttlSeconds,
          }),
        markConsumed: (scope, approvalId, resolution) =>
          approvals.markMcpConsumed(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            approvalId,
            resolution,
          ),
        hash: (scope, toolName, args) =>
          MonitoringApprovalsService.computeRequestHash(
            {
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              environmentId: scope.environmentId,
            },
            toolName,
            args,
          ),
      };
      router.setApprovalGate(gate, ttlSeconds);
    }

    this.router = router;
    return router;
  }

  private extractBearer(authorization: string | undefined): string | null {
    if (!authorization || typeof authorization !== "string") return null;
    if (!authorization.toLowerCase().startsWith("bearer ")) return null;
    return authorization.slice(7).trim();
  }

  /**
   * K.10 — verify either a Platos MCP token (`plt_mcp_*`) or an OAuth 2.1
   * access token issued by this server (`plt_oa_*`). Returns a unified
   * VerifiedToken shape so downstream router/handlers don't need to
   * branch on token origin.
   *
   * OAuth tokens carry the full scope tuple + user id + scopes (mapped
   * to MCP permissions as `["*"]` for `mcp:write` / `["*.list","*.get"]`
   * for `mcp:read`). TODO(K.10.1) refine scope→permission mapping once
   * we have the full tool catalog (e.g. a read-only scope shouldn't
   * allow `messages.rate` mutations).
   */
  private async verifyAnyBearer(raw: string): Promise<VerifiedToken | null> {
    if (raw.startsWith("plt_oa_")) {
      const oa = await this.oauth.verifyAccessToken(raw);
      if (!oa) return null;
      // SECURITY (audit C3) — an entity-minted OAuth token (entityPk set) is
      // scoped to that ENTITY's per-entity MCP surface, NOT the org-wide
      // platform surface. verifyAnyBearer never inspected entityPk, so an
      // embedded-widget visitor could request scope=mcp:write → permissions
      // ["*"] and drive org/project-wide platform tools (agents.*, providers.*,
      // entities.regenerate_secret, …). Reject entity OAuth tokens here — the
      // inverse of the per-entity surface's own entityPk pin.
      if (oa.entityPk) return null;
      const permissions = oa.scopes.includes("mcp:write")
        ? ["*"]
        : ["*.list", "*.get", "platos_whoami", "platos_list_accessible_scopes"];
      return {
        id: oa.tokenHash.slice(0, 16),
        scope: {
          organizationId: oa.scope.organizationId,
          projectId: oa.scope.projectId,
          environmentId: oa.scope.environmentId,
        },
        permissions,
        mintedByUserId: oa.userId,
        expiresAt: oa.expiresAt,
        tier: "scope",
      };
    }
    return this.tokenService.verify(raw);
  }

  @Post()
  async jsonRpc(
    @Headers("authorization") authorization: string | undefined,
    @Headers("x-platos-approval-id") approvalIdHeader: string | undefined,
    @Body() body: JsonRpcRequest,
  ): Promise<any> {
    const bearer = this.extractBearer(authorization);
    if (!bearer) {
      throw new HttpException(
        "Authorization: Bearer <PLATOS_MCP_TOKEN> required",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const token = await this.verifyAnyBearer(bearer);
    if (!token) {
      throw new HttpException("invalid or expired MCP token", HttpStatus.UNAUTHORIZED);
    }
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      throw new HttpException(
        "body must be a JSON-RPC 2.0 request with `method`",
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.getRouter().handle(body, token, {
      approvalId: approvalIdHeader ?? null,
      dashboardOrigin: process.env["APP_ORIGIN"] ?? process.env["PLATOS_WEBAPP_ORIGIN"] ?? null,
    });
  }

  @Get("sse")
  async sse(
    @Req() req: Request,
    @Res() res: Response,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<void> {
    const bearer = this.extractBearer(authorization);
    if (!bearer) {
      res.status(401).send("Authorization: Bearer <PLATOS_MCP_TOKEN> required");
      return;
    }
    const token = await this.verifyAnyBearer(bearer);
    if (!token) {
      res.status(401).send("invalid or expired MCP token");
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // MCP-over-SSE handshake — RFC-style session correlation.
    // First frame MUST be `event: endpoint` pointing at the POST URL
    // the client should send JSON-RPC requests to; we tag the URL
    // with `sessionId` so we can route responses back on this stream.
    const sessionId = crypto.randomBytes(16).toString("hex");
    const endpointUrl = `/mcp/platform/messages?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    const pingInterval = setInterval(() => {
      try {
        const msg = JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/ping",
        });
        res.write(`event: message\ndata: ${msg}\n\n`);
      } catch {
        /* socket closed — the cleanup path will fire */
      }
    }, 30_000);

    // BUG-18: sessions are stored in-memory on this controller instance.
    // On agent restart all SSE sessions are lost and MCP clients must
    // reconnect. TODO(redis-sessions): migrate to Redis-backed session
    // store (same pattern as McpEntityController) for multi-replica safety.
    // For now, ensure cleanup fires on disconnect so memory doesn't leak.
    this.sessions.set(sessionId, { token, res, pingInterval });

    const cleanup = () => {
      clearInterval(pingInterval);
      this.sessions.delete(sessionId);
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  @Post("messages")
  async messages(
    @Query("sessionId") sessionId: string | undefined,
    @Headers("x-platos-approval-id") approvalIdHeader: string | undefined,
    @Body() body: JsonRpcRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!sessionId) {
      res.status(400).send("missing sessionId query param");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      res.status(404).send("unknown or expired sessionId");
      return;
    }
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      res.status(400).send("body must be a JSON-RPC 2.0 request with `method`");
      return;
    }

    // 202 ack BEFORE dispatching — per the MCP SSE transport spec the
    // response is delivered on the SSE stream, not on this POST.
    res.status(202).send();

    try {
      const response = await this.getRouter().handle(body, session.token, {
        approvalId: approvalIdHeader ?? null,
        dashboardOrigin:
          process.env["APP_ORIGIN"] ?? process.env["PLATOS_WEBAPP_ORIGIN"] ?? null,
      });
      const frame = `event: message\ndata: ${JSON.stringify(response)}\n\n`;
      session.res.write(frame);
    } catch (err) {
      const rpcError = {
        jsonrpc: "2.0" as const,
        id: body.id ?? null,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "internal error",
        },
      };
      session.res.write(`event: message\ndata: ${JSON.stringify(rpcError)}\n\n`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // K.15 — events subscription SSE stream.
  //
  // The `events.subscribe` MCP tool returns a URL that opens this
  // endpoint. Auth is via the `token` query param (SSE clients can't
  // set Authorization). Filters are base64url JSON in the `filters`
  // query param. The server subscribes to Redis pub/sub for the token's
  // scope and writes frames as the events arrive, filtered client-side.
  // Keepalive ping every 30s; cleanup on client disconnect.
  // ─────────────────────────────────────────────────────────────

  @Get("events/subscribe")
  async eventsSubscribe(
    @Req() req: Request,
    @Res() res: Response,
    @Query("token") tokenParam: string | undefined,
    @Query("filters") filtersParam: string | undefined,
  ): Promise<void> {
    if (!tokenParam) {
      res.status(401).send("token query param required");
      return;
    }
    const verified = await this.verifyAnyBearer(tokenParam);
    if (!verified) {
      res.status(401).send("invalid or expired MCP token");
      return;
    }

    // Tool-level allowlist check — only tokens that can call
    // `events.subscribe` may open this stream.
    if (!PlatosMCPTokenService.allows(verified.permissions, "events.subscribe")) {
      res.status(403).send("token does not allow events.subscribe");
      return;
    }

    let filters: { eventTypes: string[]; subjectIds?: string[] } = {
      eventTypes: ["*"],
    };
    if (filtersParam) {
      try {
        const decoded = Buffer.from(filtersParam, "base64url").toString("utf8");
        const parsed = JSON.parse(decoded);
        if (parsed && Array.isArray(parsed.eventTypes)) {
          filters = {
            eventTypes: parsed.eventTypes.map((v: unknown) => String(v)),
            ...(Array.isArray(parsed.subjectIds)
              ? { subjectIds: parsed.subjectIds.map((v: unknown) => String(v)) }
              : {}),
          };
        }
      } catch {
        res.status(400).send("filters must be base64url(JSON)");
        return;
      }
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const scopeChannel = `mcp:events:${verified.scope.organizationId}:${verified.scope.projectId}:${verified.scope.environmentId}`;

    res.write(
      `event: hello\ndata: ${JSON.stringify({
        scope: verified.scope,
        filters,
        channel: scopeChannel,
      })}\n\n`,
    );

    const matchesType = (eventType: string) => {
      for (const pattern of filters.eventTypes) {
        if (pattern === "*") return true;
        if (pattern === eventType) return true;
        if (pattern.endsWith(".*")) {
          const prefix = pattern.slice(0, -2);
          if (eventType.startsWith(`${prefix}.`) || eventType === prefix) return true;
        }
      }
      return false;
    };

    // Dedicated subscriber client — ioredis can't issue regular commands
    // once .subscribe() is called, so we duplicate. ioredis keyPrefix
    // applies to publish channels but NOT to subscribe channels, so we
    // pre-prefix `platos:` here to match the publisher's namespace.
    const sub = this.redis.duplicate();
    const prefixedChannel = `platos:${scopeChannel}`;
    try {
      await sub.subscribe(prefixedChannel);
    } catch (err) {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          message: err instanceof Error ? err.message : String(err),
        })}\n\n`,
      );
      try {
        await sub.quit();
      } catch {
        /* */
      }
      res.end();
      return;
    }

    const onMessage = (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message) as {
          eventType?: string;
          subjectId?: string | null;
        };
        if (!parsed.eventType) return;
        if (!matchesType(parsed.eventType)) return;
        if (filters.subjectIds && filters.subjectIds.length > 0) {
          if (!parsed.subjectId || !filters.subjectIds.includes(parsed.subjectId)) {
            return;
          }
        }
        res.write(`event: message\ndata: ${message}\n\n`);
      } catch {
        /* malformed frame — skip */
      }
    };
    sub.on("message", onMessage);

    const pingInterval = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {}\n\n`);
      } catch {
        /* socket closed — cleanup fires */
      }
    }, 30_000);

    const cleanup = () => {
      clearInterval(pingInterval);
      sub.off("message", onMessage);
      sub.unsubscribe(prefixedChannel).catch(() => {
        /* already closed */
      });
      sub.quit().catch(() => {
        /* already closed */
      });
      try {
        res.end();
      } catch {
        /* already closed */
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  // ─────────────────────────────────────────────────────────────
  // Token CRUD — admin endpoints (same ScopeGuard as the rest of
  // /api/v1/agent). Used by the webapp Settings → Integrations → MCP
  // tab.
  // ─────────────────────────────────────────────────────────────

  @Post("tokens")
  async mintToken(
    @Req() req: Request,
    @Body() body: {
      name: string;
      permissions: string[];
      ttlSeconds?: number;
      /**
       * K.18 — optional tier. Defaults to "scope". "admin" requires the
       * caller to be Project ADMIN or Organization OWNER/ADMIN.
       */
      tier?: PlatosMCPTokenTier;
    },
  ) {
    const scope = (req as any).scope as RequestScope | undefined;
    if (!scope) throw new HttpException("unauthenticated", HttpStatus.UNAUTHORIZED);
    // SECURITY (audit authz-2026-07-22 F5) — platform-token issuance is an
    // operator/dashboard action. Without this, an end-user/guest session token
    // self-mints an all-permissions `plt_mcp_` token (tier "scope",
    // permissions:["*"]) and drives the operator control-plane. Fails CLOSED.
    requireOperator(scope);
    try {
      return await this.tokenService.mint({
        scope,
        name: body?.name ?? "",
        permissions: body?.permissions ?? [],
        ttlSeconds: body?.ttlSeconds,
        ...(body?.tier ? { tier: body.tier } : {}),
      });
    } catch (err) {
      if (err instanceof MCPTokenForbiddenError) {
        throw new HttpException(err.message, HttpStatus.FORBIDDEN);
      }
      throw err;
    }
  }

  @Get("tokens")
  async listTokens(@Req() req: Request) {
    const scope = (req as any).scope as RequestScope | undefined;
    if (!scope) throw new HttpException("unauthenticated", HttpStatus.UNAUTHORIZED);
    // SECURITY (audit authz-2026-07-22 F5) — platform-token inventory is an
    // operator/dashboard read (enumerates every token's permissions + scope tier).
    // Same admin-action tier as mintToken; end-user/guest tokens must not enumerate.
    requireOperator(scope);
    let tokens;
    try {
      tokens = await this.tokenService.list(scope);
    } catch (error) {
      if (error instanceof MCPTokenForbiddenError) {
        throw new HttpException(error.message, HttpStatus.FORBIDDEN);
      }
      throw error;
    }
    return { tokens };
  }

  @Post("tokens/:id/revoke")
  async revokeToken(@Req() req: Request, @Body() _body: unknown) {
    const scope = (req as any).scope as RequestScope | undefined;
    if (!scope) throw new HttpException("unauthenticated", HttpStatus.UNAUTHORIZED);
    // SECURITY (audit authz-2026-07-22 F5) — token revocation is an operator
    // action; without this an end-user/guest revokes the operator's own
    // control-plane tokens (integrity/DoS on the whole scope's MCP access).
    requireOperator(scope);
    const id = req.params["id"];
    if (!id) throw new HttpException("id missing", HttpStatus.BAD_REQUEST);
    let ok;
    try {
      ok = await this.tokenService.revoke(id, scope);
    } catch (error) {
      if (error instanceof MCPTokenForbiddenError) {
        throw new HttpException(error.message, HttpStatus.FORBIDDEN);
      }
      throw error;
    }
    return { ok };
  }

  /**
   * MCPF-K.22 — full tool catalog, grouped by category. Powers the
   * "mint token" visual permission picker (Settings → Integrations →
   * MCP): instead of hand-typing `agents.*, threads.*` patterns, the
   * operator toggles categories and the UI emits the same wildcard
   * strings that `PlatosMCPTokenService.allows()` understands.
   *
   * Runs under the normal ScopeGuard (scope headers) like the token
   * CRUD endpoints — it's a dashboard-facing read, not an MCP-token
   * call. Returns EVERY registered tool (incl. admin-tier), flagged so
   * the picker can gate cross-scope categories behind the admin
   * checkbox. Enumeration only — no scope data is touched.
   */
  @Get("catalog")
  async toolCatalog(@Req() req: Request) {
    const scope = (req as any).scope as RequestScope | undefined;
    if (!scope) throw new HttpException("unauthenticated", HttpStatus.UNAUTHORIZED);
    try {
      await this.tokenService.authorizeMetadataAccess(scope);
    } catch (error) {
      if (error instanceof MCPTokenForbiddenError) {
        throw new HttpException(error.message, HttpStatus.FORBIDDEN);
      }
      throw error;
    }

    const handlers = this.getRouter().getRegisteredTools();
    const byCategory = new Map<
      string,
      { name: string; description: string; requiresAdminTier: boolean }[]
    >();
    for (const h of handlers) {
      // Group by the tool's DOMAIN — the dotted-name prefix
      // (`agents.create` → `agents`, `trigger.runs.list` → `trigger`).
      // The handler's stamped `category` is the coarse transport tag
      // ("platos.platform"), too broad for the picker, so the name
      // prefix wins; the stamped category is only a fallback for an
      // (unexpected) dotless name.
      const category = h.name.includes(".")
        ? h.name.split(".")[0]!
        : h.category ?? "other";
      const list = byCategory.get(category) ?? [];
      list.push({
        name: h.name,
        description: h.description ?? "",
        requiresAdminTier: h.requiresAdminTier === true,
      });
      byCategory.set(category, list);
    }

    const categories = Array.from(byCategory.entries())
      .map(([category, tools]) => {
        tools.sort((a, b) => a.name.localeCompare(b.name));
        return {
          category,
          count: tools.length,
          // A category is "admin" only when EVERY tool in it needs
          // admin tier (scopes / audit / gdpr). The picker hides these
          // unless the admin-tier checkbox is on.
          adminTier: tools.every((t) => t.requiresAdminTier),
          tools,
        };
      })
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

    return {
      totalTools: handlers.length,
      totalCategories: categories.length,
      categories,
    };
  }
}

interface SseSession {
  token: VerifiedToken;
  res: Response;
  pingInterval: NodeJS.Timeout;
}
