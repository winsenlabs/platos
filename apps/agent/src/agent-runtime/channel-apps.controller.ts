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
import { requireOperator, type RequestScope } from "../auth/scope.guard";
import { validateAgentRouting } from "./channel-routing";

/**
 * Connect v3 — dashboard REST for marketplace-grade channel APPS.
 *
 * A PlatosChannelApp is a publishable Slack app identity (one clientId /
 * clientSecret / signingSecret) OWNED by the operator's scope and installed
 * into N external workspaces via OAuth ("Add to Slack"). Each install is a
 * PlatosChannelInstallation row (bot token + team). This controller is the
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
 *   POST   /api/v1/agent/channel-apps/:id/installations/:installationId/bind
 *                                                             — rebind agent / routing
 *   DELETE /api/v1/agent/channel-apps/:id/installations/:installationId
 *                                                             — revoke an install (soft)
 *
 * Every handler is OPERATOR-ONLY (requireOperator) and ScopeGuard-scoped — the
 * same posture as ChannelsController. `clientSecret` + `signingSecret` are
 * stored ENCRYPTED (MessageCryptoService envelope) and NEVER returned;
 * `hasClientSecret` / `hasSigningSecret` booleans say whether they're set. The
 * install-time bot tokens live on the installation rows and are likewise
 * redacted (`hasBotToken`). `clientId` is a public identifier and IS returned.
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
 */

const APP_PROVIDERS = new Set(["slack"]);
const DISTRIBUTIONS = new Set(["private", "public"]);
const OAUTH_BASE = "/api/v1/channels/oauth";

@Controller("api/v1/agent/channel-apps")
export class ChannelAppsController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly messageCrypto: MessageCryptoService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Evict the runtime's cached decrypted bot token(s) for an app after a
   * mutation (credential edit, delete, install revoke) so a rotated/revoked
   * token stops posting immediately instead of after the 10-min TTL. Lazy via
   * ModuleRef (strict:false) because ChannelsModule ↔ AgentRuntimeModule is a
   * DI cycle. Best-effort — an eviction failure never fails the mutation.
   */
  private invalidateApp(appId: string): void {
    try {
      this.moduleRef
        .get(ChannelRuntimeService, { strict: false })
        ?.invalidateApp(appId);
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

  private scopeWhere(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
  }

  private isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  /** Redact the two secret columns; expose only whether they're set. */
  private projectApp(row: any) {
    const { clientSecret, signingSecret, ...rest } = row;
    void clientSecret;
    void signingSecret;
    return {
      ...rest,
      hasClientSecret: clientSecret != null,
      hasSigningSecret: signingSecret != null,
    };
  }

  /** Redact the install secret columns; expose only whether they're set. */
  private projectInstallation(row: any) {
    const { botToken, refreshToken, ...rest } = row;
    void botToken;
    void refreshToken;
    return {
      ...rest,
      hasBotToken: botToken != null,
      hasRefreshToken: refreshToken != null,
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

  /** Encrypt a single secret string into the stored envelope. */
  private encryptSecret(plain: string): string {
    return JSON.stringify(this.messageCrypto.encryptJsonField(plain));
  }

  /** Forged-id guard — the agent must belong to this exact scope. */
  private async agentInScope(scope: RequestScope, agentId: string): Promise<boolean> {
    const agent = await this.prisma.platosAgent.findFirst({
      where: { id: agentId, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    return !!agent;
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
    const rows = await this.prisma.platosChannelApp.findMany({
      where: this.scopeWhere(scope),
      orderBy: { createdAt: "desc" },
    });
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
      defaultAgentId?: string | null;
      agentRouting?: unknown;
    },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const provider = String(body?.provider ?? "slack").trim().toLowerCase();
    if (!APP_PROVIDERS.has(provider)) {
      throw new HttpException(
        { error: "invalid_provider", message: "provider must be slack (v1)" },
        HttpStatus.BAD_REQUEST,
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
        HttpStatus.BAD_REQUEST,
      );
    }

    const distribution = body?.distribution
      ? String(body.distribution).trim().toLowerCase()
      : "private";
    if (!DISTRIBUTIONS.has(distribution)) {
      throw new HttpException(
        { error: "invalid_params", message: "distribution must be private | public" },
        HttpStatus.BAD_REQUEST,
      );
    }

    const displayName =
      typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
    const scopes = this.normalizeScopes(body?.scopes);
    const aiAppsSurface =
      typeof body?.aiAppsSurface === "boolean" ? body.aiAppsSurface : undefined;

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
        HttpStatus.BAD_REQUEST,
      );
    }

    // agentRouting (optional) — validate + normalize (each rule agentId in-scope).
    let agentRoutingData: unknown | undefined;
    if (body?.agentRouting !== undefined && body?.agentRouting !== null) {
      const routing = await validateAgentRouting(this.prisma, scope, body.agentRouting);
      if (!routing.ok) {
        throw new HttpException(
          { error: routing.error, message: routing.message },
          HttpStatus.BAD_REQUEST,
        );
      }
      agentRoutingData = routing.rules;
    }

    const row = await this.prisma.platosChannelApp.create({
      data: {
        ...this.scopeWhere(scope),
        provider,
        clientId,
        clientSecret: this.encryptSecret(clientSecret),
        signingSecret: this.encryptSecret(signingSecret),
        distribution,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(aiAppsSurface !== undefined ? { aiAppsSurface } : {}),
        ...(defaultAgentId ? { defaultAgentId } : {}),
        ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
      },
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
    const row = await this.prisma.platosChannelApp.findFirst({
      where: { id, ...this.scopeWhere(scope) },
    });
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
      defaultAgentId?: string | null;
      agentRouting?: unknown;
    },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const existing = await this.prisma.platosChannelApp.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!existing) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);

    const data: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
      data.displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    }
    if (typeof body.clientId === "string") {
      const clientId = body.clientId.trim();
      if (!clientId) {
        throw new HttpException(
          { error: "invalid_params", message: "clientId must be non-empty" },
          HttpStatus.BAD_REQUEST,
        );
      }
      data.clientId = clientId;
    }
    if (typeof body.clientSecret === "string" && body.clientSecret.trim()) {
      data.clientSecret = this.encryptSecret(body.clientSecret.trim());
    }
    if (typeof body.signingSecret === "string" && body.signingSecret.trim()) {
      data.signingSecret = this.encryptSecret(body.signingSecret.trim());
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
          HttpStatus.BAD_REQUEST,
        );
      }
      data.distribution = distribution;
    }
    if (typeof body.aiAppsSurface === "boolean") data.aiAppsSurface = body.aiAppsSurface;
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
            HttpStatus.BAD_REQUEST,
          );
        }
        data.defaultAgentId = defaultAgentId;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "agentRouting")) {
      const ar = body.agentRouting;
      if (ar === null) {
        data.agentRouting = null; // explicit clear → default agent only
      } else {
        const routing = await validateAgentRouting(this.prisma, scope, ar);
        if (!routing.ok) {
          throw new HttpException(
            { error: routing.error, message: routing.message },
            HttpStatus.BAD_REQUEST,
          );
        }
        data.agentRouting = routing.rules;
      }
    }

    if (Object.keys(data).length === 0) {
      const row = await this.prisma.platosChannelApp.findFirst({
        where: { id, ...this.scopeWhere(scope) },
      });
      if (!row) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
      return { app: this.projectApp(row), installUrl: this.installUrl(row.id) };
    }

    const updated = await this.prisma.platosChannelApp.update({ where: { id }, data });
    // Credential changes must not linger in the runtime's decrypted-token cache.
    this.invalidateApp(id);
    return { app: this.projectApp(updated), installUrl: this.installUrl(updated.id) };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const existing = await this.prisma.platosChannelApp.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!existing) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    // Cascades PlatosChannelInstallation + PlatosChannelAppThread (schema onDelete).
    await this.prisma.platosChannelApp.delete({ where: { id } });
    this.invalidateApp(id);
    return { deleted: true, id };
  }

  // ── Installations ─────────────────────────────────────────────────────

  @Get(":id/installations")
  async listInstallations(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const app = await this.prisma.platosChannelApp.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    const rows = await this.prisma.platosChannelInstallation.findMany({
      where: { appId: id },
      orderBy: { createdAt: "desc" },
    });
    return {
      installations: (rows as any[]).map((r) => this.projectInstallation(r)),
    };
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
    @Body() body: { agentId?: string | null; agentRouting?: unknown },
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    // The app must be in scope; the installation must belong to that app.
    const app = await this.prisma.platosChannelApp.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    const installation = await this.prisma.platosChannelInstallation.findFirst({
      where: { id: installationId, appId: id },
      select: { id: true },
    });
    if (!installation) {
      throw new HttpException("Installation not found", HttpStatus.NOT_FOUND);
    }

    const data: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "agentId")) {
      const raw = body.agentId;
      if (raw === null || raw === "") {
        data.agentId = null; // clear override → app.defaultAgentId
      } else if (typeof raw === "string") {
        const agentId = raw.trim();
        if (!(await this.agentInScope(scope, agentId))) {
          throw new HttpException(
            {
              error: "unknown_agent_id",
              message: `agent ${agentId} not found in scope`,
              agentId,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        data.agentId = agentId;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "agentRouting")) {
      const ar = body.agentRouting;
      if (ar === null) {
        data.agentRouting = null; // clear override → app.agentRouting
      } else {
        const routing = await validateAgentRouting(this.prisma, scope, ar);
        if (!routing.ok) {
          throw new HttpException(
            { error: routing.error, message: routing.message },
            HttpStatus.BAD_REQUEST,
          );
        }
        data.agentRouting = routing.rules;
      }
    }
    if (Object.keys(data).length === 0) {
      throw new HttpException(
        { error: "no_op", message: "supply at least one of agentId / agentRouting" },
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.platosChannelInstallation.update({
      where: { id: installationId },
      data,
    });
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
    @Param("installationId") installationId: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const app = await this.prisma.platosChannelApp.findFirst({
      where: { id, ...this.scopeWhere(scope) },
      select: { id: true },
    });
    if (!app) throw new HttpException("Channel app not found", HttpStatus.NOT_FOUND);
    const installation = await this.prisma.platosChannelInstallation.findFirst({
      where: { id: installationId, appId: id },
      select: { id: true },
    });
    if (!installation) {
      throw new HttpException("Installation not found", HttpStatus.NOT_FOUND);
    }
    const updated = await this.prisma.platosChannelInstallation.update({
      where: { id: installationId },
      data: { status: "revoked", revokedAt: new Date() },
    });
    this.invalidateApp(id);
    return { revoked: true, installation: this.projectInstallation(updated) };
  }
}
