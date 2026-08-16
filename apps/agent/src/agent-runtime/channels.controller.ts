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
  Logger,
} from "@nestjs/common";
import { type Request } from "express";
import { ModuleRef } from "@nestjs/core";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { ChannelRuntimeService } from "../channels/channel-runtime.service";
import { ChannelPersistenceService } from "../channels/channel-persistence.service";
import { requireOperator, type RequestScope } from "../auth/scope.guard";
import { validateAgentRouting } from "./channel-routing";

/**
 * Connect reimagining — dashboard REST for messaging-channel doorways.
 * This is what the redesigned Connect page calls. It mirrors the channels.*
 * platform MCP tools (management surface only — the inbound webhook RUNTIME
 * that receives Slack/Telegram/etc. posts is a SEPARATE slice).
 *
 *   GET    /api/v1/agent/channels              — list channels in scope
 *   POST   /api/v1/agent/channels              — create a channel
 *   GET    /api/v1/agent/channels/:id          — get one channel
 *   PATCH  /api/v1/agent/channels/:id          — partial-patch a channel
 *   DELETE /api/v1/agent/channels/:id          — delete a channel
 *   POST   /api/v1/agent/channels/:id/rotate-secret — rotate the webhook secret
 *
 * Every handler is OPERATOR-ONLY (requireOperator) and ScopeGuard-scoped —
 * the same posture as the operator-only entity-management endpoints on
 * AgentController. `credentials` is stored only in a referenced Credential
 * envelope and is NEVER returned;
 * `webhookSecret` is redacted on every read. The full secret-bearing
 * `webhookPath` is returned ONLY on create + rotate (one-time reveal).
 */

const CHANNEL_PROVIDERS = new Set(["slack", "telegram", "whatsapp", "discord"]);
const WEBHOOK_BASE = "/api/v1/channels/inbound";

// ── Connect v3 (Phase D) — BYO app mint via the Slack App Manifest API ────────
// `apps.manifest.create` requires a MANUALLY-generated App Configuration Token
// (xoxe.xoxp-… access + xoxe-… refresh, 12h TTL, created by the user at
// api.slack.com/apps → "Your App Configuration Tokens"). There is NO
// delegated/OAuth path to mint config tokens, so the one paste is unavoidable.
const SLACK_MANIFEST_CREATE_URL = "https://slack.com/api/apps.manifest.create";
const SLACK_HTTP_TIMEOUT_MS = 10_000;
// Bot scopes = the Phase-A/B recommended AI-Apps set. `assistant:write` unlocks
// assistant.threads.setStatus/setTitle/setSuggestedPrompts; `im:history` reads
// the assistant DM thread; `chat:write` posts replies; `app_mentions:read` is
// the mention-bot fallback. Scope-minimized (marketplace requirement).
const SLACK_BYO_BOT_SCOPES = [
  "assistant:write",
  "chat:write",
  "im:history",
  "app_mentions:read",
] as const;
// Slack caps display_information.name at 35 chars and bot_user.display_name at 80.
const SLACK_APP_NAME_MAX = 35;

/**
 * Build a Slack app manifest for apps.manifest.create. Targets Slack's
 * first-class "Agents & AI Apps" surface so a BYO app gets the SAME surface as
 * the marketplace tier: presence of `features.assistant_view` turns the surface
 * ON, `assistant:write` (in the bot scopes) unlocks assistant.threads.*, and the
 * `assistant_thread_*` bot events deliver the panel lifecycle.
 * `event_subscriptions.request_url` is the connection's OWN secret-bearing
 * inbound URL — known only AFTER the row is created (the create-row-first
 * ordering resolves that chicken-and-egg). The BYO bot token arrives later
 * (OAuth-install or manual paste), so `token_rotation_enabled` stays false here
 * (rotation is a marketplace-tier ChannelApp property).
 */
function buildSlackAppManifest(appName: string, requestUrl: string) {
  const name = appName.slice(0, SLACK_APP_NAME_MAX);
  return {
    display_information: { name },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: appName.slice(0, 80),
        always_online: true,
      },
      // Presence of assistant_view ENABLES the "Agents & AI Apps" surface.
      assistant_view: {
        assistant_description: `${name} is an AI assistant available in Slack.`,
      },
    },
    oauth_config: {
      scopes: { bot: [...SLACK_BYO_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: requestUrl,
        bot_events: [
          "app_mention",
          "message.im",
          "assistant_thread_started",
          "assistant_thread_context_changed",
        ],
      },
      // No interactivity handler on the BYO connection tier (it processes
      // message + assistant events only), so leave it off — enabling it would
      // require a registered interactivity request_url.
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

@Controller("api/v1/agent/channels")
export class ChannelsController {
  private readonly logger = new Logger(ChannelsController.name);
  private readonly persistence: ChannelPersistenceService;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    messageCrypto: MessageCryptoService,
    private readonly moduleRef: ModuleRef
  ) {
    this.persistence = new ChannelPersistenceService(prisma, messageCrypto);
  }

  /**
   * Evict the runtime's cached Chat instance after a mutation so the next
   * inbound webhook rebuilds with fresh credentials/config/routing — without
   * this, a rotated signing secret keeps VERIFYING against the compromised
   * old one for up to the runtime's 10-min TTL. Resolved lazily via ModuleRef
   * (`strict: false` searches the whole container) because ChannelsModule
   * imports AgentRuntimeModule — direct DI here would be circular. Best-effort:
   * an eviction failure must never fail the mutation (TTL bounds staleness).
   */
  private invalidateRuntime(connectionId: string): void {
    try {
      this.moduleRef.get(ChannelRuntimeService, { strict: false })?.invalidate(connectionId);
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

  /** Redact Credential payloads; expose only whether provider credentials are set. */
  private projectRow(row: any) {
    const {
      credentials,
      webhookSecret,
      hasCredentials,
      credential,
      environment,
      entity,
      credentialRevision,
      ...rest
    } = row;
    void credentials;
    void webhookSecret;
    void credential;
    void environment;
    void entity;
    void credentialRevision;
    return {
      ...rest,
      hasCredentials: hasCredentials === true,
    };
  }

  private webhookPathFull(id: string, webhookSecret: string): string {
    return `${WEBHOOK_BASE}/${id}/${webhookSecret}`;
  }

  /**
   * Public origin for inbound webhooks, backend-configured (never guessed
   * client-side): PLATOS_PUBLIC_BASE_URL wins; else derived from
   * PLATOS_AGENT_PUBLIC_WS_URL (wss://host → https://host); else null and
   * callers fall back to showing the path with a configure-me warning.
   */
  private publicOrigin(): string | null {
    const explicit = (process.env.PLATOS_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
    if (explicit) return explicit;
    const ws = (process.env.PLATOS_AGENT_PUBLIC_WS_URL || "").trim().replace(/\/+$/, "");
    if (ws.startsWith("wss://")) return `https://${ws.slice(6)}`;
    if (ws.startsWith("ws://")) return `http://${ws.slice(5)}`;
    return null;
  }

  /** Absolute webhook URL when a public origin is configured, else null. */
  private webhookUrlFull(id: string, webhookSecret: string): string | null {
    const origin = this.publicOrigin();
    return origin ? `${origin}${this.webhookPathFull(id, webhookSecret)}` : null;
  }

  private isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === "object" && !Array.isArray(v);
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

  @Get()
  async list(@Req() req: Request) {
    const scope = this.getScope(req);
    requireOperator(scope); // operator-only — same posture as entity management
    const rows = await this.persistence.listConnections(scope);
    return { channels: (rows as any[]).map((r) => this.projectRow(r)) };
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body()
    body: {
      provider: string;
      agentId: string;
      displayName?: string;
      agentRouting?: unknown;
      credentials?: Record<string, unknown> | null;
      config?: Record<string, unknown> | null;
    }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const provider = String(body?.provider ?? "")
      .trim()
      .toLowerCase();
    const agentId = String(body?.agentId ?? "").trim();
    if (!CHANNEL_PROVIDERS.has(provider)) {
      throw new HttpException(
        {
          error: "invalid_provider",
          message: "provider must be one of slack | telegram | whatsapp | discord",
        },
        HttpStatus.BAD_REQUEST
      );
    }
    if (!agentId) {
      throw new HttpException(
        { error: "invalid_params", message: "agentId is required" },
        HttpStatus.BAD_REQUEST
      );
    }
    if (!(await this.agentInScope(scope, agentId))) {
      throw new HttpException(
        { error: "unknown_agent_id", message: `agent ${agentId} not found in scope`, agentId },
        HttpStatus.BAD_REQUEST
      );
    }

    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : undefined;
    const configJson = this.isPlainObject(body?.config) ? body.config : undefined;
    const credentials = this.isPlainObject(body?.credentials) ? body.credentials : undefined;

    // Validate + normalize the optional routing table (each rule's agentId is
    // checked in-scope, same forged-id guard as the default agentId above).
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

    const webhookSecret = crypto.randomBytes(32).toString("hex");

    const row = await this.persistence.createConnection(scope, {
      provider,
      defaultAgentId: agentId,
      webhookSecret,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
      ...(credentials !== undefined ? { credentials } : {}),
      ...(configJson !== undefined ? { config: configJson } : {}),
    });

    // One-time reveal: full inbound path + plaintext secret (create only).
    return {
      channel: this.projectRow(row),
      webhookSecret,
      webhookPath: this.webhookPathFull(row.id, webhookSecret),
      webhookUrl: this.webhookUrlFull(row.id, webhookSecret),
    };
  }

  /**
   * Connect v3 (Phase D) — BYO app MINT. Upgrade the manual multi-screen Slack
   * walkthrough to "paste one config token, Platos builds your Slack app". This
   * operates on the ChannelConnection tier (the customer-owned BYO app), NOT the
   * marketplace ChannelApp tier.
   *
   * CHICKEN-AND-EGG: the manifest's `event_subscriptions.request_url` must embed
   * the connection's id + webhookSecret, which only exist AFTER the row is
   * created. ORDER: (1) create the ChannelConnection row (mints its
   * webhookSecret → its inbound URL is now known), (2) call apps.manifest.create
   * with that URL baked into the manifest, (3) store the returned
   * client_id/client_secret/signing_secret ENCRYPTED onto the row. On a Slack
   * rejection the half-minted row is rolled back so a mint is all-or-nothing.
   *
   * apps.manifest.create does NOT install the app — the bot token still arrives
   * later via OAuth-install (returned `oauthAuthorizeUrl`) or manual paste. The
   * config token (12h TTL) is NEVER persisted or logged; the optional refresh
   * token is discarded too — v1 is a one-shot create, we don't keep it for a
   * later manifest.update.
   */
  @Post("mint")
  async mintFromManifest(
    @Req() req: Request,
    @Body()
    body: {
      provider?: string;
      agentId?: string;
      displayName?: string;
      configToken?: string;
      configRefreshToken?: string;
    }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const provider = String(body?.provider ?? "slack")
      .trim()
      .toLowerCase();
    const agentId = String(body?.agentId ?? "").trim();
    const configToken = typeof body?.configToken === "string" ? body.configToken.trim() : "";
    const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";

    // Only Slack exposes the App Manifest API.
    if (provider !== "slack") {
      throw new HttpException(
        {
          error: "unsupported_provider",
          message: "manifest mint supports provider 'slack' only",
        },
        HttpStatus.BAD_REQUEST
      );
    }
    if (!agentId) {
      throw new HttpException(
        { error: "invalid_params", message: "agentId is required" },
        HttpStatus.BAD_REQUEST
      );
    }
    if (!configToken) {
      throw new HttpException(
        { error: "invalid_params", message: "configToken is required" },
        HttpStatus.BAD_REQUEST
      );
    }

    // In-scope guard (forged ids rejected) + name fallback for the manifest.
    const binding = await this.prisma.agentBinding.findFirst({
      where: {
        agentId,
        environmentId: scope.environmentId,
        agent: { projectId: scope.projectId },
        environment: {
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
      },
      select: { agent: { select: { id: true, name: true } } },
    });
    if (!binding) {
      throw new HttpException(
        { error: "unknown_agent_id", message: `agent ${agentId} not found in scope`, agentId },
        HttpStatus.BAD_REQUEST
      );
    }

    // The manifest's request_url must be an absolute HTTPS URL — refuse BEFORE
    // creating anything if the public origin isn't backend-configured.
    const origin = this.publicOrigin();
    if (!origin) {
      throw new HttpException(
        {
          error: "public_origin_unconfigured",
          message:
            "PLATOS_PUBLIC_BASE_URL (or PLATOS_AGENT_PUBLIC_WS_URL) must be set so the app's event request URL can be built.",
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }

    const appName = (displayName || binding.agent.name || "Platos Agent").trim() || "Platos Agent";

    // (1) CREATE the connection row FIRST so its inbound URL (id + secret) exists.
    const webhookSecret = crypto.randomBytes(32).toString("hex");
    const row = await this.persistence.createConnection(scope, {
      provider,
      defaultAgentId: agentId,
      ...(displayName ? { displayName } : {}),
      webhookSecret,
    });

    const requestUrl = `${origin}${this.webhookPathFull(row.id, webhookSecret)}`;
    const manifest = buildSlackAppManifest(appName, requestUrl);

    // (2) CALL apps.manifest.create with the URL baked in. The config token and
    // manifest ride in the FORM BODY (never the URL); nothing here is logged.
    let json: any;
    try {
      const form = new URLSearchParams({
        token: configToken,
        manifest: JSON.stringify(manifest),
      });
      const resp = await fetch(SLACK_MANIFEST_CREATE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: AbortSignal.timeout(SLACK_HTTP_TIMEOUT_MS),
      });
      json = await resp.json();
    } catch {
      await this.rollbackMint(scope, row.id);
      this.logger.error(`[channels] apps.manifest.create request failed connection=${row.id}`);
      throw new HttpException(
        {
          error: "slack_unreachable",
          message: "Could not reach Slack to create the app. Please try again.",
        },
        HttpStatus.BAD_GATEWAY
      );
    }

    if (!json?.ok) {
      await this.rollbackMint(scope, row.id);
      // Surface ONLY the Slack error code — never the config token / manifest.
      const slackError = typeof json?.error === "string" ? json.error : "unknown_error";
      this.logger.warn(
        `[channels] apps.manifest.create rejected connection=${row.id} error=${slackError}`
      );
      throw new HttpException(
        {
          error: "manifest_create_failed",
          slackError,
          message: `Slack rejected the manifest (code: ${slackError}).`,
        },
        HttpStatus.BAD_REQUEST
      );
    }

    // (3) STORE the returned credentials ENCRYPTED onto the row. signing_secret →
    // credentials.signingSecret (the Slack adapter reads THAT key for signature
    // verification); client_id/client_secret ride along in the same encrypted
    // envelope. The bot token is still absent — it arrives via OAuth-install or
    // manual paste later. app_id (public) goes into `config`.
    // `json` is the untyped Slack response — read fields off it directly.
    const clientId =
      typeof json?.credentials?.client_id === "string" ? json.credentials.client_id : "";
    const clientSecret =
      typeof json?.credentials?.client_secret === "string" ? json.credentials.client_secret : "";
    const signingSecret =
      typeof json?.credentials?.signing_secret === "string" ? json.credentials.signing_secret : "";
    const appId = typeof json.app_id === "string" ? json.app_id : null;
    const oauthAuthorizeUrl =
      typeof json.oauth_authorize_url === "string" ? json.oauth_authorize_url : null;

    const credentials = {
      ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(signingSecret ? { signingSecret } : {}),
    };
    const config: Record<string, unknown> = {
      ...(appId ? { slackAppId: appId } : {}),
      // clientId is PUBLIC (rides the OAuth authorize URL) — surface it in the
      // returned config so a later OAuth-install step has it without a decrypt.
      ...(clientId ? { slackClientId: clientId } : {}),
    };

    let updated: any;
    try {
      updated = await this.persistence.updateConnection(scope, row.id, {}, { credentials, config });
      if (!updated) throw new Error("channel connection unavailable");
    } catch {
      // The app WAS created at Slack but we couldn't persist its secrets. Do NOT
      // roll back the row (that would orphan a live Slack app whose request URL
      // points here) — surface the connectionId so the operator can retry the
      // store via PATCH. Never log the secret material.
      this.logger.error(`[channels] mint secret-store failed connection=${row.id}`);
      throw new HttpException(
        {
          error: "secret_store_failed",
          connectionId: row.id,
          appId,
          message: "The Slack app was created but its credentials could not be saved.",
        },
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
    this.invalidateRuntime(row.id);

    this.logger.log(`[channels] minted BYO slack app connection=${row.id} appId=${appId ?? "?"}`);

    // One-time reveal: the secret-bearing inbound URL (already registered at
    // Slack as the request URL) + the authorize URL to finish the install.
    return {
      channel: this.projectRow(updated),
      appId,
      oauthAuthorizeUrl,
      webhookSecret,
      webhookPath: this.webhookPathFull(row.id, webhookSecret),
      webhookUrl: requestUrl,
    };
  }

  /**
   * Best-effort rollback of a half-minted connection when Slack rejects the
   * manifest (or is unreachable) — a credential-less row would verify nothing
   * and post nothing, but keeping the mint all-or-nothing avoids clutter.
   */
  private async rollbackMint(scope: RequestScope, connectionId: string): Promise<void> {
    try {
      await this.persistence.deleteConnection(scope, connectionId);
    } catch {
      // Already gone / raced — nothing to undo.
    }
  }

  @Get(":id")
  async getOne(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const row = await this.persistence.loadScopedConnection(scope, id);
    if (!row) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);
    return { channel: this.projectRow(row) };
  }

  @Patch(":id")
  async update(
    @Req() req: Request,
    @Param("id") id: string,
    @Body()
    body: {
      displayName?: string | null;
      enabled?: boolean;
      agentId?: string;
      agentRouting?: unknown;
      config?: Record<string, unknown> | null;
      credentials?: Record<string, unknown> | null;
    }
  ) {
    const scope = this.getScope(req);
    requireOperator(scope);

    const existing = await this.persistence.loadScopedConnection(scope, id);
    if (!existing) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);

    const data: Record<string, unknown> = {};
    const credentialData: Record<string, unknown> = {};
    if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
      data.displayName = typeof body.displayName === "string" ? body.displayName.trim() : null;
    }
    if (typeof body.enabled === "boolean") data.enabled = body.enabled;
    if (typeof body.agentId === "string") {
      const agentId = body.agentId.trim();
      if (!agentId) {
        throw new HttpException(
          { error: "invalid_params", message: "agentId must be non-empty" },
          HttpStatus.BAD_REQUEST
        );
      }
      if (!(await this.agentInScope(scope, agentId))) {
        throw new HttpException(
          { error: "unknown_agent_id", message: `agent ${agentId} not found in scope`, agentId },
          HttpStatus.BAD_REQUEST
        );
      }
      data.defaultAgentId = agentId;
    }
    if (Object.prototype.hasOwnProperty.call(body, "agentRouting")) {
      const ar = body.agentRouting;
      if (ar === null) {
        data.agentRouting = []; // explicit clear → default agent only
      } else {
        // array → validate + normalize (rule agentIds checked in-scope, same
        // guard as the default agentId); anything else → 400.
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
    if (Object.prototype.hasOwnProperty.call(body, "config")) {
      credentialData.config = this.isPlainObject(body.config) ? body.config : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, "credentials")) {
      credentialData.credentials = this.isPlainObject(body.credentials) ? body.credentials : null;
    }

    if (Object.keys(data).length === 0 && Object.keys(credentialData).length === 0) {
      return { channel: this.projectRow(existing) };
    }

    const updated = await this.persistence.updateConnection(scope, id, data, credentialData);
    if (!updated) throw new HttpException("channel connection not found", HttpStatus.NOT_FOUND);
    this.invalidateRuntime(id);
    return { channel: this.projectRow(updated) };
  }

  @Delete(":id")
  async remove(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const existing = await this.persistence.loadScopedConnection(scope, id);
    if (!existing) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);
    await this.persistence.deleteConnection(scope, id);
    this.invalidateRuntime(id);
    return { deleted: true, id };
  }

  @Post(":id/rotate-secret")
  async rotateSecret(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    requireOperator(scope);
    const existing = await this.persistence.loadScopedConnection(scope, id);
    if (!existing) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);

    const webhookSecret = crypto.randomBytes(32).toString("hex");
    const updated = await this.persistence.updateConnection(scope, id, {}, { webhookSecret });
    if (!updated) throw new HttpException("Channel not found", HttpStatus.NOT_FOUND);
    this.invalidateRuntime(id);
    // One-time reveal: full inbound path + plaintext secret (rotate only).
    return {
      channel: this.projectRow(updated),
      webhookSecret,
      webhookPath: this.webhookPathFull(updated.id, webhookSecret),
      webhookUrl: this.webhookUrlFull(updated.id, webhookSecret),
    };
  }
}
