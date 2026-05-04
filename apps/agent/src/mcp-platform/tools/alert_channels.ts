/**
 * Theme MCPF-W4 — Alert channel management MCP tools (6 tools).
 *
 * Wraps `ProjectAlertChannel` — the trigger.dev failure-notification surface
 * (EMAIL, SLACK, WEBHOOK). Channels are PROJECT-scoped (no environmentId);
 * each channel routes alerts for any matching `environmentTypes` (DEVELOPMENT,
 * STAGING, PRODUCTION) within its project.
 *
 * Tools:
 *   • `alert_channels.list`             — list channels for the scope's project
 *   • `alert_channels.create`           — register an EMAIL/SLACK/WEBHOOK channel (gated)
 *   • `alert_channels.update`           — patch channel config (gated)
 *   • `alert_channels.delete`           — remove a channel (gated)
 *   • `alert_channels.test`             — send a synthetic test (WEBHOOK supported here;
 *                                         SLACK + EMAIL deferred to webapp delivery service)
 *   • `alert_channels.get_integration`  — inspect linked OAuth integration metadata
 *                                         (NEVER returns the access token)
 *
 * Tier-1 require_approval (set in `permission-gateway.service.ts`
 * PLATFORM_TIER_MINIMUMS):
 *   - alert_channels.create
 *   - alert_channels.update
 *   - alert_channels.delete
 *
 * Audit logging: mutations record channel `type` + `name` + masked URL host
 * only. Webhook URLs, Slack channelIds, and access tokens are NEVER echoed
 * into audit rows.
 */

import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { env } from "../../shared/env";
import {
  validatePublicUrl,
  describeUrlValidationError,
} from "../../shared/url-validator";
import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";

type ChannelType = "EMAIL" | "SLACK" | "WEBHOOK";
const CHANNEL_TYPES = new Set<ChannelType>(["EMAIL", "SLACK", "WEBHOOK"]);

const ALERT_TYPES = new Set([
  "TASK_RUN",
  "TASK_RUN_ATTEMPT",
  "DEPLOYMENT_FAILURE",
  "DEPLOYMENT_SUCCESS",
  "ERROR_GROUP",
]);

const ENV_TYPES = new Set(["DEVELOPMENT", "STAGING", "PRODUCTION", "PREVIEW"]);

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

/**
 * Mask a URL to host:port only — never echo the path or query string into
 * audit rows. `https://hooks.slack.com/services/T01/B01/secret` → `hooks.slack.com`.
 */
function maskUrlHost(url: string | undefined | null): string | null {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return "invalid_url";
  }
}

/**
 * Friendly id generator — mirrors `generateFriendlyId("alert_channel")` in
 * the webapp without dragging that dependency into the agent. Format
 * matches existing rows (`alert_channel_<22 chars>`).
 */
function generateFriendlyId(prefix: string): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let suffix = "";
  const buf = randomBytes(22);
  for (let i = 0; i < 22; i++) {
    const byte = buf[i];
    if (typeof byte === "number") {
      suffix += chars[byte % chars.length];
    }
  }
  return `${prefix}_${suffix}`;
}

interface EncryptedSecret {
  nonce: string;
  ciphertext: string;
  tag: string;
}

/**
 * Encrypt a webhook secret using the WEBAPP-SHARED `ENCRYPTION_KEY` (32-byte
 * UTF-8 OR 64-hex-char). Output format matches webapp `encryptSecret` so
 * the deliverAlert webhook path can decrypt later.
 */
function encryptWebhookSecret(plaintext: string): EncryptedSecret | null {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) return null;
  let key: Buffer;
  if (raw.length === 64 && /^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else if (Buffer.from(raw, "utf8").length === 32) {
    key = Buffer.from(raw, "utf8");
  } else {
    return null;
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return {
    nonce: nonce.toString("hex"),
    ciphertext: encrypted,
    tag,
  };
}

/**
 * Public-facing channel shape — the underlying `properties` JSON contains
 * encrypted secrets we never want to leak through MCP. Convert to a safe
 * subset before returning.
 */
function publicChannel(row: Record<string, any>): Record<string, unknown> {
  const props = (row["properties"] as Record<string, any> | null) ?? {};
  let safeProps: Record<string, unknown>;
  switch (row["type"]) {
    case "EMAIL":
      safeProps = { email: props["email"] ?? null };
      break;
    case "SLACK":
      safeProps = {
        channelId: props["channelId"] ?? null,
        channelName: props["channelName"] ?? null,
        integrationId: props["integrationId"] ?? null,
      };
      break;
    case "WEBHOOK":
      safeProps = {
        url: props["url"] ?? null,
        // `secret` is { nonce, ciphertext, tag } — surface presence only,
        // never the encrypted payload itself.
        hasSecret: !!props["secret"],
        version: props["version"] ?? null,
      };
      break;
    default:
      safeProps = {};
  }
  return {
    id: row["id"],
    friendlyId: row["friendlyId"],
    type: row["type"],
    name: row["name"],
    enabled: row["enabled"],
    alertTypes: row["alertTypes"] ?? [],
    environmentTypes: row["environmentTypes"] ?? [],
    properties: safeProps,
    integrationId: row["integrationId"] ?? null,
    deduplicationKey: row["deduplicationKey"] ?? null,
    userProvidedDeduplicationKey: row["userProvidedDeduplicationKey"] ?? false,
    createdAt: row["createdAt"] instanceof Date ? row["createdAt"].toISOString() : row["createdAt"],
    updatedAt: row["updatedAt"] instanceof Date ? row["updatedAt"].toISOString() : row["updatedAt"],
  };
}

export function buildAlertChannelToolHandlers(deps: {
  toolAudit: ToolAuditService;
  prisma: any;
}): McpToolHandler[] {
  const { toolAudit, prisma } = deps;

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
        scope: tuple(scope),
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

  return [
    {
      name: "alert_channels.list",
      description:
        "List `ProjectAlertChannel` rows for the caller's project. " +
        "Channels are project-scoped (one channel routes alerts across " +
        "every environment type listed in `environmentTypes`). Optional " +
        "`type` narrows by EMAIL / SLACK / WEBHOOK; `enabled` filters by " +
        "active status. Webhook secrets + Slack tokens are stripped — " +
        "WEBHOOK rows surface only `url` + `hasSecret`.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["EMAIL", "SLACK", "WEBHOOK"] },
          enabled: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const where: Record<string, unknown> = { projectId: reqScope.projectId };
        if (typeof params["type"] === "string") where["type"] = String(params["type"]);
        if (typeof params["enabled"] === "boolean") where["enabled"] = params["enabled"];
        const limit = (params["limit"] as number | undefined) ?? 100;
        const rows = await prisma.projectAlertChannel.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
        });
        return {
          channels: (rows as Array<Record<string, any>>).map((r) => publicChannel(r)),
        };
      },
    },

    {
      name: "alert_channels.create",
      description:
        "Register a new alert channel scoped to the caller's project. " +
        "Required: `type` (EMAIL|SLACK|WEBHOOK), `name`, `alertTypes` (≥1 " +
        "of TASK_RUN / DEPLOYMENT_FAILURE / DEPLOYMENT_SUCCESS / " +
        "ERROR_GROUP), and `channel` (type-specific config). EMAIL: " +
        "`{ email }`. WEBHOOK: `{ url, secret? }` — secret is encrypted " +
        "with the webapp-shared ENCRYPTION_KEY before persistence; if " +
        "omitted a 32-byte random secret is generated. SLACK: " +
        "`{ channelId, channelName, integrationId? }` (operator must " +
        "have already linked the Slack workspace via the dashboard — this " +
        "tool does NOT initiate OAuth). Optional `environmentTypes` " +
        "default to [STAGING, PRODUCTION]; `deduplicationKey` enables " +
        "idempotent retries. Audit-logged (channel type + name + masked " +
        "URL host — never the webhook URL path or any secret).",
      inputSchema: {
        type: "object",
        required: ["type", "name", "alertTypes", "channel"],
        properties: {
          type: { type: "string", enum: ["EMAIL", "SLACK", "WEBHOOK"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          alertTypes: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              enum: ["TASK_RUN", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS", "ERROR_GROUP"],
            },
          },
          environmentTypes: {
            type: "array",
            items: { type: "string", enum: ["DEVELOPMENT", "STAGING", "PRODUCTION", "PREVIEW"] },
          },
          deduplicationKey: { type: "string", maxLength: 200 },
          channel: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const type = String(params["type"]) as ChannelType;
        const name = String(params["name"]).trim();
        const alertTypes = (params["alertTypes"] as string[]).filter((t) => ALERT_TYPES.has(t));
        const environmentTypes = ((params["environmentTypes"] as string[] | undefined) ?? [
          "STAGING",
          "PRODUCTION",
        ]).filter((t) => ENV_TYPES.has(t));
        const deduplicationKey = params["deduplicationKey"] as string | undefined;
        const channel = (params["channel"] as Record<string, any>) ?? {};

        const auditArgs: Record<string, unknown> = {
          type,
          name,
          alertTypeCount: alertTypes.length,
          environmentTypeCount: environmentTypes.length,
        };

        if (!CHANNEL_TYPES.has(type)) {
          const err = "type must be EMAIL | SLACK | WEBHOOK";
          auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_type", message: err };
        }
        if (!name) {
          auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "name_required");
          return { error: "invalid_name", message: "name is required" };
        }
        if (alertTypes.length === 0) {
          auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "no_alert_types");
          return { error: "invalid_alert_types", message: "alertTypes must include at least one valid type" };
        }

        let properties: Record<string, unknown>;
        let integrationId: string | null = null;
        if (type === "EMAIL") {
          if (typeof channel["email"] !== "string" || !channel["email"].includes("@")) {
            auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "invalid_email");
            return { error: "invalid_email", message: "channel.email is required for EMAIL channels" };
          }
          properties = { email: String(channel["email"]).trim() };
        } else if (type === "WEBHOOK") {
          const url = channel["url"];
          if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
            auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "invalid_url");
            return { error: "invalid_url", message: "channel.url must be an absolute http(s) URL" };
          }
          // SSRF defence — reject URLs that resolve to private/loopback/IMDS
          // ranges or use blocked infra ports. Same guard every other agent
          // fetch path uses (events, budgets, skill-importer, tool-executor).
          // This is a register-time check; `alert_channels.test` re-validates
          // immediately before the actual fetch (DNS-rebinding defence).
          const urlCheck = await validatePublicUrl(url);
          if (!urlCheck.ok) {
            (auditArgs as Record<string, unknown>)["urlHost"] = maskUrlHost(url);
            auditMutation(
              reqScope,
              "alert_channels.create",
              auditArgs,
              null,
              "failed",
              startedAt,
              `url_blocked:${urlCheck.error.kind}`,
            );
            return {
              error: "url_blocked",
              message: `channel.url rejected: ${describeUrlValidationError(urlCheck.error)}`,
            };
          }
          // Secret: operator-supplied OR auto-generated (matches webapp behaviour).
          const plaintext = typeof channel["secret"] === "string" && channel["secret"].length > 0
            ? String(channel["secret"])
            : randomBytes(32).toString("hex");
          const encrypted = encryptWebhookSecret(plaintext);
          if (!encrypted) {
            auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "encryption_unavailable");
            return {
              error: "encryption_unavailable",
              message:
                "ENCRYPTION_KEY is not configured on this agent. Set it (matching the webapp value) to register webhook channels with secrets.",
            };
          }
          properties = { url, secret: encrypted, version: "v2" };
          (auditArgs as Record<string, unknown>)["urlHost"] = maskUrlHost(url);
        } else {
          // SLACK
          if (typeof channel["channelId"] !== "string" || typeof channel["channelName"] !== "string") {
            auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "invalid_slack_payload");
            return { error: "invalid_slack_payload", message: "SLACK channels require channelId + channelName" };
          }
          properties = {
            channelId: String(channel["channelId"]).trim(),
            channelName: String(channel["channelName"]).trim(),
            integrationId: channel["integrationId"] ?? null,
          };
          if (typeof channel["integrationId"] === "string") {
            // Validate the integration belongs to the caller's org.
            const integ = await prisma.organizationIntegration.findFirst({
              where: { id: String(channel["integrationId"]), organizationId: reqScope.organizationId },
              select: { id: true },
            });
            if (!integ) {
              auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, "integration_not_found");
              return {
                error: "integration_not_found",
                message: "channel.integrationId does not match any integration in this organization",
              };
            }
            integrationId = integ.id;
          }
        }

        // Dedup: same key on this project upserts (matches CreateAlertChannelService).
        if (deduplicationKey) {
          const existing = await prisma.projectAlertChannel.findFirst({
            where: { projectId: reqScope.projectId, deduplicationKey },
            select: { id: true },
          });
          if (existing) {
            const updated = await prisma.projectAlertChannel.update({
              where: { id: existing.id },
              data: {
                name,
                type,
                properties,
                alertTypes,
                environmentTypes,
                enabled: true,
                ...(integrationId ? { integrationId } : {}),
              },
            });
            const result = publicChannel(updated as Record<string, any>);
            auditMutation(
              reqScope,
              "alert_channels.create",
              auditArgs,
              { id: updated.id, upserted: true },
              "success",
              startedAt,
            );
            return { ...result, upserted: true };
          }
        }

        try {
          const created = await prisma.projectAlertChannel.create({
            data: {
              friendlyId: generateFriendlyId("alert_channel"),
              projectId: reqScope.projectId,
              name,
              type,
              properties,
              alertTypes,
              environmentTypes,
              enabled: true,
              ...(integrationId ? { integrationId } : {}),
              ...(deduplicationKey
                ? { deduplicationKey, userProvidedDeduplicationKey: true }
                : {}),
            },
          });
          const result = publicChannel(created as Record<string, any>);
          auditMutation(reqScope, "alert_channels.create", auditArgs, { id: created.id }, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, message);
          if (/unique/i.test(message) || err?.code === "P2002") {
            return { error: "already_exists", message: "A channel with this deduplicationKey already exists in the project." };
          }
          return { error: "create_failed", message };
        }
      },
    },

    {
      name: "alert_channels.update",
      description:
        "Patch an existing alert channel by id. Mutable fields: `name`, " +
        "`alertTypes`, `environmentTypes`, `enabled`, and the type-specific " +
        "`channel` payload (matches the create-time shape). The channel " +
        "`type` itself is immutable — delete + recreate to switch (e.g. " +
        "EMAIL → WEBHOOK). Secrets follow the same encryption path as " +
        "create. Returns `{ error: 'not_found' }` for unknown / cross-project " +
        "ids. Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          alertTypes: {
            type: "array",
            items: {
              type: "string",
              enum: ["TASK_RUN", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS", "ERROR_GROUP"],
            },
          },
          environmentTypes: {
            type: "array",
            items: { type: "string", enum: ["DEVELOPMENT", "STAGING", "PRODUCTION", "PREVIEW"] },
          },
          enabled: { type: "boolean" },
          channel: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const auditArgs: Record<string, unknown> = { id };

        const existing = await prisma.projectAlertChannel.findFirst({
          where: { id, projectId: reqScope.projectId },
          select: { id: true, type: true, name: true, properties: true, integrationId: true },
        });
        if (!existing) {
          auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }

        const data: Record<string, unknown> = {};
        if (typeof params["name"] === "string") {
          data["name"] = String(params["name"]).trim();
          (auditArgs as Record<string, unknown>)["name"] = data["name"];
        }
        if (Array.isArray(params["alertTypes"])) {
          const filtered = (params["alertTypes"] as string[]).filter((t) => ALERT_TYPES.has(t));
          if (filtered.length === 0) {
            auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "no_alert_types");
            return { error: "invalid_alert_types", message: "alertTypes must include at least one valid type" };
          }
          data["alertTypes"] = filtered;
        }
        if (Array.isArray(params["environmentTypes"])) {
          data["environmentTypes"] = (params["environmentTypes"] as string[]).filter((t) =>
            ENV_TYPES.has(t),
          );
        }
        if (typeof params["enabled"] === "boolean") data["enabled"] = params["enabled"];

        const channel = params["channel"] as Record<string, any> | undefined;
        if (channel) {
          const t = existing.type as ChannelType;
          (auditArgs as Record<string, unknown>)["channelType"] = t;
          if (t === "EMAIL" && typeof channel["email"] === "string") {
            if (!channel["email"].includes("@")) {
              auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "invalid_email");
              return { error: "invalid_email", message: "channel.email must contain '@'" };
            }
            data["properties"] = { ...(existing.properties as object), email: String(channel["email"]).trim() };
          } else if (t === "WEBHOOK") {
            const merged: Record<string, unknown> = { ...(existing.properties as object) };
            if (typeof channel["url"] === "string") {
              if (!/^https?:\/\//i.test(channel["url"])) {
                auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "invalid_url");
                return { error: "invalid_url", message: "channel.url must be an absolute http(s) URL" };
              }
              // SSRF defence — same guard as `alert_channels.create`. Reject
              // private/loopback/IMDS ranges + blocked infra ports.
              const urlCheck = await validatePublicUrl(channel["url"]);
              if (!urlCheck.ok) {
                (auditArgs as Record<string, unknown>)["urlHost"] = maskUrlHost(channel["url"]);
                auditMutation(
                  reqScope,
                  "alert_channels.update",
                  auditArgs,
                  null,
                  "failed",
                  startedAt,
                  `url_blocked:${urlCheck.error.kind}`,
                );
                return {
                  error: "url_blocked",
                  message: `channel.url rejected: ${describeUrlValidationError(urlCheck.error)}`,
                };
              }
              merged["url"] = channel["url"];
              (auditArgs as Record<string, unknown>)["urlHost"] = maskUrlHost(channel["url"]);
            }
            if (typeof channel["secret"] === "string" && channel["secret"].length > 0) {
              const encrypted = encryptWebhookSecret(String(channel["secret"]));
              if (!encrypted) {
                auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "encryption_unavailable");
                return { error: "encryption_unavailable", message: "ENCRYPTION_KEY missing on agent" };
              }
              merged["secret"] = encrypted;
              merged["version"] = "v2";
            }
            data["properties"] = merged;
          } else if (t === "SLACK") {
            const merged: Record<string, unknown> = { ...(existing.properties as object) };
            if (typeof channel["channelId"] === "string") merged["channelId"] = String(channel["channelId"]).trim();
            if (typeof channel["channelName"] === "string") merged["channelName"] = String(channel["channelName"]).trim();
            if (typeof channel["integrationId"] === "string") {
              const integ = await prisma.organizationIntegration.findFirst({
                where: { id: String(channel["integrationId"]), organizationId: reqScope.organizationId },
                select: { id: true },
              });
              if (!integ) {
                auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "integration_not_found");
                return { error: "integration_not_found", message: "channel.integrationId does not match any org integration" };
              }
              merged["integrationId"] = integ.id;
              data["integrationId"] = integ.id;
            }
            data["properties"] = merged;
          }
        }

        if (Object.keys(data).length === 0) {
          auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, "no_op");
          return { error: "no_changes", message: "supply at least one field to update" };
        }

        try {
          const updated = await prisma.projectAlertChannel.update({ where: { id }, data });
          const result = publicChannel(updated as Record<string, any>);
          auditMutation(reqScope, "alert_channels.update", auditArgs, { id: updated.id }, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "alert_channels.update", auditArgs, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },

    {
      name: "alert_channels.delete",
      description:
        "Remove an alert channel by id. Cascades through " +
        "`ProjectAlert` + `ProjectAlertStorage` rows attached to this " +
        "channel (foreign keys are ON DELETE CASCADE). Returns " +
        "`{ error: 'not_found' }` for unknown / cross-project ids. " +
        "Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const existing = await prisma.projectAlertChannel.findFirst({
          where: { id, projectId: reqScope.projectId },
          select: { id: true, type: true, name: true },
        });
        if (!existing) {
          auditMutation(reqScope, "alert_channels.delete", { id }, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }
        try {
          await prisma.projectAlertChannel.delete({ where: { id } });
          const result = { deleted: true, id, type: existing.type, name: existing.name };
          auditMutation(
            reqScope,
            "alert_channels.delete",
            { id, type: existing.type, name: existing.name },
            result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "alert_channels.delete", { id }, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },

    {
      name: "alert_channels.test",
      description:
        "Send a synthetic test notification to a channel. Currently " +
        "supports WEBHOOK channels — the agent decrypts the channel's " +
        "secret + signs a `{ type: 'test', message }` payload with " +
        "HMAC-SHA-256 + POSTs to the configured URL. EMAIL + SLACK tests " +
        "delegate to the webapp delivery service (returns " +
        "`{ supported: false }` until the webapp ships a test endpoint). " +
        "Returns `{ ok, status, latencyMs, urlHost }`. NEVER echoes the " +
        "webhook URL or secret in the response.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          message: { type: "string", maxLength: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const message = (params["message"] as string | undefined) ?? "Test notification from Platos MCP";

        const channel = await prisma.projectAlertChannel.findFirst({
          where: { id, projectId: reqScope.projectId },
          select: { id: true, type: true, properties: true, name: true, enabled: true },
        });
        if (!channel) return { error: "not_found", id };
        if (!channel.enabled) {
          return { ok: false, supported: true, error: "channel_disabled", message: "Channel is disabled" };
        }

        if (channel.type === "EMAIL") {
          return {
            supported: false,
            type: "EMAIL",
            message:
              "EMAIL test delivery is owned by the webapp's deliverAlert service. " +
              "Use the dashboard 'Send test email' button or trigger a real alert.",
          };
        }
        if (channel.type === "SLACK") {
          return {
            supported: false,
            type: "SLACK",
            message:
              "SLACK test delivery requires the webapp's OAuth integration repository " +
              "(token resolution lives in apps/webapp). Trigger a real alert or use the dashboard.",
          };
        }

        // WEBHOOK path — agent can encrypt + decrypt + POST directly.
        const props = (channel.properties as Record<string, any>) ?? {};
        const url = props["url"] as string | undefined;
        const secret = props["secret"] as EncryptedSecret | undefined;
        const urlHost = maskUrlHost(url ?? null);
        if (!url || !secret) {
          return { ok: false, error: "missing_webhook_config", urlHost };
        }
        // SSRF defence-in-depth — re-validate immediately before fetch even
        // though create/update already validated. Catches DNS rebinding (a
        // public hostname that re-resolves to 169.254.169.254 after admin
        // approval but before the test runs) and rows that may have been
        // written by older code paths predating the create-time check.
        const urlCheck = await validatePublicUrl(url);
        if (!urlCheck.ok) {
          return {
            ok: false,
            error: "url_blocked",
            urlHost,
            message: `webhook URL rejected: ${describeUrlValidationError(urlCheck.error)}`,
          };
        }
        // Decrypt the secret using the same ENCRYPTION_KEY the webapp wrote it with.
        const raw = env.ENCRYPTION_KEY;
        if (!raw) {
          return {
            ok: false,
            error: "encryption_unavailable",
            urlHost,
            message: "ENCRYPTION_KEY not set on agent — cannot decrypt webhook secret",
          };
        }
        let key: Buffer;
        if (raw.length === 64 && /^[0-9a-f]{64}$/i.test(raw)) {
          key = Buffer.from(raw, "hex");
        } else if (Buffer.from(raw, "utf8").length === 32) {
          key = Buffer.from(raw, "utf8");
        } else {
          return { ok: false, error: "encryption_unavailable", urlHost };
        }

        let plaintextSecret: string;
        try {
          const { createDecipheriv } = await import("node:crypto");
          const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.nonce, "hex"));
          decipher.setAuthTag(Buffer.from(secret.tag, "hex"));
          let plain = decipher.update(secret.ciphertext, "hex", "utf8");
          plain += decipher.final("utf8");
          plaintextSecret = plain;
        } catch (err: any) {
          return {
            ok: false,
            error: "decrypt_failed",
            urlHost,
            message: "Failed to decrypt webhook secret — likely an ENCRYPTION_KEY mismatch with the webapp",
          };
        }

        const payload = {
          type: "test",
          message,
          channelId: channel.id,
          channelName: channel.name,
          sentAt: new Date().toISOString(),
        };
        const rawBody = JSON.stringify(payload);
        const signature = createHmac("sha256", plaintextSecret).update(rawBody).digest("hex");

        const start = Date.now();
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Same header name the webapp deliverAlert path emits, so
              // operator-side webhooks already validating the signature
              // will accept this test.
              "x-trigger-signature-hmacsha256": signature,
              "x-platos-test": "1",
            },
            body: rawBody,
            signal: AbortSignal.timeout(5000),
          });
          const latencyMs = Date.now() - start;
          return {
            ok: resp.ok,
            status: resp.status,
            statusText: resp.statusText,
            latencyMs,
            urlHost,
            type: "WEBHOOK",
          };
        } catch (err: any) {
          return {
            ok: false,
            error: "fetch_failed",
            message: err?.message ?? String(err),
            latencyMs: Date.now() - start,
            urlHost,
            type: "WEBHOOK",
          };
        }
      },
    },

    {
      name: "alert_channels.get_integration",
      description:
        "Inspect the OAuth integration linked to a channel (SLACK + " +
        "future Discord etc). Returns `{ provider, externalOrgId, " +
        "integrationId, lastUpdatedAt, hasToken }` — NEVER returns the " +
        "OAuth access token. EMAIL + WEBHOOK channels return " +
        "`{ linked: false }` (they don't carry an OAuth integration). " +
        "Returns `{ error: 'not_found' }` for unknown / cross-project ids.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const channel = await prisma.projectAlertChannel.findFirst({
          where: { id, projectId: reqScope.projectId },
          select: {
            id: true,
            type: true,
            integrationId: true,
            integration: {
              select: {
                id: true,
                friendlyId: true,
                service: true,
                externalOrganizationId: true,
                organizationId: true,
                tokenReferenceId: true,
                createdAt: true,
                updatedAt: true,
                deletedAt: true,
              },
            },
          },
        });
        if (!channel) return { error: "not_found", id };
        if (!channel.integration) {
          return { linked: false, channelId: channel.id, channelType: channel.type };
        }
        const integ = channel.integration as Record<string, any>;
        // Defence-in-depth: confirm the integration belongs to the caller's
        // organization. This SHOULD always be true (channels live in the
        // project's org) but we double-check rather than trust the join.
        if (integ["organizationId"] !== reqScope.organizationId) {
          return { error: "not_found", id };
        }
        return {
          linked: true,
          channelId: channel.id,
          channelType: channel.type,
          integration: {
            id: integ["id"],
            friendlyId: integ["friendlyId"],
            provider: integ["service"],
            externalOrganizationId: integ["externalOrganizationId"],
            // Token presence flag; never the token itself.
            hasToken: !!integ["tokenReferenceId"],
            createdAt: integ["createdAt"] instanceof Date ? integ["createdAt"].toISOString() : integ["createdAt"],
            updatedAt: integ["updatedAt"] instanceof Date ? integ["updatedAt"].toISOString() : integ["updatedAt"],
            deletedAt: integ["deletedAt"]
              ? integ["deletedAt"] instanceof Date
                ? integ["deletedAt"].toISOString()
                : integ["deletedAt"]
              : null,
          },
        };
      },
    },
  ];
}
