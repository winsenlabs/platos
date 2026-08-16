import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import { type Request } from "express";
import { ModuleRef } from "@nestjs/core";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { ChannelRuntimeService } from "../channels/channel-runtime.service";
import { ChannelPersistenceService } from "../channels/channel-persistence.service";
import { requireOperator, type RequestScope } from "../auth/scope.guard";
import { validateAgentRouting } from "./channel-routing";

/**
 * Connect v3 — dashboard REST for marketplace-grade channel APPS.
 *
 * A ChannelApp is a publishable Slack app identity (one clientId plus referenced
 * client/signing credentials) OWNED by the operator's Environment and installed
 * into N external workspaces via OAuth ("Add to Slack"). Each install is a
 * ChannelInstallation with its own Credential reference. This controller is the
 * MANAGEMENT surface over the app model — the OAuth install/callback + the
 * per-app events webhook that receive Slack traffic are SEPARATE runtime slices
 * (channel-app-oauth.controller.ts / channel-app-events.controller.ts).
 *
 *   GET    /api/v1/agent/channel-apps                         — list apps in scope
 *   POST   /api/v1/agent/channel-apps                         — create an app
 *   GET    /api/v1/agent/channel-apps/:id                     — get one app
 *   PATCH  /api/v1/agent/channel-apps/:id                     — partial-patch an app
 *   DELETE /api/v1/agent/channel-apps/:id                     — delete an app (cascades installs)
 *   GET    /api/v1/agent/channel-apps/:id/installations       — list installs
 *   GET    /api/v1/agent/channel-apps/:id/installations/status
 *                                                             — operator status view (lifecycle + agent binding)
 *   POST   /api/v1/agent/channel-apps/:id/installations/import
 *                                                             — import/register an install from an operator bot token (idempotent)
 *   POST   /api/v1/agent/channel-apps/:id/installations/:installationId/bind
 *                                                             — rebind agent / routing
 *   DELETE /api/v1/agent/channel-apps/:id/installations/:installationId
 *                                                             — revoke an install (soft)
 *
 * Every handler is OPERATOR-ONLY (requireOperator) and ScopeGuard-scoped — the
 * same posture as ChannelsController. `clientSecret` + `signingSecret` are
 * stored only in the app's referenced Credential and NEVER returned;
 * `hasClientSecret` / `hasSigningSecret` booleans say whether they're set. The
 * install-time bot tokens live only in referenced installation Credentials and
 * are redacted (`hasBotToken`). `clientId` is a public identifier and IS returned.
 * POST returns `installUrl` — the "Add to Slack" href.
 *
 * RECOMMENDED Slack `scopes` for the "Agents & AI Apps" surface (send in the
 * create/update body):
 *   - `assistant:write`   — assistant.threads.setTitle / setStatus /
 *                           setSuggestedPrompts on the assistant thread.
 *   - `im:history`        — read the user's messages in the assistant DM thread.
 *   - `chat:write`        — post replies (also clears the thinking status).
 *   - `app_mentions:read` — mention-bot fallback surface.
 * Per Slack's 2026-03-05 change `setStatus` also accepts `chat:write`, but the
 * other `assistant.threads.*` methods still require `assistant:write` — request
 * BOTH. The app must additionally enable the "Agents & AI Apps" toggle in its
 * Slack config so the split-view panel + assistant_thread_started events are
 * delivered.
 *
 * ACCOUNT LINKING (`linking`, Connect v3 Phase C): `none` (default) | `optional`
 * | `required`. `optional` exposes a "Connect your account" URL when the user
 * types `link`/`connect` (and honours `unlink`); `required` additionally
 * WITHHOLDS an unlinked user's turns until they complete Sign in with Slack,
 * which attaches a verified email identity to the same canonical person. The
 * hosted flow reuses THIS app's Slack client credentials for SIWS, so the app
 * must register the extra OIDC redirect URL
 * `<publicOrigin>/api/v1/channels/link/callback` in its Slack "Redirect URLs".
 */

const APP_PROVIDERS = new Set(["slack"]);
const DISTRIBUTIONS = new Set(["private", "public"]);
// Connect v3 (Phase C) — hosted account-linking policy.
const LINKING = new Set(["none", "optional", "required"]);
const OAUTH_BASE = "/api/v1/channels/oauth";

@Controller("api/v1/agent/channel-apps")
export class ChannelAppsController {
  private readonly persistence: ChannelPersistenceService;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    messageCrypto: MessageCryptoService,
    private readonly moduleRef: ModuleRef
  ) {
    this.persistence = new ChannelPersistenceService(prisma, messageCrypto);
  }

  /**
   * Evict the runtime's cached decrypted bot token(s) for an app after a
   * mutation (credential edit, delete, install revoke) so a rotated/revoked
   * token stops posting immediately instead of after the 10-min TTL. Lazy via
   * ModuleRef (strict:false) because ChannelsModule ↔ AgentRuntimeModule is a
   * DI cycle. Best-effort — an eviction failure never fails the mutation.
   */
  private invalidateApp(appId: string): void {
    try {
      this.moduleRef.get(ChannelRuntimeService, { strict: false })?.invalidateApp(appId);
    } catch {
      // Runtime not registered (e.g. focused test module) — TTL is the backstop.
    }
  }

  private getScope(req: Request): RequestScope {
    return (
      (req as any).scope || {
        organizationId: "unknown",
        projectId: "unknown",
        environmentId: "unknown",
        userId: "unknown",
      }
    );
  }

  private isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /** Redact app secrets and Credential internals; expose only presence metadata. */
  private projectApp(row: any) {
    const {
      clientSecret,
      signingSecret,
      hasClientSecret,
      hasSigningSecret,
      credential,
      environment,
      credentialRevision,
      ...rest
    } = row;
    void clientSecret;
    void signingSecret;
    void credential;
    void environment;
    void credentialRevision;
    return {
      ...rest,
      hasClientSecret: hasClientSecret === true,
      hasSigningSecret: hasSigningSecret === true,
    };
  }

  /** Redact install secrets and Credential internals; expose only presence metadata. */
  private projectInstallation(row: any) {
    const {
      botToken,
      refreshToken,
      hasBotToken,
      hasRefreshToken,
      credential,
      app,
      credentialRevision,
      ...rest
    } = row;
    void botToken;
    void refreshToken;
    void credential;
    void app;
    void credentialRevision;
    return {
      ...rest,
      hasBotToken: hasBotToken === true,
      hasRefreshToken: hasRefreshToken === true,
    };
  }

  /**
   * Public origin, backend-configured (never guessed client-side):
   * PLATOS_PUBLIC_BASE_URL wins; else derived from PLATOS_AGENT_PUBLIC_WS_URL
   * (wss://host → https://host); else null. Same helper as ChannelsController.
   */
  private publicOrigin(): string | null {
    const explicit = (process.env.PLATOS_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    if (explicit) return explicit;
    const ws = (process.env.PLATOS_AGENT_PUBLIC_WS_URL || "").trim().replace(/\/+$/, "");
    if (ws.startsWith("wss://")) return `https://${ws.slice(6)}`;
    if (ws.startsWith("ws://")) return `http://${ws.slice(5)}`;
    return null;
  }

  /** The "Add to Slack" install URL when a public origin is configured, else null. */
  private installUrl(id: string): string | null {
    const origin = this.publicOrigin();
    return origin ? `${origin}${OAUTH_BASE}/${id}/install` : null;
  }

  /**
   * Compact operator status view of an installation row (teamId / teamName /
   * status / lastEventAt + the resolved agent binding). `app` supplies the
   * app-level fallback so `agentBinding.source` / `effectiveAgentId` reflect the
   * SAME resolution `handleAppEvent` performs (`installation.agentId` wins, else
   * `app.defaultAgentId`). Never leaks the bot token.
   */
  private installationStatusView(row: any, app: any) {
    const overrideAgentId = typeof row?.agentId === "string" && row.agentId ? row.agentId : null;
    const appDefaultAgentId =
      typeof app?.defaultAgentId === "string" && app.defaultAgentId ? app.defaultAgentId : null;
    return {
      installationId: row.id,
      teamId: row.teamId ?? null,
      teamName: row.teamName ?? null,
      enterpriseId: row.enterpriseId ?? null,
      isEnterpriseInstall: row.isEnterpriseInstall ?? false,
      status: row.status ?? "active",
      revokedAt: row.revokedAt ?? null,
      lastEventAt: row.lastEventAt ?? null,
      agentBinding: {
        agentId: overrideAgentId,
        effectiveAgentId: overrideAgentId ?? appDefaultAgentId,
        source: overrideAgentId ? "installation" : appDefaultAgentId ? "app" : "none",
        hasRoutingOverride: Array.isArray(row.agentRouting)
          ? row.agentRouting.length > 0
          : row.agentRouting != null,
      },
    };
  }

  /** Forged-id guard — the agent must belong to this exact scope. */
  private async agentInScope(scope: RequestScope, agentId: string): Promise<boolean> {
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        agent: { projectId: scope.projectId },
        environment: {
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
      },
      select: { id: true },
    });
    return !!binding;
  }

  /** Normalize a scopes[] payload into trimmed, non-empty, de-duped strings. */
  private normalizeScopes(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const s of raw) {
      const v = typeof s === "string" ? s.trim() : "";
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  // ── Apps CRUD ─────────────────────────────────────────────────────────

  @Get()
  async list(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const rows = await this.persistence.listApps(scope);
    return {
      apps: (rows as any[]).map((r) => ({
        ...this.projectApp(r),
        installUrl: this.installUrl(r.id),
      })),
    };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      provider?: string;
      displayName?: string;
      clientId: string;
      clientSecret: string;
      signingSecret: string;
      scopes?: string[];
      distribution?: string;
      aiAppsSurface?: boolean;
      linking?: string;
      defaultAgentId?: string | null;
      agentRouting?: unknown;
    }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const provider = String(body?.provider ?? "slack")
      .trim()
      .toLowerCase();
    if (!APP_PROVIDERS.has(provider)) {
      throw new HttpException(
        { error: "invalid_provider", message: "provider must be slack (v1)" },
        HttpStatus.BAD_REQUEST
      );
    }
    const clientId = String(body?.clientId ?? "").trim();
    const clientSecret = String(body?.clientSecret ?? "").trim();
    const signingSecret = String(body?.signingSecret ?? "").trim();
    if (!clientId || !clientSecret || !signingSecret) {
      throw new HttpException(
        {
          error: "invalid_params",
          message: "clientId, clientSecret and signingSecret are required",
        },
        HttpStatus.BAD_REQUEST
      );
    }

    const distribution = body?.distribution
      ? String(body.distribution).trim().toLowerCase()
      : "private";
    if (!DISTRIBUTIONS.has(distribution)) {
      throw new HttpException(
        { error: "invalid_params", message: "distribution must be private | public" },
        HttpStatus.BAD_REQUEST
      );
    }

    // linking (optional) — enum-validated; defaults to "none" at the DB layer.
    let linking: string | undefined;
    if (body?.linking !== undefined) {
      linking = String(body.linking).trim().toLowerCase();
      if (!LINKING.has(linking)) {
        throw new HttpException(
          {
            error: "invalid_params",
            message: "linking must be none | optional | required",
          },
          HttpStatus.BAD_REQUEST
        );
      }
    }

    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
    const scopes = this.normalizeScopes(body?.scopes);
    const aiAppsSurface = typeof body?.aiAppsSurface === "boolean" ? body.aiAppsSurface : undefined;

    // defaultAgentId (optional) — forged-id guard against the token scope.
    const defaultAgentId =
      typeof body?.defaultAgentId === "string" ? body.defaultAgentId.trim() : "";
    if (defaultAgentId && !(await this.agentInScope(scope, defaultAgentId))) {
      throw new HttpException(
        {
          error: "unknown_agent_id",
          message: `agent ${defaultAgentId} not found in scope`,
          agentId: defaultAgentId,
        },
        HttpStatus.BAD_REQUEST
      );
    }

    // agentRouting (optional) — validate + normalize (each rule agentId in-scope).
    let agentRoutingData: unknown | undefined;
    if (body?.agentRouting !== undefined && body?.agentRouting !== null) {
      const routing = await validateAgentRouting(this.prisma, scope, body.agentRouting);
      if (!routing.ok) {
        throw new HttpException(
          { error: routing.error, message: routing.message },
          HttpStatus.BAD_REQUEST
        );
      }
      agentRoutingData = routing.rules;
    }

    const row = await this.persistence.createApp(scope, {
      provider,
      clientId,
      clientSecret,
      signingSecret,
      distribution,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(scopes !== undefined ? { scopes } : {}),
      ...(aiAppsSurface !== undefined ? { aiAppsSurface } : {}),
      ...(linking !== undefined ? { linking } : {}),
      ...(defaultAgentId ? { defaultAgentId } : {}),
      ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
    });

    return {
      app: this.projectApp(row),
      // The "Add to Slack" href — null with a configure-me warning when the
      // public origin is unset (PLATOS_PUBLIC_BASE_URL / _WS_URL).
      installUrl: this.installUrl(row.id),
    };
  }

  @Get(":id")
  async getOne(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const row = await this.persistence.loadScopedApp(scope, id);
    if (!row) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    return { app: this.projectApp(row), installUrl: this.installUrl(row.id) };
  }

  @Patch(":id")
  async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body()
    body: {
      displayName?: string | null;
      clientId?: string;
      clientSecret?: string;
      signingSecret?: string;
      scopes?: string[];
      distribution?: string;
      aiAppsSurface?: boolean;
      linking?: string;
      defaultAgentId?: string | null;
      agentRouting?: unknown;
    }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const existing = await this.persistence.loadScopedApp(scope, id);
    if (!existing) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);

    const data: Record<string, unknown> = {};
    const credentialData: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
      data.displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    }
    if (typeof body.clientId === "string") {
      const clientId = body.clientId.trim();
      if (!clientId) {
        throw new HttpException(
          { error: "invalid_params", message: "clientId must be non-empty" },
          HttpStatus.BAD_REQUEST
        );
      }
      data.clientId = clientId;
    }
    if (typeof body.clientSecret === "string" && body.clientSecret.trim()) {
      credentialData.clientSecret = body.clientSecret.trim();
    }
    if (typeof body.signingSecret === "string" && body.signingSecret.trim()) {
      credentialData.signingSecret = body.signingSecret.trim();
    }
    if (Object.prototype.hasOwnProperty.call(body, "scopes")) {
      const scopes = this.normalizeScopes(body.scopes);
      if (scopes !== undefined) data.scopes = scopes;
    }
    if (typeof body.distribution === "string") {
      const distribution = body.distribution.trim().toLowerCase();
      if (!DISTRIBUTIONS.has(distribution)) {
        throw new HttpException(
          { error: "invalid_params", message: "distribution must be private | public" },
          HttpStatus.BAD_REQUEST
        );
      }
      data.distribution = distribution;
    }
    if (typeof body.aiAppsSurface === "boolean") {
      credentialData.aiAppsSurface = body.aiAppsSurface;
    }
    if (typeof body.linking === "string") {
      const linking = body.linking.trim().toLowerCase();
      if (!LINKING.has(linking)) {
        throw new HttpException(
          {
            error: "invalid_params",
            message: "linking must be none | optional | required",
          },
          HttpStatus.BAD_REQUEST
        );
      }
      credentialData.linking = linking;
    }
    if (Object.prototype.hasOwnProperty.call(body, "defaultAgentId")) {
      const raw = body.defaultAgentId;
      if (raw === null || raw === "") {
        data.defaultAgentId = null; // explicit clear
      } else if (typeof raw === "string") {
        const defaultAgentId = raw.trim();
        if (!(await this.agentInScope(scope, defaultAgentId))) {
          throw new HttpException(
            {
              error: "unknown_agent_id",
              message: `agent ${defaultAgentId} not found in scope`,
              agentId: defaultAgentId,
            },
            HttpStatus.BAD_REQUEST
          );
        }
        data.defaultAgentId = defaultAgentId;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "agentRouting")) {
      const ar = body.agentRouting;
      if (ar === null) {
        data.agentRouting = []; // explicit clear → default agent only
      } else {
        const routing = await validateAgentRouting(this.prisma, scope, ar);
        if (!routing.ok) {
          throw new HttpException(
            { error: routing.error, message: routing.message },
            HttpStatus.BAD_REQUEST
          );
        }
        data.agentRouting = routing.rules;
      }
    }

    if (Object.keys(data).length === 0 && Object.keys(credentialData).length === 0) {
      return { app: this.projectApp(existing), installUrl: this.installUrl(existing.id) };
    }

    const updated = await this.persistence.updateApp(scope, id, data, credentialData);
    if (!updated) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    // Credential changes must not linger in the runtime's decrypted-token cache.
    this.invalidateApp(id);
    return { app: this.projectApp(updated), installUrl: this.installUrl(updated.id) };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const existing = await this.persistence.loadScopedApp(scope, id);
    if (!existing) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    await this.persistence.deleteApp(scope, id);
    this.invalidateApp(id);
    return { deleted: true, id };
  }

  // ── Installations ─────────────────────────────────────────────────────

  @Get(":id/installations")
  async listInstallations(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const rows = await this.persistence.listInstallations(scope, id);
    if (!rows) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    return {
      installations: (rows as any[]).map((r) => this.projectInstallation(r)),
    };
  }

  /**
   * Operator-visible per-install STATUS surface (requirement c). Compact,
   * lifecycle-focused view of every installation of an app —
   * `{ installationId, teamId, teamName, enterpriseId, isEnterpriseInstall,
   * status, revokedAt, lastEventAt, agentBinding }` — read live off the SAME
   * rows the uninstall / tokens_revoked webhook mutates, so an uninstall shows
   * up here as `status: "revoked"` with no extra plumbing. Never returns the
   * bot token. `agentBinding` reflects the exact resolution handleAppEvent uses.
   */
  @Get(":id/installations/status")
  async installationsStatus(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const app = await this.persistence.loadScopedApp(scope, id);
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    const rows = await this.persistence.listInstallations(scope, id);
    if (!rows) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    return {
      installations: (rows as any[]).map((r) => this.installationStatusView(r, app)),
    };
  }

  /**
   * Operator-driven install IMPORT (requirement 1). Registers a
   * ChannelInstallation under an existing in-scope app from an
   * operator-supplied bot token — for a manually-created Slack app, or migrating
   * an install from elsewhere — WITHOUT the browser OAuth dance. This is the
   * additive twin of the OAuth callback's persistence: the same referenced
   * Credential envelope and stable `(appId, externalInstallationId)` upsert, so
   * it is IDEMPOTENT (re-import of the same workspace updates the row in place
   * and flips a revoked install back to active). Optional `agentId` /
   * `agentRouting` bind the install at
   * import time (same in-scope guards as bind). The hosted-OAuth flow is
   * untouched; this is a parallel entry point onto the same rows.
   */
  @Post(":id/installations/import")
  async importInstallation(
    @Req() req: Request,
    @Param("id") id: string,
    @Body()
    body: {
      teamId?: string | null;
      enterpriseId?: string | null;
      isEnterpriseInstall?: boolean;
      teamName?: string | null;
      botToken?: string;
      botUserId?: string | null;
      grantedScopes?: string[];
      installedByUserId?: string | null;
      agentId?: string | null;
      agentRouting?: unknown;
    }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    // App must exist in the operator's scope (forged/cross-scope appId rejected).
    const app = await this.persistence.loadScopedApp(scope, id);
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);

    const teamId =
      typeof body?.teamId === "string" && body.teamId.trim() ? body.teamId.trim() : null;
    const enterpriseId =
      typeof body?.enterpriseId === "string" && body.enterpriseId.trim()
        ? body.enterpriseId.trim()
        : null;
    const isEnterpriseInstall = body?.isEnterpriseInstall === true;
    const botToken = typeof body?.botToken === "string" ? body.botToken.trim() : "";

    if (!botToken) {
      throw new HttpException(
        { error: "invalid_params", message: "botToken is required" },
        HttpStatus.BAD_REQUEST
      );
    }
    // Keyed by (appId, teamId, enterpriseId) — at least one workspace anchor is
    // needed. A Grid org-install is teamId=null + enterpriseId set.
    if (!teamId && !enterpriseId) {
      throw new HttpException(
        {
          error: "invalid_params",
          message: "teamId (or enterpriseId for a Grid org-install) is required",
        },
        HttpStatus.BAD_REQUEST
      );
    }
    if (isEnterpriseInstall && !enterpriseId) {
      throw new HttpException(
        {
          error: "invalid_params",
          message: "enterpriseId is required when isEnterpriseInstall is true",
        },
        HttpStatus.BAD_REQUEST
      );
    }

    const teamName =
      typeof body?.teamName === "string" && body.teamName.trim() ? body.teamName.trim() : null;
    const botUserId =
      typeof body?.botUserId === "string" && body.botUserId.trim() ? body.botUserId.trim() : null;
    const installedByUserId =
      typeof body?.installedByUserId === "string" && body.installedByUserId.trim()
        ? body.installedByUserId.trim()
        : null;
    const grantedScopes = this.normalizeScopes(body?.grantedScopes) ?? [];

    // Optional per-install agent binding at import time (same guards as bind).
    let agentId: string | null | undefined;
    if (Object.prototype.hasOwnProperty.call(body, "agentId")) {
      const raw = body.agentId;
      if (raw === null || raw === "") {
        agentId = null;
      } else if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!(await this.agentInScope(scope, trimmed))) {
          throw new HttpException(
            {
              error: "unknown_agent_id",
              message: `agent ${trimmed} not found in scope`,
              agentId: trimmed,
            },
            HttpStatus.BAD_REQUEST
          );
        }
        agentId = trimmed;
      }
    }
    let agentRoutingData: unknown | null | undefined;
    if (Object.prototype.hasOwnProperty.call(body, "agentRouting")) {
      const ar = body.agentRouting;
      if (ar === null) {
        agentRoutingData = [];
      } else {
        const routing = await validateAgentRouting(this.prisma, scope, ar);
        if (!routing.ok) {
          throw new HttpException(
            { error: routing.error, message: routing.message },
            HttpStatus.BAD_REQUEST
          );
        }
        agentRoutingData = routing.rules;
      }
    }

    // Persist through the same clean Credential-reference path as hosted OAuth.
    // A manually imported token is static, so stale refresh state is cleared.
    const row = await this.persistence.upsertInstallationGrant(
      app,
      { teamId, enterpriseId, isEnterpriseInstall },
      {
        botToken,
        refreshToken: null,
        tokenExpiresAt: null,
        botUserId,
        grantedScopes,
        displayName: teamName,
        installedByUserId,
        ...(agentId !== undefined ? { defaultAgentId: agentId } : {}),
        ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
      }
    );
    // A re-import that re-keys a live install must evict any cached bot token so
    // the new token takes effect immediately instead of after the runtime TTL.
    this.invalidateApp(id);
    return { installation: this.projectInstallation(row) };
  }

  /**
   * Rebind an installation to a different agent / routing table (per-workspace
   * override of the app's defaults). `agentId: null` clears the override →
   * falls back to app.defaultAgentId; `agentRouting: null` clears the per-install
   * table → falls back to app.agentRouting.
   */
  @Post(":id/installations/:installationId/bind")
  async bindInstallation(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("installationId") installationId: string,
    @Body() body: { agentId?: string | null; agentRouting?: unknown }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    // The app must be in scope; the installation must belong to that app.
    const app = await this.persistence.loadScopedApp(scope, id);
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    const installation = await this.persistence.loadInstallation(installationId, id);
    if (!installation) {
      throw new HttpException("Installation not found", HttpStatus.NOT_FOUND);
    }

    const data: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "agentId")) {
      const raw = body.agentId;
      if (raw === null || raw === "") {
        data.defaultAgentId = null; // clear override → app.defaultAgentId
      } else if (typeof raw === "string") {
        const agentId = raw.trim();
        if (!(await this.agentInScope(scope, agentId))) {
          throw new HttpException(
            {
              error: "unknown_agent_id",
              message: `agent ${agentId} not found in scope`,
              agentId,
            },
            HttpStatus.BAD_REQUEST
          );
        }
        data.defaultAgentId = agentId;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "agentRouting")) {
      const ar = body.agentRouting;
      if (ar === null) {
        data.agentRouting = []; // clear override → app.agentRouting
      } else {
        const routing = await validateAgentRouting(this.prisma, scope, ar);
        if (!routing.ok) {
          throw new HttpException(
            { error: routing.error, message: routing.message },
            HttpStatus.BAD_REQUEST
          );
        }
        data.agentRouting = routing.rules;
      }
    }
    if (Object.keys(data).length === 0) {
      throw new HttpException(
        { error: "no_op", message: "supply at least one of agentId / agentRouting" },
        HttpStatus.BAD_REQUEST
      );
    }

    const updated = await this.persistence.updateInstallationBinding(
      scope,
      id,
      installationId,
      data
    );
    if (!updated) throw new HttpException("Installation not found", HttpStatus.NOT_FOUND);
    // Routing/agent binding is read fresh per-event by the events runtime, so
    // no token-cache eviction is needed here.
    return { installation: this.projectInstallation(updated) };
  }

  /**
   * Revoke an installation (SOFT — status=revoked, revokedAt=now). Never
   * hard-deletes: Slack's uninstall lifecycle is order-unstable and the
   * install row is the audit trail. Evicts the cached bot token so the revoked
   * workspace stops receiving replies immediately.
   */
  @Delete(":id/installations/:installationId")
  async revokeInstallation(
    @Req() req: Request,
    @Param("id") id: string,
    @Param("installationId") installationId: string
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const app = await this.persistence.loadScopedApp(scope, id);
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    const installation = await this.persistence.loadInstallation(installationId, id);
    if (!installation) {
      throw new HttpException("Installation not found", HttpStatus.NOT_FOUND);
    }
    const updated = await this.persistence.revokeInstallation(scope, id, installationId);
    if (!updated) throw new HttpException("Installation not found", HttpStatus.NOT_FOUND);
    this.invalidateApp(id);
    return { revoked: true, installation: this.projectInstallation(updated) };
  }
}
