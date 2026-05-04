import { Inject, Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";

/**
 * Theme K.10 — OAuth 2.1 authorization-server service.
 *
 * Implements the protocol primitives:
 *
 *   • RFC 7591 — Dynamic Client Registration
 *   • RFC 6749 + OAuth 2.1 — Authorization Code Grant (PKCE required,
 *                            `plain` rejected)
 *   • RFC 7636 — Proof Key for Code Exchange (S256 only)
 *   • RFC 7662 — Token Introspection
 *   • RFC 7009 — Token Revocation
 *   • RFC 8414 — Authorization Server Metadata
 *
 * All token material is sha256-stored at rest. Raw values are returned
 * exactly once from their respective mint endpoint.
 *
 * Access tokens use the `plt_oa_` prefix so the MCP controller can
 * route them to this verifier alongside `plt_mcp_` (PlatosMCPToken).
 */

export interface ScopeTuple {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

export interface OAuthClientRecord {
  id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  grantTypes: string[];
  scope: string | null;
  organizationId: string;
  registeredByUserId: string;
  createdAt: Date;
  /** PIFSP-21 — non-null when the client was registered via entity-scoped DCR. */
  entityPk?: string | null;
}

export interface DCRInput {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
  grantTypes?: string[];
  scope?: string;
  /** The user id performing registration, or "anonymous" for open DCR. */
  registeredByUserId?: string;
  /** The org the client is pinned to for registration bookkeeping. */
  organizationId?: string;
  /**
   * PIFSP-21 — optional per-entity pinning. When set, the client can only
   * authorize against this entity's `/oauth/entity/:entityId/*` routes.
   * Legacy platform DCR (`POST /oauth/register`) leaves this null.
   */
  entityPk?: string;
}

export interface DCRResult {
  client_id: string;
  client_secret?: string;
  client_id_issued_at: number;
  client_secret_expires_at: 0;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

export interface VerifiedOAuthAccessToken {
  tokenHash: string;
  clientId: string;
  userId: string;
  scope: ScopeTuple;
  scopes: string[];
  expiresAt: Date;
  /** PIFSP-21 — non-null when the token was issued via the entity-scoped
   *  OAuth flow. Routes the request to `/mcp/entity/:entityId/*` only. */
  entityPk?: string | null;
}

const ACCESS_TOKEN_PREFIX = "plt_oa_";
const REFRESH_TOKEN_PREFIX = "plt_or_";
const CLIENT_ID_PREFIX = "plt_oac_";
const CLIENT_SECRET_PREFIX = "plt_ocs_";
const AUTH_CODE_PREFIX = "plt_ocd_";

export const OAUTH_ACCESS_TOKEN_TTL_SEC = 3600; // 1h
export const OAUTH_REFRESH_TOKEN_TTL_SEC = 90 * 24 * 3600; // 90d
export const OAUTH_AUTH_CODE_TTL_SEC = 60; // 60s

const ALLOWED_AUTH_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "none",
]);

const ALLOWED_GRANT_TYPES = new Set([
  "authorization_code",
  "refresh_token",
]);

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

@Injectable()
export class OAuthService {
  private readonly logger = new Logger(OAuthService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  private sha256(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  private timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
      return false;
    }
  }

  private randomId(prefix: string, bytes = 32): string {
    return `${prefix}${crypto.randomBytes(bytes).toString("base64url")}`;
  }

  // ─────────────────────────────────────────────────────────────
  // RFC 7591 — Dynamic Client Registration
  // ─────────────────────────────────────────────────────────────

  async register(input: DCRInput): Promise<DCRResult> {
    if (!input.clientName || typeof input.clientName !== "string") {
      throw new OAuthError("invalid_client_metadata", "client_name required");
    }
    if (
      !Array.isArray(input.redirectUris) ||
      input.redirectUris.length === 0 ||
      input.redirectUris.some((u) => typeof u !== "string" || u.length === 0)
    ) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a non-empty string[]");
    }
    // OAuth 2.1 §3.1.2.1 — absolute URI, no fragment. Allow http:// only for
    // loopback (localhost, 127.0.0.1, ::1); require https:// otherwise.
    for (const uri of input.redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new OAuthError("invalid_redirect_uri", `malformed redirect_uri: ${uri}`);
      }
      if (parsed.hash) {
        throw new OAuthError(
          "invalid_redirect_uri",
          `redirect_uri must not contain fragment: ${uri}`,
        );
      }
      const isLoopback =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]";
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
        throw new OAuthError(
          "invalid_redirect_uri",
          `redirect_uri must be https (or http on loopback): ${uri}`,
        );
      }
    }

    const authMethod = input.tokenEndpointAuthMethod ?? "client_secret_basic";
    if (!ALLOWED_AUTH_METHODS.has(authMethod)) {
      throw new OAuthError(
        "invalid_client_metadata",
        `token_endpoint_auth_method must be one of ${Array.from(ALLOWED_AUTH_METHODS).join(", ")}`,
      );
    }
    const grantTypes = input.grantTypes ?? ["authorization_code", "refresh_token"];
    for (const gt of grantTypes) {
      if (!ALLOWED_GRANT_TYPES.has(gt)) {
        throw new OAuthError("invalid_client_metadata", `unsupported grant_type: ${gt}`);
      }
    }

    const clientId = this.randomId(CLIENT_ID_PREFIX, 16);
    const isPublic = authMethod === "none";
    const rawSecret = isPublic ? undefined : this.randomId(CLIENT_SECRET_PREFIX, 32);
    const clientSecretHash = rawSecret ? this.sha256(rawSecret) : null;

    const row = await this.prisma.platosOAuthClient.create({
      data: {
        clientId,
        clientSecretHash,
        clientName: input.clientName.slice(0, 200),
        redirectUris: input.redirectUris,
        tokenEndpointAuthMethod: authMethod,
        grantTypes,
        scope: input.scope ?? null,
        registeredByUserId: input.registeredByUserId ?? "anonymous",
        // K.10 — for open DCR, pin to "public" until a consent flow stamps
        // the real org. Every client MUST belong to some org at consent time.
        organizationId: input.organizationId ?? "public",
        // PIFSP-21 — pin entity for entity-scoped DCR.
        ...(input.entityPk ? { entityPk: input.entityPk } : {}),
      },
      select: {
        id: true,
        clientId: true,
        clientName: true,
        redirectUris: true,
        tokenEndpointAuthMethod: true,
        grantTypes: true,
        scope: true,
        createdAt: true,
      },
    });

    return {
      client_id: row.clientId,
      ...(rawSecret ? { client_secret: rawSecret } : {}),
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      client_secret_expires_at: 0, // 0 = does not expire
      client_name: row.clientName,
      redirect_uris: row.redirectUris,
      grant_types: row.grantTypes,
      token_endpoint_auth_method: row.tokenEndpointAuthMethod,
      ...(row.scope ? { scope: row.scope } : {}),
    };
  }

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    if (!clientId || typeof clientId !== "string") return null;
    const row = await this.prisma.platosOAuthClient.findUnique({
      where: { clientId },
    });
    if (!row) return null;
    // MCPF-W3 — soft-deleted clients cannot mint or refresh tokens. The row
    // stays in place for audit reconstruction; protocol-layer callers see
    // it as missing.
    if (row.deletedAt) return null;
    return row;
  }

  async verifyClientSecret(clientId: string, clientSecret: string): Promise<boolean> {
    const row = await this.prisma.platosOAuthClient.findUnique({
      where: { clientId },
      select: { clientSecretHash: true, deletedAt: true },
    });
    if (!row || !row.clientSecretHash) return false;
    // MCPF-W3 — soft-deleted clients can't authenticate.
    if (row.deletedAt) return false;
    const provided = this.sha256(clientSecret);
    return this.timingSafeEqualHex(row.clientSecretHash, provided);
  }

  // ─────────────────────────────────────────────────────────────
  // MCPF-W3 — operator-facing client + token management
  // ─────────────────────────────────────────────────────────────

  /**
   * MCPF-W3 — list OAuth clients in (organizationId, [entityPk?]). Returns
   * safe metadata only; `clientSecretHash` is NEVER returned (it's still a
   * secret — an attacker with the hash can grind it offline).
   *
   * Soft-deleted clients are excluded by default; pass
   * `includeDeleted: true` to include them (audit/compliance views).
   */
  async listClients(
    organizationId: string,
    options: { entityPk?: string | null; includeDeleted?: boolean } = {},
  ): Promise<Array<{
    id: string;
    clientId: string;
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: string;
    grantTypes: string[];
    scope: string | null;
    organizationId: string;
    entityPk: string | null;
    registeredByUserId: string;
    createdAt: string;
    deletedAt: string | null;
  }>> {
    const where: Record<string, unknown> = { organizationId };
    if (options.entityPk !== undefined) {
      where["entityPk"] = options.entityPk;
    }
    if (!options.includeDeleted) {
      where["deletedAt"] = null;
    }
    const rows = await this.prisma.platosOAuthClient.findMany({
      where,
      select: {
        id: true,
        clientId: true,
        clientName: true,
        redirectUris: true,
        tokenEndpointAuthMethod: true,
        grantTypes: true,
        scope: true,
        organizationId: true,
        entityPk: true,
        registeredByUserId: true,
        createdAt: true,
        deletedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r: any) => ({
      id: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      redirectUris: r.redirectUris,
      tokenEndpointAuthMethod: r.tokenEndpointAuthMethod,
      grantTypes: r.grantTypes,
      scope: r.scope ?? null,
      organizationId: r.organizationId,
      entityPk: r.entityPk ?? null,
      registeredByUserId: r.registeredByUserId,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      deletedAt: r.deletedAt
        ? r.deletedAt instanceof Date
          ? r.deletedAt.toISOString()
          : String(r.deletedAt)
        : null,
    }));
  }

  /**
   * MCPF-W3 — soft-delete a client + cascade-revoke every outstanding
   * access + refresh token for the client. Scope-pinned via
   * `organizationId` — cross-tenant ids return `{ deleted: false }`.
   *
   * Idempotent: re-deleting an already-soft-deleted client is a no-op
   * (returns `{ deleted: true, alreadyDeleted: true }`).
   */
  async deleteClient(
    clientId: string,
    organizationId: string,
  ): Promise<{
    deleted: boolean;
    alreadyDeleted?: boolean;
    accessTokensRevoked: number;
    refreshTokensRevoked: number;
  }> {
    const existing = await this.prisma.platosOAuthClient.findUnique({
      where: { clientId },
      select: { id: true, organizationId: true, deletedAt: true },
    });
    if (!existing || existing.organizationId !== organizationId) {
      return { deleted: false, accessTokensRevoked: 0, refreshTokensRevoked: 0 };
    }
    if (existing.deletedAt) {
      return {
        deleted: true,
        alreadyDeleted: true,
        accessTokensRevoked: 0,
        refreshTokensRevoked: 0,
      };
    }
    const now = new Date();
    const [, accessRes, refreshRes] = await this.prisma.$transaction([
      this.prisma.platosOAuthClient.update({
        where: { clientId },
        data: { deletedAt: now },
      }),
      this.prisma.platosOAuthAccessToken.updateMany({
        where: { clientId, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.platosOAuthRefreshToken.updateMany({
        where: { clientId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    return {
      deleted: true,
      accessTokensRevoked: accessRes?.count ?? 0,
      refreshTokensRevoked: refreshRes?.count ?? 0,
    };
  }

  /**
   * MCPF-W3 — list outstanding access tokens for an org (or for one
   * specific client within the org). Metadata only — `tokenHash` is also
   * a secret (sha256 of the bearer; an attacker with hash + a guessing
   * oracle can compromise) and is NEVER returned. Same redaction
   * discipline as `entities.set_test_credentials` — secrets bleed through
   * once at mint, never on subsequent reads.
   */
  async listAccessTokens(
    organizationId: string,
    options: {
      clientId?: string;
      entityPk?: string | null;
      includeRevoked?: boolean;
      includeExpired?: boolean;
      limit?: number;
    } = {},
  ): Promise<Array<{
    id: string;
    clientId: string;
    userId: string;
    scopes: string[];
    issuedAt: string;
    expiresAt: string;
    revokedAt: string | null;
    expired: boolean;
    entityPk: string | null;
  }>> {
    const where: Record<string, unknown> = {
      // Scope-narrow via the JSON column path. The Prisma JSON filter
      // matches the canonical shape we always write.
      scopeTuple: { path: ["organizationId"], equals: organizationId },
    };
    if (options.clientId) where["clientId"] = options.clientId;
    if (options.entityPk !== undefined) where["entityPk"] = options.entityPk;
    if (!options.includeRevoked) where["revokedAt"] = null;
    if (!options.includeExpired) where["expiresAt"] = { gt: new Date() };
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = await this.prisma.platosOAuthAccessToken.findMany({
      where,
      select: {
        tokenHash: true,
        clientId: true,
        userId: true,
        scopes: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
        entityPk: true,
      },
      orderBy: { issuedAt: "desc" },
      take: limit,
    });
    const now = Date.now();
    return rows.map((r: any) => ({
      // We expose a stable opaque id — the first 16 chars of the hash —
      // so the operator can reference the row for revocation without us
      // ever returning the full hash.
      id: String(r.tokenHash).slice(0, 16),
      clientId: r.clientId,
      userId: r.userId,
      scopes: r.scopes ?? [],
      issuedAt: r.issuedAt instanceof Date ? r.issuedAt.toISOString() : String(r.issuedAt),
      expiresAt: r.expiresAt instanceof Date ? r.expiresAt.toISOString() : String(r.expiresAt),
      revokedAt: r.revokedAt
        ? r.revokedAt instanceof Date
          ? r.revokedAt.toISOString()
          : String(r.revokedAt)
        : null,
      expired:
        r.expiresAt instanceof Date ? r.expiresAt.getTime() < now : new Date(r.expiresAt).getTime() < now,
      entityPk: r.entityPk ?? null,
    }));
  }

  /**
   * MCPF-W3 — revoke a single access token by its `id` (= first 16 chars of
   * the sha256 token hash). Scope-pinned via `organizationId`. Returns
   * `{ revoked: false }` for cross-tenant or unknown ids — never throws,
   * RFC 7009 §2.2 requires unknown-token revocation to succeed silently.
   */
  async revokeAccessTokenById(
    id: string,
    organizationId: string,
  ): Promise<{ revoked: boolean }> {
    if (!id || typeof id !== "string" || id.length < 8) return { revoked: false };
    // The `id` is the prefix of the token hash. Find it within scope.
    const candidates = await this.prisma.platosOAuthAccessToken.findMany({
      where: {
        scopeTuple: { path: ["organizationId"], equals: organizationId },
        revokedAt: null,
      },
      select: { tokenHash: true },
    });
    const match = (candidates as Array<{ tokenHash: string }>).find(
      (c) => c.tokenHash.startsWith(id),
    );
    if (!match) return { revoked: false };
    const result = await this.prisma.platosOAuthAccessToken.updateMany({
      where: { tokenHash: match.tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: (result?.count ?? 0) > 0 };
  }

  /**
   * MCPF-W3 — rotate the client_secret for a confidential OAuth client.
   * Returns the NEW plaintext secret ONCE — caller must capture it now.
   * The old secret stops authenticating immediately (the new hash overwrites
   * the old). Public clients (`tokenEndpointAuthMethod: "none"`) cannot be
   * rotated — their input shape doesn't have a secret.
   *
   * Scope-pinned via `organizationId`. Soft-deleted clients return
   * `{ rotated: false, reason: "deleted" }`.
   */
  async rotateClientSecret(
    clientId: string,
    organizationId: string,
  ): Promise<
    | { rotated: true; clientId: string; clientSecret: string; issuedAt: string }
    | { rotated: false; reason: "not_found" | "deleted" | "public_client" }
  > {
    const existing = await this.prisma.platosOAuthClient.findUnique({
      where: { clientId },
      select: {
        organizationId: true,
        deletedAt: true,
        tokenEndpointAuthMethod: true,
      },
    });
    if (!existing || existing.organizationId !== organizationId) {
      return { rotated: false, reason: "not_found" };
    }
    if (existing.deletedAt) {
      return { rotated: false, reason: "deleted" };
    }
    if (existing.tokenEndpointAuthMethod === "none") {
      return { rotated: false, reason: "public_client" };
    }
    const newSecret = this.randomId(CLIENT_SECRET_PREFIX, 32);
    const newHash = this.sha256(newSecret);
    const now = new Date();
    await this.prisma.platosOAuthClient.update({
      where: { clientId },
      data: { clientSecretHash: newHash },
    });
    return {
      rotated: true,
      clientId,
      clientSecret: newSecret,
      issuedAt: now.toISOString(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Authorization codes
  // ─────────────────────────────────────────────────────────────

  async issueAuthCode(input: {
    clientId: string;
    userId: string;
    scopeTuple: ScopeTuple;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    redirectUri: string;
    scopes: string[];
    /** PIFSP-21 — pinned entity, forwarded to issued tokens. */
    entityPk?: string;
  }): Promise<{ code: string; expiresAt: Date }> {
    if (!input.codeChallenge || input.codeChallengeMethod !== "S256") {
      throw new OAuthError(
        "invalid_request",
        "PKCE required — code_challenge + code_challenge_method=S256 must be provided",
      );
    }
    const code = this.randomId(AUTH_CODE_PREFIX, 32);
    const expiresAt = new Date(Date.now() + OAUTH_AUTH_CODE_TTL_SEC * 1000);
    await this.prisma.platosOAuthAuthCode.create({
      data: {
        code,
        clientId: input.clientId,
        userId: input.userId,
        scopeTuple: input.scopeTuple,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        redirectUri: input.redirectUri,
        scopes: input.scopes,
        expiresAt,
        ...(input.entityPk ? { entityPk: input.entityPk } : {}),
      },
    });
    return { code, expiresAt };
  }

  /**
   * Exchange an auth code + PKCE verifier for an access+refresh token pair.
   * Consumes the code (one-shot).
   */
  async exchangeAuthCode(input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenHash: string;
    expiresIn: number;
    scopes: string[];
    scope: ScopeTuple;
    userId: string;
  }> {
    const row = await this.prisma.platosOAuthAuthCode.findUnique({
      where: { code: input.code },
    });
    if (!row) {
      throw new OAuthError("invalid_grant", "code not found");
    }
    if (row.usedAt) {
      // OAuth 2.1 — replay detection. Revoke any tokens downstream of this
      // code's previous exchange. We don't track the linkage here so the
      // minimum is to fail closed; TODO(K.10.1) cascade-revoke downstream.
      throw new OAuthError("invalid_grant", "code already used");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new OAuthError("invalid_grant", "code expired");
    }
    if (row.clientId !== input.clientId) {
      throw new OAuthError("invalid_grant", "code was issued to a different client");
    }
    if (row.redirectUri !== input.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    }
    // RFC 7636 — recompute S256(verifier) and compare to the stored challenge.
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(input.codeVerifier)
      .digest("base64url");
    if (expectedChallenge !== row.codeChallenge) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }
    await this.prisma.platosOAuthAuthCode.update({
      where: { code: input.code },
      data: { usedAt: new Date() },
    });

    return this.mintTokenPair({
      clientId: row.clientId,
      userId: row.userId,
      scopeTuple: row.scopeTuple as ScopeTuple,
      scopes: row.scopes,
      ...(row.entityPk ? { entityPk: row.entityPk as string } : {}),
    });
  }

  async mintTokenPair(input: {
    clientId: string;
    userId: string;
    scopeTuple: ScopeTuple;
    scopes: string[];
    /** PIFSP-21 — when present both tokens are stamped with this pin. */
    entityPk?: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenHash: string;
    expiresIn: number;
    scopes: string[];
    scope: ScopeTuple;
    userId: string;
    entityPk?: string;
  }> {
    const accessToken = this.randomId(ACCESS_TOKEN_PREFIX, 32);
    const refreshToken = this.randomId(REFRESH_TOKEN_PREFIX, 32);
    const accessTokenHash = this.sha256(accessToken);
    const refreshTokenHash = this.sha256(refreshToken);
    const now = Date.now();
    const accessExpiresAt = new Date(now + OAUTH_ACCESS_TOKEN_TTL_SEC * 1000);
    const refreshExpiresAt = new Date(now + OAUTH_REFRESH_TOKEN_TTL_SEC * 1000);
    const entityPk = input.entityPk;

    await this.prisma.$transaction([
      this.prisma.platosOAuthAccessToken.create({
        data: {
          tokenHash: accessTokenHash,
          clientId: input.clientId,
          userId: input.userId,
          scopeTuple: input.scopeTuple,
          scopes: input.scopes,
          expiresAt: accessExpiresAt,
          ...(entityPk ? { entityPk } : {}),
        },
      }),
      this.prisma.platosOAuthRefreshToken.create({
        data: {
          tokenHash: refreshTokenHash,
          accessTokenHash,
          clientId: input.clientId,
          userId: input.userId,
          scopeTuple: input.scopeTuple,
          scopes: input.scopes,
          expiresAt: refreshExpiresAt,
          ...(entityPk ? { entityPk } : {}),
        },
      }),
    ]);

    return {
      accessToken,
      refreshToken,
      accessTokenHash,
      expiresIn: OAUTH_ACCESS_TOKEN_TTL_SEC,
      scopes: input.scopes,
      scope: input.scopeTuple,
      userId: input.userId,
      ...(entityPk ? { entityPk } : {}),
    };
  }

  /**
   * Swap a refresh token for a fresh access+refresh pair. The old refresh
   * is revoked (rotation) per OAuth 2.1.
   */
  async exchangeRefreshToken(input: {
    clientId: string;
    refreshToken: string;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenHash: string;
    expiresIn: number;
    scopes: string[];
    scope: ScopeTuple;
    userId: string;
  }> {
    const refreshTokenHash = this.sha256(input.refreshToken);
    const row = await this.prisma.platosOAuthRefreshToken.findUnique({
      where: { tokenHash: refreshTokenHash },
    });
    if (!row) {
      throw new OAuthError("invalid_grant", "refresh_token not found");
    }
    if (row.revokedAt) {
      throw new OAuthError("invalid_grant", "refresh_token revoked");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new OAuthError("invalid_grant", "refresh_token expired");
    }
    if (row.clientId !== input.clientId) {
      throw new OAuthError("invalid_grant", "refresh_token was issued to a different client");
    }

    // Rotate — revoke old refresh, mint fresh pair.
    await this.prisma.platosOAuthRefreshToken.update({
      where: { tokenHash: refreshTokenHash },
      data: { revokedAt: new Date() },
    });

    return this.mintTokenPair({
      clientId: row.clientId,
      userId: row.userId,
      scopeTuple: row.scopeTuple as ScopeTuple,
      scopes: row.scopes,
      ...(row.entityPk ? { entityPk: row.entityPk as string } : {}),
    });
  }

  /**
   * RFC 7662 — introspect. Returns the active token's claims, or
   * `{ active: false }` on any failure mode.
   */
  async verifyAccessToken(raw: string | undefined | null): Promise<VerifiedOAuthAccessToken | null> {
    if (!raw || typeof raw !== "string" || !raw.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const tokenHash = this.sha256(raw);
    const row = await this.prisma.platosOAuthAccessToken.findUnique({
      where: { tokenHash },
    });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;

    return {
      tokenHash,
      clientId: row.clientId,
      userId: row.userId,
      scope: row.scopeTuple as ScopeTuple,
      scopes: row.scopes,
      expiresAt: row.expiresAt,
      entityPk: (row.entityPk as string | null | undefined) ?? null,
    };
  }

  async revokeToken(raw: string): Promise<boolean> {
    if (!raw || typeof raw !== "string") return false;
    const tokenHash = this.sha256(raw);
    let ok = false;
    if (raw.startsWith(ACCESS_TOKEN_PREFIX)) {
      const r = await this.prisma.platosOAuthAccessToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      ok = r.count > 0;
    } else if (raw.startsWith(REFRESH_TOKEN_PREFIX)) {
      const r = await this.prisma.platosOAuthRefreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      ok = r.count > 0;
    }
    // RFC 7009 §2.2 — unknown tokens MUST NOT cause an error.
    return ok;
  }
}
