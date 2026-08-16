import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import {
  ACCESS_KEY_SAFE_SELECT,
  CredentialKind,
  PlatosSecretStore,
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
  rotateAccessKey,
  type EnvironmentAuthorizationAccess,
  type EnvironmentOperatorAuthorization,
  type OperatorAuthorization,
} from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  PLATOS_SECRET_STORE_TOKEN,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import * as crypto from "crypto";
import { ToolRegistryService } from "../tool-gateway/tool-registry.service";
import type { RequestScope } from "./scope.guard";

/**
 * Session token claims.
 *
 * Every scoped token is a standard HS256 JWT signed by the Platos platform.
 * Entity-backed end-user tokens additionally carry `authorizationId`, the ID
 * of the clean McpBearerToken that authorized the mint. Validation re-loads
 * that row and its Entity ancestry so bearer revocation/expiry immediately
 * invalidates already-minted HTTP and WebSocket session tokens.
 *
 * `userToken` is an OPTIONAL opaque blob — the customer's own user JWT (or
 * any identity proof). Platos never parses it; it just forwards it on tool
 * calls as `X-Platos-User-Token` so the entity handler can re-verify the
 * user with its own auth stack.
 */
export interface SessionPayload {
  organizationId: string;
  projectId: string;
  environmentId: string;
  entityId?: string;
  /** Persisted McpBearerToken that authorized an entity end-user mint. */
  authorizationId?: string;
  userId: string;
  userToken?: string;       // opaque user identity proof from the entity's auth system
  permissions?: string[];
  iss: "platos-platform";
  iat: number;
  /** PIFSP-1 — optional agent scope. When set the token can only be used
   * with that specific agent (ScopeGuard enforces path match). */
  agentId?: string;
  /** Optional caller-supplied identity hints (visitor name, email).
   * Surfaced to the agent prompt as `{{user.name}}` / `{{user.email}}`
   * via scope.sessionContext, enriches PlatosEndUser asynchronously. */
  userMeta?: { name?: string; email?: string };
  /**
   * Optional channel-native identity claims asserted by the entity backend
   * (the trust anchor that already authenticated the end-user on its own
   * side). Each entry is a (channel, handle) pair — e.g.
   * `{ channel: "email", handle: "a@b.com", verified: true }`. `verified`
   * claims let ConversationService.resolveEndUser link this session to a
   * canonical PlatosEndUser across channels (link-not-merge). Sanitized at
   * mint time (max 8 entries; channel /^[a-z0-9_-]{1,32}$/; handle 1..256,
   * no control chars). NEVER copied from guest tokens.
   */
  userIdentities?: Array<{ channel: string; handle: string; verified?: boolean }>;
  exp: number;
}

export interface EntityRegistration {
  organizationId: string;
  projectId: string;
  environmentId?: string;
  entityId: string; // human-readable slug e.g. "fandesk-main"
  displayName: string;
  mcpUrls: string[];
  serviceSecret: string;
  // Per-tool params live on the agent editor as "MCP arguments".

  // MCP-connected-entity (design Commit 5 / §1.5a). Default "wire" — the
  // classic inbound platools relationship. "mcp" = an OUTBOUND MCP client
  // relationship (Composio, Linear-hosted, any streamable-HTTP MCP server).
  connectionKind?: "wire" | "mcp";
  /**
   * Transport config for a `connectionKind === "mcp"` entity — reparented onto
   * the entity's 1:1 `PlatosEntityMcpClient` row. REQUIRED when
   * `connectionKind === "mcp"`; ignored otherwise. The outbound endpoint lives
   * here as `url`, NOT on `mcpUrls` (which is the wire "sync-from" list — §1.5a
   * warns against overloading it).
   */
  mcpClient?: {
    transport: string; // "remote-http" | "remote-sse" | "hosted-*" (stdio deferred)
    url?: string | null; // remote only; MAY contain {{endUserId}}
    credsSecretKey?: string | null; // bare Credential name; never the raw secret
    headersTemplate?: unknown; // { header: valueTemplate }; values may embed {{secret}}/{{endUserId}}
  };
}

export type AccessKeyOperatorScope = Pick<
  RequestScope,
  | "organizationId"
  | "projectId"
  | "environmentId"
  | "userId"
  | "sessionId"
  | "principal"
  | "operatorUserId"
>;

/**
 * AuthService — handles session tokens, HMAC verification, and entity registry.
 *
 * Session tokens are short-lived platform-signed JWTs. Entity end-user mints
 * are authorized by a clean McpBearerToken and remain bound to its lifecycle.
 *
 * HMAC: used for Platos→entity tool calls (service-to-service auth).
 *   Each entity has a serviceSecret. Platos signs requests, entity verifies.
 *
 * Entity registry: CRUD for connected entities, scoped by (organizationId, projectId).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private prisma: ControlDatabaseClient;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: ControlDatabaseClient,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    // Optional so focused test modules that never touch entity deletion do not
    // have to pull the whole tool gateway in. ToolGatewayModule has no edge
    // back into AuthModule, so this import direction introduces no cycle.
    @Optional() private readonly toolRegistry?: ToolRegistryService,
    @Optional()
    @Inject(PLATOS_SECRET_STORE_TOKEN)
    private readonly secretStore?: PlatosSecretStore,
  ) {
    this.prisma = prisma;
  }

  /**
   * EOBD.5 — read the platform signing secret on every call instead of
   * capturing once in the constructor. Allows hot rotation: operator
   * updates SESSION_SECRET + restarts nothing, and the next
   * validate / mint call picks up the new value.
   *
   * Existing sockets revalidate the signed token before each client event, so
   * rotating the secret invalidates their next operation without a restart.
   *
   * Shared secret for all scoped session tokens. Must be set in production.
   */
  private get platformSigningSecret(): string | undefined {
    const secret = process.env.SESSION_SECRET?.trim();
    return secret && secret.length >= 16 ? secret : undefined;
  }

  // ═══════════════════════════════════════════════════════
  // Session Tokens
  // ═══════════════════════════════════════════════════════

  /**
   * Validate a standard platform-signed scoped JWT.
   *
   * Entity end-user tokens are accepted only while their persisted
   * McpBearerToken remains active and its Entity/Project/Environment ancestry
   * exactly matches the signed claims. This single method is shared by the
   * HTTP ScopeGuard and WebSocket gateway.
   */
  async validateSessionToken(token: string): Promise<SessionPayload | null> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [headerB64, payloadB64, signatureB64] = parts;
      if (!headerB64 || !payloadB64 || !signatureB64) return null;

      let header: unknown;
      let claims: SessionPayload;
      try {
        header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
        claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (
        !header ||
        typeof header !== "object" ||
        (header as { alg?: unknown }).alg !== "HS256" ||
        !claims ||
        claims.iss !== "platos-platform" ||
        typeof claims.organizationId !== "string" ||
        typeof claims.projectId !== "string" ||
        typeof claims.environmentId !== "string" ||
        typeof claims.userId !== "string" ||
        typeof claims.iat !== "number" ||
        !Number.isFinite(claims.iat) ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp)
      ) {
        return null;
      }

      const signingSecret = this.platformSigningSecret;
      if (!signingSecret) {
        this.logger.warn(
          "validateSessionToken: SESSION_SECRET not set — rejecting scoped token.",
        );
        return null;
      }
      const signingInput = `${headerB64}.${payloadB64}`;
      const expected = crypto
        .createHmac("sha256", signingSecret)
        .update(signingInput)
        .digest("base64url");
      if (expected.length !== signatureB64.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureB64))) {
        return null;
      }

      const now = new Date();
      if (claims.exp * 1000 <= now.getTime()) return null;
      if (claims.iat > Math.floor(now.getTime() / 1000) + 60) return null;

      if (claims.authorizationId !== undefined) {
        if (typeof claims.authorizationId !== "string" || typeof claims.entityId !== "string") {
          return null;
        }
        const authorization = await this.prisma.mcpBearerToken.findUnique({
          where: { id: claims.authorizationId },
          select: {
            id: true,
            revokedAt: true,
            expiresAt: true,
            entity: {
              select: {
                externalId: true,
                project: { select: { id: true, organizationId: true } },
              },
            },
          },
        });
        if (
          !authorization ||
          authorization.revokedAt ||
          (authorization.expiresAt && authorization.expiresAt.getTime() <= now.getTime()) ||
          authorization.entity.externalId !== claims.entityId ||
          authorization.entity.project.id !== claims.projectId ||
          authorization.entity.project.organizationId !== claims.organizationId
        ) {
          return null;
        }

        const environment = await this.prisma.environment.findUnique({
          where: { id: claims.environmentId },
          select: { project: { select: { id: true, organizationId: true } } },
        });
        if (
          !environment ||
          environment.project.id !== authorization.entity.project.id ||
          environment.project.organizationId !== authorization.entity.project.organizationId
        ) {
          return null;
        }

        // Close the lookup→use revocation race. A revoke/expiry that wins here
        // invalidates the session instead of allowing one unaudited request.
        const active = await this.prisma.mcpBearerToken.updateMany({
          where: {
            id: authorization.id,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          data: { lastUsedAt: now },
        });
        if (active.count !== 1) return null;
      }

      return claims;
    } catch (err) {
      this.logger.warn(`validateSessionToken error: ${(err as Error).message}`);
      return null;
    }
  }

  private mintPlatformToken(
    claims: Omit<SessionPayload, "iss" | "iat" | "exp"> & Record<string, unknown>,
    ttlSeconds: number,
  ): string | null {
    const signingSecret = this.platformSigningSecret;
    if (!signingSecret) {
      this.logger.warn("SESSION_SECRET not set — cannot mint scoped token.");
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const full: SessionPayload & Record<string, unknown> = {
      ...claims,
      iss: "platos-platform",
      iat: now,
      exp: now + ttlSeconds,
    };
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(full)).toString("base64url");
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(signingInput)
      .digest("base64url");
    return `${signingInput}.${signature}`;
  }

  /** Mint an operator or guest platform token with no entity bearer binding. */
  async createPlatformSessionToken(
    claims: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      userToken?: string;
      permissions?: string[];
      extraClaims?: Record<string, unknown>;
    },
    ttlSeconds: number = 3600,
  ): Promise<string | null> {
    const { extraClaims, ...coreClaims } = claims;
    return this.mintPlatformToken(
      {
        ...(extraClaims ?? {}),
        ...coreClaims,
      } as Omit<SessionPayload, "iss" | "iat" | "exp"> & Record<string, unknown>,
      ttlSeconds,
    );
  }

  /**
   * Mint an entity end-user token authorized by a persisted McpBearerToken.
   * The authorization ID is signed into the JWT and revalidated on every HTTP
   * request and WebSocket connection.
   */
  async createEntitySessionToken(
    claims: Omit<SessionPayload, "iss" | "iat" | "exp" | "authorizationId">,
    authorizationId: string,
    ttlSeconds: number = 3600,
  ): Promise<string | null> {
    return this.mintPlatformToken(
      { ...claims, authorizationId },
      ttlSeconds,
    );
  }

  // ═══════════════════════════════════════════════════════
  // HMAC Verification (for entity backends to verify Platos requests)
  // ═══════════════════════════════════════════════════════

  /**
   * Generate HMAC signature for a tool call to an entity backend.
   */
  signRequest(body: string, serviceSecret: string, timestamp: string): string {
    const message = `${timestamp}.${body}`;
    return crypto.createHmac("sha256", serviceSecret).update(message).digest("hex");
  }

  /**
   * Verify an HMAC signature (for incoming requests from entities, e.g., webhooks).
   */
  verifySignature(body: string, signature: string, serviceSecret: string, timestamp: string): boolean {
    const expected = this.signRequest(body, serviceSecret, timestamp);
    if (expected.length !== signature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  // ═══════════════════════════════════════════════════════
  // Entity Registry
  // ═══════════════════════════════════════════════════════

  /**
   * Register a new entity. If serviceSecret is omitted or "auto", generate a
   * cryptographically strong 32-byte hex secret and return it in the response.
   * The secret is shown ONCE at creation — if lost, use regenerateServiceSecret.
   */
  async registerEntity(data: EntityRegistration, operatorScope?: AccessKeyOperatorScope): Promise<any> {
    const connectionKind = data.connectionKind === "mcp" ? "mcp" : "wire";
    if (connectionKind === "mcp" && (!data.mcpClient || !data.mcpClient.transport)) {
      const bad: any = new Error(
        "connectionKind 'mcp' requires mcpClient.transport",
      );
      bad.statusCode = 400;
      throw bad;
    }

    const project = await this.prisma.project.findFirst({
      where: { id: data.projectId, organizationId: data.organizationId },
      select: {
        id: true,
        organizationId: true,
        environments: {
          where: { archivedAt: null },
          select: { id: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!project) {
      const bad: any = new Error("Project not found in organization scope");
      bad.statusCode = 404;
      throw bad;
    }
    if (
      data.environmentId &&
      !project.environments.some((environment) => environment.id === data.environmentId)
    ) {
      const bad: any = new Error("Environment not found in project scope");
      bad.statusCode = 400;
      throw bad;
    }
    if (connectionKind === "wire" && project.environments.length === 0) {
      const bad: any = new Error("Wire entities require an active project environment");
      bad.statusCode = 400;
      throw bad;
    }

    const secret =
      connectionKind === "wire"
        ? !data.serviceSecret || data.serviceSecret === "auto"
          ? crypto.randomBytes(32).toString("hex")
          : data.serviceSecret
        : null;
    if (secret && (!this.secretStore || !operatorScope)) {
      throw new Error("Entity credential encryption is unavailable");
    }
    const credentialAuthorizations = new Map<string, EnvironmentOperatorAuthorization>();
    if (secret && operatorScope) {
      for (const environment of project.environments) {
        credentialAuthorizations.set(
          environment.id,
          await this.authorizeEnvironmentOperatorScope(
            { ...operatorScope, environmentId: environment.id },
            "secret:mutate",
          ),
        );
      }
    }

    const credentialEnvironmentId =
      data.environmentId ?? project.environments[0]?.id;
    let outboundCredentialId: string | null = null;
    if (connectionKind === "mcp" && data.mcpClient?.credsSecretKey) {
      if (!credentialEnvironmentId) {
        const bad: any = new Error("MCP credential requires an active project environment");
        bad.statusCode = 400;
        throw bad;
      }
      const credential = await this.prisma.credential.findFirst({
        where: {
          environmentId: credentialEnvironmentId,
          name: data.mcpClient.credsSecretKey,
          revokedAt: null,
          environment: {
            projectId: data.projectId,
            project: { organizationId: data.organizationId },
          },
        },
        select: { id: true },
      });
      if (!credential) {
        const bad: any = new Error("MCP credential not found in environment scope");
        bad.statusCode = 400;
        throw bad;
      }
      outboundCredentialId = credential.id;
    }

    try {
      const entity = await this.prisma.$transaction(async (tx) => {
        const created = await tx.entity.create({
          data: {
            projectId: data.projectId,
            externalId: data.entityId,
            displayName: data.displayName,
            mcpUrls: data.mcpUrls,
            connectionKind,
            connectionStatus: "disconnected",
            ...(connectionKind === "mcp" && data.mcpClient
              ? {
                  mcpClient: {
                    create: {
                      transport: data.mcpClient.transport,
                      url: data.mcpClient.url ?? null,
                      credentialId: outboundCredentialId,
                      headersTemplate:
                        data.mcpClient.headersTemplate != null
                          ? (data.mcpClient.headersTemplate as any)
                          : {},
                    },
                  },
                }
              : {}),
          },
        });
        if (secret) {
          for (const environment of project.environments) {
            const authorization = credentialAuthorizations.get(environment.id);
            if (!authorization) throw new Error("Entity credential encryption is unavailable");
            const credential = await this.secretStore!.createInTransaction(tx, {
              authorization,
              kind: CredentialKind.ENTITY_SECRET,
              name: data.entityId,
              plaintext: secret,
            });
            await tx.credential.update({
              where: { id: credential.id },
              data: {
                prefix: secret.slice(0, 8),
                secretHash: crypto.createHash("sha256").update(secret).digest("hex"),
                permissions: ["entity:wire"],
              },
            });
          }
        }
        return tx.entity.findUniqueOrThrow({
          where: { id: created.id },
          select: AuthService.ENTITY_SAFE_SELECT,
        });
      });
      return {
        ...AuthService.projectEntity(entity),
        ...(secret ? { plaintextSecret: secret } : {}),
      };
    } catch (err: any) {
      if (err?.code === "P2002") {
        const conflict: any = new Error(
          `Entity "${data.entityId}" already exists in this project. ` +
            `Use a different entityId, or call POST /entities/${data.entityId}/regenerate-secret to rotate its secret.`,
        );
        conflict.statusCode = 409;
        throw conflict;
      }
      throw err;
    }
  }

  /** Safe columns returned by getEntity / listEntities. Credential secret
   * material is intentionally outside this graph. */
  private static readonly ENTITY_SAFE_SELECT = {
    id: true,
    externalId: true,
    displayName: true,
    mcpUrls: true,
    projectId: true,
    connectionStatus: true,
    lastConnectedAt: true,
    connectionKind: true,
    allowedOrigins: true,
    mcpConfig: true,
    mcpClient: {
      select: {
        entityId: true,
        transport: true,
        url: true,
        headersTemplate: true,
        lastDiscoveryAt: true,
        discoveryError: true,
        createdAt: true,
        updatedAt: true,
        credential: { select: { name: true } },
      },
    },
    project: { select: { organizationId: true } },
    createdAt: true,
    updatedAt: true,
  } as const;

  private static projectEntity(row: any): any {
    const { externalId, project, mcpClient, ...entity } = row;
    return {
      ...entity,
      entityId: externalId,
      organizationId: project.organizationId,
      linkedAgentIds: [],
      mcpClient: mcpClient
        ? {
            ...mcpClient,
            credsSecretKey: mcpClient.credential?.name ?? null,
            credential: undefined,
          }
        : null,
    };
  }

  // ═══════════════════════════════════════════════════════
  // Multi-tenant CORS — allowedOrigins aggregation cache
  // ═══════════════════════════════════════════════════════
  //
  // The agent's CORS handler (main.ts) needs to permit any origin that
  // ANY active entity has whitelisted, in addition to the operator's
  // PLATOS_CORS_ORIGIN list. Hitting Postgres on every preflight is
  // unworkable, so we keep a 30s in-memory cache of the union.
  //
  // Invalidation: TTL-only. When an operator adds an origin to an
  // entity, the new origin becomes effective within 30s. That's
  // acceptable for browser embedding; faster invalidation isn't worth
  // the complexity.
  private originCache: Set<string> | null = null;
  private originCacheLoadedAt = 0;
  private originCacheRefreshing: Promise<Set<string>> | null = null;
  private static readonly ORIGIN_CACHE_TTL_MS = 30_000;

  /**
   * Return the union of every entity's `allowedOrigins`, cached for 30s.
   * Used by the dynamic CORS handler in main.ts. Empty set is fine —
   * callers also union with the static PLATOS_CORS_ORIGIN list.
   */
  async getAllAllowedOrigins(): Promise<Set<string>> {
    const now = Date.now();
    if (
      this.originCache &&
      now - this.originCacheLoadedAt < AuthService.ORIGIN_CACHE_TTL_MS
    ) {
      return this.originCache;
    }
    if (this.originCacheRefreshing) return this.originCacheRefreshing;
    this.originCacheRefreshing = (async () => {
      const rows = await this.prisma.entity.findMany({
        select: { allowedOrigins: true },
      });
      const set = new Set<string>();
      for (const row of rows) {
        for (const origin of row.allowedOrigins ?? []) {
          if (origin) set.add(origin);
        }
      }
      this.originCache = set;
      this.originCacheLoadedAt = Date.now();
      this.originCacheRefreshing = null;
      return set;
    })();
    return this.originCacheRefreshing;
  }

  /** Force-refresh the origin cache after an entity write. Cheap. */
  invalidateOriginCache(): void {
    this.originCache = null;
    this.originCacheLoadedAt = 0;
  }

  async getEntity(organizationId: string, projectId: string, entityId: string): Promise<any> {
    const entity = await this.prisma.entity.findFirst({
      where: {
        projectId,
        externalId: entityId,
        project: { organizationId },
      },
      select: AuthService.ENTITY_SAFE_SELECT,
    });
    return entity ? AuthService.projectEntity(entity) : null;
  }

  async listEntities(organizationId: string, projectId: string): Promise<any[]> {
    const entities = await this.prisma.entity.findMany({
      where: { projectId, project: { organizationId } },
      orderBy: { createdAt: "desc" },
      select: AuthService.ENTITY_SAFE_SELECT,
    });
    return entities.map(AuthService.projectEntity);
  }

  /**
   * Delete an entity and everything the tool registry still believes about it.
   *
   * The DB row was previously all that got deleted. The registry's in-memory
   * scoped-tool cache is keyed by (org, project, env, entityId) and had no
   * eviction path on this route, so a deleted entity's tools stayed live: they
   * were still injected into every turn with full schemas, and dispatching one
   * resolved `entityPk` against a row that no longer existed, failing with
   * "Entity <id> not registered". Only a process restart cleared it.
   *
   * The purge runs BEFORE the row is deleted so the cache key can be rebuilt
   * from the entity; `purgeEntity` also matches buckets by entityPk so it stays
   * correct if that order ever changes.
   */
  async deleteEntity(organizationId: string, projectId: string, entityId: string): Promise<boolean> {
    const entity = await this.prisma.entity.findFirst({
      where: { projectId, externalId: entityId, project: { organizationId } },
      select: { id: true },
    });

    if (entity && this.toolRegistry) {
      try {
        const purged = await this.toolRegistry.purgeEntity(entity.id);
        this.logger.log(
          `deleteEntity ${entityId}: purged ${purged.mappingsRemoved} tool mappings, ${purged.bucketsEvicted} cache buckets`,
        );
      } catch (err: any) {
        // A failed purge must not block the delete — the operator asked for the
        // entity to be gone. Loud, because the surviving cache entries are the
        // exact condition that produces "Entity not registered" at dispatch.
        this.logger.error(
          `deleteEntity ${entityId}: registry purge failed, stale tools may persist until restart — ${err?.message ?? err}`,
        );
      }
    }

    if (!entity) return false;
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.credential.updateMany({
        where: {
          kind: CredentialKind.ENTITY_SECRET,
          name: entityId,
          revokedAt: null,
          environment: { projectId, project: { organizationId } },
        },
        data: { revokedAt: now },
      });
      return tx.entity.deleteMany({
        where: { id: entity.id, projectId, project: { organizationId } },
      });
    });
    return result.count > 0;
  }

  /**
   * MCPF-W1 — partial-patch an entity's metadata. Scope-pinned via the
   * composite unique (organizationId, projectId, entityId). Returns the
   * updated row using ENTITY_SAFE_SELECT so serviceSecret + serviceSecretHash
   * never leak.
   *
   * Thin Prisma wrapper — used by the `entities.update` MCP tool. Webapp +
   * REST callers continue to go through `agent.controller.ts:patchEntity`
   * for their full linkedAgentIds + testCredentials editing surface.
   *
   * Editable fields are intentionally limited to `displayName` + `mcpUrls`.
   * Other entity attributes have purpose-built mutators:
   *   - `linkedAgentIds` → `agent.controller.ts:patchEntity` /
   *     `entities.set_linked_agents` (scope-validates each id).
   *   - `testCredentials` → `agent.controller.ts:patchEntity` /
   *     `entities.set_test_credentials` (RFC 7230 + encryption).
   *   - `serviceSecret`   → `regenerateServiceSecret(...)` /
   *     `entities.regenerate_secret`.
   * Caller-supplied fields outside the typed patch are dropped at the
   * type boundary; we do not silently accept forward-compat columns.
   */
  async updateEntity(
    organizationId: string,
    projectId: string,
    entityId: string,
    patch: {
      displayName?: string;
      mcpUrls?: string[];
      allowedOrigins?: string[];
    },
  ): Promise<any> {
    const data: Record<string, unknown> = {};
    if (patch.displayName !== undefined) data["displayName"] = patch.displayName;
    if (Array.isArray(patch.mcpUrls)) data["mcpUrls"] = patch.mcpUrls;
    if (Array.isArray(patch.allowedOrigins)) {
      // Normalize: strip trailing slashes, drop empty strings, dedupe.
      // Origins compare against the browser's Origin header verbatim,
      // which never has a trailing slash, so we strip ours too.
      const normalized = Array.from(
        new Set(
          patch.allowedOrigins
            .map((s) => (typeof s === "string" ? s.trim().replace(/\/+$/, "") : ""))
            .filter((s) => s.length > 0),
        ),
      );
      data["allowedOrigins"] = normalized;
    }
    if (Object.keys(data).length === 0) {
      return this.getEntity(organizationId, projectId, entityId);
    }
    const existing = await this.prisma.entity.findFirst({
      where: { projectId, externalId: entityId, project: { organizationId } },
      select: { id: true },
    });
    if (!existing) return null;
    const updated = await this.prisma.entity.update({
      where: { id: existing.id },
      data,
      select: AuthService.ENTITY_SAFE_SELECT,
    });
    // If the patch touched origins, invalidate the cache so the next
    // CORS preflight sees the new value within ms instead of waiting
    // out the 30s TTL.
    if (Array.isArray(patch.allowedOrigins)) this.invalidateOriginCache();
    return AuthService.projectEntity(updated);
  }

  // ═══════════════════════════════════════════════════════
  // Access Keys
  // ═══════════════════════════════════════════════════════

  /** Resolve canonical Environment ancestry and current operator membership. */
  async authorizeEnvironmentOperatorScope(
    scope: AccessKeyOperatorScope,
    access: EnvironmentAuthorizationAccess,
  ): Promise<EnvironmentOperatorAuthorization> {
    if (scope.principal !== "operator") throw new Error("environment_forbidden");
    const operator: OperatorAuthorization = {
      sessionId: scope.sessionId || "platos-agent-control-plane",
      actorUserId: scope.operatorUserId || scope.userId,
      effectiveUserId: scope.userId,
      email: "",
      expiresAt: new Date(Date.now() + 60_000),
      mfaVerifiedAt: null,
      impersonation: scope.operatorUserId
        ? {
            active: true,
            actorUserId: scope.operatorUserId,
            targetUserId: scope.userId,
          }
        : null,
    };
    const authorization = await authorizeEnvironmentOperator(
      this.prisma,
      operator,
      scope.environmentId,
      access,
    );
    if (
      authorization.organizationId !== scope.organizationId ||
      authorization.projectId !== scope.projectId
    ) {
      throw new Error("environment_forbidden");
    }
    return authorization;
  }

  /** Store only a browser-generated hash and retain the replaced key briefly. */
  async createOrRotateAccessKey(
    scope: AccessKeyOperatorScope,
    input: { keyHash: string; keyPrefix: string },
  ) {
    const authorization = await this.authorizeEnvironmentOperatorScope(scope, "secret:mutate");
    return rotateAccessKey(this.prisma, {
      environmentId: authorization.environmentId,
      keyHash: input.keyHash,
      keyPrefix: input.keyPrefix,
    });
  }

  async setAllowedOrigins(scope: AccessKeyOperatorScope, origins: string[]): Promise<void> {
    const authorization = await this.authorizeEnvironmentOperatorScope(scope, "secret:mutate");
    await this.prisma.accessKey.updateMany({
      where: {
        environmentId: authorization.environmentId,
        revokedAt: null,
        validUntil: null,
      },
      data: { allowedOrigins: origins },
    });
  }

  /** Verify the active or unexpired retiring hash without serializing either. */
  async verifyAccessKey(
    scope: { organizationId: string; projectId: string; environmentId: string; userId?: string },
    providedKey: string | undefined,
    origin: string | undefined,
  ): Promise<boolean | null> {
    let environmentId: string;
    try {
      const authorization = await authorizeEnvironmentRuntime(this.prisma, {
        actorId: scope.userId || "access-key-verifier",
        environmentId: scope.environmentId,
      });
      if (
        authorization.organizationId !== scope.organizationId ||
        authorization.projectId !== scope.projectId
      ) return false;
      environmentId = authorization.environmentId;
    } catch {
      return false;
    }

    const records = await this.prisma.accessKey.findMany({
      where: {
        environmentId,
        revokedAt: null,
        OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
      },
      select: { id: true, keyHash: true, allowedOrigins: true },
    });
    if (records.length === 0) return null;
    if (!providedKey) return false;
    const candidate = Buffer.from(crypto.createHash("sha256").update(providedKey).digest("hex"), "hex");
    const record = records.find((entry) => {
      const stored = Buffer.from(entry.keyHash, "hex");
      return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
    });
    if (!record) return false;
    if (record.allowedOrigins.length > 0) {
      if (!origin) return false;
      const allowed = record.allowedOrigins.some((configured) => {
        try {
          return new URL(origin).origin === new URL(configured).origin;
        } catch {
          return origin === configured;
        }
      });
      if (!allowed) return false;
    }
    void this.prisma.accessKey.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);
    return true;
  }

  async getAccessKey(scope: AccessKeyOperatorScope) {
    const authorization = await this.authorizeEnvironmentOperatorScope(scope, "metadata");
    const keys = await this.prisma.accessKey.findMany({
      where: { environmentId: authorization.environmentId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: ACCESS_KEY_SAFE_SELECT,
    });
    return {
      key: keys.find((key) => key.validUntil === null) ?? null,
      retiringKey: keys.find((key) => key.validUntil !== null) ?? null,
    };
  }

  async deleteAccessKey(scope: AccessKeyOperatorScope): Promise<void> {
    const authorization = await this.authorizeEnvironmentOperatorScope(scope, "secret:mutate");
    await this.prisma.accessKey.updateMany({
      where: { environmentId: authorization.environmentId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Rotate an entity's service secret. Old secret becomes invalid immediately —
   * the entity's platools connector must reconnect with the new secret.
   */
  async regenerateServiceSecret(
    organizationId: string,
    projectId: string,
    entityId: string,
    operatorScope?: AccessKeyOperatorScope,
  ): Promise<{ organizationId: string; projectId: string; entityId: string; serviceSecret: string } | null> {
    if (!this.secretStore || !operatorScope) {
      throw new Error("Entity credential encryption is unavailable");
    }
    const entity = await this.prisma.entity.findFirst({
      where: {
        projectId,
        externalId: entityId,
        connectionKind: "wire",
        project: { organizationId },
      },
      select: {
        project: {
          select: {
            environments: {
              where: { archivedAt: null },
              select: { id: true },
            },
          },
        },
      },
    });
    if (!entity || entity.project.environments.length === 0) return null;

    const newSecret = crypto.randomBytes(32).toString("hex");
    const authorizations = new Map<string, EnvironmentOperatorAuthorization>();
    for (const environment of entity.project.environments) {
      authorizations.set(
        environment.id,
        await this.authorizeEnvironmentOperatorScope(
          { ...operatorScope, environmentId: environment.id },
          "secret:mutate",
        ),
      );
    }
    await this.prisma.$transaction(async (tx) => {
      for (const environment of entity.project.environments) {
        const authorization = authorizations.get(environment.id)!;
        const existing = await tx.credential.findUnique({
          where: {
            environmentId_kind_name: {
              environmentId: environment.id,
              kind: CredentialKind.ENTITY_SECRET,
              name: entityId,
            },
          },
          select: { id: true, revokedAt: true, activeSecretVersionId: true },
        });
        let credentialId: string;
        if (existing?.activeSecretVersionId && !existing.revokedAt) {
          const rotated = await this.secretStore!.rotateInTransaction(tx, {
            authorization,
            credentialId: existing.id,
            plaintext: newSecret,
          });
          credentialId = rotated.id;
        } else if (!existing) {
          const created = await this.secretStore!.createInTransaction(tx, {
            authorization,
            kind: CredentialKind.ENTITY_SECRET,
            name: entityId,
            plaintext: newSecret,
          });
          credentialId = created.id;
        } else {
          throw new Error("entity_credential_unavailable");
        }
        await tx.credential.update({
          where: { id: credentialId },
          data: {
            prefix: newSecret.slice(0, 8),
            secretHash: crypto.createHash("sha256").update(newSecret).digest("hex"),
            permissions: ["entity:wire"],
          },
        });
      }
    });
    return { organizationId, projectId, entityId, serviceSecret: newSecret };
  }

  /** Resolve a wire entity secret only after canonical Environment authorization. */
  async resolveEntityServiceSecret(scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    entityId: string;
  }): Promise<string | null> {
    if (!this.secretStore) return null;
    try {
      const authorization = await authorizeEnvironmentRuntime(this.prisma, {
        actorId: `entity:${scope.entityId}`,
        environmentId: scope.environmentId,
      });
      if (
        authorization.organizationId !== scope.organizationId ||
        authorization.projectId !== scope.projectId
      ) return null;
      const material = await this.secretStore.readForRuntime({
        authorization,
        name: scope.entityId,
        kind: CredentialKind.ENTITY_SECRET,
      });
      return material.reveal();
    } catch {
      return null;
    }
  }

}
