import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import * as crypto from "crypto";
import { env } from "../shared/env";

/**
 * Session token claims.
 *
 * Two signing sources:
 *
 * 1. **Entity-signed** (default, `iss: "entity"` or omitted) — signed by an
 *    entity backend using its `serviceSecret`. Platos verifies by looking
 *    up the entity in the DB and recomputing HMAC with that entity's secret.
 *    `entityId` is required. Every entity has its own signing key; external
 *    integrators use this path.
 *
 * 2. **Platform-signed** (`iss: "platos-platform"`) — signed by the Platos
 *    webapp using the shared `PLATOS_SESSION_SECRET`. Used to auth browser
 *    WS connections from the Platos dashboard to the agent. `entityId` is
 *    absent. No DB lookup — verified against the platform secret directly.
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
  entityId?: string;        // required when iss === "entity"; absent when iss === "platos-platform"
  userId: string;
  userToken?: string;       // opaque user identity proof from the entity's auth system
  permissions?: string[];
  iss?: "entity" | "platos-platform"; // issuer — defaults to "entity" for backwards compat
  iat?: number;             // EOBD.1 — issued-at (optional). Emitted by new mints.
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
  entityId: string; // human-readable slug e.g. "fandesk-main"
  displayName: string;
  mcpUrls: string[];
  serviceSecret: string;
  // PIFSP-3: `customParams` field removed — the column was dropped from
  // PlatosConnectedEntity (migration 20260424010000_*). Per-tool params
  // now live on the agent editor as "MCP arguments" (agent-config ticket).
}

/**
 * AuthService — handles session tokens, HMAC verification, and entity registry.
 *
 * Session tokens: short-lived (5min), signed with each ENTITY'S own
 *   `serviceSecret`. Issued by the entity backend; Platos looks up the
 *   entity by claim → verifies with that entity's secret.
 *
 * HMAC: used for Platos→entity tool calls (service-to-service auth).
 *   Each entity has a serviceSecret. Platos signs requests, entity verifies.
 *
 * Entity registry: CRUD for connected entities, scoped by (organizationId, projectId).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.prisma = prisma;
  }

  /**
   * EOBD.5 — read the platform signing secret on every call instead of
   * capturing once in the constructor. Allows hot rotation: operator
   * updates PLATOS_SESSION_SECRET + restarts nothing, and the next
   * validate / mint call picks up the new value.
   *
   * Live WS sessions authed under the old secret stay connected until
   * the socket closes; that's acceptable for routine rotation. For
   * revocation use cases, restart the process.
   *
   * Shared secret for platform-issued session tokens
   * (iss: "platos-platform"). Used by the Platos webapp to auth browser
   * Socket.IO connections to the agent. Also serves as a dev-mode
   * fallback for entity-signed tokens when PLATOS_TEST_MODE=true.
   * Must be set in production.
   */
  private get platformSigningSecret(): string {
    if (!env.PLATOS_SESSION_SECRET) throw new Error("PLATOS_SESSION_SECRET is required");
    return env.PLATOS_SESSION_SECRET;
  }

  // ═══════════════════════════════════════════════════════
  // Session Tokens
  // ═══════════════════════════════════════════════════════

  /**
   * Validate a session token against the claim's entity's serviceSecret.
   *
   * Returns the payload if the HMAC verifies AND the entity exists AND the
   * token hasn't expired. Returns null otherwise.
   *
   * Token format: base64url(JSON payload).base64url(HMAC-SHA256 signature)
   *
   * Verification flow:
   *   1. Parse claims (unsigned — trust nothing yet)
   *   2. Look up entity by (organizationId, projectId, entityId) from claims
   *   3. Decrypt-or-read entity.serviceSecret
   *   4. Recompute HMAC(payloadB64, entity.serviceSecret)
   *   5. Timing-safe compare with the token's signature
   *   6. Check expiry
   */
  async validateSessionToken(token: string): Promise<SessionPayload | null> {
    try {
      // EOBD.1 — accept both formats for one release:
      //   3-part: `base64url(header).base64url(payload).base64url(sig)` — standard HS256 JWT (new).
      //   2-part: `base64url(payload).base64url(sig)`                   — legacy custom (pre-EOBD.1).
      // The signing input is the full dotted prefix before the last `.`.
      // For 3-part that's `header.payload`; for 2-part that's just `payload`.
      const parts = token.split(".");
      if (parts.length !== 2 && parts.length !== 3) return null;

      let payloadB64: string;
      let signatureB64: string;
      let signingInput: string;

      if (parts.length === 3) {
        const [headerB64, p, s] = parts;
        payloadB64 = p;
        signatureB64 = s;
        signingInput = `${headerB64}.${payloadB64}`;
        // Sanity-check the header — reject non-HS256.
        try {
          const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf-8"));
          if (header?.alg !== "HS256") return null;
        } catch {
          return null;
        }
      } else {
        [payloadB64, signatureB64] = parts;
        signingInput = payloadB64;
      }

      // Step 1 — parse claims (still untrusted)
      let claims: SessionPayload;
      try {
        claims = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8"));
      } catch {
        return null;
      }
      if (
        !claims ||
        typeof claims.organizationId !== "string" ||
        typeof claims.projectId !== "string" ||
        typeof claims.environmentId !== "string" ||
        typeof claims.userId !== "string"
      ) {
        return null;
      }

      // Step 2 — pick signing secret based on issuer.
      let serviceSecret: string | undefined;
      if (claims.iss === "platos-platform") {
        // Platform-signed token — minted by the Platos webapp for browser WS
        // connections to the agent. Verified against PLATOS_SESSION_SECRET.
        // entityId is absent; no DB lookup.
        if (!this.platformSigningSecret) {
          this.logger.warn(
            "validateSessionToken: platform token received but PLATOS_SESSION_SECRET not set — rejecting.",
          );
          return null;
        }
        serviceSecret = this.platformSigningSecret;
      } else {
        // Entity-signed token — default path for external integrators.
        if (typeof claims.entityId !== "string") {
          return null;
        }
        try {
          const entity = await this.prisma.platosConnectedEntity.findUnique({
            where: {
              organizationId_projectId_entityId: {
                organizationId: claims.organizationId,
                projectId: claims.projectId,
                entityId: claims.entityId,
              },
            },
            select: { serviceSecret: true },
          });
          serviceSecret = entity?.serviceSecret;
        } catch (err) {
          this.logger.warn(`validateSessionToken DB lookup failed: ${(err as Error).message}`);
          return null;
        }

        // Dev-mode fallback: if no entity row AND a platform secret is set
        // AND PLATOS_TEST_MODE is true, fall back. Production should never
        // hit this branch; the platform-issued path above is the prod route
        // for webapp-sourced tokens.
        if (!serviceSecret) {
          if (this.platformSigningSecret && env.PLATOS_TEST_MODE === true) {
            serviceSecret = this.platformSigningSecret;
          } else {
            return null;
          }
        }
      }

      // Step 3 — verify HMAC (timing-safe). `signingInput` is the full
      // dotted prefix before the signature: `header.payload` for 3-part
      // JWTs, just `payload` for the legacy 2-part format.
      const expectedSig = crypto
        .createHmac("sha256", serviceSecret)
        .update(signingInput)
        .digest("base64url");
      if (expectedSig.length !== signatureB64.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(signatureB64))) {
        return null;
      }

      // Step 4 — expiry check. EOBD.2: `exp` is mandatory. A token
      // without a numeric, in-the-future `exp` is rejected. Every internal
      // mint path sets exp, so no legitimate caller omits it.
      if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
      if (Date.now() > claims.exp * 1000) return null;

      return claims;
    } catch (err) {
      this.logger.warn(`validateSessionToken error: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Mint a platform-issued session token (iss: "platos-platform"). Signed
   * with PLATOS_SESSION_SECRET — NOT an entity's serviceSecret. Used by the
   * Platos webapp to auth browser Socket.IO connections to the agent.
   *
   * The webapp is expected to mint in its Remix loader (authenticated via
   * the existing user session cookie) and pass to the browser as the `token`
   * in the Socket.IO handshake auth.
   *
   * Returns null if PLATOS_SESSION_SECRET is not set.
   */
  async createPlatformSessionToken(
    claims: {
      organizationId: string;
      projectId: string;
      environmentId: string;
      userId: string;
      userToken?: string;
      permissions?: string[];
      /**
       * EOBD.102 — extra claims merged into the JWT payload. Used by
       * the public guest-token flow (EOBD.89) to stamp `isGuest: true`
       * + `agentId` without adding each new field to the core claim
       * shape. Caller-provided keys override core claims last-writer-wins
       * except for `iss`/`iat`/`exp` which are always server-set.
       */
      extraClaims?: Record<string, unknown>;
    },
    ttlSeconds: number = 3600,
  ): Promise<string | null> {
    if (!this.platformSigningSecret) {
      this.logger.warn(
        "createPlatformSessionToken: PLATOS_SESSION_SECRET not set — cannot mint.",
      );
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const { extraClaims, ...coreClaims } = claims;
    const full: SessionPayload & Record<string, unknown> = {
      ...(extraClaims ?? {}),
      ...coreClaims,
      iss: "platos-platform",
      iat: now,
      exp: now + ttlSeconds,
    };
    // EOBD.1 — emit standard 3-part HS256 JWT (matches webapp mint
    // helper and works with jsonwebtoken / jose / PyJWT etc.).
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payloadB64 = Buffer.from(JSON.stringify(full)).toString("base64url");
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = crypto
      .createHmac("sha256", this.platformSigningSecret)
      .update(signingInput)
      .digest("base64url");
    return `${signingInput}.${signature}`;
  }

  /**
   * Mint a session token signed by the given entity's serviceSecret.
   *
   * In production, entity backends mint tokens themselves (they have the
   * shared secret). This helper is for tests + dev workflows + admin CLIs.
   */
  async createSessionToken(
    claims: Omit<SessionPayload, "exp">,
    ttlSeconds: number = 300,
  ): Promise<string | null> {
    const entity = await this.prisma.platosConnectedEntity.findUnique({
      where: {
        organizationId_projectId_entityId: {
          organizationId: claims.organizationId,
          projectId: claims.projectId,
          entityId: claims.entityId,
        },
      },
      select: { serviceSecret: true },
    });
    if (!entity?.serviceSecret) return null;

    const full: SessionPayload = { ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
    // TODO(EOBD.1 follow-up) — this entity-signed helper still emits the
    // legacy 2-part format so existing tests and admin CLIs continue to
    // work. Migrate to 3-part HS256 when the legacy-accept window in
    // validateSessionToken is removed (next major release after
    // downstream integrators have rotated their tokens).
    const payloadB64 = Buffer.from(JSON.stringify(full)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", entity.serviceSecret)
      .update(payloadB64)
      .digest("base64url");
    return `${payloadB64}.${signature}`;
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
  async registerEntity(data: EntityRegistration): Promise<any> {
    // Strict create — duplicate entityId per (org, project) throws so the
    // caller gets a clear 409. The previous upsert path silently overwrote
    // mutable fields on the existing row AND returned a freshly-generated
    // `plaintextSecret` that was NEVER written — callers then handed that
    // fake secret to their backend, which failed to authenticate against
    // the old hash in the DB. To rotate a secret, use
    // `POST /entities/:id/regenerate-secret` (existing endpoint).
    const secret = !data.serviceSecret || data.serviceSecret === "auto"
      ? crypto.randomBytes(32).toString("hex")
      : data.serviceSecret;

    try {
      const entity = await this.prisma.platosConnectedEntity.create({
        data: {
          organizationId: data.organizationId,
          projectId: data.projectId,
          entityId: data.entityId,
          displayName: data.displayName,
          mcpUrls: data.mcpUrls,
          serviceSecret: secret,
          // PIFSP-3: `customParams` removed — column dropped in this release.
          connectionStatus: "disconnected",
        },
      });
      return { ...entity, plaintextSecret: secret };
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

  /** Safe columns returned by getEntity / listEntities — serviceSecret and
   * serviceSecretHash are intentionally excluded from list/get responses.
   * BUG-2: never leak serviceSecret via REST endpoints. */
  private static readonly ENTITY_SAFE_SELECT = {
    id: true,
    entityId: true,
    displayName: true,
    mcpUrls: true,
    organizationId: true,
    projectId: true,
    connectionStatus: true,
    lastConnectedAt: true,
    linkedAgentIds: true,
    allowedOrigins: true,
    testCredentials: true,
    mcpConfig: true,
    createdAt: true,
    updatedAt: true,
  } as const;

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
      const rows = await this.prisma.platosConnectedEntity.findMany({
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
    return this.prisma.platosConnectedEntity.findUnique({
      where: {
        organizationId_projectId_entityId: { organizationId, projectId, entityId },
      },
      // BUG-2: exclude serviceSecret and serviceSecretHash from API responses.
      select: AuthService.ENTITY_SAFE_SELECT,
    });
  }

  async listEntities(organizationId: string, projectId: string): Promise<any[]> {
    return this.prisma.platosConnectedEntity.findMany({
      where: { organizationId, projectId },
      orderBy: { createdAt: "desc" },
      // BUG-2: exclude serviceSecret and serviceSecretHash from API responses.
      select: AuthService.ENTITY_SAFE_SELECT,
    });
  }

  async deleteEntity(organizationId: string, projectId: string, entityId: string): Promise<boolean> {
    const result = await this.prisma.platosConnectedEntity.deleteMany({
      where: { organizationId, projectId, entityId },
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
      return this.prisma.platosConnectedEntity.findUnique({
        where: {
          organizationId_projectId_entityId: { organizationId, projectId, entityId },
        },
        select: AuthService.ENTITY_SAFE_SELECT,
      });
    }
    const updated = await this.prisma.platosConnectedEntity.update({
      where: {
        organizationId_projectId_entityId: { organizationId, projectId, entityId },
      },
      data,
      select: AuthService.ENTITY_SAFE_SELECT,
    });
    // If the patch touched origins, invalidate the cache so the next
    // CORS preflight sees the new value within ms instead of waiting
    // out the 30s TTL.
    if (Array.isArray(patch.allowedOrigins)) this.invalidateOriginCache();
    return updated;
  }

  // ═══════════════════════════════════════════════════════
  // Access Keys
  // ═══════════════════════════════════════════════════════

  /** Generate a new scoped access key. Returns the raw key (shown once) + the DB record. */
  async generateAccessKey(scope: { organizationId: string; projectId: string; environmentId: string }): Promise<{ rawKey: string; keyPrefix: string }> {
    const raw = `platos_live_${crypto.randomBytes(24).toString("hex")}`;
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const prefix = raw.slice(0, 16);
    await this.prisma.platosAccessKey.upsert({
      where: { platos_access_key_scope_uniq: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId } },
      update: { keyHash: hash, keyPrefix: prefix, updatedAt: new Date() },
      create: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId, keyHash: hash, keyPrefix: prefix },
    });
    return { rawKey: raw, keyPrefix: prefix };
  }

  /** Update allowed origins for a scope's access key. */
  async setAllowedOrigins(scope: { organizationId: string; projectId: string; environmentId: string }, origins: string[]): Promise<void> {
    await this.prisma.platosAccessKey.updateMany({
      where: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
      data: { allowedOrigins: origins },
    });
  }

  /** Verify X-Platos-Api-Key + origin. Returns: true=pass, false=fail, null=no key configured (skip). */
  async verifyAccessKey(
    scope: { organizationId: string; projectId: string; environmentId: string },
    providedKey: string | undefined,
    origin: string | undefined,
  ): Promise<boolean | null> {
    const record = await this.prisma.platosAccessKey.findFirst({
      where: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
      select: { keyHash: true, allowedOrigins: true, id: true },
    });
    if (!record) return null; // no key configured — pass through
    if (!providedKey) return false;
    const hash = crypto.createHash("sha256").update(providedKey).digest("hex");
    // BUG-7: use timing-safe comparison to prevent timing oracle attacks.
    const hashBuf = Buffer.from(hash, "hex");
    const storedBuf = Buffer.from(record.keyHash, "hex");
    if (hashBuf.length !== storedBuf.length || !crypto.timingSafeEqual(hashBuf, storedBuf)) return false;
    if (record.allowedOrigins.length > 0) {
      if (!origin) return false;
      // BUG-8: use exact origin comparison, not startsWith, to prevent
      // bypass via crafted subdomains (e.g. https://example.com.evil.com).
      const allowed = (record.allowedOrigins as string[]).some((o: string) => {
        try {
          return new URL(origin).origin === new URL(o).origin;
        } catch {
          return origin === o;
        }
      });
      if (!allowed) return false;
    }
    // Update lastUsedAt asynchronously — don't block the request
    this.prisma.platosAccessKey.updateMany({
      where: { id: record.id },
      data: { lastUsedAt: new Date() },
    }).catch(() => undefined);
    return true;
  }

  /** Get the access key record (without keyHash) for display. */
  async getAccessKey(scope: { organizationId: string; projectId: string; environmentId: string }) {
    return this.prisma.platosAccessKey.findFirst({
      where: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
      select: { keyPrefix: true, allowedOrigins: true, lastUsedAt: true, createdAt: true },
    });
  }

  /** Delete the access key for a scope. */
  async deleteAccessKey(scope: { organizationId: string; projectId: string; environmentId: string }): Promise<void> {
    await this.prisma.platosAccessKey.deleteMany({
      where: { organizationId: scope.organizationId, projectId: scope.projectId, environmentId: scope.environmentId },
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
  ): Promise<{ organizationId: string; projectId: string; entityId: string; serviceSecret: string } | null> {
    const newSecret = crypto.randomBytes(32).toString("hex");
    const updated = await this.prisma.platosConnectedEntity
      .update({
        where: {
          organizationId_projectId_entityId: { organizationId, projectId, entityId },
        },
        data: { serviceSecret: newSecret },
      })
      .catch(() => null);
    if (!updated) return null;
    return { organizationId, projectId, entityId, serviceSecret: newSecret };
  }
}
