import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import * as crypto from "node:crypto";
import {
  CredentialKind,
  PlatosSecretStore,
  authorizeEnvironmentService,
} from "@platos/tenancy-database";
import {
  ENTITY_MCP_SCOPES,
  OAuthError,
  OAuthService,
  OAUTH_ACCESS_TOKEN_TTL_SEC,
  PLATFORM_MCP_SCOPES,
} from "./oauth.service";
import { env } from "../shared/env";
import {
  type ControlDatabaseClient,
  PLATOS_SECRET_STORE_TOKEN,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { validatePublicUrl, describeUrlValidationError } from "../shared/url-validator";

/**
 * Theme K.10 — OAuth 2.1 authorization-server endpoints.
 *
 * All under `/oauth/*` — public (no ScopeGuard). Authentication is
 * embedded in each endpoint via the OAuth protocol itself (client
 * credentials, auth codes, PKCE verifiers, bearer tokens).
 *
 *   GET  /.well-known/oauth-authorization-server — RFC 8414 metadata
 *   POST /oauth/register                          — RFC 7591 DCR
 *   GET  /oauth/authorize                         — redirects to webapp consent
 *   POST /oauth/authorize/callback                — webapp → agent, issues code + redirects
 *   POST /oauth/token                             — RFC 6749 + OAuth 2.1
 *   POST /oauth/introspect                        — RFC 7662
 *   POST /oauth/revoke                            — RFC 7009
 */
@Controller()
export class OAuthController {
  constructor(
    private readonly oauth: OAuthService,
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Inject(PLATOS_SECRET_STORE_TOKEN) private readonly secretStore: PlatosSecretStore,
  ) {}

  private get issuerUrl(): string {
    return env.APP_ORIGIN ?? env.PLATOS_AGENT_API_URL ?? "http://localhost:3100";
  }

  /**
   * PIFSP-21 — resolve the PlatosConnectedEntity by human-readable
   * `entityId` slug. Used by every entity-scoped OAuth route.
   *
   * Returns `null` if the entity is missing OR `PlatosEntityMcpConfig`
   * is absent / `enabled = false`. Routes map this to 404 so we don't
   * leak entity existence to strangers probing MCP endpoints.
   */
  private async resolveEntityForMcp(
    entityIdSlug: string,
    environmentId?: string,
  ): Promise<
    | {
        entityPk: string;
        organizationId: string;
        projectId: string;
        environmentId: string;
        displayName: string;
        config: any;
      }
    | null
  > {
    if (!entityIdSlug || typeof entityIdSlug !== "string" || !environmentId) return null;
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: environmentId,
        archivedAt: null,
        project: { archivedAt: null, organization: { archivedAt: null } },
      },
      select: {
        id: true,
        project: {
          select: {
            id: true,
            organizationId: true,
            entities: {
              where: { externalId: entityIdSlug },
              select: { id: true, displayName: true, mcpConfig: true },
              take: 2,
            },
          },
        },
      },
    });
    if (!environment || environment.project.entities.length !== 1) return null;
    const ent = environment.project.entities[0]!;
    if (!ent.mcpConfig) return null;
    if (!ent.mcpConfig.enabled) return null;
    return {
      entityPk: ent.id,
      organizationId: environment.project.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
      displayName: ent.displayName,
      config: ent.mcpConfig,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RFC 8414 — Authorization Server Metadata
  // ─────────────────────────────────────────────────────────────

  @Get(".well-known/oauth-authorization-server")
  async metadata() {
    const issuer = this.issuerUrl;
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none",
      ],
      scopes_supported: [...PLATFORM_MCP_SCOPES],
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RFC 7591 — Dynamic Client Registration
  // ─────────────────────────────────────────────────────────────

  @Post("oauth/register")
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body()
    body: {
      client_name?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: "client_secret_basic" | "client_secret_post" | "none";
      grant_types?: string[];
      scope?: string;
      organization_id?: string;
      registered_by_user_id?: string;
    },
  ) {
    try {
      const result = await this.oauth.register({
        clientName: body?.client_name ?? "",
        redirectUris: body?.redirect_uris ?? [],
        ...(body?.token_endpoint_auth_method
          ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method }
          : {}),
        ...(body?.grant_types ? { grantTypes: body.grant_types } : {}),
        scope: body?.scope,
        ...(body?.organization_id ? { organizationId: body.organization_id } : {}),
        ...(body?.registered_by_user_id
          ? { registeredByUserId: body.registered_by_user_id }
          : {}),
      });
      return result;
    } catch (err) {
      if (err instanceof OAuthError) {
        throw new HttpException({ error: err.code, error_description: err.message }, err.status);
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Authorization endpoint — redirects to webapp consent.
  //
  // Per OAuth 2.1 the UA hits /authorize with:
  //   response_type=code, client_id, redirect_uri, scope, state,
  //   code_challenge, code_challenge_method
  // The agent has no session cookie / consent UI — we bounce the UA
  // to the webapp's /oauth/consent loader, which uses the standard
  // Remix auth session to identify the user and then POSTs back to
  // /oauth/authorize/callback on this controller with the approval.
  // ─────────────────────────────────────────────────────────────

  @Get("oauth/authorize")
  async authorize(
    @Req() _req: Request,
    @Res() res: Response,
    @Query("response_type") responseType: string | undefined,
    @Query("client_id") clientId: string | undefined,
    @Query("redirect_uri") redirectUri: string | undefined,
    @Query("scope") scope: string | undefined,
    @Query("state") state: string | undefined,
    @Query("code_challenge") codeChallenge: string | undefined,
    @Query("code_challenge_method") codeChallengeMethod: string | undefined,
    @Query("environment_id") environmentId: string | undefined,
  ): Promise<void> {
    // Parameter validation — per RFC 6749 §4.1.2.1 errors that apply to
    // redirect_uri itself MUST NOT redirect; other errors redirect back.
    if (!clientId) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "client_id required",
      });
      return;
    }
    const client = await this.oauth.findClient(clientId);
    if (!client) {
      res.status(400).json({
        error: "invalid_client",
        error_description: "unknown client_id",
      });
      return;
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "redirect_uri missing or not registered for this client",
      });
      return;
    }

    const sendErrorRedirect = (code: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", code);
      url.searchParams.set("error_description", description);
      if (state) url.searchParams.set("state", state);
      res.redirect(302, url.toString());
    };

    if (responseType !== "code") {
      sendErrorRedirect("unsupported_response_type", "only response_type=code is supported");
      return;
    }
    // OAuth 2.1 — PKCE required.
    if (!codeChallenge) {
      sendErrorRedirect("invalid_request", "code_challenge is required (PKCE)");
      return;
    }
    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      sendErrorRedirect("invalid_request", "only code_challenge_method=S256 is supported");
      return;
    }

    if (!environmentId) {
      sendErrorRedirect("invalid_request", "environment_id is required");
      return;
    }
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: environmentId,
        archivedAt: null,
        project: { archivedAt: null, organizationId: client.organizationId },
      },
      select: { id: true, project: { select: { id: true, organizationId: true } } },
    });
    if (!environment) {
      sendErrorRedirect("invalid_scope", "environment_id is not valid for this client");
      return;
    }

    let transaction: string;
    try {
      const effectiveScopes = await this.oauth.effectiveScopes(clientId, scope);
      transaction = await this.oauth.createConsentTransaction({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: "S256",
        scopes: effectiveScopes,
        scopeTuple: {
          organizationId: environment.project.organizationId,
          projectId: environment.project.id,
          environmentId: environment.id,
        },
        ...(state ? { state } : {}),
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        sendErrorRedirect(error.code, error.message);
        return;
      }
      throw error;
    }

    // Bounce to the webapp consent screen. The loader reads these query
    // params + requireUserId, renders the approval card, then POSTs back
    // to `/oauth/authorize/callback` on this controller.
    const webappBase =
      env.APP_ORIGIN ??
      env.PLATOS_WEBAPP_ADMIN_URL ??
      "http://localhost:3030";
    const consentUrl = new URL("/oauth/consent", webappBase);
    consentUrl.searchParams.set("transaction", transaction);
    res.redirect(302, consentUrl.toString());
  }

  @Get("oauth/consent")
  async inspectConsent(@Query("transaction") transaction: string | undefined) {
    if (!transaction) throw new HttpException("transaction required", HttpStatus.BAD_REQUEST);
    const row = await this.oauth.inspectConsentTransaction(transaction);
    if (!row) throw new HttpException("consent transaction invalid or expired", HttpStatus.GONE);
    return {
      transaction,
      flow: row.entityId
        ? row.entity?.mcpConfig?.identityMode?.split("+").includes("oidc")
          ? "entity_oidc"
          : row.entity?.mcpConfig?.identityMode?.split("+").includes("anonymous")
            ? "entity_anonymous"
            : "entity_bearer"
        : "platform",
      client: {
        clientId: row.client.clientId,
        clientName: row.client.clientName,
        redirectUri: row.redirectUri,
      },
      entity: row.entityId && row.entity ? {
        entityPk: row.entityId,
        entityId: row.entity.externalId,
        displayName: row.entity.displayName,
        branding: row.entity.mcpConfig?.branding ?? null,
      } : null,
      environment: row.environment,
      effectiveScopes: row.scopes,
    };
  }

  /**
   * Called by the webapp consent action once the user has approved +
   * selected the (org, project, env) tuple. Auth: the webapp forwards
   * the user identity via an HMAC'd body signed with SESSION_SECRET
   * (reuses the same shared secret). TODO(K.10.1) switch to a proper
   * inter-service signed JWT with iat/aud claims instead of reusing
   * the session secret directly.
   */
  @Post("oauth/authorize/callback")
  async authorizeCallback(
    @Headers("x-platos-internal-token") internalToken: string | undefined,
    @Body()
    body: {
      transaction: string;
      userId: string;
      action?: "approve" | "deny";
    },
  ): Promise<{ redirectTo: string }> {
    if (!env.PLATOS_INTERNAL_AUTH_TOKEN) {
      throw new HttpException(
        "internal consent authentication not configured",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const provided = Buffer.from(internalToken ?? "");
    const expected = Buffer.from(env.PLATOS_INTERNAL_AUTH_TOKEN);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
      throw new HttpException("invalid internal consent authentication", HttpStatus.UNAUTHORIZED);
    }

    try {
      const consent = await this.oauth.consumeConsentTransaction(body.transaction);
      if (body.action === "deny") {
        const denied = new URL(consent.redirectUri);
        denied.searchParams.set("error", "access_denied");
        if (consent.state) denied.searchParams.set("state", consent.state);
        return { redirectTo: denied.toString() };
      }
      const { code } = await this.oauth.issueAuthCode({
        clientId: consent.client.clientId,
        userId: body.userId,
        scopeTuple: {
          organizationId: consent.organizationId,
          projectId: consent.projectId,
          environmentId: consent.environmentId,
        },
        codeChallenge: consent.codeChallenge,
        codeChallengeMethod: "S256",
        redirectUri: consent.redirectUri,
        scopes: consent.scopes,
        ...(consent.entityId ? { entityPk: consent.entityId } : {}),
      });

      const redirect = new URL(consent.redirectUri);
      redirect.searchParams.set("code", code);
      if (consent.state) redirect.searchParams.set("state", consent.state);
      return { redirectTo: redirect.toString() };
    } catch (err) {
      if (err instanceof OAuthError) {
        throw new HttpException({ error: err.code, error_description: err.message }, err.status);
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RFC 6749 / OAuth 2.1 — Token endpoint
  // ─────────────────────────────────────────────────────────────

  @Post("oauth/token")
  async token(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      client_id?: string;
      client_secret?: string;
      refresh_token?: string;
    },
  ) {
    const { clientId, clientSecret } = this.extractClientCredentials(authorization, body);
    if (!clientId) {
      throw this.oauthHttp("invalid_client", "client_id required", HttpStatus.UNAUTHORIZED);
    }

    const client = await this.oauth.findClient(clientId);
    if (!client) {
      throw this.oauthHttp("invalid_client", "unknown client_id", HttpStatus.UNAUTHORIZED);
    }

    // Authenticate confidential clients.
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!clientSecret) {
        throw this.oauthHttp(
          "invalid_client",
          "client_secret required",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const ok = await this.oauth.verifyClientSecret(clientId, clientSecret);
      if (!ok) {
        throw this.oauthHttp(
          "invalid_client",
          "client authentication failed",
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    try {
      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.code_verifier || !body.redirect_uri) {
          throw new OAuthError(
            "invalid_request",
            "code, redirect_uri, code_verifier required",
          );
        }
        const result = await this.oauth.exchangeAuthCode({
          clientId,
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
        });
        return {
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scopes.join(" "),
        };
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) {
          throw new OAuthError("invalid_request", "refresh_token required");
        }
        const result = await this.oauth.exchangeRefreshToken({
          clientId,
          refreshToken: body.refresh_token,
        });
        return {
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scopes.join(" "),
        };
      }
      throw new OAuthError("unsupported_grant_type", `grant_type=${body.grant_type}`);
    } catch (err) {
      if (err instanceof OAuthError) {
        throw this.oauthHttp(err.code, err.message, err.status);
      }
      throw err;
    }
  }

  private extractClientCredentials(
    authorization: string | undefined,
    body: { client_id?: string; client_secret?: string },
  ): { clientId: string | undefined; clientSecret: string | undefined } {
    if (authorization && authorization.toLowerCase().startsWith("basic ")) {
      try {
        const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
        const colon = decoded.indexOf(":");
        if (colon >= 0) {
          return {
            clientId: decodeURIComponent(decoded.slice(0, colon)),
            clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
          };
        }
      } catch {
        /* fall through to body */
      }
    }
    return { clientId: body?.client_id, clientSecret: body?.client_secret };
  }

  private oauthHttp(code: string, description: string, status: number) {
    return new HttpException(
      { error: code, error_description: description },
      status,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // RFC 7662 — Introspection
  // ─────────────────────────────────────────────────────────────

  @Post("oauth/introspect")
  async introspect(
    @Headers("authorization") authorization: string | undefined,
    @Body() body: { token?: string; client_id?: string; client_secret?: string },
  ) {
    // Authenticate the introspecting client — only registered clients may
    // introspect (prevents strangers probing token liveness). Public
    // clients are allowed to introspect their own tokens (no secret needed).
    const { clientId, clientSecret } = this.extractClientCredentials(authorization, body);
    if (!clientId) {
      throw this.oauthHttp(
        "invalid_client",
        "client_id required",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const client = await this.oauth.findClient(clientId);
    if (!client) {
      throw this.oauthHttp("invalid_client", "unknown client_id", HttpStatus.UNAUTHORIZED);
    }
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!clientSecret) {
        throw this.oauthHttp(
          "invalid_client",
          "client_secret required",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const ok = await this.oauth.verifyClientSecret(clientId, clientSecret);
      if (!ok) {
        throw this.oauthHttp(
          "invalid_client",
          "client authentication failed",
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    if (!body?.token) {
      return { active: false };
    }
    const verified = await this.oauth.verifyAccessToken(body.token);
    if (!verified) return { active: false };
    // RFC 7662 §2.2 — return the token's claims.
    return {
      active: true,
      client_id: verified.clientId,
      username: verified.userId,
      scope: verified.scopes.join(" "),
      exp: Math.floor(verified.expiresAt.getTime() / 1000),
      token_type: "Bearer",
      // Non-standard — scope tuple so introspecting code can enforce
      // org/project/env alignment without a second call.
      "platos:scope": verified.scope,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // RFC 7009 — Revocation
  // ─────────────────────────────────────────────────────────────

  @Post("oauth/revoke")
  @HttpCode(HttpStatus.OK)
  async revoke(
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      token?: string;
      token_type_hint?: "access_token" | "refresh_token";
      client_id?: string;
      client_secret?: string;
    },
  ) {
    const { clientId, clientSecret } = this.extractClientCredentials(authorization, body);
    if (!clientId) {
      throw this.oauthHttp(
        "invalid_client",
        "client_id required",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const client = await this.oauth.findClient(clientId);
    if (!client) {
      throw this.oauthHttp("invalid_client", "unknown client_id", HttpStatus.UNAUTHORIZED);
    }
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!clientSecret) {
        throw this.oauthHttp(
          "invalid_client",
          "client_secret required",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const ok = await this.oauth.verifyClientSecret(clientId, clientSecret);
      if (!ok) {
        throw this.oauthHttp(
          "invalid_client",
          "client authentication failed",
          HttpStatus.UNAUTHORIZED,
        );
      }
    }
    // RFC 7009 §2.2 — endpoint responds 200 whether or not the token was
    // recognized. Leaks nothing on unknown tokens.
    if (body?.token) {
      await this.oauth.revokeToken(body.token, clientId);
    }
    // Reference expires_in for parity with /token responses during dev
    // probing — harmless, not part of the spec.
    return { ok: true, ttl: OAUTH_ACCESS_TOKEN_TTL_SEC };
  }

  // ═════════════════════════════════════════════════════════════════════
  // PIFSP-21 — per-entity OAuth 2.1 surface.
  //
  // Same RFC-8414 / 7591 / 6749 / 7636 / 7009 semantics as the
  // platform-wide routes above, but pinned to a specific
  // PlatosConnectedEntity (by human-readable `entityId` slug). MCP
  // clients see a clean per-integration URL:
  //   https://test.platos.dev/mcp/entity/fandesk-main
  // …and the authorization server metadata + DCR + authorize + token
  // + revoke all scope to that entity's `PlatosEntityMcpConfig` row.
  //
  // Legacy platform-wide OAuth tokens (no entityPk) keep working on the
  // existing `/oauth/*` routes above. Entity-scoped tokens never escape
  // their entity — the MCP gateway verifies `token.entityPk` matches the
  // requested entity on every tools/call.
  // ═════════════════════════════════════════════════════════════════════

  @Get(".well-known/oauth-authorization-server/entity/:entityId")
  async entityMetadata(
    @Param("entityId") entityIdSlug: string,
    @Query("environmentId") environmentId: string | undefined,
  ) {
    const ent = await this.resolveEntityForMcp(entityIdSlug, environmentId);
    if (!ent) {
      throw new HttpException(
        { error: "not_found", error_description: `MCP not enabled for entity '${entityIdSlug}'` },
        HttpStatus.NOT_FOUND,
      );
    }
    const issuer = this.issuerUrl;
    const base = `${issuer}/oauth/entity/${encodeURIComponent(entityIdSlug)}`;
    const environmentQuery = `?environmentId=${encodeURIComponent(ent.environmentId)}`;
    return {
      issuer,
      authorization_endpoint: `${base}/authorize${environmentQuery}`,
      token_endpoint: `${base}/token${environmentQuery}`,
      revocation_endpoint: `${base}/revoke${environmentQuery}`,
      registration_endpoint: `${base}/register${environmentQuery}`,
      introspection_endpoint: `${issuer}/oauth/introspect`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_basic",
        "client_secret_post",
        "none",
      ],
      scopes_supported: [...ENTITY_MCP_SCOPES],
      // Non-standard hint so MCP clients can render the entity's name.
      "platos:entity_id": entityIdSlug,
      "platos:entity_display_name": ent.displayName,
    };
  }

  @Post("oauth/entity/:entityId/register")
  @HttpCode(HttpStatus.CREATED)
  async entityRegister(
    @Param("entityId") entityIdSlug: string,
    @Query("environmentId") environmentId: string | undefined,
    @Body()
    body: {
      client_name?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: "client_secret_basic" | "client_secret_post" | "none";
      grant_types?: string[];
      scope?: string;
    },
  ) {
    const ent = await this.resolveEntityForMcp(entityIdSlug, environmentId);
    if (!ent) {
      throw new HttpException(
        { error: "not_found", error_description: "entity MCP not enabled" },
        HttpStatus.NOT_FOUND,
      );
    }
    // PIFSP-21 — redirect_uri allowlist enforcement. When the operator
    // has populated `redirectUriAllowlist`, reject any registered URI
    // outside that set. Empty allowlist = unrestricted (validated only
    // by the default loopback/https rule in OAuthService.register()).
    const allowlist: string[] = ent.config.redirectUriAllowlist ?? [];
    if (allowlist.length > 0) {
      const requested = body?.redirect_uris ?? [];
      for (const uri of requested) {
        if (!allowlist.includes(uri)) {
          throw new HttpException(
            {
              error: "invalid_redirect_uri",
              error_description: `redirect_uri '${uri}' not in entity allowlist`,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
      }
    }
    try {
      const result = await this.oauth.register({
        clientName: body?.client_name ?? "",
        redirectUris: body?.redirect_uris ?? [],
        ...(body?.token_endpoint_auth_method
          ? { tokenEndpointAuthMethod: body.token_endpoint_auth_method }
          : {}),
        ...(body?.grant_types ? { grantTypes: body.grant_types } : {}),
        scope: body?.scope,
        organizationId: ent.organizationId,
        entityPk: ent.entityPk,
      });
      return result;
    } catch (err) {
      if (err instanceof OAuthError) {
        throw new HttpException({ error: err.code, error_description: err.message }, err.status);
      }
      throw err;
    }
  }

  /**
   * PIFSP-21 — entity-scoped authorize endpoint. Bounces to the webapp
   * consent screen the same way `/oauth/authorize` does, but the
   * consent loader sees the entity context (org/project pre-pinned)
   * and shows the entity's branded consent card.
   */
  @Get("oauth/entity/:entityId/authorize")
  async entityAuthorize(
    @Param("entityId") entityIdSlug: string,
    @Req() _req: Request,
    @Res() res: Response,
    @Query("response_type") responseType: string | undefined,
    @Query("client_id") clientId: string | undefined,
    @Query("redirect_uri") redirectUri: string | undefined,
    @Query("scope") scope: string | undefined,
    @Query("state") state: string | undefined,
    @Query("code_challenge") codeChallenge: string | undefined,
    @Query("code_challenge_method") codeChallengeMethod: string | undefined,
    @Query("environmentId") environmentId: string | undefined,
  ): Promise<void> {
    const ent = await this.resolveEntityForMcp(entityIdSlug, environmentId);
    if (!ent) {
      res.status(404).json({
        error: "not_found",
        error_description: `MCP not enabled for entity '${entityIdSlug}'`,
      });
      return;
    }
    if (!clientId) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "client_id required",
      });
      return;
    }
    const client = await this.oauth.findClient(clientId);
    if (!client) {
      res.status(400).json({
        error: "invalid_client",
        error_description: "unknown client_id",
      });
      return;
    }
    // PIFSP-21 — ensure client is pinned to THIS entity.
    const clientEntityPk = (client as { entityPk?: string | null }).entityPk ?? null;
    if (!clientEntityPk || clientEntityPk !== ent.entityPk) {
      res.status(400).json({
        error: "invalid_client",
        error_description: "client is not registered for this entity",
      });
      return;
    }
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "redirect_uri missing or not registered for this client",
      });
      return;
    }

    const sendErrorRedirect = (code: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", code);
      url.searchParams.set("error_description", description);
      if (state) url.searchParams.set("state", state);
      res.redirect(302, url.toString());
    };

    if (responseType !== "code") {
      sendErrorRedirect("unsupported_response_type", "only response_type=code is supported");
      return;
    }
    if (!codeChallenge) {
      sendErrorRedirect("invalid_request", "code_challenge is required (PKCE)");
      return;
    }
    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      sendErrorRedirect("invalid_request", "only code_challenge_method=S256 is supported");
      return;
    }

    let transaction: string;
    try {
      const effectiveScopes = await this.oauth.effectiveScopes(clientId, scope);
      transaction = await this.oauth.createConsentTransaction({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod: "S256",
        scopes: effectiveScopes,
        scopeTuple: {
          organizationId: ent.organizationId,
          projectId: ent.projectId,
          environmentId: ent.environmentId,
        },
        entityPk: ent.entityPk,
        ...(state ? { state } : {}),
      });
    } catch (error) {
      if (error instanceof OAuthError) {
        sendErrorRedirect(error.code, error.message);
        return;
      }
      throw error;
    }

    const webappBase =
      env.APP_ORIGIN ?? env.PLATOS_WEBAPP_ADMIN_URL ?? "http://localhost:3030";
    const consentUrl = new URL("/oauth/consent", webappBase);
    consentUrl.searchParams.set("transaction", transaction);
    res.redirect(302, consentUrl.toString());
  }

  /**
   * PIFSP-22 — Anonymous authorize callback.
   * When an entity's identityMode includes "anonymous", the consent screen
   * shows "Continue without signing in". That button POSTs here with the
   * original authorize params. We mint an anon session and issue an authcode
   * directly, then redirect back to the redirect_uri with ?code=...
   */
  @Post("oauth/entity/:entityId/authorize/anonymous")
  async entityAnonAuthorize(
    @Param("entityId") entityIdSlug: string,
    @Req() req: Request,
    @Res() res: Response,
    @Body()
    body: {
      transaction?: string;
    },
  ): Promise<void> {
    const consent = body.transaction
      ? await this.oauth.inspectConsentTransaction(body.transaction)
      : null;
    if (!consent || !consent.entityId || consent.entity?.externalId !== entityIdSlug) {
      res.status(400).json({ error: "invalid consent transaction" });
      return;
    }
    const ent = await this.resolveEntityForMcp(entityIdSlug, consent.environmentId);
    if (!ent) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Verify entity allows anonymous identity mode
    const mcpConfig = await this.prisma.entityMcpConfig.findUnique({
      where: { entityId: ent.entityPk },
      select: { identityMode: true, enabled: true },
    });
    if (!mcpConfig?.enabled) {
      res.status(403).json({ error: "MCP not enabled" });
      return;
    }
    const modes = ((mcpConfig.identityMode as string) ?? "").split("+");
    if (!modes.includes("anonymous")) {
      res.status(403).json({ error: "anonymous mode not enabled for this entity" });
      return;
    }

    const anonClient = await this.oauth.findClient(consent.client.clientId);
    if (!anonClient) {
      res.status(400).json({ error: "invalid_client", error_description: "unknown client_id" });
      return;
    }
    const anonClientEntityPk = (anonClient as { entityPk?: string | null }).entityPk ?? null;
    if (!anonClientEntityPk || anonClientEntityPk !== ent.entityPk) {
      res.status(400).json({ error: "invalid_client", error_description: "client is not registered for this entity" });
      return;
    }
    let consumed;
    try {
      consumed = await this.oauth.consumeConsentTransaction(body.transaction!);
    } catch {
      res.status(400).json({ error: "consent transaction expired or already consumed" });
      return;
    }

    // Mint anon session only after atomically claiming the one-time consent.
    // BUG-19: use the static top-level crypto import instead of dynamic require().
    const mcpUserId = `mcp:anon:${crypto.randomUUID().replace(/-/g, "")}`;
    const anonymousSession = await this.prisma.mcpAnonymousSession.create({
      data: {
        entityId: ent.entityPk,
        environmentId: ent.environmentId,
        mcpUserId,
        firstSeenIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? (req.socket?.remoteAddress ?? null),
        userAgent: req.headers["user-agent"] ?? null,
      },
    });

    // Issue authcode for the anon user
    const { code } = await this.oauth.issueAuthCode({
      clientId: consumed.client.clientId,
      userId: anonClient.registeredByUserId,
      scopeTuple: {
        organizationId: ent.organizationId,
        projectId: ent.projectId,
        environmentId: ent.environmentId,
      },
      codeChallenge: consumed.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: consumed.redirectUri,
      scopes: consumed.scopes,
      entityPk: ent.entityPk,
      mcpIdentity: { kind: "anonymous", sessionId: anonymousSession.id },
    });

    const redirectUrl = new URL(consumed.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (consumed.state) redirectUrl.searchParams.set("state", consumed.state);
    res.redirect(302, redirectUrl.toString());
  }

  /**
   * PIFSP-21 — entity-scoped token endpoint. Delegates to the same
   * `exchangeAuthCode` / `exchangeRefreshToken` primitives as
   * `/oauth/token`; the `entityPk` stamp flows through the authcode /
   * refresh-token row automatically.
   */
  @Post("oauth/entity/:entityId/token")
  async entityToken(
    @Param("entityId") entityIdSlug: string,
    @Query("environmentId") environmentId: string | undefined,
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      code_verifier?: string;
      client_id?: string;
      client_secret?: string;
      refresh_token?: string;
    },
  ) {
    const ent = await this.resolveEntityForMcp(entityIdSlug, environmentId);
    if (!ent) {
      throw new HttpException(
        { error: "not_found", error_description: "entity MCP not enabled" },
        HttpStatus.NOT_FOUND,
      );
    }
    const { clientId, clientSecret } = this.extractClientCredentials(authorization, body);
    if (!clientId) {
      throw this.oauthHttp("invalid_client", "client_id required", HttpStatus.UNAUTHORIZED);
    }
    const client = await this.oauth.findClient(clientId);
    if (!client) {
      throw this.oauthHttp("invalid_client", "unknown client_id", HttpStatus.UNAUTHORIZED);
    }
    const clientEntityPk = (client as { entityPk?: string | null }).entityPk ?? null;
    if (!clientEntityPk || clientEntityPk !== ent.entityPk) {
      throw this.oauthHttp(
        "invalid_client",
        "client is not registered for this entity",
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!clientSecret) {
        throw this.oauthHttp(
          "invalid_client",
          "client_secret required",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const ok = await this.oauth.verifyClientSecret(clientId, clientSecret);
      if (!ok) {
        throw this.oauthHttp(
          "invalid_client",
          "client authentication failed",
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    try {
      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.code_verifier || !body.redirect_uri) {
          throw new OAuthError(
            "invalid_request",
            "code, redirect_uri, code_verifier required",
          );
        }
        const result = await this.oauth.exchangeAuthCode({
          clientId,
          code: body.code,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
          expectedScope: {
            organizationId: ent.organizationId,
            projectId: ent.projectId,
            environmentId: ent.environmentId,
          },
        });
        return {
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scopes.join(" "),
        };
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) {
          throw new OAuthError("invalid_request", "refresh_token required");
        }
        const result = await this.oauth.exchangeRefreshToken({
          clientId,
          refreshToken: body.refresh_token,
          expectedScope: {
            organizationId: ent.organizationId,
            projectId: ent.projectId,
            environmentId: ent.environmentId,
          },
        });
        return {
          access_token: result.accessToken,
          token_type: "Bearer",
          expires_in: result.expiresIn,
          refresh_token: result.refreshToken,
          scope: result.scopes.join(" "),
        };
      }
      throw new OAuthError("unsupported_grant_type", `grant_type=${body.grant_type}`);
    } catch (err) {
      if (err instanceof OAuthError) {
        throw this.oauthHttp(err.code, err.message, err.status);
      }
      throw err;
    }
  }

  /**
   * PIFSP-21 — entity-scoped revoke. Accepts access or refresh tokens
   * issued by this entity's OAuth flow. Client auth identical to the
   * platform revoke endpoint.
   */
  @Post("oauth/entity/:entityId/revoke")
  @HttpCode(HttpStatus.OK)
  async entityRevoke(
    @Param("entityId") entityIdSlug: string,
    @Query("environmentId") environmentId: string | undefined,
    @Headers("authorization") authorization: string | undefined,
    @Body()
    body: {
      token?: string;
      token_type_hint?: "access_token" | "refresh_token";
      client_id?: string;
      client_secret?: string;
    },
  ) {
    const ent = await this.resolveEntityForMcp(entityIdSlug, environmentId);
    if (!ent) {
      throw new HttpException(
        { error: "not_found", error_description: "entity MCP not enabled" },
        HttpStatus.NOT_FOUND,
      );
    }
    const { clientId, clientSecret } = this.extractClientCredentials(authorization, body);
    if (!clientId) {
      throw this.oauthHttp(
        "invalid_client",
        "client_id required",
        HttpStatus.UNAUTHORIZED,
      );
    }
    const client = await this.oauth.findClient(clientId);
    if (!client) {
      throw this.oauthHttp("invalid_client", "unknown client_id", HttpStatus.UNAUTHORIZED);
    }
    const clientEntityPk = (client as { entityPk?: string | null }).entityPk ?? null;
    if (!clientEntityPk || clientEntityPk !== ent.entityPk) {
      throw this.oauthHttp(
        "invalid_client",
        "client is not registered for this entity",
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (client.tokenEndpointAuthMethod !== "none") {
      if (!clientSecret) {
        throw this.oauthHttp(
          "invalid_client",
          "client_secret required",
          HttpStatus.UNAUTHORIZED,
        );
      }
      const ok = await this.oauth.verifyClientSecret(clientId, clientSecret);
      if (!ok) {
        throw this.oauthHttp(
          "invalid_client",
          "client authentication failed",
          HttpStatus.UNAUTHORIZED,
        );
      }
    }
    if (body?.token) {
      await this.oauth.revokeToken(body.token, clientId, {
        organizationId: ent.organizationId,
        projectId: ent.projectId,
        environmentId: ent.environmentId,
      });
    }
    return { ok: true };
  }

  // ═════════════════════════════════════════════════════════════════════
  // Entity-delegated OIDC — gap 2 of 3 in the auth proxy design.
  //
  // When PlatosEntityMcpConfig.identityMode includes "oidc", the entity
  // backend owns its auth system (Google, email/magic-link, SAML, etc.).
  // Platos acts as an auth proxy:
  //
  //   GET  /oauth/entity/:entityId/oidc-redirect   — reads identityProviders,
  //         builds entity OAuth URL, redirects user's browser there.
  //   GET  /oauth/entity/:entityId/oidc-callback   — entity redirects back
  //         here; Platos exchanges code, stores encrypted session, then
  //         issues its own auth code and bounces to the original MCP client
  //         redirect_uri.
  //
  // Entity operators register Platos' callback URL once in their system:
  //   https://<host>/oauth/entity/<entityId>/oidc-callback
  //
  // They paste provider descriptors into PlatosEntityMcpConfig.identityProviders:
  //   [{ "type": "oauth2_pkce", "authorizationUrl": "...", "tokenUrl": "...",
  //      "clientId": "...", "clientSecret": "...", "scopes": ["..."] }]
  // ═════════════════════════════════════════════════════════════════════

  /**
   * Reads the entity's identityProviders JSON, builds the entity's OAuth
   * authorize URL, and redirects the user's browser there. A signed state
   * blob carries the original MCP client params so the callback can
   * reconstruct the full flow without Redis.
   */
  @Get("oauth/entity/:entityId/oidc-redirect")
  async entityOidcRedirect(
    @Param("entityId") entityIdSlug: string,
    @Req() _req: Request,
    @Res() res: Response,
    @Query("transaction") transaction: string | undefined,
  ): Promise<void> {
    const consent = transaction
      ? await this.oauth.inspectConsentTransaction(transaction)
      : null;
    if (!consent || !consent.entityId || consent.entity?.externalId !== entityIdSlug) {
      res.status(400).json({ error: "invalid consent transaction" });
      return;
    }
    const ent = await this.resolveEntityForMcp(entityIdSlug, consent.environmentId);
    if (!ent) {
      res.status(404).json({ error: "entity MCP not enabled" });
      return;
    }

    const providerCfg = this.parseIdentityProviders(ent.config.identityProviders);
    if (!providerCfg) {
      res.status(400).json({
        error: "oidc_not_configured",
        error_description: "This entity has not configured an identity provider. Set identityProviders in the MCP Identity tab.",
      });
      return;
    }

    const client = await this.oauth.findClient(consent.client.clientId);
    if (!client || (client as any).entityPk !== ent.entityPk) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    // Generate a fresh PKCE pair for OUR leg to the entity's OAuth server.
    // This is separate from the MCP client's PKCE (code_challenge above).
    // BUG-19: use static crypto import (already imported at module level).
    const entityPkceVerifier = crypto.randomBytes(48).toString("base64url");
    const entityPkceChallenge = crypto
      .createHash("sha256")
      .update(entityPkceVerifier)
      .digest("base64url");

    // Build a signed state blob so the callback can recover all params.
    // Format: base64url(json) + "." + HMAC-SHA256(base64url(json), secret)
    const callbackUrl = `${this.issuerUrl}/oauth/entity/${encodeURIComponent(entityIdSlug)}/oidc-callback`;
    const statePayload = {
      transaction,
      entityPkceVerifier,
      callbackUrl,
      ts: Math.floor(Date.now() / 1000),
    };
    const stateJson = Buffer.from(JSON.stringify(statePayload)).toString("base64url");
    const secret = env.SESSION_SECRET ?? "";
    const stateSig = crypto
      .createHmac("sha256", secret)
      .update(stateJson)
      .digest("base64url");
    const signedState = `${stateJson}.${stateSig}`;

    // BUG-3: validate authorizationUrl to prevent SSRF via operator-supplied config.
    const authUrlValidation = await validatePublicUrl(providerCfg.authorizationUrl);
    if (!authUrlValidation.ok) {
      res.status(400).json({
        error: "invalid_configuration",
        error_description: `authorizationUrl blocked: ${describeUrlValidationError(authUrlValidation.error)}`,
      });
      return;
    }

    // Build entity authorize URL.
    const authUrl = new URL(providerCfg.authorizationUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", providerCfg.clientId);
    authUrl.searchParams.set("redirect_uri", callbackUrl);
    authUrl.searchParams.set("scope", (providerCfg.scopes ?? []).join(" ") || "openid email profile");
    authUrl.searchParams.set("code_challenge", entityPkceChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", signedState);

    res.redirect(302, authUrl.toString());
  }

  /**
   * Entity redirects back here after the user logged in. We exchange the
   * code with the entity's token endpoint, store the encrypted session,
   * issue a Platos auth code, and redirect to the original MCP client.
   */
  @Get("oauth/entity/:entityId/oidc-callback")
  async entityOidcCallback(
    @Param("entityId") entityIdSlug: string,
    @Res() res: Response,
    @Query("code") code: string | undefined,
    @Query("state") signedState: string | undefined,
    @Query("error") entityError: string | undefined,
  ): Promise<void> {
    // Propagate entity-side errors (user denied, etc.) back to MCP client.
    if (entityError) {
      // We don't have the original redirect_uri without decoding state, so
      // we try to decode and redirect; fall back to a plain JSON error.
      if (signedState) {
        const sp = this.verifyAndDecodeState(signedState);
        if (sp) {
          const consent = await this.oauth.inspectConsentTransaction(sp.transaction);
          if (consent) {
            await this.oauth.consumeConsentTransaction(sp.transaction).catch(() => undefined);
            const errUrl = new URL(consent.redirectUri);
            errUrl.searchParams.set("error", entityError);
            if (consent.state) errUrl.searchParams.set("state", consent.state);
            res.redirect(302, errUrl.toString());
            return;
          }
        }
      }
      res.status(400).json({ error: entityError });
      return;
    }

    if (!code || !signedState) {
      res.status(400).json({ error: "code and state required" });
      return;
    }

    const sp = this.verifyAndDecodeState(signedState);
    if (!sp) {
      res.status(400).json({ error: "invalid_state", error_description: "state tampered or expired" });
      return;
    }

    const consent = await this.oauth.inspectConsentTransaction(sp.transaction);
    if (!consent || !consent.entityId || consent.entity?.externalId !== entityIdSlug) {
      res.status(400).json({ error: "invalid_state", error_description: "consent transaction expired or consumed" });
      return;
    }
    let consumed;
    try {
      consumed = await this.oauth.consumeConsentTransaction(sp.transaction);
    } catch {
      res.status(400).json({ error: "invalid_state", error_description: "consent transaction already consumed" });
      return;
    }
    const ent = await this.resolveEntityForMcp(entityIdSlug, consent.environmentId);
    if (!ent) {
      res.status(404).json({ error: "entity MCP not enabled" });
      return;
    }

    const providerCfg = this.parseIdentityProviders(ent.config.identityProviders);
    if (!providerCfg) {
      res.status(400).json({ error: "oidc_not_configured" });
      return;
    }

    // Exchange code with entity's token endpoint.
    // BUG-3: validate tokenUrl to prevent SSRF via operator-supplied config.
    const tokenUrlValidation = await validatePublicUrl(providerCfg.tokenUrl);
    if (!tokenUrlValidation.ok) {
      const errUrl = new URL(consent.redirectUri);
      errUrl.searchParams.set("error", "server_error");
      errUrl.searchParams.set("error_description", "entity tokenUrl blocked by SSRF guard");
      if (consent.state) errUrl.searchParams.set("state", consent.state);
      res.redirect(302, errUrl.toString());
      return;
    }

    let entityTokenData: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      id_token?: string;
    };
    try {
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: sp.callbackUrl,
        code_verifier: sp.entityPkceVerifier,
        client_id: providerCfg.clientId,
        ...(providerCfg.clientSecret ? { client_secret: providerCfg.clientSecret } : {}),
      });
      const tokenRes = await fetch(providerCfg.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: tokenBody.toString(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!tokenRes.ok) {
        const txt = await tokenRes.text().catch(() => "");
        throw new Error(`entity token endpoint returned ${tokenRes.status}: ${txt}`);
      }
      entityTokenData = await tokenRes.json() as typeof entityTokenData;
    } catch (err: any) {
      const errUrl = new URL(consent.redirectUri);
      errUrl.searchParams.set("error", "server_error");
      errUrl.searchParams.set("error_description", "entity token exchange failed");
      if (consent.state) errUrl.searchParams.set("state", consent.state);
      res.redirect(302, errUrl.toString());
      return;
    }

    // Extract user identity from id_token or userinfo if present.
    // BUG-12: the id_token JWT signature is NOT verified (the provider's JWKS
    // endpoint is not available). We trust the sub because the token came from
    // the entity's own token endpoint over TLS. To prevent cross-entity sub
    // collision (a sub from entity A matching entity B's user), we scope-salt
    // the externalSub with the entityPk before any DB lookup/upsert.
    let email: string | undefined;
    let rawSub: string | undefined;
    let name: string | undefined;
    if (entityTokenData.id_token) {
      try {
        const parts = entityTokenData.id_token.split(".");
        if (parts.length >= 2) {
          const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
          rawSub = String(claims.sub ?? "");
          email = typeof claims.email === "string" ? claims.email : undefined;
          name = typeof claims.name === "string" ? claims.name : undefined;
        }
      } catch { /* id_token parse failures are non-fatal */ }
    }
    // Fallback: use access_token prefix as raw sub if no id_token.
    if (!rawSub) {
      rawSub = `${entityTokenData.access_token.slice(0, 16)}`;
    }

    const externalSubject = rawSub;
    const provider = providerCfg.type ?? "oauth2_pkce";
    const identityHash = crypto
      .createHash("sha256")
      .update(`${ent.entityPk}:${provider}:${externalSubject}`)
      .digest("hex");
    const mcpUserId = `mcp:oidc:${provider}:${identityHash.slice(0, 32)}`;

    const tokenPayload = JSON.stringify({
      accessToken: entityTokenData.access_token,
      refreshToken: entityTokenData.refresh_token ?? null,
    });
    const expiresAt = entityTokenData.expires_in
      ? new Date(Date.now() + entityTokenData.expires_in * 1000)
      : null;

    const client = await this.oauth.findClient(consent.client.clientId);
    if (!client || client.entityPk !== ent.entityPk) {
      res.status(400).json({ error: "invalid_client" });
      return;
    }

    // Persist entity-issued token material only through the clean Credential
    // relation. McpOidcSession remains canonical identity metadata.
    const credentialName = `mcp-oidc-${identityHash}`;
    const serviceAuthorization = await authorizeEnvironmentService(this.prisma, {
      actorId: `mcp-oidc:${ent.entityPk}`,
      environmentId: ent.environmentId,
    });
    const oidcSession = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.credential.findUnique({
        where: {
          environmentId_kind_name: {
            environmentId: ent.environmentId,
            kind: CredentialKind.ENTITY_SECRET,
            name: credentialName,
          },
        },
        select: { id: true, activeSecretVersionId: true, revokedAt: true },
      });
      const credential = existing?.activeSecretVersionId && !existing.revokedAt
        ? await this.secretStore.rotateInTransaction(tx, {
            authorization: serviceAuthorization,
            credentialId: existing.id,
            plaintext: tokenPayload,
          })
        : !existing
        ? await this.secretStore.createInTransaction(tx, {
          authorization: serviceAuthorization,
          kind: CredentialKind.ENTITY_SECRET,
          name: credentialName,
          plaintext: tokenPayload,
        })
        : (() => { throw new Error("entity_oauth_credential_unavailable"); })();
      await tx.credential.update({
        where: { id: credential.id },
        data: { expiresAt, lastUsedAt: new Date() },
      });
      return tx.mcpOidcSession.upsert({
        where: {
          environmentId_entityId_provider_externalSubject: {
            environmentId: ent.environmentId,
            entityId: ent.entityPk,
            provider,
            externalSubject,
          },
        },
        create: {
          environmentId: ent.environmentId,
          entityId: ent.entityPk,
          mcpUserId,
          provider,
          email: email ?? null,
          emailVerified: !!email,
          externalSubject,
          displayName: name ?? null,
          credentialId: credential.id,
          lastLoginAt: new Date(),
        },
        update: {
          mcpUserId,
          credentialId: credential.id,
          email: email ?? undefined,
          emailVerified: !!email,
          displayName: name ?? undefined,
          lastLoginAt: new Date(),
          revokedAt: null,
        },
      });
    });

    const { code: platosCode } = await this.oauth.issueAuthCode({
      clientId: consumed.client.clientId,
      userId: client.registeredByUserId,
      scopeTuple: {
        organizationId: ent.organizationId,
        projectId: ent.projectId,
        environmentId: ent.environmentId,
      },
      codeChallenge: consumed.codeChallenge,
      codeChallengeMethod: "S256",
      redirectUri: consumed.redirectUri,
      scopes: consumed.scopes,
      entityPk: ent.entityPk,
      mcpIdentity: { kind: "oidc", sessionId: oidcSession.id },
    });

    const finalRedirect = new URL(consumed.redirectUri);
    finalRedirect.searchParams.set("code", platosCode);
    if (consumed.state) finalRedirect.searchParams.set("state", consumed.state);
    res.redirect(302, finalRedirect.toString());
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private parseIdentityProviders(raw: unknown): {
    type: string;
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
  } | null {
    if (!Array.isArray(raw)) return null;
    const cfg = raw.find((entry): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const type = (entry as Record<string, unknown>).type;
      return type === "oidc" || type === "oauth2_pkce";
    });
    if (!cfg) return null;
    if (typeof cfg.authorizationUrl !== "string" || !cfg.authorizationUrl.trim()) return null;
    if (typeof cfg.tokenUrl !== "string" || !cfg.tokenUrl.trim()) return null;
    if (typeof cfg.clientId !== "string" || !cfg.clientId.trim()) return null;
    if (cfg.clientSecret !== undefined && typeof cfg.clientSecret !== "string") return null;
    if (
      cfg.scopes !== undefined &&
      (!Array.isArray(cfg.scopes) ||
        cfg.scopes.some((scope) => typeof scope !== "string" || !scope.trim()))
    ) {
      return null;
    }
    return {
      type: cfg.type as string,
      authorizationUrl: cfg.authorizationUrl.trim(),
      tokenUrl: cfg.tokenUrl.trim(),
      clientId: cfg.clientId.trim(),
      clientSecret: typeof cfg.clientSecret === "string" && cfg.clientSecret
        ? cfg.clientSecret
        : undefined,
      scopes: Array.isArray(cfg.scopes) ? cfg.scopes.map((scope) => scope.trim()) : undefined,
    };
  }

  private verifyAndDecodeState(signedState: string): {
    transaction: string;
    entityPkceVerifier: string;
    callbackUrl: string;
    ts: number;
  } | null {
    const dot = signedState.lastIndexOf(".");
    if (dot < 0) return null;
    const payload = signedState.slice(0, dot);
    const sig = signedState.slice(dot + 1);
    // BUG-19: use the static top-level crypto import instead of dynamic require().
    const secret = env.SESSION_SECRET ?? "";
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("base64url");
    const sigBuf = Buffer.from(sig, "utf8");
    const expBuf = Buffer.from(expectedSig, "utf8");
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
      // Reject state older than 15 minutes (user has that long to complete auth).
      if (!parsed.ts || Math.abs(Date.now() / 1000 - Number(parsed.ts)) > 900) return null;
      if (typeof parsed.transaction !== "string" || !parsed.transaction) return null;
      return parsed as ReturnType<typeof this.verifyAndDecodeState>;
    } catch {
      return null;
    }
  }


}
