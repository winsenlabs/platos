/**
 * Connect v3 — channel_apps.* platform MCP tools.
 *
 * A PlatosChannelApp is a publishable Slack app (one clientId / clientSecret /
 * signingSecret) OWNED by the token's scope and OAuth-installed into N external
 * workspaces (PlatosChannelInstallation rows). These tools are the management
 * surface over that model — create / list / get / update / delete the app +
 * list / bind / import / revoke / status its installations. The OAuth
 * install/callback + per-app events webhook that receive Slack traffic are
 * SEPARATE runtime slices.
 *
 * `import_installation` is the OPERATOR-driven twin of the OAuth callback's
 * persistence: it registers an install from an operator-supplied bot token
 * (manually-created app / migration) WITHOUT the browser OAuth dance, encrypting
 * the token with the SAME envelope and upserting on the SAME nullable
 * (appId, teamId, enterpriseId) tuple (idempotent). `installations_status` is
 * the operator lifecycle-visibility surface; `revoke_installation` is the MCP
 * mirror of the REST soft-revoke.
 *
 * Contract, mirroring `channels.ts`:
 *   - Scope is ALWAYS taken from the verified MCP token, never the LLM args.
 *   - `defaultAgentId` + every `agentRouting` rule agentId is validated against
 *     the scope (forged ids rejected), same guard as channels.*.
 *   - `clientSecret` + `signingSecret` are stored ENCRYPTED via the SAME
 *     MessageCryptoService envelope (`encryptJsonField` → `JSON.stringify`) and
 *     are NEVER returned; `hasClientSecret` / `hasSigningSecret` booleans say
 *     whether they're set. Install bot tokens live on the installation rows and
 *     are likewise redacted (`hasBotToken`). `clientId` is public and returned.
 *   - Mutations are audit-logged (fire-and-forget) with secrets redacted.
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { MessageCryptoService } from "../../monitoring/message-crypto.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import { validateAgentRouting } from "../../agent-runtime/channel-routing";

const APP_PROVIDERS = new Set(["slack"]);
const DISTRIBUTIONS = new Set(["private", "public"]);
// Connect v3 (Phase C) — hosted account-linking policy.
const LINKING = new Set(["none", "optional", "required"]);
const OAUTH_BASE = "/api/v1/channels/oauth";

function scopeTuple(scope: RequestScope) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
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

/** The "Add to Slack" install URL when a public origin is configured, else null. */
function installUrl(appId: string): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}${OAUTH_BASE}/${appId}/install` : null;
}

/** Project an app row — strip the two secret columns, surface set-booleans. */
function projectApp(row: any) {
  const { clientSecret, signingSecret, ...rest } = row;
  void clientSecret;
  void signingSecret;
  return {
    ...rest,
    hasClientSecret: clientSecret != null,
    hasSigningSecret: signingSecret != null,
  };
}

/** Project an installation row — strip the secret columns, surface set-booleans. */
function projectInstallation(row: any) {
  const { botToken, refreshToken, ...rest } = row;
  void botToken;
  void refreshToken;
  return {
    ...rest,
    hasBotToken: botToken != null,
    hasRefreshToken: refreshToken != null,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeScopes(raw: unknown): string[] | undefined {
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

export function buildChannelAppToolHandlers(deps: {
  prisma: any;
  messageCrypto: MessageCryptoService;
  toolAudit: ToolAuditService;
  /**
   * Evict the channels RUNTIME's cached decrypted bot token(s) for an app
   * after update / delete / revoke_installation — otherwise a rotated app
   * credential or a revoked workspace keeps posting from the token cache for
   * up to the runtime's 10-min TTL. Wired by McpPlatformController via lazy
   * ModuleRef resolution. Optional + best-effort.
   */
  invalidateApp?: (appId: string) => void;
}): McpToolHandler[] {
  const { prisma, messageCrypto, toolAudit } = deps;

  /** Best-effort runtime-cache eviction — never fails the mutation. */
  function evictApp(appId: string): void {
    try {
      deps.invalidateApp?.(appId);
    } catch {
      // TTL bounds staleness if eviction wiring is absent/broken.
    }
  }

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

  /** Forged-id guard — the agent must belong to this exact scope. */
  async function agentInScope(scope: RequestScope, agentId: string): Promise<boolean> {
    const agent = await prisma.platosAgent.findFirst({
      where: { id: agentId, ...scopeTuple(scope) },
      select: { id: true },
    });
    return !!agent;
  }

  /** Encrypt a single secret string into the stored envelope. */
  function encryptSecret(plain: string): string {
    return JSON.stringify(messageCrypto.encryptJsonField(plain));
  }

  /**
   * Compact operator status view of an install row — mirrors the REST
   * installationStatusView. `app` supplies the app-level fallback so
   * `agentBinding.source` / `effectiveAgentId` reflect the SAME resolution
   * handleAppEvent performs. Never leaks the bot token.
   */
  function projectInstallationStatus(row: any, app: any) {
    const overrideAgentId =
      typeof row?.agentId === "string" && row.agentId ? row.agentId : null;
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
        hasRoutingOverride: row.agentRouting != null,
      },
    };
  }

  /**
   * Explicit find-then-write "upsert" on the nullable (appId, teamId,
   * enterpriseId) tuple — the SAME contract the OAuth callback uses. NOT
   * prisma.upsert: NULLs are DISTINCT in a Postgres unique index, so an
   * ON CONFLICT upsert would duplicate-insert on re-import of a normal
   * workspace; findFirst with `teamId: null` compiles to `IS NULL`.
   */
  async function importUpsert(
    appId: string,
    teamId: string | null,
    enterpriseId: string | null,
    data: Record<string, unknown>,
  ): Promise<any> {
    const existing = await prisma.platosChannelInstallation.findFirst({
      where: { appId, teamId, enterpriseId },
      select: { id: true },
    });
    if (existing) {
      return prisma.platosChannelInstallation.update({ where: { id: existing.id }, data });
    }
    return prisma.platosChannelInstallation.create({
      data: { appId, teamId, enterpriseId, ...data },
    });
  }

  return [
    {
      name: "channel_apps.create",
      description:
        "Create a publishable channel APP (marketplace-grade Slack app that " +
        "installs into external workspaces via OAuth). `provider` is `slack` " +
        "(v1). Required: `clientId` (public), `clientSecret` + `signingSecret` " +
        "(both stored ENCRYPTED at rest and NEVER returned). Optional " +
        "`scopes` (string[] — Slack OAuth scopes requested at install), " +
        "`distribution` (private|public, default private), `aiAppsSurface` " +
        "(bool, default true), `defaultAgentId` (fallback agent for new " +
        "installs — validated in-scope), `agentRouting` (ordered `{match, " +
        "agentId}` rules, same shape + in-scope validation as channels.*). " +
        "RECOMMENDED Slack `scopes` for the AI-Apps surface: `assistant:write` " +
        "(assistant.threads.setTitle/setStatus/setSuggestedPrompts), " +
        "`im:history` (read DMs in the assistant thread), `chat:write` (post " +
        "replies — also clears the thinking status; since 2026-03-05 " +
        "setStatus accepts chat:write too, but the other assistant.threads.* " +
        "methods still need assistant:write, so request BOTH), and " +
        "`app_mentions:read` (mention-bot fallback). Also enable the app's " +
        "\"Agents & AI Apps\" toggle in the Slack app config so the split-view " +
        "assistant panel + assistant_thread_started events are delivered. " +
        "`linking` (none|optional|required, default none) sets the hosted " +
        "account-linking policy: `optional` surfaces a \"Connect your account\" " +
        "URL when a user types link/connect (and honours unlink); `required` " +
        "additionally WITHHOLDS an unlinked user's turns until they complete " +
        "Sign in with Slack (attaching a verified email identity to the same " +
        "person). SIWS reuses this app's Slack client credentials, so register " +
        "the extra OIDC redirect URL " +
        "`<publicOrigin>/api/v1/channels/link/callback` in the Slack app's " +
        "Redirect URLs. Returns the app row (secrets redacted → " +
        "`hasClientSecret` / `hasSigningSecret`) plus `installUrl` — the " +
        "Add-to-Slack href.",
      inputSchema: {
        type: "object",
        required: ["clientId", "clientSecret", "signingSecret"],
        properties: {
          provider: { type: "string", enum: ["slack"] },
          displayName: { type: "string" },
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          signingSecret: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          distribution: { type: "string", enum: ["private", "public"] },
          aiAppsSurface: { type: "boolean" },
          linking: {
            type: "string",
            enum: ["none", "optional", "required"],
            description:
              "Hosted account-linking policy (default none). required also needs " +
              "<publicOrigin>/api/v1/channels/link/callback in the Slack app's Redirect URLs.",
          },
          defaultAgentId: { type: "string" },
          agentRouting: {
            type: "array",
            maxItems: 32,
            description:
              "Ordered routing rules; first match wins, else defaultAgentId.",
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
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const provider = String(params["provider"] ?? "slack").trim().toLowerCase();
        const clientId = String(params["clientId"] ?? "").trim();
        const clientSecret = String(params["clientSecret"] ?? "").trim();
        const signingSecret = String(params["signingSecret"] ?? "").trim();
        const displayName =
          typeof params["displayName"] === "string" ? params["displayName"].trim() : undefined;
        const scopes = normalizeScopes(params["scopes"]);
        const distribution = params["distribution"]
          ? String(params["distribution"]).trim().toLowerCase()
          : "private";
        const aiAppsSurface =
          typeof params["aiAppsSurface"] === "boolean" ? params["aiAppsSurface"] : undefined;
        const linking =
          params["linking"] !== undefined
            ? String(params["linking"]).trim().toLowerCase()
            : undefined;
        const defaultAgentId =
          typeof params["defaultAgentId"] === "string" ? params["defaultAgentId"].trim() : "";
        const routingProvided =
          params["agentRouting"] !== undefined && params["agentRouting"] !== null;

        // Redacted audit args — NEVER echo the two secrets.
        const auditArgs = {
          provider,
          clientId,
          displayName,
          distribution,
          ...(linking !== undefined ? { linking } : {}),
          hasClientSecret: !!clientSecret,
          hasSigningSecret: !!signingSecret,
          scopeCount: scopes?.length ?? 0,
          defaultAgentId: defaultAgentId || undefined,
          hasAgentRouting: routingProvided,
        };

        if (!APP_PROVIDERS.has(provider)) {
          const err = "provider must be slack (v1)";
          auditMutation(scope, "channel_apps.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_provider", message: err };
        }
        if (!clientId || !clientSecret || !signingSecret) {
          const err = "clientId, clientSecret and signingSecret are required";
          auditMutation(scope, "channel_apps.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!DISTRIBUTIONS.has(distribution)) {
          const err = "distribution must be private | public";
          auditMutation(scope, "channel_apps.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (linking !== undefined && !LINKING.has(linking)) {
          const err = "linking must be none | optional | required";
          auditMutation(scope, "channel_apps.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (defaultAgentId && !(await agentInScope(scope, defaultAgentId))) {
          auditMutation(
            scope,
            "channel_apps.create",
            auditArgs,
            null,
            "failed",
            startedAt,
            "unknown_agent_id",
          );
          return { error: "unknown_agent_id", agentId: defaultAgentId };
        }

        let agentRoutingData: unknown | undefined;
        if (routingProvided) {
          const routing = await validateAgentRouting(prisma, scope, params["agentRouting"]);
          if (!routing.ok) {
            auditMutation(
              scope,
              "channel_apps.create",
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

        try {
          const row = await prisma.platosChannelApp.create({
            data: {
              ...scopeTuple(scope),
              provider,
              clientId,
              clientSecret: encryptSecret(clientSecret),
              signingSecret: encryptSecret(signingSecret),
              distribution,
              ...(displayName !== undefined ? { displayName } : {}),
              ...(scopes !== undefined ? { scopes } : {}),
              ...(aiAppsSurface !== undefined ? { aiAppsSurface } : {}),
              ...(linking !== undefined ? { linking } : {}),
              ...(defaultAgentId ? { defaultAgentId } : {}),
              ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
            },
          });
          const result = { ...projectApp(row), installUrl: installUrl(row.id) };
          auditMutation(
            scope,
            "channel_apps.create",
            auditArgs,
            { id: row.id, provider, clientId },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channel_apps.create", auditArgs, null, "failed", startedAt, message);
          return { error: "create_failed", message };
        }
      },
    },

    {
      name: "channel_apps.list",
      description:
        "List channel apps in the token's scope, newest first. `clientSecret` " +
        "+ `signingSecret` are redacted (`hasClientSecret` / `hasSigningSecret` " +
        "booleans). Each row carries its Add-to-Slack `installUrl`.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["slack"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const provider =
          typeof params["provider"] === "string" ? params["provider"].trim().toLowerCase() : undefined;
        const rows = await prisma.platosChannelApp.findMany({
          where: { ...scopeTuple(scope), ...(provider ? { provider } : {}) },
          orderBy: { createdAt: "desc" },
        });
        return {
          apps: (rows as any[]).map((r) => ({ ...projectApp(r), installUrl: installUrl(r.id) })),
        };
      },
    },

    {
      name: "channel_apps.get",
      description:
        "Fetch a single channel app by `id` (scope-filtered). Secrets redacted; " +
        "`installUrl` included. Cross-scope ids return `{ error: 'not_found' }`.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["id"] ?? "").trim();
        if (!id) return { error: "invalid_params", message: "id required" };
        const row = await prisma.platosChannelApp.findFirst({
          where: { id, ...scopeTuple(scope) },
        });
        if (!row) return { error: "not_found", id };
        return { ...projectApp(row), installUrl: installUrl(row.id) };
      },
    },

    {
      name: "channel_apps.update",
      description:
        "Partial-patch a channel app: `displayName` (string|null), `clientId` " +
        "(string), `clientSecret` / `signingSecret` (re-encrypt; omit to keep " +
        "the current value), `scopes` (string[] — for the AI-Apps surface " +
        "recommend `assistant:write` + `im:history` + `chat:write` + " +
        "`app_mentions:read`, and enable the app's \"Agents & AI Apps\" " +
        "toggle), `distribution` (private|public), `aiAppsSurface` (bool), " +
        "`linking` (none|optional|required — the hosted account-linking policy; " +
        "`required` withholds unlinked users' turns until they Sign in with " +
        "Slack, and needs <publicOrigin>/api/v1/channels/link/callback in the " +
        "Slack app's Redirect URLs), `defaultAgentId` (string|null to clear — " +
        "validated in-scope), `agentRouting` (array of `{match, agentId}` rules " +
        "| null to clear). Scope-pinned — cross-scope ids return " +
        "`{ error: 'not_found' }`. Returns the updated row with secrets redacted.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: ["string", "null"] },
          clientId: { type: "string" },
          clientSecret: { type: "string" },
          signingSecret: { type: "string" },
          scopes: { type: "array", items: { type: "string" } },
          distribution: { type: "string", enum: ["private", "public"] },
          aiAppsSurface: { type: "boolean" },
          linking: {
            type: "string",
            enum: ["none", "optional", "required"],
            description:
              "Hosted account-linking policy. required also needs " +
              "<publicOrigin>/api/v1/channels/link/callback in the Slack app's Redirect URLs.",
          },
          defaultAgentId: { type: ["string", "null"] },
          agentRouting: {
            type: ["array", "null"],
            maxItems: 32,
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
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["id"] ?? "").trim();
        const hasClientSecret =
          typeof params["clientSecret"] === "string" && !!(params["clientSecret"] as string).trim();
        const hasSigningSecret =
          typeof params["signingSecret"] === "string" && !!(params["signingSecret"] as string).trim();
        const auditArgs: Record<string, unknown> = {
          id,
          ...(Object.prototype.hasOwnProperty.call(params, "displayName")
            ? { displayName: params["displayName"] }
            : {}),
          ...(typeof params["clientId"] === "string" ? { clientId: params["clientId"] } : {}),
          ...(hasClientSecret ? { clientSecretRotated: true } : {}),
          ...(hasSigningSecret ? { signingSecretRotated: true } : {}),
          ...(typeof params["distribution"] === "string"
            ? { distribution: params["distribution"] }
            : {}),
          ...(typeof params["aiAppsSurface"] === "boolean"
            ? { aiAppsSurface: params["aiAppsSurface"] }
            : {}),
          ...(typeof params["linking"] === "string"
            ? { linking: params["linking"] }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "defaultAgentId")
            ? { defaultAgentId: params["defaultAgentId"] }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "agentRouting")
            ? { hasAgentRouting: params["agentRouting"] != null }
            : {}),
        };

        if (!id) {
          const err = "id required";
          auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }

        const existing = await prisma.platosChannelApp.findFirst({
          where: { id, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!existing) {
          auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }

        const data: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(params, "displayName")) {
          const dn = params["displayName"];
          data.displayName = typeof dn === "string" ? dn.trim() : null;
        }
        if (typeof params["clientId"] === "string") {
          const clientId = params["clientId"].trim();
          if (!clientId) {
            const err = "clientId must be non-empty";
            auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, err);
            return { error: "invalid_params", message: err };
          }
          data.clientId = clientId;
        }
        if (hasClientSecret) {
          data.clientSecret = encryptSecret((params["clientSecret"] as string).trim());
        }
        if (hasSigningSecret) {
          data.signingSecret = encryptSecret((params["signingSecret"] as string).trim());
        }
        if (Object.prototype.hasOwnProperty.call(params, "scopes")) {
          const scopes = normalizeScopes(params["scopes"]);
          if (scopes !== undefined) data.scopes = scopes;
        }
        if (typeof params["distribution"] === "string") {
          const distribution = params["distribution"].trim().toLowerCase();
          if (!DISTRIBUTIONS.has(distribution)) {
            const err = "distribution must be private | public";
            auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, err);
            return { error: "invalid_params", message: err };
          }
          data.distribution = distribution;
        }
        if (typeof params["aiAppsSurface"] === "boolean") {
          data.aiAppsSurface = params["aiAppsSurface"];
        }
        if (typeof params["linking"] === "string") {
          const linking = params["linking"].trim().toLowerCase();
          if (!LINKING.has(linking)) {
            const err = "linking must be none | optional | required";
            auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, err);
            return { error: "invalid_params", message: err };
          }
          data.linking = linking;
        }
        if (Object.prototype.hasOwnProperty.call(params, "defaultAgentId")) {
          const raw = params["defaultAgentId"];
          if (raw === null || raw === "") {
            data.defaultAgentId = null;
          } else if (typeof raw === "string") {
            const defaultAgentId = raw.trim();
            if (!(await agentInScope(scope, defaultAgentId))) {
              auditMutation(
                scope,
                "channel_apps.update",
                auditArgs,
                null,
                "failed",
                startedAt,
                "unknown_agent_id",
              );
              return { error: "unknown_agent_id", agentId: defaultAgentId };
            }
            data.defaultAgentId = defaultAgentId;
          }
        }
        if (Object.prototype.hasOwnProperty.call(params, "agentRouting")) {
          const ar = params["agentRouting"];
          if (ar === null) {
            data.agentRouting = null;
          } else {
            const routing = await validateAgentRouting(prisma, scope, ar);
            if (!routing.ok) {
              auditMutation(
                scope,
                "channel_apps.update",
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

        if (Object.keys(data).length === 0) {
          const row = await prisma.platosChannelApp.findFirst({
            where: { id, ...scopeTuple(scope) },
          });
          if (!row) {
            auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, "not_found");
            return { error: "not_found", id };
          }
          auditMutation(scope, "channel_apps.update", auditArgs, { id, noop: true }, "success", startedAt);
          return { ...projectApp(row), installUrl: installUrl(row.id) };
        }

        try {
          const updated = await prisma.platosChannelApp.update({ where: { id }, data });
          evictApp(id);
          auditMutation(scope, "channel_apps.update", auditArgs, { id }, "success", startedAt);
          return { ...projectApp(updated), installUrl: installUrl(updated.id) };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channel_apps.update", auditArgs, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },

    {
      name: "channel_apps.delete",
      description:
        "Delete a channel app by `id` (scope-filtered). Cascades its " +
        "PlatosChannelInstallation + PlatosChannelAppThread rows. Returns " +
        "`{ ok, id }`. Cross-scope ids return `{ ok: false, error: 'not_found' }`.",
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
        const existing = await prisma.platosChannelApp.findFirst({
          where: { id, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!existing) {
          auditMutation(scope, "channel_apps.delete", { id }, null, "failed", startedAt, "not_found");
          return { ok: false, error: "not_found", id };
        }
        try {
          await prisma.platosChannelApp.delete({ where: { id } });
          evictApp(id);
          const result = { ok: true, id };
          auditMutation(scope, "channel_apps.delete", { id }, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channel_apps.delete", { id }, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },

    {
      name: "channel_apps.list_installations",
      description:
        "List the workspace installations of a channel app (`appId`, " +
        "scope-filtered), newest first. Bot tokens are redacted (`hasBotToken`). " +
        "Each row carries teamId / enterpriseId / teamName / botUserId / " +
        "grantedScopes / agentId + agentRouting overrides / status.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: { appId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const appId = String(params["appId"] ?? "").trim();
        if (!appId) return { error: "invalid_params", message: "appId required" };
        const app = await prisma.platosChannelApp.findFirst({
          where: { id: appId, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!app) return { error: "not_found", appId };
        const rows = await prisma.platosChannelInstallation.findMany({
          where: { appId },
          orderBy: { createdAt: "desc" },
        });
        return { installations: (rows as any[]).map((r) => projectInstallation(r)) };
      },
    },

    {
      name: "channel_apps.bind_installation",
      description:
        "Rebind one workspace installation of an app to a different agent / " +
        "routing table (per-workspace override of the app defaults). `appId` + " +
        "`installationId` identify the row; `agentId` (string|null to clear → " +
        "app.defaultAgentId) and/or `agentRouting` (array of `{match, agentId}` " +
        "rules | null to clear → app.agentRouting) are the override. At least " +
        "one must be supplied. Scope-pinned via the parent app.",
      inputSchema: {
        type: "object",
        required: ["appId", "installationId"],
        properties: {
          appId: { type: "string" },
          installationId: { type: "string" },
          agentId: { type: ["string", "null"] },
          agentRouting: {
            type: ["array", "null"],
            maxItems: 32,
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
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const appId = String(params["appId"] ?? "").trim();
        const installationId = String(params["installationId"] ?? "").trim();
        const hasAgentId = Object.prototype.hasOwnProperty.call(params, "agentId");
        const hasAgentRouting = Object.prototype.hasOwnProperty.call(params, "agentRouting");
        const auditArgs: Record<string, unknown> = {
          appId,
          installationId,
          ...(hasAgentId ? { agentId: params["agentId"] } : {}),
          ...(hasAgentRouting ? { hasAgentRouting: params["agentRouting"] != null } : {}),
        };

        if (!appId || !installationId) {
          const err = "appId and installationId required";
          auditMutation(scope, "channel_apps.bind_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!hasAgentId && !hasAgentRouting) {
          const err = "supply at least one of agentId / agentRouting";
          auditMutation(scope, "channel_apps.bind_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "no_op", message: err };
        }

        const app = await prisma.platosChannelApp.findFirst({
          where: { id: appId, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!app) {
          auditMutation(scope, "channel_apps.bind_installation", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", appId };
        }
        const installation = await prisma.platosChannelInstallation.findFirst({
          where: { id: installationId, appId },
          select: { id: true },
        });
        if (!installation) {
          auditMutation(
            scope,
            "channel_apps.bind_installation",
            auditArgs,
            null,
            "failed",
            startedAt,
            "installation_not_found",
          );
          return { error: "installation_not_found", installationId };
        }

        const data: Record<string, unknown> = {};
        if (hasAgentId) {
          const raw = params["agentId"];
          if (raw === null || raw === "") {
            data.agentId = null;
          } else if (typeof raw === "string") {
            const agentId = raw.trim();
            if (!(await agentInScope(scope, agentId))) {
              auditMutation(
                scope,
                "channel_apps.bind_installation",
                auditArgs,
                null,
                "failed",
                startedAt,
                "unknown_agent_id",
              );
              return { error: "unknown_agent_id", agentId };
            }
            data.agentId = agentId;
          }
        }
        if (hasAgentRouting) {
          const ar = params["agentRouting"];
          if (ar === null) {
            data.agentRouting = null;
          } else {
            const routing = await validateAgentRouting(prisma, scope, ar);
            if (!routing.ok) {
              auditMutation(
                scope,
                "channel_apps.bind_installation",
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

        try {
          const updated = await prisma.platosChannelInstallation.update({
            where: { id: installationId },
            data,
          });
          auditMutation(
            scope,
            "channel_apps.bind_installation",
            auditArgs,
            { installationId },
            "success",
            startedAt,
          );
          return projectInstallation(updated);
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channel_apps.bind_installation", auditArgs, null, "failed", startedAt, message);
          return { error: "bind_failed", message };
        }
      },
    },

    {
      name: "channel_apps.import_installation",
      description:
        "Import / register a workspace installation of an app from an " +
        "OPERATOR-supplied bot token — for a manually-created Slack app, or " +
        "migrating an install from elsewhere — WITHOUT the browser OAuth dance. " +
        "`appId` identifies the (in-scope) parent app. Required: `botToken` " +
        "(stored ENCRYPTED via the SAME MessageCryptoService envelope as the " +
        "OAuth callback, NEVER returned) and `teamId` (or `enterpriseId` for a " +
        "Grid org-install). Optional `teamName`, `enterpriseId`, " +
        "`isEnterpriseInstall`, `botUserId`, `grantedScopes` (string[]), " +
        "`installedByUserId`, and `agentId` / `agentRouting` to bind the install " +
        "at import time (same in-scope guards as bind_installation). IDEMPOTENT " +
        "on (appId, teamId, enterpriseId): re-import updates the row in place and " +
        "flips a revoked install back to active. Returns the installation row " +
        "with the bot token redacted (`hasBotToken`).",
      inputSchema: {
        type: "object",
        required: ["appId", "botToken"],
        properties: {
          appId: { type: "string" },
          botToken: { type: "string" },
          teamId: { type: ["string", "null"] },
          enterpriseId: { type: ["string", "null"] },
          isEnterpriseInstall: { type: "boolean" },
          teamName: { type: ["string", "null"] },
          botUserId: { type: ["string", "null"] },
          grantedScopes: { type: "array", items: { type: "string" } },
          installedByUserId: { type: ["string", "null"] },
          agentId: { type: ["string", "null"] },
          agentRouting: {
            type: ["array", "null"],
            maxItems: 32,
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
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const appId = String(params["appId"] ?? "").trim();
        const teamId =
          typeof params["teamId"] === "string" && params["teamId"].trim()
            ? params["teamId"].trim()
            : null;
        const enterpriseId =
          typeof params["enterpriseId"] === "string" && params["enterpriseId"].trim()
            ? params["enterpriseId"].trim()
            : null;
        const isEnterpriseInstall = params["isEnterpriseInstall"] === true;
        const botToken =
          typeof params["botToken"] === "string" ? params["botToken"].trim() : "";
        const hasAgentId = Object.prototype.hasOwnProperty.call(params, "agentId");
        const hasAgentRouting = Object.prototype.hasOwnProperty.call(params, "agentRouting");

        // Redacted audit args — NEVER echo the bot token.
        const auditArgs: Record<string, unknown> = {
          appId,
          teamId,
          enterpriseId,
          isEnterpriseInstall,
          hasBotToken: !!botToken,
          ...(hasAgentId ? { agentId: params["agentId"] } : {}),
          ...(hasAgentRouting ? { hasAgentRouting: params["agentRouting"] != null } : {}),
        };

        if (!appId) {
          const err = "appId required";
          auditMutation(scope, "channel_apps.import_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!botToken) {
          const err = "botToken is required";
          auditMutation(scope, "channel_apps.import_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (!teamId && !enterpriseId) {
          const err = "teamId (or enterpriseId for a Grid org-install) is required";
          auditMutation(scope, "channel_apps.import_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        if (isEnterpriseInstall && !enterpriseId) {
          const err = "enterpriseId is required when isEnterpriseInstall is true";
          auditMutation(scope, "channel_apps.import_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }

        const app = await prisma.platosChannelApp.findFirst({
          where: { id: appId, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!app) {
          auditMutation(scope, "channel_apps.import_installation", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", appId };
        }

        let agentId: string | null | undefined;
        if (hasAgentId) {
          const raw = params["agentId"];
          if (raw === null || raw === "") {
            agentId = null;
          } else if (typeof raw === "string") {
            const trimmed = raw.trim();
            if (!(await agentInScope(scope, trimmed))) {
              auditMutation(
                scope,
                "channel_apps.import_installation",
                auditArgs,
                null,
                "failed",
                startedAt,
                "unknown_agent_id",
              );
              return { error: "unknown_agent_id", agentId: trimmed };
            }
            agentId = trimmed;
          }
        }
        let agentRoutingData: unknown | null | undefined;
        if (hasAgentRouting) {
          const ar = params["agentRouting"];
          if (ar === null) {
            agentRoutingData = null;
          } else {
            const routing = await validateAgentRouting(prisma, scope, ar);
            if (!routing.ok) {
              auditMutation(
                scope,
                "channel_apps.import_installation",
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
        }

        const teamName =
          typeof params["teamName"] === "string" && params["teamName"].trim()
            ? params["teamName"].trim()
            : null;
        const botUserId =
          typeof params["botUserId"] === "string" && params["botUserId"].trim()
            ? params["botUserId"].trim()
            : null;
        const installedByUserId =
          typeof params["installedByUserId"] === "string" && params["installedByUserId"].trim()
            ? params["installedByUserId"].trim()
            : null;
        const grantedScopes = normalizeScopes(params["grantedScopes"]) ?? [];

        // Static operator grant — clear any rotation state a previous OAuth
        // install left behind (refreshToken / tokenExpiresAt): getFreshBotToken
        // keys "this install rotates" off tokenExpiresAt, and a stale expiry
        // would refresh the OLD grant over the freshly imported key.
        const data: Record<string, unknown> = {
          botToken: encryptSecret(botToken),
          refreshToken: null,
          tokenExpiresAt: null,
          isEnterpriseInstall,
          grantedScopes,
          teamName,
          botUserId,
          installedByUserId,
          status: "active",
          revokedAt: null,
          ...(agentId !== undefined ? { agentId } : {}),
          ...(agentRoutingData !== undefined ? { agentRouting: agentRoutingData } : {}),
        };

        try {
          const row = await importUpsert(appId, teamId, enterpriseId, data);
          // Re-keying a live install must evict any cached bot token.
          evictApp(appId);
          auditMutation(
            scope,
            "channel_apps.import_installation",
            auditArgs,
            { installationId: row.id, appId },
            "success",
            startedAt,
          );
          return projectInstallation(row);
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channel_apps.import_installation", auditArgs, null, "failed", startedAt, message);
          return { error: "import_failed", message };
        }
      },
    },

    {
      name: "channel_apps.revoke_installation",
      description:
        "Revoke ONE workspace installation of an app (SOFT — status=revoked, " +
        "revokedAt=now; never hard-deletes, since Slack's uninstall lifecycle is " +
        "order-unstable and the row is the audit trail). `appId` + " +
        "`installationId` identify the row; scope-pinned via the parent app. " +
        "Evicts the cached bot token so the workspace stops receiving replies " +
        "immediately. Returns the updated row (bot token redacted). The MCP " +
        "mirror of REST DELETE :id/installations/:installationId.",
      inputSchema: {
        type: "object",
        required: ["appId", "installationId"],
        properties: {
          appId: { type: "string" },
          installationId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const appId = String(params["appId"] ?? "").trim();
        const installationId = String(params["installationId"] ?? "").trim();
        const auditArgs = { appId, installationId };

        if (!appId || !installationId) {
          const err = "appId and installationId required";
          auditMutation(scope, "channel_apps.revoke_installation", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_params", message: err };
        }
        const app = await prisma.platosChannelApp.findFirst({
          where: { id: appId, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!app) {
          auditMutation(scope, "channel_apps.revoke_installation", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", appId };
        }
        const installation = await prisma.platosChannelInstallation.findFirst({
          where: { id: installationId, appId },
          select: { id: true },
        });
        if (!installation) {
          auditMutation(
            scope,
            "channel_apps.revoke_installation",
            auditArgs,
            null,
            "failed",
            startedAt,
            "installation_not_found",
          );
          return { error: "installation_not_found", installationId };
        }
        try {
          const updated = await prisma.platosChannelInstallation.update({
            where: { id: installationId },
            data: { status: "revoked", revokedAt: new Date() },
          });
          evictApp(appId);
          auditMutation(
            scope,
            "channel_apps.revoke_installation",
            auditArgs,
            { installationId },
            "success",
            startedAt,
          );
          return { revoked: true, ...projectInstallation(updated) };
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(scope, "channel_apps.revoke_installation", auditArgs, null, "failed", startedAt, message);
          return { error: "revoke_failed", message };
        }
      },
    },

    {
      name: "channel_apps.installations_status",
      description:
        "Operator STATUS view of every workspace installation of an app " +
        "(`appId`, scope-filtered), newest first — a compact, lifecycle-focused " +
        "shape per install: `{ installationId, teamId, teamName, enterpriseId, " +
        "isEnterpriseInstall, status, revokedAt, lastEventAt, agentBinding }`. " +
        "Read live off the SAME rows the uninstall / tokens_revoked webhook " +
        "mutates, so an uninstall shows here as status=revoked. `agentBinding` " +
        "reports the resolved agent (installation override → app default) exactly " +
        "as handleAppEvent resolves it. Read-only; never returns bot tokens.",
      inputSchema: {
        type: "object",
        required: ["appId"],
        properties: { appId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const appId = String(params["appId"] ?? "").trim();
        if (!appId) return { error: "invalid_params", message: "appId required" };
        const app = await prisma.platosChannelApp.findFirst({
          where: { id: appId, ...scopeTuple(scope) },
          select: { id: true, defaultAgentId: true },
        });
        if (!app) return { error: "not_found", appId };
        const rows = await prisma.platosChannelInstallation.findMany({
          where: { appId },
          orderBy: { createdAt: "desc" },
        });
        return {
          installations: (rows as any[]).map((r) => projectInstallationStatus(r, app)),
        };
      },
    },
  ];
}
