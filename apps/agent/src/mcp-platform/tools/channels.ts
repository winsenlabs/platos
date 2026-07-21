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
import type { MessageCryptoService } from "../../monitoring/message-crypto.service";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";

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

/** The full one-time webhook path (embeds the secret) — create + rotate only. */
function webhookPathFull(connectionId: string, webhookSecret: string): string {
  return `${WEBHOOK_BASE}/${connectionId}/${webhookSecret}`;
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
  const { credentials, webhookSecret, ...rest } = row;
  void webhookSecret;
  return { ...rest, hasCredentials: credentials != null };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function buildChannelToolHandlers(deps: {
  prisma: any;
  messageCrypto: MessageCryptoService;
  toolAudit: ToolAuditService;
}): McpToolHandler[] {
  const { prisma, messageCrypto, toolAudit } = deps;

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
    const agent = await prisma.platosAgent.findFirst({
      where: { id: agentId, ...scopeTuple(scope) },
      select: { id: true },
    });
    return !!agent;
  }

  /** Encrypt a credentials object into the stored envelope, or null to clear. */
  function encryptCredentials(raw: unknown): string | null {
    if (!isPlainObject(raw)) return null;
    return JSON.stringify(messageCrypto.encryptJsonField(raw));
  }

  return [
    {
      name: "channels.create",
      description:
        "Create a messaging-channel doorway bound to ONE agent. `provider` " +
        "is one of slack | telegram | whatsapp | discord. `agentId` must " +
        "belong to the token's scope (forged ids are rejected). Optional " +
        "`credentials` (object) is stored ENCRYPTED at rest and never " +
        "returned — put ALL secret material there (bot tokens, signing " +
        "secrets, webhook verify tokens); optional `config` (object) is " +
        "returned UNREDACTED, so it must hold only non-secret extras (slack " +
        "team_id, whatsapp phoneNumberId…). A 32-byte hex " +
        "webhookSecret is minted server-side. Returns the row (credentials + " +
        "webhookSecret redacted) plus the full one-time inbound `webhookPath` " +
        "`/api/v1/channels/inbound/:connectionId/:webhookSecret` and the " +
        "plaintext `webhookSecret` — shown ONCE, store it now.",
      inputSchema: {
        type: "object",
        required: ["provider", "agentId"],
        properties: {
          provider: { type: "string", enum: ["slack", "telegram", "whatsapp", "discord"] },
          agentId: { type: "string" },
          displayName: { type: "string" },
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
        const encryptedCreds = encryptCredentials(params["credentials"]);

        // Redacted audit args — never echo credentials.
        const auditArgs = {
          provider,
          agentId,
          displayName,
          hasCredentials: encryptedCreds !== null,
          hasConfig: configJson !== undefined,
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

        const webhookSecret = crypto.randomBytes(32).toString("hex");
        try {
          const row = await prisma.platosChannelConnection.create({
            data: {
              ...scopeTuple(scope),
              provider,
              agentId,
              ...(displayName !== undefined ? { displayName } : {}),
              ...(encryptedCreds !== null ? { credentials: encryptedCreds } : {}),
              ...(configJson !== undefined ? { config: configJson } : {}),
              webhookSecret,
            },
          });
          const result = {
            ...projectRow(row),
            webhookSecret,
            webhookPath: webhookPathFull(row.id, webhookSecret),
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
        const rows = await prisma.platosChannelConnection.findMany({
          where: {
            ...scopeTuple(scope),
            ...(provider ? { provider } : {}),
            ...(agentId ? { agentId } : {}),
          },
          orderBy: { createdAt: "desc" },
        });
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
        const row = await prisma.platosChannelConnection.findFirst({
          where: { id, ...scopeTuple(scope) },
        });
        if (!row) return { error: "not_found", id };
        return { ...projectRow(row), webhookPath: webhookPathRedacted(row.id) };
      },
    },

    {
      name: "channels.update",
      description:
        "Partial-patch a channel connection: `displayName` (string|null), " +
        "`enabled` (boolean), `agentId` (must belong to scope), `config` " +
        "(object|null to clear), `credentials` (object to re-encrypt|null to " +
        "clear). Scope-pinned — cross-scope ids return `{ error: " +
        "'not_found' }`. Returns the updated row with secrets redacted. To " +
        "rotate the webhook secret use channels.rotate_webhook_secret.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: ["string", "null"] },
          enabled: { type: "boolean" },
          agentId: { type: "string" },
          config: { type: ["object", "null"] },
          credentials: { type: ["object", "null"] },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const id = String(params["id"] ?? "").trim();
        const hasCredentials = Object.prototype.hasOwnProperty.call(params, "credentials");
        const auditArgs: Record<string, unknown> = {
          id,
          ...(Object.prototype.hasOwnProperty.call(params, "displayName")
            ? { displayName: params["displayName"] }
            : {}),
          ...(typeof params["enabled"] === "boolean" ? { enabled: params["enabled"] } : {}),
          ...(typeof params["agentId"] === "string" ? { agentId: params["agentId"] } : {}),
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

        const existing = await prisma.platosChannelConnection.findFirst({
          where: { id, ...scopeTuple(scope) },
          select: { id: true },
        });
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
          data.agentId = agentId;
        }
        if (Object.prototype.hasOwnProperty.call(params, "config")) {
          data.config = isPlainObject(params["config"]) ? params["config"] : null;
        }
        if (hasCredentials) {
          // object → re-encrypt; null (or anything non-object) → clear.
          data.credentials = encryptCredentials(params["credentials"]);
        }

        if (Object.keys(data).length === 0) {
          // No-op patch — return existing without bumping updatedAt.
          const row = await prisma.platosChannelConnection.findFirst({
            where: { id, ...scopeTuple(scope) },
          });
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
          const updated = await prisma.platosChannelConnection.update({
            where: { id },
            data,
          });
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
        const existing = await prisma.platosChannelConnection.findFirst({
          where: { id, ...scopeTuple(scope) },
          select: { id: true },
        });
        if (!existing) {
          auditMutation(scope, "channels.delete", { id }, null, "failed", startedAt, "not_found");
          return { ok: false, error: "not_found", id };
        }
        try {
          await prisma.platosChannelConnection.delete({ where: { id } });
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
        const existing = await prisma.platosChannelConnection.findFirst({
          where: { id, ...scopeTuple(scope) },
          select: { id: true },
        });
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
          const updated = await prisma.platosChannelConnection.update({
            where: { id },
            data: { webhookSecret },
          });
          const result = {
            ...projectRow(updated),
            webhookSecret,
            webhookPath: webhookPathFull(updated.id, webhookSecret),
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
