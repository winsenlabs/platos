import { Inject, Injectable } from "@nestjs/common";
import { AuthorizationScopeKind } from "@platos/tenancy-database";
import * as crypto from "node:crypto";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { env } from "../shared/env";

/** Theme K.10 — OAuth 2.1 authorization-server primitives. */

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
  entityPk?: string | null;
}

export interface DCRInput {
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
  grantTypes?: string[];
  scope?: string;
  registeredByUserId?: string;
  organizationId?: string;
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
  mcpUserId: string;
  identityMode: "anonymous" | "oidc" | "bearer";
  scope: ScopeTuple;
  scopes: string[];
  expiresAt: Date;
  entityPk?: string | null;
}

interface McpIdentityMarker {
  kind: "anonymous" | "oidc";
  sessionId: string;
}

interface TokenPairInput {
  clientDbId: string;
  clientPublicId: string;
  userId: string;
  scopeTuple: ScopeTuple;
  scopes: string[];
  rotationFamilyId?: string;
  parentRefreshTokenId?: string;
  entityPk?: string;
}

const ACCESS_TOKEN_PREFIX = "plt_oa_";
const REFRESH_TOKEN_PREFIX = "plt_or_";
const CLIENT_ID_PREFIX = "plt_oac_";
const CLIENT_SECRET_PREFIX = "plt_ocs_";
const AUTH_CODE_PREFIX = "plt_ocd_";
const MCP_IDENTITY_SCOPE_PREFIX = "platos:mcp-identity:";
const CONSENT_TOKEN_PREFIX = "plt_octx_";

export const PLATFORM_MCP_SCOPES = ["mcp:read", "mcp:write"] as const;
export const ENTITY_MCP_SCOPES = ["mcp:tools"] as const;
export const OAUTH_CONSENT_TTL_SEC = 10 * 60;

export const OAUTH_ACCESS_TOKEN_TTL_SEC = 3600;
export const OAUTH_REFRESH_TOKEN_TTL_SEC = 90 * 24 * 3600;
export const OAUTH_AUTH_CODE_TTL_SEC = 60;

const ALLOWED_AUTH_METHODS = new Set([
  "client_secret_basic",
  "client_secret_post",
  "none",
]);
const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);

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
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

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

  private parseRegisteredScopes(scope: string | null | undefined): string[] {
    return [...new Set((scope ?? "").split(/\s+/).filter(Boolean))];
  }

  private serverOwnedScopes(entityPk?: string): string[] {
    return [...(entityPk ? ENTITY_MCP_SCOPES : PLATFORM_MCP_SCOPES)];
  }

  private consentSignature(opaque: string): string {
    const secret = env.SESSION_SECRET;
    if (!secret) {
      throw new OAuthError("server_error", "consent signing is not configured", 503);
    }
    return crypto.createHmac("sha256", secret).update(opaque).digest("base64url");
  }

  private consentTokenHash(signedToken: string): string | null {
    const dot = signedToken.lastIndexOf(".");
    if (dot <= 0) return null;
    const opaque = signedToken.slice(0, dot);
    const signature = signedToken.slice(dot + 1);
    if (!opaque.startsWith(CONSENT_TOKEN_PREFIX) || !signature) return null;
    const expected = this.consentSignature(opaque);
    const providedBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
    ) {
      return null;
    }
    return this.sha256(opaque);
  }

  private publicScopes(scopes: string[]): string[] {
    return scopes.filter((scope) => !scope.startsWith(MCP_IDENTITY_SCOPE_PREFIX));
  }

  private identityMarker(scopes: string[]): McpIdentityMarker | null {
    const encoded = scopes.find((scope) => scope.startsWith(MCP_IDENTITY_SCOPE_PREFIX));
    if (!encoded) return null;
    const [kind, sessionId] = encoded.slice(MCP_IDENTITY_SCOPE_PREFIX.length).split(":", 2);
    if ((kind !== "anonymous" && kind !== "oidc") || !sessionId) return null;
    return { kind, sessionId };
  }

  private encodeIdentityMarker(marker: McpIdentityMarker): string {
    return `${MCP_IDENTITY_SCOPE_PREFIX}${marker.kind}:${marker.sessionId}`;
  }

  private async canonicalScope(
    scope: ScopeTuple,
    db: Pick<ControlDatabaseClient, "environment"> = this.prisma,
  ): Promise<ScopeTuple> {
    const environment = await db.environment.findFirst({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        archivedAt: null,
        project: {
          organizationId: scope.organizationId,
          archivedAt: null,
          organization: { archivedAt: null },
        },
      },
      select: {
        id: true,
        project: { select: { id: true, organizationId: true } },
      },
    });
    if (!environment) {
      throw new OAuthError("invalid_scope", "environment is not in the authorized scope");
    }
    return {
      organizationId: environment.project.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
    };
  }

  private scopeData(scope: ScopeTuple) {
    return {
      scopeKind: AuthorizationScopeKind.ENVIRONMENT,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    } as const;
  }

  private async registrationUser(
    organizationId: string,
    requestedUserId?: string,
  ): Promise<string> {
    const membership = await this.prisma.organizationMembership.findFirst({
      where: {
        organizationId,
        deactivatedAt: null,
        ...(requestedUserId ? { userId: requestedUserId } : {}),
        user: { disabledAt: null },
      },
      select: { userId: true },
      orderBy: { createdAt: "asc" },
    });
    if (!membership) {
      throw new OAuthError(
        "invalid_client_metadata",
        "registration requires an active organization operator",
        403,
      );
    }
    return membership.userId;
  }

  async register(input: DCRInput): Promise<DCRResult> {
    if (!input.clientName || typeof input.clientName !== "string") {
      throw new OAuthError("invalid_client_metadata", "client_name required");
    }
    if (
      !Array.isArray(input.redirectUris) ||
      input.redirectUris.length === 0 ||
      input.redirectUris.some((uri) => typeof uri !== "string" || uri.length === 0)
    ) {
      throw new OAuthError(
        "invalid_redirect_uri",
        "redirect_uris must be a non-empty string[]",
      );
    }
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
    for (const grantType of grantTypes) {
      if (!ALLOWED_GRANT_TYPES.has(grantType)) {
        throw new OAuthError(
          "invalid_client_metadata",
          `unsupported grant_type: ${grantType}`,
        );
      }
    }

    let organizationId = input.organizationId;
    if (input.entityPk) {
      const entity = await this.prisma.entity.findUnique({
        where: { id: input.entityPk },
        select: { project: { select: { organizationId: true } } },
      });
      if (!entity || (organizationId && entity.project.organizationId !== organizationId)) {
        throw new OAuthError("invalid_client_metadata", "entity is not in registration scope", 403);
      }
      organizationId = entity.project.organizationId;
    }
    if (!organizationId) {
      throw new OAuthError(
        "invalid_client_metadata",
        "organization scope is required for client registration",
        403,
      );
    }
    const registeredByUserId = await this.registrationUser(
      organizationId,
      input.registeredByUserId,
    );

    const clientId = this.randomId(CLIENT_ID_PREFIX, 16);
    const rawSecret =
      authMethod === "none" ? undefined : this.randomId(CLIENT_SECRET_PREFIX, 32);
    const advertisedScopes = this.serverOwnedScopes(input.entityPk);
    const requestedRegistrationScopes = this.parseRegisteredScopes(input.scope);
    const advertisedScopeSet = new Set<string>(advertisedScopes);
    if (requestedRegistrationScopes.some((scope) => !advertisedScopeSet.has(scope))) {
      throw new OAuthError(
        "invalid_client_metadata",
        "scope contains a label that is not advertised by this authorization server",
      );
    }
    const row = await this.prisma.oAuthClient.create({
      data: {
        organizationId,
        clientId,
        clientSecretHash: rawSecret ? this.sha256(rawSecret) : null,
        clientName: input.clientName.slice(0, 200),
        redirectUris: input.redirectUris,
        tokenEndpointAuthMethod: authMethod,
        grantTypes,
        scopes: advertisedScopes,
        registeredByUserId,
        entityId: input.entityPk ?? null,
      },
    });

    return {
      client_id: row.clientId,
      ...(rawSecret ? { client_secret: rawSecret } : {}),
      client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
      client_secret_expires_at: 0,
      client_name: row.clientName,
      redirect_uris: row.redirectUris,
      grant_types: row.grantTypes,
      token_endpoint_auth_method: row.tokenEndpointAuthMethod,
      ...(row.scopes.length > 0 ? { scope: row.scopes.join(" ") } : {}),
    };
  }

  private projectClient(row: {
    id: string;
    clientId: string;
    clientName: string;
    redirectUris: string[];
    tokenEndpointAuthMethod: string;
    grantTypes: string[];
    scopes: string[];
    organizationId: string;
    registeredByUserId: string;
    entityId: string | null;
    createdAt: Date;
  }): OAuthClientRecord {
    return {
      id: row.id,
      clientId: row.clientId,
      clientName: row.clientName,
      redirectUris: row.redirectUris,
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
      grantTypes: row.grantTypes,
      scope: row.scopes.length > 0 ? row.scopes.join(" ") : null,
      organizationId: row.organizationId,
      registeredByUserId: row.registeredByUserId,
      entityPk: row.entityId,
      createdAt: row.createdAt,
    };
  }

  async findClient(clientId: string): Promise<OAuthClientRecord | null> {
    if (!clientId || typeof clientId !== "string") return null;
    const row = await this.prisma.oAuthClient.findUnique({ where: { clientId } });
    if (!row || row.deletedAt) return null;
    return this.projectClient(row);
  }

  async effectiveScopes(clientId: string, requested?: string): Promise<string[]> {
    const client = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
      select: { scopes: true, deletedAt: true },
    });
    if (!client || client.deletedAt) {
      throw new OAuthError("invalid_client", "unknown client_id");
    }
    const requestedScopes = this.parseRegisteredScopes(requested);
    const effective = requestedScopes.length > 0 ? requestedScopes : client.scopes;
    if (effective.some((scope) => !client.scopes.includes(scope))) {
      throw new OAuthError("invalid_scope", "requested scope is not advertised for this client");
    }
    return effective;
  }

  async createConsentTransaction(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    scopes: string[];
    scopeTuple: ScopeTuple;
    entityPk?: string;
    state?: string;
  }): Promise<string> {
    const scope = await this.canonicalScope(input.scopeTuple);
    const client = await this.prisma.oAuthClient.findUnique({
      where: { clientId: input.clientId },
      select: { id: true, entityId: true, organizationId: true, redirectUris: true, scopes: true, deletedAt: true },
    });
    if (
      !client ||
      client.deletedAt ||
      client.organizationId !== scope.organizationId ||
      client.entityId !== (input.entityPk ?? null) ||
      !client.redirectUris.includes(input.redirectUri) ||
      input.scopes.some((label) => !client.scopes.includes(label))
    ) {
      throw new OAuthError("invalid_request", "consent request is not valid for this client and scope");
    }
    const opaque = this.randomId(CONSENT_TOKEN_PREFIX, 32);
    const signed = `${opaque}.${this.consentSignature(opaque)}`;
    await this.prisma.oAuthConsentTransaction.create({
      data: {
        tokenHash: this.sha256(opaque),
        nonce: crypto.randomUUID(),
        clientId: client.id,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        scopes: input.scopes,
        entityId: input.entityPk ?? null,
        ...scope,
        state: input.state ?? null,
        expiresAt: new Date(Date.now() + OAUTH_CONSENT_TTL_SEC * 1000),
      },
    });
    return signed;
  }

  async inspectConsentTransaction(signedToken: string) {
    const tokenHash = this.consentTokenHash(signedToken);
    if (!tokenHash) return null;
    const row = await this.prisma.oAuthConsentTransaction.findUnique({
      where: { tokenHash },
      include: {
        client: { select: { clientId: true, clientName: true, deletedAt: true } },
        entity: { select: { externalId: true, displayName: true, mcpConfig: true } },
        environment: { select: { id: true, name: true, slug: true } },
      },
    });
    if (!row || row.client.deletedAt || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return row;
  }

  async consumeConsentTransaction(signedToken: string) {
    const tokenHash = this.consentTokenHash(signedToken);
    if (!tokenHash) throw new OAuthError("invalid_request", "consent transaction is invalid");
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.oAuthConsentTransaction.findUnique({
        where: { tokenHash },
        include: { client: { select: { clientId: true, registeredByUserId: true, deletedAt: true } } },
      });
      if (!row || row.client.deletedAt || row.consumedAt || row.expiresAt.getTime() <= Date.now()) {
        throw new OAuthError("invalid_request", "consent transaction is expired or already consumed");
      }
      const claimed = await tx.oAuthConsentTransaction.updateMany({
        where: { id: row.id, consumedAt: null, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new OAuthError("invalid_request", "consent transaction is expired or already consumed");
      }
      return row;
    });
  }

  async verifyClientSecret(clientId: string, clientSecret: string): Promise<boolean> {
    const row = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
      select: { clientSecretHash: true, deletedAt: true },
    });
    if (!row?.clientSecretHash || row.deletedAt) return false;
    return this.timingSafeEqualHex(row.clientSecretHash, this.sha256(clientSecret));
  }

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
    const rows = await this.prisma.oAuthClient.findMany({
      where: {
        organizationId,
        ...(options.entityPk !== undefined ? { entityId: options.entityPk } : {}),
        ...(!options.includeDeleted ? { deletedAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => ({
      id: row.id,
      clientId: row.clientId,
      clientName: row.clientName,
      redirectUris: row.redirectUris,
      tokenEndpointAuthMethod: row.tokenEndpointAuthMethod,
      grantTypes: row.grantTypes,
      scope: row.scopes.length > 0 ? row.scopes.join(" ") : null,
      organizationId: row.organizationId,
      entityPk: row.entityId,
      registeredByUserId: row.registeredByUserId,
      createdAt: row.createdAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    }));
  }

  async deleteClient(
    clientId: string,
    organizationId: string,
  ): Promise<{
    deleted: boolean;
    alreadyDeleted?: boolean;
    accessTokensRevoked: number;
    refreshTokensRevoked: number;
  }> {
    const existing = await this.prisma.oAuthClient.findUnique({
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
    const [, accessTokens, refreshTokens] = await this.prisma.$transaction([
      this.prisma.oAuthClient.update({
        where: { id: existing.id },
        data: { deletedAt: now },
      }),
      this.prisma.oAuthAccessToken.updateMany({
        where: { clientId: existing.id, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.oAuthRefreshToken.updateMany({
        where: { clientId: existing.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    return {
      deleted: true,
      accessTokensRevoked: accessTokens.count,
      refreshTokensRevoked: refreshTokens.count,
    };
  }

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
    const rows = await this.prisma.oAuthAccessToken.findMany({
      where: {
        organizationId,
        ...(options.clientId || options.entityPk !== undefined
          ? {
              client: {
                ...(options.clientId ? { clientId: options.clientId } : {}),
                ...(options.entityPk !== undefined
                  ? { entityId: options.entityPk }
                  : {}),
              },
            }
          : {}),
        ...(!options.includeRevoked ? { revokedAt: null } : {}),
        ...(!options.includeExpired ? { expiresAt: { gt: new Date() } } : {}),
      },
      select: {
        id: true,
        userId: true,
        scopes: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
        client: { select: { clientId: true, entityId: true } },
      },
      orderBy: { issuedAt: "desc" },
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });
    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      clientId: row.client.clientId,
      userId: row.userId,
      scopes: this.publicScopes(row.scopes),
      issuedAt: row.issuedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      expired: row.expiresAt.getTime() < now,
      entityPk: row.client.entityId,
    }));
  }

  async revokeAccessTokenById(
    id: string,
    organizationId: string,
  ): Promise<{ revoked: boolean }> {
    if (!id || typeof id !== "string") return { revoked: false };
    const result = await this.prisma.oAuthAccessToken.updateMany({
      where: { id, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count > 0 };
  }

  async rotateClientSecret(
    clientId: string,
    organizationId: string,
  ): Promise<
    | { rotated: true; clientId: string; clientSecret: string; issuedAt: string }
    | { rotated: false; reason: "not_found" | "deleted" | "public_client" }
  > {
    const existing = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
      select: {
        id: true,
        organizationId: true,
        deletedAt: true,
        tokenEndpointAuthMethod: true,
      },
    });
    if (!existing || existing.organizationId !== organizationId) {
      return { rotated: false, reason: "not_found" };
    }
    if (existing.deletedAt) return { rotated: false, reason: "deleted" };
    if (existing.tokenEndpointAuthMethod === "none") {
      return { rotated: false, reason: "public_client" };
    }
    const clientSecret = this.randomId(CLIENT_SECRET_PREFIX, 32);
    const issuedAt = new Date();
    await this.prisma.oAuthClient.update({
      where: { id: existing.id },
      data: { clientSecretHash: this.sha256(clientSecret) },
    });
    return {
      rotated: true,
      clientId,
      clientSecret,
      issuedAt: issuedAt.toISOString(),
    };
  }

  async issueAuthCode(input: {
    clientId: string;
    userId: string;
    scopeTuple: ScopeTuple;
    codeChallenge: string;
    codeChallengeMethod: "S256";
    redirectUri: string;
    scopes: string[];
    entityPk?: string;
    mcpIdentity?: McpIdentityMarker;
  }): Promise<{ code: string; expiresAt: Date }> {
    if (!input.codeChallenge || input.codeChallengeMethod !== "S256") {
      throw new OAuthError(
        "invalid_request",
        "PKCE required — code_challenge + code_challenge_method=S256 must be provided",
      );
    }
    const scope = await this.canonicalScope(input.scopeTuple);
    const client = await this.prisma.oAuthClient.findUnique({
      where: { clientId: input.clientId },
      select: {
        id: true,
        organizationId: true,
        entityId: true,
        deletedAt: true,
        redirectUris: true,
        scopes: true,
      },
    });
    if (
      !client ||
      client.deletedAt ||
      client.organizationId !== scope.organizationId ||
      (input.entityPk !== undefined && client.entityId !== input.entityPk) ||
      !client.redirectUris.includes(input.redirectUri)
    ) {
      throw new OAuthError("invalid_grant", "client is not valid for the authorized scope");
    }
    const requestedScopes = this.publicScopes(input.scopes);
    if (requestedScopes.some((scopeLabel) => !client.scopes.includes(scopeLabel))) {
      throw new OAuthError("invalid_scope", "requested scope was not registered for this client");
    }
    const user = await this.prisma.organizationMembership.findFirst({
      where: {
        organizationId: scope.organizationId,
        userId: input.userId,
        deactivatedAt: null,
        user: { disabledAt: null },
      },
      select: { userId: true },
    });
    if (!user) {
      throw new OAuthError("access_denied", "user is not active in the organization", 403);
    }

    const code = this.randomId(AUTH_CODE_PREFIX, 32);
    const expiresAt = new Date(Date.now() + OAUTH_AUTH_CODE_TTL_SEC * 1000);
    const scopes = requestedScopes;
    if (input.mcpIdentity) scopes.push(this.encodeIdentityMarker(input.mcpIdentity));
    await this.prisma.oAuthAuthorizationCode.create({
      data: {
        codeHash: this.sha256(code),
        clientId: client.id,
        userId: user.userId,
        ...this.scopeData(scope),
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        redirectUri: input.redirectUri,
        scopes,
        expiresAt,
      },
    });
    return { code, expiresAt };
  }

  async exchangeAuthCode(input: {
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    expectedScope?: ScopeTuple;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenHash: string;
    expiresIn: number;
    scopes: string[];
    scope: ScopeTuple;
    userId: string;
  }> {
    const codeHash = this.sha256(input.code);
    const row = await this.prisma.oAuthAuthorizationCode.findUnique({
      where: { codeHash },
      include: { client: { select: { clientId: true, entityId: true } } },
    });
    if (!row) throw new OAuthError("invalid_grant", "code not found");
    if (row.usedAt) throw new OAuthError("invalid_grant", "code already used");
    if (row.expiresAt.getTime() < Date.now()) {
      throw new OAuthError("invalid_grant", "code expired");
    }
    if (row.client.clientId !== input.clientId) {
      throw new OAuthError("invalid_grant", "code was issued to a different client");
    }
    if (row.redirectUri !== input.redirectUri) {
      throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    }
    const expectedChallenge = crypto
      .createHash("sha256")
      .update(input.codeVerifier)
      .digest("base64url");
    if (expectedChallenge !== row.codeChallenge) {
      throw new OAuthError("invalid_grant", "PKCE verification failed");
    }
    if (!row.organizationId || !row.projectId || !row.environmentId) {
      throw new OAuthError("invalid_grant", "authorization code has no canonical scope");
    }
    if (
      input.expectedScope &&
      (row.organizationId !== input.expectedScope.organizationId ||
        row.projectId !== input.expectedScope.projectId ||
        row.environmentId !== input.expectedScope.environmentId)
    ) {
      throw new OAuthError("invalid_grant", "authorization code scope does not match this endpoint");
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.oAuthAuthorizationCode.updateMany({
        where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      return this.mintTokenPairInTransaction(tx, {
        clientDbId: row.clientId,
        clientPublicId: row.client.clientId,
        userId: row.userId,
        scopeTuple: {
          organizationId: row.organizationId!,
          projectId: row.projectId!,
          environmentId: row.environmentId!,
        },
        scopes: row.scopes,
        entityPk: row.client.entityId ?? undefined,
      });
    });
    if (!result) throw new OAuthError("invalid_grant", "code already used");
    return result;
  }

  async mintTokenPair(input: {
    clientId: string;
    userId: string;
    scopeTuple: ScopeTuple;
    scopes: string[];
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
    const scope = await this.canonicalScope(input.scopeTuple);
    const client = await this.prisma.oAuthClient.findUnique({
      where: { clientId: input.clientId },
      select: { id: true, entityId: true, organizationId: true, deletedAt: true },
    });
    if (!client || client.deletedAt || client.organizationId !== scope.organizationId) {
      throw new OAuthError("invalid_client", "unknown client_id", 401);
    }
    return this.prisma.$transaction((tx) =>
      this.mintTokenPairInTransaction(tx, {
        clientDbId: client.id,
        clientPublicId: input.clientId,
        userId: input.userId,
        scopeTuple: scope,
        scopes: input.scopes,
        entityPk: client.entityId ?? undefined,
      }),
    );
  }

  private async mintTokenPairInTransaction(
    tx: Parameters<Parameters<ControlDatabaseClient["$transaction"]>[0]>[0],
    input: TokenPairInput,
  ) {
    const accessToken = this.randomId(ACCESS_TOKEN_PREFIX, 32);
    const refreshToken = this.randomId(REFRESH_TOKEN_PREFIX, 32);
    const accessTokenHash = this.sha256(accessToken);
    const now = Date.now();
    const access = await tx.oAuthAccessToken.create({
      data: {
        tokenHash: accessTokenHash,
        clientId: input.clientDbId,
        userId: input.userId,
        ...this.scopeData(input.scopeTuple),
        scopes: input.scopes,
        expiresAt: new Date(now + OAUTH_ACCESS_TOKEN_TTL_SEC * 1000),
      },
      select: { id: true },
    });
    await tx.oAuthRefreshToken.create({
      data: {
        tokenHash: this.sha256(refreshToken),
        accessTokenId: access.id,
        clientId: input.clientDbId,
        userId: input.userId,
        ...this.scopeData(input.scopeTuple),
        scopes: input.scopes,
        rotationFamilyId: input.rotationFamilyId ?? crypto.randomUUID(),
        parentRefreshTokenId: input.parentRefreshTokenId,
        expiresAt: new Date(now + OAUTH_REFRESH_TOKEN_TTL_SEC * 1000),
      },
    });
    return {
      accessToken,
      refreshToken,
      accessTokenHash,
      expiresIn: OAUTH_ACCESS_TOKEN_TTL_SEC,
      scopes: this.publicScopes(input.scopes),
      scope: input.scopeTuple,
      userId: input.userId,
      ...(input.entityPk ? { entityPk: input.entityPk } : {}),
    };
  }

  async exchangeRefreshToken(input: {
    clientId: string;
    refreshToken: string;
    expectedScope?: ScopeTuple;
  }): Promise<{
    accessToken: string;
    refreshToken: string;
    accessTokenHash: string;
    expiresIn: number;
    scopes: string[];
    scope: ScopeTuple;
    userId: string;
  }> {
    const tokenHash = this.sha256(input.refreshToken);
    const row = await this.prisma.oAuthRefreshToken.findUnique({
      where: { tokenHash },
      include: { client: { select: { clientId: true, entityId: true } } },
    });
    if (!row) throw new OAuthError("invalid_grant", "refresh_token not found");
    if (row.client.clientId !== input.clientId) {
      throw new OAuthError(
        "invalid_grant",
        "refresh_token was issued to a different client",
      );
    }
    if (!row.organizationId || !row.projectId || !row.environmentId) {
      throw new OAuthError("invalid_grant", "refresh_token has no canonical scope");
    }
    if (
      input.expectedScope &&
      (row.organizationId !== input.expectedScope.organizationId ||
        row.projectId !== input.expectedScope.projectId ||
        row.environmentId !== input.expectedScope.environmentId)
    ) {
      throw new OAuthError("invalid_grant", "refresh_token scope does not match this endpoint");
    }
    if (row.consumedAt || row.revokedAt) {
      const now = new Date();
      await this.prisma.$transaction([
        this.prisma.oAuthRefreshToken.updateMany({
          where: { rotationFamilyId: row.rotationFamilyId },
          data: { replayDetectedAt: now, revokedAt: now },
        }),
        this.prisma.oAuthAccessToken.updateMany({
          where: {
            refreshTokens: { some: { rotationFamilyId: row.rotationFamilyId } },
            revokedAt: null,
          },
          data: { revokedAt: now },
        }),
      ]);
      throw new OAuthError("invalid_grant", "refresh_token replay detected");
    }
    if (row.expiresAt.getTime() < Date.now()) {
      throw new OAuthError("invalid_grant", "refresh_token expired");
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.oAuthRefreshToken.updateMany({
        where: {
          id: row.id,
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      return this.mintTokenPairInTransaction(tx, {
        clientDbId: row.clientId,
        clientPublicId: row.client.clientId,
        userId: row.userId,
        scopeTuple: {
          organizationId: row.organizationId!,
          projectId: row.projectId!,
          environmentId: row.environmentId!,
        },
        scopes: row.scopes,
        rotationFamilyId: row.rotationFamilyId,
        parentRefreshTokenId: row.id,
        entityPk: row.client.entityId ?? undefined,
      });
    });
    if (!result) {
      throw new OAuthError("invalid_grant", "refresh_token replay detected");
    }
    return result;
  }

  async verifyAccessToken(
    raw: string | undefined | null,
  ): Promise<VerifiedOAuthAccessToken | null> {
    if (!raw || typeof raw !== "string" || !raw.startsWith(ACCESS_TOKEN_PREFIX)) {
      return null;
    }
    return this.verifyAccessTokenHash(this.sha256(raw));
  }

  /** Revalidate an SSE session without retaining the raw OAuth bearer. */
  async verifyAccessTokenHash(
    tokenHash: string,
  ): Promise<VerifiedOAuthAccessToken | null> {
    const row = await this.prisma.oAuthAccessToken.findUnique({
      where: { tokenHash },
      include: { client: { select: { clientId: true, entityId: true, deletedAt: true } } },
    });
    if (
      !row ||
      row.revokedAt ||
      row.client.deletedAt ||
      row.expiresAt.getTime() < Date.now() ||
      !row.organizationId ||
      !row.projectId ||
      !row.environmentId
    ) {
      return null;
    }

    let mcpUserId = row.userId;
    let identityMode: VerifiedOAuthAccessToken["identityMode"] = "oidc";
    const marker = this.identityMarker(row.scopes);
    if (marker?.kind === "anonymous") {
      const session = await this.prisma.mcpAnonymousSession.findFirst({
        where: {
          id: marker.sessionId,
          entityId: row.client.entityId ?? "",
          environmentId: row.environmentId,
          revokedAt: null,
        },
        select: { mcpUserId: true },
      });
      if (!session) return null;
      mcpUserId = session.mcpUserId;
      identityMode = "anonymous";
    } else if (marker?.kind === "oidc") {
      const session = await this.prisma.mcpOidcSession.findFirst({
        where: {
          id: marker.sessionId,
          entityId: row.client.entityId ?? "",
          environmentId: row.environmentId,
          revokedAt: null,
        },
        select: { mcpUserId: true },
      });
      if (!session) return null;
      mcpUserId = session.mcpUserId;
      identityMode = "oidc";
    }

    return {
      tokenHash,
      clientId: row.client.clientId,
      userId: row.userId,
      mcpUserId,
      identityMode,
      scope: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        environmentId: row.environmentId,
      },
      scopes: this.publicScopes(row.scopes),
      expiresAt: row.expiresAt,
      entityPk: row.client.entityId,
    };
  }

  async revokeToken(
    raw: string,
    clientId?: string,
    expectedScope?: ScopeTuple,
  ): Promise<boolean> {
    if (!raw || typeof raw !== "string") return false;
    const tokenHash = this.sha256(raw);
    const now = new Date();
    if (raw.startsWith(ACCESS_TOKEN_PREFIX)) {
      const result = await this.prisma.oAuthAccessToken.updateMany({
        where: {
          tokenHash,
          revokedAt: null,
          ...(clientId ? { client: { clientId } } : {}),
          ...(expectedScope ?? {}),
        },
        data: { revokedAt: now },
      });
      return result.count > 0;
    }
    if (raw.startsWith(REFRESH_TOKEN_PREFIX)) {
      const result = await this.prisma.oAuthRefreshToken.updateMany({
        where: {
          tokenHash,
          revokedAt: null,
          ...(clientId ? { client: { clientId } } : {}),
          ...(expectedScope ?? {}),
        },
        data: { revokedAt: now },
      });
      return result.count > 0;
    }
    return false;
  }
}
