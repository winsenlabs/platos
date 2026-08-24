import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import * as crypto from "node:crypto";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import { OAuthService } from "../oauth/oauth.service";
import { ToolExecutorService } from "../tool-gateway/tool-executor.service";
import { ToolRouterService } from "../tool-gateway/tool-router.service";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";
import type { JsonRpcRequest, JsonRpcResponse } from "./mcp-router";
import { RPC_ERRORS } from "./mcp-router";
import { McpBearerTokenService } from "./mcp-bearer-token.service";
import { McpIdentityResolverService } from "./identity-resolver.service";
import { McpToolAclService } from "./mcp-tool-acl.service";
import {
  validateIdentityProviders,
  validateMcpIdentityMode,
} from "./mcp-management.validation";

/**
 * PIFSP-21 — per-entity MCP Gateway.
 *
 * Serves customer-facing MCP endpoints at:
 *   POST /mcp/entity/:entityId                — streamable HTTP JSON-RPC
 *   GET  /mcp/entity/:entityId/sse            — Server-Sent Events
 *   POST /mcp/entity/:entityId/messages       — SSE control
 *   GET  /mcp/entity/:entityId/events/subscribe — notifications (PIFSP-23)
 *
 * Auth is via OAuth 2.1 bearer tokens minted at
 * `/oauth/entity/:entityId/*`. Every request:
 *   1. Resolves the PlatosConnectedEntity by slug + loads PlatosEntityMcpConfig.
 *   2. Verifies the bearer token + confirms `token.entityPk` pins to
 *      this entity (cross-entity tokens return 403).
 *   3. Narrows the tool matrix to `toolAllowlist` (empty = zero tools
 *      per PIFSP-25 explicit-opt-in semantics).
 *   4. Dispatches `tools/call` via ToolExecutorService with
 *      `_context.source: "mcp_client"` + audit-tagging.
 *
 * This controller runs WITHOUT ScopeGuard — the OAuth token self-auths.
 * See `scope.guard.ts` for the bypass entry.
 */
@Controller("mcp/entity")
export class McpEntityController {
  constructor(
    private readonly oauth: OAuthService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly toolRouter: ToolRouterService,
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly bearerTokenService: McpBearerTokenService,
    private readonly identityResolver: McpIdentityResolverService,
    private readonly toolAclService: McpToolAclService,
    private readonly toolRegistry: ToolRegistryService,
  ) {}

  private getScope(req: Request): RequestScope {
    // BUG-20: throw 401 instead of returning a fallback with "unknown" values
    // that silently pass through to DB queries.
    if (!(req as any).scope) throw new UnauthorizedException("Missing scope");
    return (req as any).scope;
  }

  private getOperatorScope(req: Request): RequestScope {
    const scope = this.getScope(req);
    requireOperator(scope);
    return scope;
  }

  private extractBearer(authorization: string | undefined): string | null {
    if (!authorization || typeof authorization !== "string") return null;
    if (!authorization.toLowerCase().startsWith("bearer ")) return null;
    return authorization.slice(7).trim();
  }

  /** Resolve the entity by slug + load mcp config. null = 404.
   *
   * BUG-1: entityId slug is NOT globally unique — the unique constraint is
   * (organizationId, projectId, entityId). When a scope is provided (from
   * ScopeGuard on management endpoints), the lookup is scoped to that org/project.
   * For OAuth-token-authenticated MCP paths the bearer token's entityPk
   * provides the cross-tenant pin in authenticate().
   */
  private async loadEntity(
    entityIdSlug: string,
    scope?: Pick<RequestScope, "organizationId" | "projectId">,
  ): Promise<
    | {
        entityPk: string;
        entityId: string;
        organizationId: string;
        projectId: string;
        displayName: string;
        config: {
          enabled: boolean;
          toolAllowlist: string[];
          rateLimitPerMinute: number;
          identityMode: string;
        };
      }
    | null
  > {
    if (!entityIdSlug || typeof entityIdSlug !== "string") return null;
    const where: Record<string, unknown> = { externalId: entityIdSlug };
    // BUG-1: add org/project filters when scope is available so slug lookup
    // cannot cross tenant boundaries.
    if (scope) {
      where.projectId = scope.projectId;
      where.project = { organizationId: scope.organizationId };
    }
    const ent = await this.prisma.entity.findFirst({
      where,
      select: {
        id: true,
        externalId: true,
        projectId: true,
        displayName: true,
        mcpConfig: true,
        project: { select: { organizationId: true } },
      },
    });
    if (!ent || !ent.mcpConfig) return null;
    return {
      entityPk: ent.id,
      entityId: ent.externalId,
      organizationId: ent.project.organizationId,
      projectId: ent.projectId,
      displayName: ent.displayName,
      config: {
        enabled: ent.mcpConfig.enabled,
        toolAllowlist: ent.mcpConfig.toolAllowlist ?? [],
        rateLimitPerMinute: ent.mcpConfig.rateLimitPerMinute ?? 60,
        identityMode: ent.mcpConfig.identityMode ?? "bearer",
      },
    };
  }

  private async loadEntityByPk(entityPk: string) {
    if (!entityPk) return null;
    const ent = await this.prisma.entity.findUnique({
      where: { id: entityPk },
      select: {
        id: true,
        externalId: true,
        projectId: true,
        displayName: true,
        mcpConfig: true,
        project: { select: { organizationId: true } },
      },
    });
    if (!ent?.mcpConfig) return null;
    return {
      entityPk: ent.id,
      entityId: ent.externalId,
      organizationId: ent.project.organizationId,
      projectId: ent.projectId,
      displayName: ent.displayName,
      config: {
        enabled: ent.mcpConfig.enabled,
        toolAllowlist: ent.mcpConfig.toolAllowlist ?? [],
        rateLimitPerMinute: ent.mcpConfig.rateLimitPerMinute ?? 60,
        identityMode: ent.mcpConfig.identityMode ?? "bearer",
      },
    };
  }

  private async loadAnonymousEntity(
    entityIdSlug: string,
    req: Request,
  ): Promise<
    | {
        entity: NonNullable<Awaited<ReturnType<McpEntityController["loadEntityByPk"]>>>;
        environmentId: string;
      }
    | { error: string; status: number }
  > {
    const raw = (req.query as Record<string, unknown> | undefined)?.environmentId;
    if (Array.isArray(raw) || typeof raw !== "string" || !raw.trim()) {
      return { error: "environmentId is required for anonymous MCP authentication", status: 400 } as const;
    }
    const environment = await this.prisma.environment.findFirst({
      where: { id: raw.trim(), archivedAt: null, project: { archivedAt: null } },
      select: {
        id: true,
        project: {
          select: {
            entities: {
              where: { externalId: entityIdSlug },
              select: { id: true },
              take: 2,
            },
          },
        },
      },
    });
    if (!environment || environment.project.entities.length !== 1) {
      return { error: "entity MCP not found in the requested environment", status: 404 } as const;
    }
    const entity = await this.loadEntityByPk(environment.project.entities[0]!.id);
    if (!entity) return { error: "entity MCP not found", status: 404 } as const;
    return { entity, environmentId: environment.id };
  }

  /**
   * Authenticate + authorize an incoming MCP request. Returns the
   * resolved entity + bearer metadata or null if rejected.
   */
  private async authenticate(
    entityIdSlug: string,
    bearer?: string,
    req?: Request,
  ): Promise<
    | {
        entity: Awaited<ReturnType<McpEntityController["loadEntity"]>>;
        token: {
          tokenHash: string;
          clientId: string;
          mcpUserId: string;
          entityPk: string;
          environmentId: string;
          identityMode: string;
          scopes: string[];
        };
      }
    | { error: string; status: number }
  > {
    let entity: Awaited<ReturnType<McpEntityController["loadEntityByPk"]>> = null;

    // Two token systems are valid here:
    //   1. Bearer PATs (`plt_ent_*`) — minted via the webapp UI / the
    //      `entities.generate_mcp_token` MCP tool. Stored as
    //      PlatosMcpBearerToken rows with sha256 hashes; entity + environment
    //      scoped. The intended use case is CI/CD or a single
    //      service-to-service integrator (e.g. an operator pasting the
    //      token into Claude Code as an HTTP MCP).
    //   2. OAuth 2.1 access tokens (`plt_oa_*`) — minted via the per-entity
    //      OAuth authorize/token flow. Carry a full scope tuple including
    //      environmentId.
    //
    // We try the PAT path first (cheap exact-hash lookup) when the prefix
    // matches, then fall through to OAuth verification. This was a
    // production bug: only OAuth was checked, so every PAT minted via the
    // webapp came back as 401 "invalid or expired token" even though the
    // row existed and was unexpired.
    let verified: {
      tokenHash: string;
      clientId: string;
      mcpUserId: string;
      entityPk: string;
      environmentId: string;
      organizationId: string;
      projectId: string;
      identityMode: string;
      scopes: string[];
    } | null = null;

    if (bearer?.startsWith("plt_ent_")) {
      const patRow = await this.bearerTokenService.validate(bearer);
      if (patRow) {
        entity = await this.loadEntityByPk(patRow.entityPk);
        if (!entity || entity.entityId !== entityIdSlug) {
          return { error: "token not valid for this entity route", status: 403 };
        }
        // sha256(raw) — same hash McpBearerTokenService stored at mint time.
        const tokenHash = crypto.createHash("sha256").update(bearer).digest("hex");
        verified = {
          tokenHash,
          clientId: "pat",
          mcpUserId: patRow.mcpUserId,
          entityPk: patRow.entityPk,
          environmentId: patRow.environmentId,
          organizationId: entity.organizationId,
          projectId: entity.projectId,
          identityMode: "bearer",
          scopes: patRow.scopes ?? [],
        };
      }
    }

    if (!verified) {
      const oauthVerified = await this.oauth.verifyAccessToken(bearer);
      if (oauthVerified) {
        if (!oauthVerified.entityPk) {
          return { error: "token not valid for an entity MCP route", status: 403 };
        }
        entity = await this.loadEntityByPk(oauthVerified.entityPk);
        if (!entity || entity.entityId !== entityIdSlug) {
          return { error: "token not valid for this entity route", status: 403 };
        }
        verified = {
          tokenHash: oauthVerified.tokenHash,
          clientId: oauthVerified.clientId,
          mcpUserId: oauthVerified.mcpUserId,
          entityPk: oauthVerified.entityPk ?? "",
          environmentId: oauthVerified.scope.environmentId,
          organizationId: oauthVerified.scope.organizationId,
          projectId: oauthVerified.scope.projectId,
          // FINDING H12a — the anonymous "continue without signing in" flow
          // (oauth.controller.ts entityAnonAuthorize) mints a normal OAuth
          // token whose userId is prefixed `mcp:anon:`. Labeling it "oidc"
          // would let an anonymous visitor clear a tool's `minIdentityMode:
          // "oidc"` gate (which is meant to require a signed-in user). Map
          // anonymous tokens to the "anonymous" identity tier.
          identityMode: oauthVerified.identityMode,
          scopes: oauthVerified.scopes ?? [],
        };
      }
    }

    if (!verified && bearer) return { error: "invalid or expired token", status: 401 };

    if (!verified && !bearer && req) {
      const anonymousAuthority = await this.loadAnonymousEntity(entityIdSlug, req);
      if ("error" in anonymousAuthority) return anonymousAuthority;
      entity = anonymousAuthority.entity;
      if (!entity.config.enabled) return { error: "entity MCP not enabled", status: 403 };
      const identity = await this.identityResolver.resolve(req, entity.entityPk);
      if ("error" in identity) return identity;
      if (identity.identityMode !== "anonymous") {
        return { error: "invalid anonymous identity", status: 401 };
      }
      const sessionId = String(identity.metadata.sessionId ?? "");
      const session = await this.prisma.mcpAnonymousSession.findFirst({
        where: {
          id: sessionId,
          entityId: entity.entityPk,
          environmentId: identity.environmentId,
          revokedAt: null,
          environment: {
            projectId: entity.projectId,
            project: { organizationId: entity.organizationId },
          },
        },
        select: { id: true, environmentId: true },
      });
      if (!session) return { error: "invalid anonymous session", status: 401 };
      verified = {
        tokenHash: `anonymous:${session.id}`,
        clientId: "anonymous",
        mcpUserId: identity.mcpUserId,
        entityPk: entity.entityPk,
        environmentId: identity.environmentId,
        organizationId: entity.organizationId,
        projectId: entity.projectId,
        identityMode: "anonymous",
        scopes: ["mcp:tools"],
      };
    }

    if (!verified) return { error: "invalid or expired token", status: 401 };
    if (!entity) return { error: "entity MCP not found", status: 404 };
    if (!entity.config.enabled) return { error: "entity MCP not enabled", status: 403 };

    const allowedModes = entity.config.identityMode.split("+");
    if (!allowedModes.includes(verified.identityMode)) {
      return { error: `${verified.identityMode} identity is not enabled for this entity`, status: 403 };
    }

    // PIFSP-21 — cross-entity tokens are rejected. Tokens minted via the
    // platform `/oauth/authorize` path have no entityPk and are not
    // valid on customer-facing MCP surfaces. PATs always have entityPk
    // (set at mint time) but we still verify the entityPk match in case a
    // PAT was minted for a different entity in the same scope.
    if (!verified.entityPk || verified.entityPk !== entity.entityPk) {
      return { error: "token not valid for this entity", status: 403 };
    }

    // PIFSP-21 wave-2-review C2: The OAuth token's environmentId comes from
    // the consent screen. Guard against the case where a user selected an env
    // from a DIFFERENT org at consent (see review caveat C2). If the token's
    // org mismatches the entity's org, reject with 403 rather than letting a
    // mismatched scope silently return no tools (which looks like a broken
    // integration rather than an auth error). Fail-closed. (For PAT path
    // we set organizationId = entity.organizationId so this is a no-op.)
    if (verified.organizationId !== entity.organizationId) {
      return {
        error: "token organization does not match entity — re-authorize against the entity's MCP endpoint",
        status: 403,
      };
    }
    if (verified.projectId !== entity.projectId) {
      return { error: "token project does not match entity", status: 403 };
    }
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: verified.environmentId,
        projectId: entity.projectId,
        archivedAt: null,
        project: { organizationId: entity.organizationId },
      },
      select: { id: true },
    });
    if (!environment) {
      return { error: "token environment does not match entity project", status: 403 };
    }
    return {
      entity,
      token: {
        tokenHash: verified.tokenHash,
        clientId: verified.clientId,
        mcpUserId: verified.mcpUserId,
        entityPk: entity.entityPk,
        environmentId: verified.environmentId,
        identityMode: verified.identityMode,
        scopes: verified.scopes,
      },
    };
  }

  /**
   * PIFSP-21 — per-(mcpUser, entity) rate limit. Redis-backed token
   * bucket using the same pattern as the `monitoring/rate-limit.service`.
   * Returns `{ allowed: false, retryAfter }` on exhaustion.
   */
  private async checkRateLimit(
    entityPk: string,
    mcpUserId: string,
    perMinute: number,
  ): Promise<{ allowed: boolean; retryAfter?: number }> {
    if (perMinute <= 0) return { allowed: true };
    const key = `platos:mcp:rl:${entityPk}:${mcpUserId}:${Math.floor(Date.now() / 60_000)}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, 90);
      }
      if (count > perMinute) {
        return { allowed: false, retryAfter: 60 };
      }
      return { allowed: true };
    } catch {
      // Fail-open on backend errors — never let Redis hiccup block a
      // legitimate tool call. The next minute the bucket reshapes.
      return { allowed: true };
    }
  }

  /**
   * Build a scope-tuple aligned with RequestScope. For the MCP gateway
   * the `userId` slot is the Platos-side user who completed consent
   * (from the OAuth access-token row). The customer-side identity (MCP
   * user id) rides in the `_context.mcpUserId` envelope + audit row.
   */
  private buildScope(
    entity: NonNullable<Awaited<ReturnType<McpEntityController["loadEntity"]>>>,
    token: {
      clientId: string;
      mcpUserId: string;
      entityPk: string;
      environmentId: string;
    },
  ): RequestScope {
    return {
      organizationId: entity.organizationId,
      projectId: entity.projectId,
      environmentId: token.environmentId,
      userId: token.mcpUserId,
      entityId: entity.entityId,
    };
  }

  /**
   * MCP-as-connected-entity (design §3.1 row ii) — resolve the end-user identity
   * for a tool `origin` on the inbound mcp_client path. The scope's `userId` is
   * `token.mcpUserId`; look up a `PlatosEndUser` by that `externalUserId` in
   * scope and return its `externalUserId` (Composio's `user_id`) when one exists.
   *
   * FAIL-CLOSED by omission: when no `PlatosEndUser` resolves (e.g. an
   * `mcp:oidc:*` token that maps through the OIDC session, not an externalUserId,
   * or a client with no end-user row yet) this returns `undefined`, so a
   * downstream `connectionKind="mcp"` tool with a `{{endUserId}}` template fails
   * closed at the §3.2 guard — never a shared/wrong identity. Any error →
   * `undefined` (fail closed).
   */
  private async resolveEndUserIdForScope(
    scope: RequestScope,
  ): Promise<string | undefined> {
    try {
      const oidcSession = await this.prisma.mcpOidcSession.findFirst({
        where: {
          environmentId: scope.environmentId,
          mcpUserId: scope.userId,
          revokedAt: null,
          entity: {
            externalId: scope.entityId,
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
          },
        },
        select: { externalSubject: true },
      });
      if (oidcSession?.externalSubject) return oidcSession.externalSubject;

      const identity = await this.prisma.endUserIdentity.findFirst({
        where: {
          organizationId: scope.organizationId,
          subject: scope.userId,
          disabledAt: null,
          endUser: { disabledAt: null },
        },
        select: { subject: true },
      });
      return identity?.subject || undefined;
    } catch {
      return undefined;
    }
  }

  /** Filter the entity's matrix to `toolAllowlist`. Empty list = no tools. */
  private filteredAllowlist(entityCfg: { toolAllowlist: string[] }): Set<string> {
    return new Set(entityCfg.toolAllowlist ?? []);
  }

  // ═════════════════════════════════════════════════════════════════════
  // HTTP (streamable JSON-RPC)
  // ═════════════════════════════════════════════════════════════════════

  @Post(":entityId")
  async jsonRpc(
    @Param("entityId") entityIdSlug: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() body: JsonRpcRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JsonRpcResponse> {
    const bearer = this.extractBearer(authorization);
    const auth = await this.authenticate(entityIdSlug, bearer ?? undefined, req);
    if ("error" in auth) {
      throw new HttpException(auth.error, auth.status);
    }
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      throw new HttpException(
        "body must be a JSON-RPC 2.0 request with `method`",
        HttpStatus.BAD_REQUEST,
      );
    }
    const response = await this.handleRpc(body, auth.entity!, auth.token);
    // When the JSON-RPC body carries a rate-limit error, surface the
    // retry hint as the standard HTTP `Retry-After` header so MCP
    // clients (Claude Code, Inspector, etc.) can back off without
    // parsing the JSON-RPC envelope.
    if (response.error && response.error.code === RPC_ERRORS.RATE_LIMITED) {
      const data = response.error.data as { retryAfterSeconds?: number } | undefined;
      const retry = data?.retryAfterSeconds ?? 60;
      res.setHeader("Retry-After", String(retry));
    }
    return response;
  }

  @Get(":entityId/sse")
  async sse(
    @Param("entityId") entityIdSlug: string,
    @Req() req: Request,
    @Res() res: Response,
    @Headers("authorization") authorization: string | undefined,
  ): Promise<void> {
    const bearer = this.extractBearer(authorization);
    const auth = await this.authenticate(entityIdSlug, bearer ?? undefined, req);
    if ("error" in auth) {
      res.status(auth.status).send(auth.error);
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sessionId = crypto.randomBytes(16).toString("hex");
    // Session is stored in Redis so multi-replica agent pods can route the
    // client's POST /messages correctly. TTL bounded at 1h to match
    // OAuth access-token TTL.
    const sessionKey = `platos:mcp:entity:session:${sessionId}`;
    await this.redis.set(
      sessionKey,
      JSON.stringify({
        entityIdSlug,
        tokenHash: auth.token.tokenHash,
        token: auth.token,
      }),
      "EX",
      3600,
    );
    const endpointUrl = `/mcp/entity/${encodeURIComponent(entityIdSlug)}/messages?sessionId=${sessionId}`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

    const pingInterval = setInterval(() => {
      try {
        const msg = JSON.stringify({ jsonrpc: "2.0", method: "notifications/ping" });
        res.write(`event: message\ndata: ${msg}\n\n`);
      } catch {
        /* socket closed */
      }
    }, 30_000);

    const sseChannel = `platos:mcp:entity:sse:${sessionId}`;
    const sub = this.redis.duplicate();
    try {
      await sub.subscribe(sseChannel);
    } catch {
      /* best-effort */
    }
    sub.on("message", (_ch, message) => {
      try {
        res.write(`event: message\ndata: ${message}\n\n`);
      } catch {
        /* socket closed */
      }
    });

    const cleanup = () => {
      clearInterval(pingInterval);
      sub.unsubscribe(sseChannel).catch(() => {
        /* */
      });
      sub.quit().catch(() => {
        /* */
      });
      this.redis.del(sessionKey).catch(() => {
        /* */
      });
      try {
        res.end();
      } catch {
        /* */
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  @Post(":entityId/messages")
  async messages(
    @Param("entityId") entityIdSlug: string,
    @Query("sessionId") sessionId: string | undefined,
    @Body() body: JsonRpcRequest,
    @Res() res: Response,
  ): Promise<void> {
    if (!sessionId) {
      res.status(400).send("missing sessionId query param");
      return;
    }
    const sessionKey = `platos:mcp:entity:session:${sessionId}`;
    const raw = await this.redis.get(sessionKey).catch(() => null);
    if (!raw) {
      res.status(404).send("unknown or expired sessionId");
      return;
    }
    let parsed: {
      entityIdSlug: string;
      tokenHash: string;
      token: {
        tokenHash: string;
        clientId: string;
        mcpUserId: string;
        entityPk: string;
        environmentId: string;
        identityMode: string;
        scopes: string[];
      };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.status(500).send("corrupt session record");
      return;
    }
    if (parsed.entityIdSlug !== entityIdSlug) {
      res.status(400).send("sessionId does not match entity");
      return;
    }
    // Re-authenticate by looking up the token row directly from the stored
    // hash. The raw bearer is not stored (would defeat the at-rest
    // hashing); we reconstruct the token metadata via the DB. Try the
    // OAuth access-token table first, then fall back to PlatosMcpBearerToken
    // (PAT path) so SSE clients using `plt_ent_*` tokens also work.
    const oauthRow = await this.oauth.verifyAccessTokenHash(parsed.tokenHash);
    const isAnonymous = parsed.tokenHash.startsWith("anonymous:");
    const patRow = !isAnonymous && !oauthRow
      ? await this.bearerTokenService.validateHash(parsed.tokenHash)
      : null;
    if (!isAnonymous && !oauthRow && !patRow) {
      res.status(401).send("session token revoked or expired");
      return;
    }
    const authoritativeEntityPk = oauthRow?.entityPk ?? patRow?.entityPk ?? parsed.token.entityPk;
    const entity = authoritativeEntityPk
      ? await this.loadEntityByPk(authoritativeEntityPk)
      : null;
    if (!entity || entity.entityId !== entityIdSlug) {
      res.status(403).send("session token does not match entity route");
      return;
    }
    if (!entity.config.enabled) {
      res.status(403).send("entity MCP not enabled");
      return;
    }

    let token: {
      tokenHash: string;
      clientId: string;
      mcpUserId: string;
      entityPk: string;
      environmentId: string;
      identityMode: string;
      scopes: string[];
    } | null = null;

    if (isAnonymous) {
      const anonymousSession = await this.prisma.mcpAnonymousSession.findFirst({
        where: {
          id: parsed.tokenHash.slice("anonymous:".length),
          entityId: entity.entityPk,
          environmentId: parsed.token.environmentId,
          revokedAt: null,
          environment: {
            projectId: entity.projectId,
            project: { organizationId: entity.organizationId },
          },
        },
        select: { id: true },
      });
      if (!anonymousSession || parsed.token.identityMode !== "anonymous") {
        res.status(401).send("anonymous session revoked or expired");
        return;
      }
      token = parsed.token;
    } else if (oauthRow) {
      if (
        oauthRow.entityPk !== entity.entityPk ||
        oauthRow.scope.organizationId !== entity.organizationId ||
        oauthRow.scope.projectId !== entity.projectId ||
        oauthRow.scope.environmentId !== parsed.token.environmentId
      ) {
        res.status(403).send("token not valid for this entity");
        return;
      }
      token = {
        tokenHash: oauthRow.tokenHash,
        clientId: oauthRow.clientId,
        mcpUserId: oauthRow.mcpUserId,
        entityPk: entity.entityPk,
        environmentId: oauthRow.scope.environmentId,
        identityMode: oauthRow.identityMode,
        scopes: oauthRow.scopes,
      };
    } else {
      // PAT path — revalidate the exact persisted entity + environment owner.
      if (!patRow) {
        res.status(401).send("session token revoked or expired");
        return;
      }
      if (
        patRow.entityPk !== entity.entityPk ||
        patRow.environmentId !== parsed.token.environmentId
      ) {
        res.status(403).send("token not valid for this entity");
        return;
      }
      token = {
        tokenHash: parsed.tokenHash,
        clientId: "pat",
        mcpUserId: patRow.mcpUserId,
        entityPk: entity.entityPk,
        environmentId: patRow.environmentId,
        identityMode: "bearer",
        scopes: patRow.scopes,
      };
    }

    if (!entity.config.identityMode.split("+").includes(token.identityMode)) {
      res.status(403).send(`${token.identityMode} identity is not enabled for this entity`);
      return;
    }
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: token.environmentId,
        projectId: entity.projectId,
        archivedAt: null,
        project: { organizationId: entity.organizationId },
      },
      select: { id: true },
    });
    if (!environment) {
      res.status(403).send("token environment does not match entity project");
      return;
    }

    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      res.status(400).send("body must be a JSON-RPC 2.0 request");
      return;
    }

    // 202 ack; response rides the SSE stream.
    res.status(202).send();
    try {
      const response = await this.handleRpc(body, entity, token);
      const frame = JSON.stringify(response);
      await this.redis.publish(`platos:mcp:entity:sse:${sessionId}`, frame);
    } catch (err) {
      const rpcError = {
        jsonrpc: "2.0" as const,
        id: body.id ?? null,
        error: {
          code: RPC_ERRORS.INTERNAL_ERROR,
          message: err instanceof Error ? err.message : "internal error",
        },
      };
      await this.redis.publish(
        `platos:mcp:entity:sse:${sessionId}`,
        JSON.stringify(rpcError),
      );
    }
  }

  /**
   * Placeholder for the notifications subscription stream — the full
   * feature lands in PIFSP-23 with filter support + event-bus integration.
   * Ships a minimal ping-only stream here so MCP clients that expect
   * the endpoint to exist can open it without errors.
   */
  @Get(":entityId/events/subscribe")
  async eventsSubscribe(
    @Param("entityId") entityIdSlug: string,
    @Query("token") tokenParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const auth = await this.authenticate(entityIdSlug, tokenParam, req);
    if ("error" in auth) {
      res.status(auth.status).send(auth.error);
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(
      `event: hello\ndata: ${JSON.stringify({
        entityId: entityIdSlug,
        mcpUserId: auth.token.mcpUserId,
      })}\n\n`,
    );
    const ping = setInterval(() => {
      try {
        res.write(`event: ping\ndata: {}\n\n`);
      } catch {
        /* */
      }
    }, 30_000);
    const cleanup = () => {
      clearInterval(ping);
      try {
        res.end();
      } catch {
        /* */
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  // ═════════════════════════════════════════════════════════════════════
  // JSON-RPC method dispatch
  // ═════════════════════════════════════════════════════════════════════

  private async handleRpc(
    req: JsonRpcRequest,
    entity: NonNullable<Awaited<ReturnType<McpEntityController["loadEntity"]>>>,
    token: {
      clientId: string;
      mcpUserId: string;
      entityPk: string;
      environmentId: string;
      identityMode: string;
      scopes: string[];
    },
  ): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {}, logging: {} },
              serverInfo: {
                name: `platos-entity-mcp:${entity.entityId}`,
                version: "0.1.0",
              },
            },
          };
        case "notifications/ping":
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          // await (not bare return) so a rejection from the ACL prisma query
          // is caught by this try/catch and returned as a JSON-RPC error
          // envelope rather than escaping to an HTTP 500 on the streamable path.
          return await this.handleToolsList(id, entity, token);
        case "tools/call":
          return await this.handleToolsCall(id, req.params as any, entity, token);
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: RPC_ERRORS.METHOD_NOT_FOUND,
              message: `method '${req.method}' not supported on entity MCP`,
            },
          };
      }
    } catch (err: any) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERRORS.INTERNAL_ERROR,
          message: err?.message || "internal error",
        },
      };
    }
  }

  private async handleToolsList(
    id: string | number | null,
    entity: NonNullable<Awaited<ReturnType<McpEntityController["loadEntity"]>>>,
    token: {
      mcpUserId: string;
      clientId: string;
      entityPk: string;
      environmentId: string;
      identityMode: string;
      scopes: string[];
    },
  ): Promise<JsonRpcResponse> {
    const scope = this.buildScope(entity, token);
    const allowlist = this.filteredAllowlist(entity.config);
    // PIFSP-25 — empty allowlist = zero tools. We intentionally do NOT
    // fall back to the full matrix here.
    if (allowlist.size === 0) {
      return { jsonrpc: "2.0", id, result: { tools: [] } };
    }
    // Narrow the scope matrix to this entity + to tools on the allowlist.
    const visibleEntities = this.toolRouter.visibleEntitiesForAgent(scope);
    // FINDING H12 — per-tool identity ACL. The allowlist above is the coarse
    // entity-wide gate; each exposed tool also carries an ACL row with
    // minIdentityMode / allowedPatIds / scopeLabels. Hide any tool the
    // caller's identity is not permitted to see. Build a name->row map so a
    // tool with no ACL row falls back to the system default below (symmetric
    // with handleToolsCall — a rowless allowlisted tool is gated at the
    // default "bearer" floor in BOTH list and call, never list-hidden-yet-
    // callable).
    const caller = {
      identityMode: token.identityMode,
      mcpUserId: token.mcpUserId,
      scopes: token.scopes,
    };
    const aclRows = await this.toolAclService.getExposedPoliciesByName(
      entity.entityPk,
      token.environmentId,
    );
    // FINDING H12 (residual) — the ACL uniqueness key is (entityPk, toolId), so
    // ONE entity can hold several exposed rows for the SAME toolName. The old
    // `new Map(rows.map(...))` let the LAST row win while handleToolsCall's
    // findFirst took the FIRST — the two paths could pick different rows for
    // one name (list-hidden yet callable). Group ALL rows per name; the gate
    // below requires EVERY row to admit the caller (most-restrictive wins),
    // which is order-independent and mirrored exactly in handleToolsCall.
    const aclByName = new Map<string, any[]>();
    for (const r of aclRows as Array<{ toolName: string }>) {
      const existing = aclByName.get(r.toolName);
      if (existing) existing.push(r);
      else aclByName.set(r.toolName, [r]);
    }
    const matches: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      category: string;
    }> = [];
    // We piggy-back on toolRouter.resolve's matrix by calling it per tool in
    // the allowlist — keeps a single source-of-truth + reuses enabledOnly.
    for (const toolName of allowlist) {
      // FINDING H12 — skip tools the caller's identity may not access. Rowless
      // allowlisted tools use the system-default ACL (min "bearer"), matching
      // handleToolsCall's fallback.
      const effectiveAcls: any[] = aclByName.get(toolName) ?? [
        {
          toolName,
          minIdentityMode: "bearer",
          allowedPatIds: [] as string[],
          scopeLabels: ["mcp:tools"],
        },
      ];
      // Most-restrictive wins: the tool is visible only if EVERY exposed row
      // for this name admits the caller. Identical rule in handleToolsCall.
      if (
        this.toolAclService.filterByIdentity(effectiveAcls, caller).length !== effectiveAcls.length
      ) {
        continue;
      }
      const route = this.toolRouter.resolve({
        scope,
        toolName,
        entityIds: [entity.entityId],
        disambiguationStrategy: "first-match",
        enabledOnly: true,
      });
      if (route.ok) {
        matches.push({
          name: route.toolName,
          // We don't have description cheaply here — paramSchema carries
          // the shape; the dashboard's MCP tab will render details. Use
          // a stub description so the client knows it's valid.
          description: (route.paramSchema as { description?: string }).description ?? "",
          inputSchema: route.paramSchema,
          category: route.category ?? "uncategorized",
        });
      }
    }
    // Silence unused warning on visibleEntities — kept for future
    // debugging (e.g. if the entity has zero tools mapped we can report
    // a clearer error in PIFSP-25).
    void visibleEntities;
    return { jsonrpc: "2.0", id, result: { tools: matches } };
  }

  private async handleToolsCall(
    id: string | number | null,
    params: { name?: string; arguments?: Record<string, unknown> } | undefined,
    entity: NonNullable<Awaited<ReturnType<McpEntityController["loadEntity"]>>>,
    token: {
      clientId: string;
      mcpUserId: string;
      entityPk: string;
      environmentId: string;
      identityMode: string;
      scopes: string[];
    },
  ): Promise<JsonRpcResponse> {
    const name = params?.name;
    if (!name || typeof name !== "string") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.INVALID_PARAMS, message: "`name` is required" },
      };
    }
    const allowlist = this.filteredAllowlist(entity.config);
    if (!allowlist.has(name)) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERRORS.PERMISSION_DENIED,
          message: `tool '${name}' not in entity allowlist`,
        },
      };
    }

    // FINDING H12 — per-tool identity ACL. The allowlist above is the coarse
    // entity-wide gate; enforce the tool's ACL row (minIdentityMode /
    // allowedPatIds / scopeLabels) against the caller's identity. Fail CLOSED
    // to the SYSTEM DEFAULT ACL when no row exists: the coarse allowlist can
    // be written directly via the entity config PATCH (patchEntityMcpConfig)
    // without creating an ACL row, and autoInsert() has no callers, so "a row
    // always exists" is NOT an enforced invariant. Skipping the gate on a
    // rowless tool (the old `if (aclRow)`) was a fail-open bypass AND was
    // asymmetric with tools/list (which hid such tools). The default row
    // (min "bearer") denies anonymous callers and matches the synthetic
    // default used across mcp-tool-acl.service.ts.
    // `exposed: true` mirrors handleToolsList's filter so an un-exposed row
    // (e.g. one re-added to toolAllowlist via the config PATCH) is ignored
    // here too and falls back to the default below — keeps list and call
    // applying the SAME effective ACL (no callable-but-list-hidden drift).
    // FINDING H12 (residual) — findFirst took whichever duplicate-toolName row
    // the DB happened to return first while tools/list took the last, so the
    // two paths could apply different gates to one tool name. Load ALL exposed
    // rows for the name and require every one of them to admit the caller
    // (most-restrictive wins) — same rule, same result, no ordering assumed.
    const aclRowsForName = await this.toolAclService.getExposedPoliciesByName(
      entity.entityPk,
      token.environmentId,
      name,
    );
    const effectiveAcls: any[] =
      aclRowsForName.length > 0
        ? aclRowsForName
        : [
            {
              toolName: name,
              minIdentityMode: "bearer",
              allowedPatIds: [] as string[],
              scopeLabels: ["mcp:tools"],
            },
          ];
    const permitted = this.toolAclService.filterByIdentity(effectiveAcls, {
      identityMode: token.identityMode,
      mcpUserId: token.mcpUserId,
      scopes: token.scopes,
    });
    if (permitted.length !== effectiveAcls.length) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERRORS.PERMISSION_DENIED,
          message: `tool '${name}' not permitted for this identity`,
        },
      };
    }

    // PIFSP-21 — per-(mcpUser, entity) rate limit.
    const rl = await this.checkRateLimit(
      entity.entityPk,
      token.mcpUserId,
      entity.config.rateLimitPerMinute,
    );
    if (!rl.allowed) {
      const retryAfter = rl.retryAfter ?? 60;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERRORS.RATE_LIMITED,
          message: `Rate limit reached. Try again in ${retryAfter} seconds.`,
          data: {
            code: "rate_limit",
            retryAfterSeconds: retryAfter,
            scope: "user_per_minute",
            limit: entity.config.rateLimitPerMinute,
          },
        },
      };
    }

    const scope = this.buildScope(entity, token);
    // PIFSP-21 — delegate resolution to the PIFSP-11 primitive. The
    // tool-executor will ALSO re-resolve; doing it here lets us short-
    // circuit with a clean error when the tool isn't in the matrix.
    const route = this.toolRouter.resolve({
      scope,
      toolName: name,
      entityIds: [entity.entityId],
      disambiguationStrategy: "first-match",
      enabledOnly: true,
    });
    if (!route.ok) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: RPC_ERRORS.METHOD_NOT_FOUND,
          message: route.detail,
        },
      };
    }

    // MCP-as-connected-entity (design §3.1 row ii) — resolve the end user so a
    // downstream connectionKind="mcp" tool can substitute `{{endUserId}}`;
    // undefined ⇒ templated mcp tool fails closed at the §3.2 guard.
    const endUserId = await this.resolveEndUserIdForScope(scope);
    const result = await this.toolExecutor.execute(
      {
        tool: name,
        params: params?.arguments ?? {},
        purpose: "mcp_client",
      },
      scope,
      // PIFSP-21 — propagate MCP-origin metadata. The audit row picks
      // up `source`/`mcpUserId`/`mcpClientId`; the dispatch envelope
      // carries `source: "mcp_client"` so entity backends can
      // distinguish LLM turns from external MCP clients.
      {
        source: "mcp_client",
        mcpUserId: token.mcpUserId,
        mcpClientId: token.clientId,
        endUserId,
      },
      {
        entityPk: route.entityPk,
        entityId: route.entityId,
        toolId: route.toolId,
      },
    );

    if (result.status === "success") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text:
                typeof result.result === "string"
                  ? result.result
                  : JSON.stringify(result.result),
            },
          ],
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: RPC_ERRORS.INTERNAL_ERROR,
        message: result.error ?? "tool dispatch failed",
        data: { status: result.status, latencyMs: result.latencyMs },
      },
    };
  }

  // ─── PIFSP-22 — Bearer PAT management ─────────────────────────────────

  /** List PATs for an entity (hashes never returned). Scope-gated by ScopeGuard. */
  @Get(":entityId/tokens")
  async listBearerTokens(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    return this.bearerTokenService.list(
      entity.entityPk,
      scope.environmentId,
      {
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      },
    );
  }

  /** Generate a new PAT. Returns the raw token — shown once. */
  @Post(":entityId/tokens")
  async generateBearerToken(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: { label: string; scopes?: string[]; expiresIn?: number },
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    const expiresAt = body.expiresIn ? new Date(Date.now() + body.expiresIn * 1000) : undefined;
    const result = await this.bearerTokenService.generate(
      entity.entityPk,
      scope.environmentId,
      body.label ?? "PAT",
      scope.userId,
      { scopes: body.scopes, expiresAt },
    );
    return result; // includes raw token (show once)
  }

  /** Revoke a PAT by id. */
  @Delete(":entityId/tokens/:tokenId")
  async revokeBearerToken(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Param("tokenId") tokenId: string,
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) {
      throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    }
    const ok = await this.bearerTokenService.revoke(
      tokenId,
      entity.entityPk,
      scope.environmentId,
      scope.userId,
    );
    return { revoked: ok };
  }

  // ─── PIFSP-25 — Tool ACL ───────────────────────────────────────────────

  @Get(":entityId/tool-acl")
  async listToolAcl(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Query("exposed") exposed?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const result = await this.toolAclService.list(entity.entityPk, scope.environmentId, {
      exposed: exposed === "true" ? true : exposed === "false" ? false : undefined,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
    return result;
  }

  @Patch(":entityId/tool-acl/:toolId")
  async patchToolAcl(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Param("toolId") toolId: string,
    @Body() body: { exposed?: boolean; minIdentityMode?: string; allowedPatIds?: string[]; scopeLabels?: string[] },
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    // Resolve toolName from the mapping row. The frontend sends `toolId`
    // pulled from `list()`'s synthesized rows, which is the
    // PlatosEntityToolMapping.id. PlatosEntityToolMapping uses `entityId`
    // (FK → PlatosConnectedEntity.id) — NOT `entityPk` — and the
    // human-readable name lives on the joined PlatosToolDefinition.
    const toolReg = await this.prisma.environmentEntityTool.findFirst({
      where: { id: toolId, entityId: entity.entityPk, environmentId: scope.environmentId },
      select: { toolId: true, tool: { select: { name: true } } },
    });
    if (!toolReg) throw new HttpException("Tool not found", HttpStatus.NOT_FOUND);
    const row = await this.toolAclService.upsert(
      entity.entityPk,
      scope.environmentId,
      toolReg.toolId,
      toolReg.tool.name,
      scope.userId,
      body,
    );
    return row;
  }

  @Post(":entityId/tool-acl/bulk")
  async bulkToolAcl(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: { action: "expose" | "hide" | "set_identity"; toolIds: string[]; minIdentityMode?: string },
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const count = await this.toolAclService.bulk(entity.entityPk, scope.environmentId, body.toolIds, body.action, {
      minIdentityMode: body.minIdentityMode,
      addedBy: scope.userId,
    });
    return { updated: count };
  }

  // ─── PIFSP-23 — MCPs dashboard list endpoint ──────────────────────────

  /**
   * List all entities in scope with their MCP config.
   * Used by /mcps/_index route.
   */
  @Get()
  async listMcps(@Req() req: Request) {
    const scope = this.getOperatorScope(req);
    // Entity ownership is canonical through Project. Environment-specific
    // enablement is represented by tool mappings rather than an Entity column.
    const entities = await this.prisma.entity.findMany({
      where: {
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        mcpConfig: true,
        _count: { select: { mcpBearerTokens: true } },
      },
    });
    return {
      entities: entities.map((e: any) => ({
        entityId: e.externalId,
        entityPk: e.id,
        displayName: e.displayName,
        mcpEnabled: e.mcpConfig?.enabled ?? false,
        identityMode: e.mcpConfig?.identityMode ?? "anonymous",
        toolCount: (e.mcpConfig?.toolAllowlist ?? []).length,
        bearerTokenCount: e._count.mcpBearerTokens,
      })),
    };
  }

  /** Get full MCP config for a specific entity. */
  @Get(":entityId/config")
  async getMcpConfig(@Req() req: Request, @Param("entityId") entityId: string) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const config = await this.prisma.entityMcpConfig.findUnique({
      where: { entityId: entity.entityPk },
    });
    return { entityId, entityPk: entity.entityPk, config };
  }

  /** Canonical dashboard write contract for the complete persisted MCP config. */
  @Patch(":entityId/config")
  async patchMcpConfig(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: {
      enabled?: boolean;
      identityMode?: string;
      identityProviders?: unknown;
      branding?: unknown;
      toolAllowlist?: unknown;
      redirectUriAllowlist?: unknown;
      rateLimitPerMinute?: unknown;
      injectMcpContext?: boolean;
    },
  ) {
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    const update: Record<string, unknown> = {};
    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (body.identityMode !== undefined) {
      update.identityMode = validateMcpIdentityMode(body.identityMode);
    }
    if (body.identityProviders !== undefined) {
      update.identityProviders = validateIdentityProviders(body.identityProviders);
    }
    if (body.branding !== undefined) {
      if (!body.branding || typeof body.branding !== "object" || Array.isArray(body.branding)) {
        throw new BadRequestException("branding must be a JSON object");
      }
      update.branding = body.branding;
    }
    if (body.toolAllowlist !== undefined) {
      if (!Array.isArray(body.toolAllowlist)) throw new BadRequestException("toolAllowlist must be an array");
      update.toolAllowlist = body.toolAllowlist.filter((value): value is string => typeof value === "string").slice(0, 500);
    }
    if (body.redirectUriAllowlist !== undefined) {
      if (!Array.isArray(body.redirectUriAllowlist)) throw new BadRequestException("redirectUriAllowlist must be an array");
      update.redirectUriAllowlist = body.redirectUriAllowlist.filter((value): value is string => typeof value === "string").slice(0, 50);
    }
    if (body.rateLimitPerMinute !== undefined) {
      if (!Number.isInteger(body.rateLimitPerMinute) || Number(body.rateLimitPerMinute) < 1 || Number(body.rateLimitPerMinute) > 10_000) {
        throw new BadRequestException("rateLimitPerMinute must be an integer between 1 and 10000");
      }
      update.rateLimitPerMinute = body.rateLimitPerMinute;
    }
    if (typeof body.injectMcpContext === "boolean") {
      update.injectMcpContext = body.injectMcpContext;
    }
    await this.prisma.entityMcpConfig.upsert({
      where: { entityId: entity.entityPk },
      create: {
        entityId: entity.entityPk,
        enabled: false,
        identityMode: "bearer",
        identityProviders: [],
        branding: {},
        toolAllowlist: [],
        rateLimitPerMinute: 60,
        redirectUriAllowlist: [],
        injectMcpContext: false,
        ...update,
      },
      update,
    });
    const config = await this.prisma.entityMcpConfig.findUnique({
      where: { entityId: entity.entityPk },
    });
    if (!config) throw new HttpException("MCP config unavailable", HttpStatus.SERVICE_UNAVAILABLE);
    if (body.injectMcpContext !== undefined) {
      try {
        await this.toolRegistry.rebuildIndex();
      } catch {
        // Persisted state remains authoritative; registry repair is retryable.
      }
    }
    return { entityId, entityPk: entity.entityPk, config };
  }

  /** PIFSP-24 — Update branding JSON on the entity's MCP config. */
  @Patch(":entityId/branding")
  async updateBranding(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() branding: Record<string, unknown>,
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    await this.prisma.entityMcpConfig.upsert({
      where: { entityId: entity.entityPk },
      create: {
        entityId: entity.entityPk,
        enabled: false,
        branding: branding as any,
        identityMode: "anonymous",
        identityProviders: [],
        toolAllowlist: [],
        rateLimitPerMinute: 60,
        redirectUriAllowlist: [],
      },
      update: { branding: branding as any },
    });
    return { ok: true };
  }

  /** PIFSP-24 — Update identity mode config + optional identityProviders JSON. */
  @Patch(":entityId/identity")
  async updateIdentityMode(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: { identityMode?: string; identityProviders?: unknown },
  ) {
    // BUG-1: get scope first so loadEntity can scope the slug lookup to this tenant.
    const scope = this.getOperatorScope(req);
    const entity = await this.loadEntity(entityId, scope);
    if (!entity) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (entity.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const updateData: Record<string, unknown> = {};
    if (body.identityMode !== undefined) updateData.identityMode = validateMcpIdentityMode(body.identityMode);
    if (body.identityProviders !== undefined) updateData.identityProviders = validateIdentityProviders(body.identityProviders);
    await this.prisma.entityMcpConfig.updateMany({
      where: { entityId: entity.entityPk },
      data: updateData,
    });
    return { ok: true };
  }

  /** Toggle MCP enabled/disabled for an entity. Creates config row if absent. */
  @Patch(":entityId/enabled")
  async setEnabled(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: { enabled: boolean },
  ) {
    // BUG-1: scope the lookup to (organizationId, projectId) to prevent cross-tenant discovery.
    const scope = this.getOperatorScope(req);
    const ent = await this.prisma.entity.findFirst({
      where: {
        externalId: entityId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { id: true, project: { select: { organizationId: true } } },
    });
    if (!ent) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (ent.project.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    await this.prisma.entityMcpConfig.upsert({
      where: { entityId: ent.id },
      create: {
        entityId: ent.id,
        enabled: body.enabled,
        identityMode: "bearer",
        identityProviders: [],
        branding: {},
        toolAllowlist: [],
        rateLimitPerMinute: 60,
        redirectUriAllowlist: [],
      },
      update: { enabled: body.enabled },
    });
    return { ok: true, enabled: body.enabled };
  }

  /**
   * MCPF-followup: toggle the per-entity `_context` envelope injection
   * flag. Default OFF — backwards-compat with entity backends whose
   * tool functions don't accept unexpected `_context` kwargs. Operator
   * flips this on once their backend is on a platools-py version that
   * handles the envelope.
   */
  @Patch(":entityId/inject-context")
  async setInjectMcpContext(
    @Req() req: Request,
    @Param("entityId") entityId: string,
    @Body() body: { injectMcpContext: boolean },
  ) {
    const scope = this.getOperatorScope(req);
    const ent = await this.prisma.entity.findFirst({
      where: {
        externalId: entityId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { id: true, project: { select: { organizationId: true } } },
    });
    if (!ent) throw new HttpException("Entity not found", HttpStatus.NOT_FOUND);
    if (ent.project.organizationId !== scope.organizationId) throw new HttpException("Forbidden", HttpStatus.FORBIDDEN);
    const inject = body.injectMcpContext === true;
    await this.prisma.entityMcpConfig.upsert({
      where: { entityId: ent.id },
      create: {
        entityId: ent.id,
        enabled: false,
        identityMode: "bearer",
        identityProviders: [],
        branding: {},
        toolAllowlist: [],
        rateLimitPerMinute: 60,
        redirectUriAllowlist: [],
        injectMcpContext: inject,
      },
      update: { injectMcpContext: inject },
    });
    // Bust the in-memory tool registry cache so the new flag takes
    // effect on the next dispatch without an agent restart.
    try {
      await this.toolRegistry.rebuildIndex();
    } catch {
      // Cache rebuild best-effort — DB row is the source of truth.
    }
    return { ok: true, injectMcpContext: inject };
  }
}
