/**
 * Connect reimagining — channels.* platform MCP tools.
 *
 * A PlatosChannelConnection is a messaging-channel *doorway* (Slack workspace /
 * Telegram bot / WhatsApp number / Discord app) bound to ONE agent. These tools
 * are the management surface over that model — create / list / get / update /
 * delete / rotate the webhook secret. The inbound webhook RUNTIME (receiving
 * provider posts and routing them to the agent) is a SEPARATE slice; nothing
 * here touches it.
 *
 * Contract, mirroring `entities.ts`:
 *   - Scope is ALWAYS taken from the verified MCP token, never from the
 *     LLM-supplied args — every query is filtered by the token's
 *     (organizationId, projectId, environmentId) tuple.
 *   - `agentId` is validated against the scope the same way
 *     `entities.set_linked_agents` validates agent ids (a forged id → error).
 *   - `credentials` is stored ENCRYPTED via the SAME MessageCryptoService
 *     envelope the entity test-credentials use (`encryptJsonField` →
 *     `JSON.stringify`). It is NEVER decrypted or returned by this surface.
 *   - `webhookSecret` is minted with `crypto.randomBytes(32).toString("hex")`.
 *     The full inbound webhook path (which embeds the secret) is revealed ONLY
 *     on create + rotate; list/get redact both `credentials` and
 *     `webhookSecret` and expose only a placeholder path.
 *   - Mutations are audit-logged (fire-and-forget) with secrets redacted.
 */

import * as crypto from "node:crypto";

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import { validateAgentRouting } from "../../agent-runtime/channel-routing";
import type { ControlDatabaseClient } from "../../shared/database.provider";
import type { ChannelPersistenceService } from "../../channels/channel-persistence.service";

const CHANNEL_PROVIDERS = new Set(["slack", "telegram", "whatsapp", "discord"]);

// Base of the inbound webhook route. The inbound RUNTIME that serves this path
// is a separate slice; here it is used only to compose the returned path.
const WEBHOOK_BASE = "/api/v1/channels/inbound";

function scopeTuple(scope: RequestScope) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function agentBindingWhere(scope: RequestScope, agentId: string) {
  return {
    agentId,
    environmentId: scope.environmentId,
    environment: {
      projectId: scope.projectId,
      project: { organizationId: scope.organizationId },
    },
    agent: { projectId: scope.projectId },
  } as const;
}

/** The full one-time webhook path (embeds the secret) — create + rotate only. */
function webhookPathFull(connectionId: string, webhookSecret: string): string {
  return `${WEBHOOK_BASE}/${connectionId}/${webhookSecret}`;
}

/**
 * Public origin, backend-configured: PLATOS_PUBLIC_BASE_URL wins, else derived
 * from PLATOS_AGENT_PUBLIC_WS_URL (wss→https). Null when unconfigured.
 */
function publicOrigin(): string | null {
  const explicit = (process.env.PLATOS_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const ws = (process.env.PLATOS_AGENT_PUBLIC_WS_URL || "").trim().replace(/\/+$/, "");
  if (ws.startsWith("wss://")) return `https://${ws.slice(6)}`;
  if (ws.startsWith("ws://")) return `http://${ws.slice(5)}`;
  return null;
}

/** Absolute webhook URL when a public origin is configured, else null. */
function webhookUrlFull(connectionId: string, webhookSecret: string): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}${webhookPathFull(connectionId, webhookSecret)}` : null;
}

/** Placeholder path for reads — connectionId resolved, secret masked. */
function webhookPathRedacted(connectionId: string): string {
  return `${WEBHOOK_BASE}/${connectionId}/:webhookSecret`;
}

/**
 * Project a PlatosChannelConnection row for return — strip the two secret
 * columns (`credentials`, `webhookSecret`) and surface a boolean so callers
 * know whether credentials are set without ever seeing them.
 */
function projectRow(row: any) {
  const { credentials, webhookSecret, credential, environment, ...rest } = row;
  void webhookSecret;
  void credential;
  void environment;
  return { ...rest, hasCredentials: credentials != null };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ── Connect v3 (Phase D) — BYO app mint via the Slack App Manifest API ────────
// `apps.manifest.create` requires a MANUALLY-generated App Configuration Token
// (xoxe.xoxp-… access + xoxe-… refresh, 12h TTL, created by the user at
// api.slack.com/apps → "Your App Configuration Tokens"). There is NO
// delegated/OAuth path to mint config tokens, so the one paste is unavoidable.
const SLACK_MANIFEST_CREATE_URL = "https://slack.com/api/apps.manifest.create";
const SLACK_HTTP_TIMEOUT_MS = 10_000;
// Bot scopes = the Phase-A/B recommended AI-Apps set (scope-minimized).
const SLACK_BYO_BOT_SCOPES = [
  "assistant:write",
  "chat:write",
  "im:history",
  "app_mentions:read",
] as const;
// Slack caps display_information.name at 35 chars, bot_user.display_name at 80.
const SLACK_APP_NAME_MAX = 35;

/**
 * Build a Slack app manifest for apps.manifest.create. Targets Slack's
 * first-class "Agents & AI Apps" surface so a BYO app matches the marketplace
 * tier: presence of `features.assistant_view` turns the surface ON,
 * `assistant:write` (in the bot scopes) unlocks assistant.threads.*, and the
 * `assistant_thread_*` bot events deliver the panel lifecycle. `request_url`
 * is the connection's OWN secret-bearing inbound URL — known only AFTER the row
 * is created (create-row-first ordering). The BYO bot token arrives later
 * (OAuth-install or manual paste), so token rotation stays off here (it's a
 * marketplace-tier property: PlatosChannelApp.tokenRotation).
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

export function buildChannelToolHandlers(deps: {
  prisma: ControlDatabaseClient;
  channelPersistence: ChannelPersistenceService;
  toolAudit: ToolAuditService;
  /**
   * Evict the channels RUNTIME's cached Chat instance for a connection after
   * update / delete / rotate — otherwise the runtime keeps serving the OLD
   * decrypted credentials + routing for up to its 10-min TTL (rotated signing
   * secrets keep verifying, revoked bot tokens keep posting). Wired by
   * McpPlatformController via lazy ModuleRef resolution (ChannelsModule ↔
   * AgentRuntimeModule would otherwise be a DI cycle). Optional + best-effort.
   */
  invalidateRuntime?: (connectionId: string) => void;
}): McpToolHandler[] {
  const { prisma, channelPersistence, toolAudit } = deps;

  /** Best-effort runtime-cache eviction — never fails the mutation. */
  function evictRuntime(connectionId: string): void {
    try {
      deps.invalidateRuntime?.(connectionId);
    } catch {
      // TTL bounds staleness if eviction wiring is absent/broken.
    }
  }

  /**
   * Fire-and-forget audit trail for mutating channels.* tools. Mirrors the
   * shape used by `entities.ts` / `end-users.ts` so MCP-driven channel edits
   * surface in the same dashboard rows. Callers pass ALREADY-REDACTED args +
   * result — secrets must never reach the audit log.
   */
  function auditMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit
      .record({
        scope: scopeTuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(error !== undefined ? { error } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => undefined);
  }

  /**
   * Forged-id guard — the agent must belong to this exact scope. Mirrors the
   * validation in `entities.set_linked_agents` (org + project + env filter).
   */
  async function agentInScope(scope: RequestScope, agentId: string): Promise<boolean> {
    const agent = await prisma.agentBinding.findFirst({
      where: agentBindingWhere(scope, agentId),
      select: { id: true },
    });
    return !!agent;
  }

  return [
    {
      name: "channels.create",
      description:
        "Create a messaging-channel doorway. `provider` is one of slack | " +
        "telegram | whatsapp | discord. `agentId` is the DEFAULT agent and " +
        "must belong to the token's scope (forged ids are rejected). Optional " +
        "`agentRouting` fans ONE connection out to MANY agents: an ordered " +
        "list (≤32) of `{ match, agentId }` rules where `match` is either " +
        "`{ type: 'channel', id }` (matches the platform channel/group/" +
        "guild-channel id) or `{ type: 'prefix', value }` (matches when the " +
        "message text starts with '<value>:' or '@<value>', case-insensitive). " +
        "First matching rule wins, else the default `agentId`; every rule's " +
        "agentId is validated in-scope just like the default. Optional " +
        "`credentials` (object) is stored ENCRYPTED at rest and never " +
        "returned — put ALL secret material there (bot tokens, signing " +
        "secrets, webhook verify tokens); optional `config` (object) is " +
        "returned UNREDACTED, so it must hold only non-secret extras (slack " +
        "team_id, whatsapp phoneNumberId…). A 32-byte hex " +
        "webhookSecret is minted server-side. Returns the row (credentials + " +
        "webhookSecret redacted; `agentRouting` shown as stored) plus the full " +
        "one-time inbound `webhookPath` " +
        "`/api/v1/channels/inbound/:connectionId/:webhookSecret` and the " +
        "plaintext `webhookSecret` — shown ONCE, store it now.",
      inputSchema: {
        type: "object",
        required: ["provider", "agentId"],
        properties: {
          provider: { type: "string", enum: ["slack", "telegram", "whatsapp", "discord"] },
          agentId: { type: "string" },
          displayName: { type: "string" },
          agentRouting: {
            type: "array",
            maxItems: 32,
            description:
              "Ordered routing rules; first match wins, else the default agentId.",
            items: {
              type: "object",
              required: ["match", "agentId"],
              properties: {
                match: {
                  type: "object",
                  required: ["type"],
                  properties: {
                    type: { type: "string", enum: ["channel", "prefix"] },
                    id: { type: "string", description: "platform channel id (type=channel)" },
                    value: { type: "string", description: "handle prefix (type=prefix)" },
                  },
                  additionalProperties: false,
                },
                agentId: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          credentials: { type: "object" },
          config: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const provider = String(params["provider"] ?? "").trim().toLowerCase();
        const agentId = String(params["agentId"] ?? "").trim();
        const displayName =
          typeof params["displayName"] === "string" ? params["displayName"].trim() : undefined;
        const configJson = isPlainObject(params["config"]) ? params["config"] : undefined;
        const hasCredentialInput = isPlainObject(params["credentials"]);
        const routingProvided =
          params["agentRouting"] !== undefined && params["agentRouting"] !== null;

        // Redacted audit args — never echo credentials. agentRouting is not
        // secret, but we log only its presence to keep audit rows lean.
        const auditArgs = {
          provider,
          agentId,
          displayName,
          hasCredentials: hasCredentialInput,
          hasConfig: configJson !== undefined,
          hasAgentRouting: routingProvided,
        };

        if (!CHANNEL_PROVIDERS.has(provider)) {
          const err = "provider must be one of slack | telegram | whatsapp | discord";
          auditMutation(scope, "channels.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_provider", message: err };
        }
        if (!agentId) {
          const err = "agentId required";
          auditMutation(scope, "channels.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!(await agentInScope(scope, agentId))) {
          auditMutation(
            scope,
            "channels.create",
            auditArgs,
            null,
            "failed",
            startedAt,
            "unknown_agent_id",
          );
          return { error: "unknown_agent_id", agentId };
        }

        // Validate + normalize the routing table (rule agentIds are checked
        // in-scope exactly like the default agentId above).
        let agentRoutingData: unknown | undefined;
        if (routingProvided) {
          const routing = await validateAgentRouting(prisma, scope, params["agentRouting"]);
          if (!routing.ok) {
            auditMutation(
              scope,
              "channels.create",
              auditArgs,
              null,
              "failed",
              startedAt,
              routing.error,
            );
            return { error: routing.error, message: routing.message };
          }
          agentRoutingData = routing.rules;
        }

        const webhookSecret = crypto.randomBytes(32).toString("hex");
        try {
          const row = await channelPersistence.createConnection(scopeTuple(scope), {
            provider,
            defaultAgentId: agentId,
            ...(displayName !== undefined ? { displayName } : {}),
            ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
            credentials: isPlainObject(params["credentials"]) ? params["credentials"] : null,
            config: configJson ?? null,
            webhookSecret,
          });
          const result = {
            ...projectRow(row),
            webhookSecret,
            webhookPath: webhookPathFull(row.id, webhookSecret),
            webhookUrl: webhookUrlFull(row.id, webhookSecret),
          };
          // Redacted result — log the id + provider, never the secret/path.
          auditMutation(
            scope,
            "channels.create",
            auditArgs,
            { id: row.id, provider, agentId },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channels.create", auditArgs, null, "failed", startedAt, message);
          return { error: "create_failed", message };
        }
      },
    },

    {
      name: "channels.mint_from_manifest",
      description:
        "Connect v3 (Phase D) — BYO app MINT: \"paste one Slack App " +
        "Configuration Token, Platos builds your Slack app.\" Operates on the " +
        "CONNECTION tier (the customer-owned BYO app), not the marketplace app " +
        "tier. `configToken` is an App Configuration Token (xoxe.xoxp-… access, " +
        "12h TTL) the user generates MANUALLY at api.slack.com/apps → \"Your " +
        "App Configuration Tokens\" — there is NO OAuth way to mint it. " +
        "`provider` must be 'slack'. FLOW: creates a PlatosChannelConnection " +
        "row FIRST (so its secret-bearing inbound URL exists), bakes that URL " +
        "into a manifest that enables Slack's \"Agents & AI Apps\" surface " +
        "(assistant:write + assistant_thread_* events) with the recommended " +
        "bot scopes, calls apps.manifest.create, then stores the returned " +
        "client_id / client_secret / signing_secret ENCRYPTED on the row " +
        "(signing_secret is what verifies inbound Slack signatures). The app " +
        "is NOT installed by this call — the bot token arrives later via the " +
        "returned `oauthAuthorizeUrl` or a manual paste. The config token is " +
        "NEVER persisted or logged; the optional `configRefreshToken` is " +
        "accepted but DISCARDED (v1 is a one-shot create). Returns the row " +
        "(secrets redacted), `appId`, `oauthAuthorizeUrl`, and the one-time " +
        "`webhookUrl` / `webhookSecret`.",
      inputSchema: {
        type: "object",
        required: ["agentId", "configToken"],
        properties: {
          provider: { type: "string", enum: ["slack"] },
          agentId: { type: "string" },
          displayName: { type: "string" },
          configToken: { type: "string" },
          configRefreshToken: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const provider = String(params["provider"] ?? "slack").trim().toLowerCase();
        const agentId = String(params["agentId"] ?? "").trim();
        const configToken =
          typeof params["configToken"] === "string" ? params["configToken"].trim() : "";
        const displayName =
          typeof params["displayName"] === "string" ? params["displayName"].trim() : "";

        // Redacted audit args — NEVER echo the config token / refresh token.
        const auditArgs = {
          provider,
          agentId,
          displayName,
          hasConfigToken: configToken.length > 0,
          hasConfigRefreshToken:
            typeof params["configRefreshToken"] === "string" &&
            params["configRefreshToken"].length > 0,
        };

        if (provider !== "slack") {
          const err = "manifest mint supports provider 'slack' only";
          auditMutation(scope, "channels.mint_from_manifest", auditArgs, null, "failed", startedAt, err);
          return { error: "unsupported_provider", message: err };
        }
        if (!agentId) {
          const err = "agentId required";
          auditMutation(scope, "channels.mint_from_manifest", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!configToken) {
          const err = "configToken required";
          auditMutation(scope, "channels.mint_from_manifest", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }

        // In-scope guard (forged ids rejected) + name fallback for the manifest.
        const agent = await prisma.agentBinding.findFirst({
          where: agentBindingWhere(scope, agentId),
          select: { agent: { select: { id: true, name: true } } },
        });
        if (!agent) {
          auditMutation(
            scope,
            "channels.mint_from_manifest",
            auditArgs,
            null,
            "failed",
            startedAt,
            "unknown_agent_id",
          );
          return { error: "unknown_agent_id", agentId };
        }

        // The manifest's request_url must be an absolute HTTPS URL — refuse
        // BEFORE creating anything if the public origin isn't configured.
        const origin = publicOrigin();
        if (!origin) {
          auditMutation(
            scope,
            "channels.mint_from_manifest",
            auditArgs,
            null,
            "failed",
            startedAt,
            "public_origin_unconfigured",
          );
          return {
            error: "public_origin_unconfigured",
            message:
              "PLATOS_PUBLIC_BASE_URL (or PLATOS_AGENT_PUBLIC_WS_URL) must be set so the app's event request URL can be built.",
          };
        }

        const appName =
          (displayName || agent.agent.name || "Platos Agent").trim() || "Platos Agent";

        // (1) CREATE the connection row FIRST so its inbound URL (id + secret)
        // exists — the chicken-and-egg the manifest request_url depends on.
        const webhookSecret = crypto.randomBytes(32).toString("hex");
        let row: any;
        try {
          row = await channelPersistence.createConnection(scopeTuple(scope), {
            provider,
            defaultAgentId: agentId,
            ...(displayName ? { displayName } : {}),
            webhookSecret,
          });
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channels.mint_from_manifest", auditArgs, null, "failed", startedAt, message);
          return { error: "create_failed", message };
        }

        /** Best-effort rollback — a credential-less row verifies/posts nothing. */
        const rollback = async () => {
          try {
            await channelPersistence.deleteConnection(scopeTuple(scope), row.id);
          } catch {
            // Already gone / raced — nothing to undo.
          }
        };

        const requestUrl = `${origin}${webhookPathFull(row.id, webhookSecret)}`;
        const manifest = buildSlackAppManifest(appName, requestUrl);

        // (2) CALL apps.manifest.create. Config token + manifest ride in the
        // FORM BODY (never the URL); nothing here is logged. 10s bound.
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
          await rollback();
          const message = "could not reach Slack to create the app";
          auditMutation(scope, "channels.mint_from_manifest", auditArgs, null, "failed", startedAt, "slack_unreachable");
          return { error: "slack_unreachable", message };
        }

        if (!json?.ok) {
          await rollback();
          // Surface ONLY the Slack error code — never the config token/manifest.
          const slackError = typeof json?.error === "string" ? json.error : "unknown_error";
          auditMutation(
            scope,
            "channels.mint_from_manifest",
            auditArgs,
            null,
            "failed",
            startedAt,
            `manifest_create_failed:${slackError}`,
          );
          return {
            error: "manifest_create_failed",
            slackError,
            message: `Slack rejected the manifest (code: ${slackError}).`,
          };
        }

        // (3) STORE the returned credentials ENCRYPTED. signing_secret →
        // credentials.signingSecret (the key the Slack adapter reads for
        // signature verification); client_id/client_secret ride the same
        // envelope. Bot token is absent — it arrives via OAuth-install / paste.
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

        const config: Record<string, unknown> = {
          ...(appId ? { slackAppId: appId } : {}),
          // clientId is PUBLIC (rides the authorize URL) — surface it in config
          // so a later OAuth-install step has it without a decrypt.
          ...(clientId ? { slackClientId: clientId } : {}),
        };

        let updated: any;
        try {
          updated = await channelPersistence.updateConnection(
            scopeTuple(scope),
            row.id,
            {},
            {
              credentials: {
                ...(clientId ? { clientId } : {}),
                ...(clientSecret ? { clientSecret } : {}),
                ...(signingSecret ? { signingSecret } : {}),
              },
              config,
            },
          );
          if (!updated) throw new Error("channel connection unavailable after write");
        } catch {
          // The app WAS created at Slack but the secret store failed. Do NOT
          // roll back (that orphans a live Slack app pointing here) — return the
          // connectionId so the caller can retry the store. A generic message
          // (never the raw DB error, which could echo the write payload) + no
          // secret is ever logged.
          auditMutation(scope, "channels.mint_from_manifest", auditArgs, null, "failed", startedAt, "secret_store_failed");
          return {
            error: "secret_store_failed",
            connectionId: row.id,
            appId,
            message: "The Slack app was created but its credentials could not be saved.",
          };
        }
        evictRuntime(row.id);

        // Redacted audit — log the id + appId presence, never the secrets/URL.
        auditMutation(
          scope,
          "channels.mint_from_manifest",
          auditArgs,
          { id: row.id, appId, minted: true },
          "success",
          startedAt,
        );

        // One-time reveal: the secret-bearing inbound URL (already registered at
        // Slack as the request URL) + the authorize URL to finish the install.
        return {
          ...projectRow(updated),
          appId,
          oauthAuthorizeUrl,
          webhookSecret,
          webhookPath: webhookPathFull(row.id, webhookSecret),
          webhookUrl: requestUrl,
        };
      },
    },

    {
      name: "channels.list",
      description:
        "List channel connections in the token's scope, newest first. " +
        "`credentials` + `webhookSecret` are redacted; `hasCredentials` says " +
        "whether credentials are set. Each row carries a placeholder " +
        "`webhookPath` (secret masked) — the full secret-bearing path is " +
        "revealed only by channels.create / channels.rotate_webhook_secret.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["slack", "telegram", "whatsapp", "discord"] },
          agentId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const provider =
          typeof params["provider"] === "string" ? params["provider"].trim().toLowerCase() : undefined;
        const agentId =
          typeof params["agentId"] === "string" ? params["agentId"].trim() : undefined;
        const rows = (await channelPersistence.listConnections(scopeTuple(scope))).filter(
          (row) => (!provider || row.provider === provider) && (!agentId || row.agentId === agentId),
        );
        return {
          channels: (rows as any[]).map((r) => ({
            ...projectRow(r),
            webhookPath: webhookPathRedacted(r.id),
          })),
        };
      },
    },

    {
      name: "channels.get",
      description:
        "Fetch a single channel connection by `id` (scope-filtered). " +
        "`credentials` + `webhookSecret` are redacted; the returned " +
        "`webhookPath` is a placeholder (secret masked). Cross-scope ids " +
        "return `{ error: 'not_found' }`.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["id"] ?? "").trim();
        if (!id) return { error: "invalid_params", message: "id required" };
        const row = await channelPersistence.loadScopedConnection(scopeTuple(scope), id);
        if (!row) return { error: "not_found", id };
        return { ...projectRow(row), webhookPath: webhookPathRedacted(row.id) };
      },
    },

    {
      name: "channels.update",
      description:
        "Partial-patch a channel connection: `displayName` (string|null), " +
        "`enabled` (boolean), `agentId` (the DEFAULT agent, must belong to " +
        "scope), `agentRouting` (array of `{ match, agentId }` rules to replace " +
        "the routing table | null to clear — same shape + in-scope validation " +
        "as channels.create), `config` (object|null to clear), `credentials` " +
        "(object to re-encrypt|null to clear). Scope-pinned — cross-scope ids " +
        "return `{ error: 'not_found' }`. Returns the updated row with secrets " +
        "redacted (`agentRouting` shown as stored). To rotate the webhook " +
        "secret use channels.rotate_webhook_secret.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: ["string", "null"] },
          enabled: { type: "boolean" },
          agentId: { type: "string" },
          agentRouting: {
            type: ["array", "null"],
            maxItems: 32,
            description:
              "Replace the ordered routing rules (first match wins, else the " +
              "default agentId); null clears the table.",
            items: {
              type: "object",
              required: ["match", "agentId"],
              properties: {
                match: {
                  type: "object",
                  required: ["type"],
                  properties: {
                    type: { type: "string", enum: ["channel", "prefix"] },
                    id: { type: "string", description: "platform channel id (type=channel)" },
                    value: { type: "string", description: "handle prefix (type=prefix)" },
                  },
                  additionalProperties: false,
                },
                agentId: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          config: { type: ["object", "null"] },
          credentials: { type: ["object", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["id"] ?? "").trim();
        const hasCredentials = Object.prototype.hasOwnProperty.call(params, "credentials");
        const agentRoutingKeyPresent = Object.prototype.hasOwnProperty.call(params, "agentRouting");
        const auditArgs: Record<string, unknown> = {
          id,
          ...(Object.prototype.hasOwnProperty.call(params, "displayName")
            ? { displayName: params["displayName"] }
            : {}),
          ...(typeof params["enabled"] === "boolean" ? { enabled: params["enabled"] } : {}),
          ...(typeof params["agentId"] === "string" ? { agentId: params["agentId"] } : {}),
          ...(agentRoutingKeyPresent ? { hasAgentRouting: params["agentRouting"] != null } : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "config")
            ? { hasConfig: isPlainObject(params["config"]) }
            : {}),
          ...(hasCredentials ? { hasCredentials: isPlainObject(params["credentials"]) } : {}),
        };

        if (!id) {
          const err = "id required";
          auditMutation(scope, "channels.update", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }

        const existing = await channelPersistence.loadScopedConnection(scopeTuple(scope), id);
        if (!existing) {
          auditMutation(scope, "channels.update", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }

        const data: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(params, "displayName")) {
          const dn = params["displayName"];
          data.displayName = typeof dn === "string" ? dn.trim() : null;
        }
        if (typeof params["enabled"] === "boolean") data.enabled = params["enabled"];
        if (typeof params["agentId"] === "string") {
          const agentId = params["agentId"].trim();
          if (!agentId) {
            const err = "agentId must be non-empty";
            auditMutation(scope, "channels.update", auditArgs, null, "failed", startedAt, err);
            return { error: "invalid_params", message: err };
          }
          if (!(await agentInScope(scope, agentId))) {
            auditMutation(
              scope,
              "channels.update",
              auditArgs,
              null,
              "failed",
              startedAt,
              "unknown_agent_id",
            );
            return { error: "unknown_agent_id", agentId };
          }
          data.defaultAgentId = agentId;
        }
        if (agentRoutingKeyPresent) {
          const ar = params["agentRouting"];
          if (ar === null) {
            data.agentRouting = []; // explicit clear → default agent only
          } else {
            // array → validate + normalize (rule agentIds checked in-scope,
            // same guard as the default agentId); anything else → error.
            const routing = await validateAgentRouting(prisma, scope, ar);
            if (!routing.ok) {
              auditMutation(
                scope,
                "channels.update",
                auditArgs,
                null,
                "failed",
                startedAt,
                routing.error,
              );
              return { error: routing.error, message: routing.message };
            }
            data.agentRouting = routing.rules;
          }
        }
        if (Object.prototype.hasOwnProperty.call(params, "config")) {
          // Stored inside the channel Credential envelope.
        }
        if (hasCredentials) {
          // object → re-encrypt; null (or anything non-object) → clear.
          // Stored inside the channel Credential envelope.
        }

        const credentialData: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(params, "config")) {
          credentialData.config = isPlainObject(params["config"]) ? params["config"] : null;
        }
        if (hasCredentials) {
          credentialData.credentials = isPlainObject(params["credentials"])
            ? params["credentials"]
            : null;
        }

        if (Object.keys(data).length === 0 && Object.keys(credentialData).length === 0) {
          // No-op patch — return existing without bumping updatedAt.
          const row = await channelPersistence.loadScopedConnection(scopeTuple(scope), id);
          if (!row) {
            // Raced a concurrent delete between the existence check and this
            // refetch — report not_found instead of throwing on the destructure.
            auditMutation(scope, "channels.update", auditArgs, null, "failed", startedAt, "not_found");
            return { error: "not_found", id };
          }
          auditMutation(scope, "channels.update", auditArgs, { id, noop: true }, "success", startedAt);
          return { ...projectRow(row), webhookPath: webhookPathRedacted(id) };
        }

        try {
          const updated = await channelPersistence.updateConnection(
            scopeTuple(scope),
            id,
            data,
            credentialData,
          );
          if (!updated) return { error: "not_found", id };
          evictRuntime(id);
          auditMutation(scope, "channels.update", auditArgs, { id }, "success", startedAt);
          return { ...projectRow(updated), webhookPath: webhookPathRedacted(updated.id) };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channels.update", auditArgs, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },

    {
      name: "channels.delete",
      description:
        "Delete a channel connection by `id` (scope-filtered). Cascades its " +
        "PlatosChannelThread rows. Returns `{ ok, id }`. Cross-scope ids " +
        "return `{ ok: false, error: 'not_found' }`.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["id"] ?? "").trim();
        if (!id) return { error: "invalid_params", message: "id required" };
        const existing = await channelPersistence.loadScopedConnection(scopeTuple(scope), id);
        if (!existing) {
          auditMutation(scope, "channels.delete", { id }, null, "failed", startedAt, "not_found");
          return { ok: false, error: "not_found", id };
        }
        try {
          await channelPersistence.deleteConnection(scopeTuple(scope), id);
          evictRuntime(id);
          const result = { ok: true, id };
          auditMutation(scope, "channels.delete", { id }, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channels.delete", { id }, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },

    {
      name: "channels.rotate_webhook_secret",
      description:
        "Mint a fresh 32-byte hex webhookSecret for a channel connection, " +
        "invalidating the previous inbound URL. Scope-pinned. Returns the row " +
        "(secrets redacted) plus the new plaintext `webhookSecret` and the " +
        "full one-time `webhookPath` " +
        "`/api/v1/channels/inbound/:connectionId/:webhookSecret` — shown " +
        "ONCE. Update the provider's webhook config immediately.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["id"] ?? "").trim();
        if (!id) return { error: "invalid_params", message: "id required" };
        const existing = await channelPersistence.loadScopedConnection(scopeTuple(scope), id);
        if (!existing) {
          auditMutation(
            scope,
            "channels.rotate_webhook_secret",
            { id },
            null,
            "failed",
            startedAt,
            "not_found",
          );
          return { error: "not_found", id };
        }
        const webhookSecret = crypto.randomBytes(32).toString("hex");
        try {
          const updated = await channelPersistence.updateConnection(
            scopeTuple(scope),
            id,
            {},
            { webhookSecret },
          );
          if (!updated) return { error: "not_found", id };
          evictRuntime(id);
          const result = {
            ...projectRow(updated),
            webhookSecret,
            webhookPath: webhookPathFull(updated.id, webhookSecret),
            webhookUrl: webhookUrlFull(updated.id, webhookSecret),
          };
          // Redacted audit — never log the new secret/path.
          auditMutation(
            scope,
            "channels.rotate_webhook_secret",
            { id },
            { id, rotated: true },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(
            scope,
            "channels.rotate_webhook_secret",
            { id },
            null,
            "failed",
            startedAt,
            message,
          );
          return { error: "rotate_failed", message };
        }
      },
    },
  ];
}
