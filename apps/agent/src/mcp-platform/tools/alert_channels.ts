/** Canonical Environment-owned alert-channel MCP tools. */

import { createHmac, randomUUID } from "node:crypto";
import {
  CredentialKind,
  type EnvironmentOperatorAuthorization,
  type OperatorAuthorization,
  type PlatosSecretStore,
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
} from "@platos/tenancy-database";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import {
  describeUrlValidationError,
  fetchWithValidatedRedirects,
  validatePublicUrl,
} from "../../shared/url-validator";
import type { McpToolHandler } from "../mcp-router";
import { ScopedEnvService } from "../../providers/scoped-env.service";
import { sendAlertEmail } from "../../monitoring/alert-email-delivery";

type ChannelType = "EMAIL" | "SLACK" | "WEBHOOK";
const CHANNEL_TYPES = new Set<ChannelType>(["EMAIL", "SLACK", "WEBHOOK"]);
const ALERT_TYPES = new Set([
  "TASK_RUN",
  "TASK_RUN_ATTEMPT",
  "DEPLOYMENT_FAILURE",
  "DEPLOYMENT_SUCCESS",
  "ERROR_GROUP",
  "BUDGET",
]);

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function maskUrlHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return "invalid_url";
  }
}

function publicChannel(row: any): Record<string, unknown> {
  const config = row.configuration ?? {};
  const properties = row.type === "EMAIL"
    ? { email: config.email ?? null }
    : row.type === "SLACK"
      ? {
          channelId: config.slackChannelId ?? null,
          channelName: config.slackChannelName ?? null,
          integrationId: config.integrationId ?? null,
        }
      : {
          url: config.webhookUrl ?? null,
          hasSecret: !!config.credentialId,
          version: config.credentialId ? "credential-v1" : null,
        };
  const latest = row.deliveries?.[0];
  return {
    id: row.id,
    friendlyId: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    alertTypes: row.alertTypes ?? [],
    properties,
    integrationId: config.integrationId ?? null,
    deduplicationKey: row.deduplicationKey ?? null,
    userProvidedDeduplicationKey: row.userProvidedDeduplicationKey ?? false,
    deliveryState: latest
      ? {
          status: latest.status,
          attemptCount: latest.attemptCount,
          deliveredAt: latest.deliveredAt,
          lastErrorCode: latest.lastErrorCode,
          lastErrorMessage: latest.lastErrorMessage,
          lastStatusCode: latest.lastStatusCode,
        }
      : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

const channelInclude = {
  configuration: true,
  deliveries: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      status: true,
      attemptCount: true,
      deliveredAt: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      lastStatusCode: true,
    },
  },
} as const;

export function buildAlertChannelToolHandlers(deps: {
  toolAudit: ToolAuditService;
  prisma: any;
  secretStore: PlatosSecretStore;
}): McpToolHandler[] {
  const { toolAudit, prisma, secretStore } = deps;
  const scopedEnv = new ScopedEnvService(prisma, secretStore);

  function auditMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    error?: string,
  ): void {
    toolAudit.record({
      scope: tuple(scope),
      toolName,
      userId: scope.userId ?? null,
      args,
      result,
      ...(error !== undefined ? { error } : {}),
      status,
      latencyMs: Date.now() - startedAt,
      source: "mcp_platform",
    }).catch(() => undefined);
  }

  return [
    {
      name: "alert_channels.list",
      description:
        "List Environment-owned EMAIL, SLACK, and WEBHOOK alert channels with redacted configuration and latest delivery state.",
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
        const authorization = await authorize(prisma, reqScope, "metadata");
        const rows = await prisma.alertChannel.findMany({
          where: {
            environmentId: authorization.environmentId,
            deletedAt: null,
            ...(typeof params["type"] === "string" ? { type: params["type"] } : {}),
            ...(typeof params["enabled"] === "boolean" ? { enabled: params["enabled"] } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: (params["limit"] as number | undefined) ?? 100,
          include: channelInclude,
        });
        return { channels: rows.map(publicChannel) };
      },
    },
    {
      name: "alert_channels.create",
      macroRecordable: false,
      description:
        "Create an Environment-owned alert channel. Webhook signing secrets are stored as CHANNEL_SECRET Credentials.",
      inputSchema: {
        type: "object",
        required: ["type", "name", "alertTypes", "channel"],
        properties: {
          type: { type: "string", enum: ["EMAIL", "SLACK", "WEBHOOK"] },
          name: { type: "string", minLength: 1, maxLength: 200 },
          alertTypes: { type: "array", minItems: 1, items: { type: "string" } },
          deduplicationKey: { type: "string", maxLength: 200 },
          channel: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const type = String(params["type"]) as ChannelType;
        const name = String(params["name"] ?? "").trim();
        const alertTypes = ((params["alertTypes"] as string[] | undefined) ?? []).filter((v) => ALERT_TYPES.has(v));
        const channel = (params["channel"] as Record<string, unknown> | undefined) ?? {};
        const auditArgs: Record<string, unknown> = {
          type,
          name,
          alertTypeCount: alertTypes.length,
        };
        try {
          if (!CHANNEL_TYPES.has(type)) return { error: "invalid_type" };
          if (!name) return { error: "invalid_name", message: "name is required" };
          if (alertTypes.length === 0) return { error: "invalid_alert_types" };
          const configuration = await validateConfiguration(type, channel);
          if (configuration.webhookUrl) auditArgs["urlHost"] = maskUrlHost(configuration.webhookUrl);
          const authorization = await authorize(prisma, reqScope, "secret:mutate");
          const id = randomUUID();
          const created = await prisma.$transaction(async (tx: any) => {
            let credentialId: string | null = null;
            if (type === "WEBHOOK" || (type === "SLACK" && configuration.secret)) {
              const credential = await secretStore.createInTransaction(tx, {
                authorization,
                name: `alert-channel:${id}`,
                plaintext: configuration.secret!,
                kind: CredentialKind.CHANNEL_SECRET,
              });
              credentialId = credential.id;
            }
            return tx.alertChannel.create({
              data: {
                id,
                environmentId: authorization.environmentId,
                type,
                name,
                alertTypes,
                deduplicationKey: params["deduplicationKey"] as string | undefined,
                userProvidedDeduplicationKey: typeof params["deduplicationKey"] === "string",
                configuration: {
                  create: configData(type, configuration, credentialId),
                },
              },
              include: channelInclude,
            });
          });
          const result = publicChannel(created);
          auditMutation(reqScope, "alert_channels.create", auditArgs, { id: created.id }, "success", startedAt);
          return result;
        } catch (error: any) {
          const message = error?.message ?? error?.code ?? String(error);
          auditMutation(reqScope, "alert_channels.create", auditArgs, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          if (message.startsWith("invalid_")) return { error: message };
          if (message.startsWith("url_blocked:")) return { error: "url_blocked", message: message.slice(12) };
          if (error?.code === "P2002") return { error: "already_exists" };
          return { error: "create_failed", message };
        }
      },
    },
    {
      name: "alert_channels.update",
      macroRecordable: false,
      description:
        "Update an Environment-owned alert channel. Type and ownership are immutable; supplied webhook secrets rotate Credential.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          alertTypes: { type: "array", items: { type: "string" } },
          enabled: { type: "boolean" },
          channel: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        try {
          const authorization = await authorize(prisma, reqScope, "secret:mutate");
          const existing = await prisma.alertChannel.findFirst({
            where: { id, environmentId: authorization.environmentId, deletedAt: null },
            include: { configuration: true },
          });
          if (!existing?.configuration) return { error: "not_found", id };
          const core: Record<string, unknown> = {};
          if (typeof params["name"] === "string") core.name = params["name"].trim();
          if (typeof params["enabled"] === "boolean") core.enabled = params["enabled"];
          if (Array.isArray(params["alertTypes"])) {
            const values = (params["alertTypes"] as string[]).filter((v) => ALERT_TYPES.has(v));
            if (values.length === 0) return { error: "invalid_alert_types" };
            core.alertTypes = values;
          }
          const channelInput = params["channel"] as Record<string, unknown> | undefined;
          const config = channelInput
            ? await validateConfiguration(existing.type, channelInput, true)
            : null;
          if (Object.keys(core).length === 0 && !config) return { error: "no_changes" };
          const updated = await prisma.$transaction(async (tx: any) => {
            const configUpdate: Record<string, unknown> = {};
            if (config) {
              if (existing.type === "EMAIL" && config.email) configUpdate.email = config.email;
              if (existing.type === "SLACK") {
                if (config.channelId) configUpdate.slackChannelId = config.channelId;
                if (config.channelName) configUpdate.slackChannelName = config.channelName;
                if (config.integrationId !== undefined) {
                  configUpdate.integrationId = config.integrationId;
                  configUpdate.integrationProvider = config.integrationId ? "SLACK" : null;
                }
                if (config.secret) {
                  if (existing.configuration.credentialId) {
                    await secretStore.rotateInTransaction(tx, {
                      authorization,
                      credentialId: existing.configuration.credentialId,
                      plaintext: config.secret,
                    });
                  } else {
                    const credential = await secretStore.createInTransaction(tx, {
                      authorization,
                      name: `alert-channel:${id}`,
                      plaintext: config.secret,
                      kind: CredentialKind.CHANNEL_SECRET,
                    });
                    configUpdate.credentialId = credential.id;
                  }
                }
              }
              if (existing.type === "WEBHOOK") {
                if (config.webhookUrl) configUpdate.webhookUrl = config.webhookUrl;
                if (config.secret) {
                  if (!existing.configuration.credentialId) throw new Error("credential_unavailable");
                  await secretStore.rotateInTransaction(tx, {
                    authorization,
                    credentialId: existing.configuration.credentialId,
                    plaintext: config.secret,
                  });
                }
              }
            }
            return tx.alertChannel.update({
              where: { id },
              data: {
                ...core,
                ...(Object.keys(configUpdate).length > 0
                  ? { configuration: { update: configUpdate } }
                  : {}),
              },
              include: channelInclude,
            });
          });
          const result = publicChannel(updated);
          auditMutation(reqScope, "alert_channels.update", { id, type: existing.type }, { id }, "success", startedAt);
          return result;
        } catch (error: any) {
          const message = error?.message ?? error?.code ?? String(error);
          auditMutation(reqScope, "alert_channels.update", { id }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          if (message.startsWith("invalid_")) return { error: message };
          if (message.startsWith("url_blocked:")) return { error: "url_blocked", message: message.slice(12) };
          return { error: "update_failed", message };
        }
      },
    },
    {
      name: "alert_channels.delete",
      description: "Delete an Environment-owned alert channel while retaining its delivery ledger.",
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
        try {
          const authorization = await authorize(prisma, reqScope, "secret:mutate");
          const existing = await prisma.alertChannel.findFirst({
            where: { id, environmentId: authorization.environmentId, deletedAt: null },
            select: {
              id: true,
              type: true,
              name: true,
              configuration: { select: { credentialId: true } },
            },
          });
          if (!existing) return { error: "not_found", id };
          await prisma.$transaction(async (tx: any) => {
            await tx.alertChannel.update({
              where: { id },
              data: {
                enabled: false,
                deletedAt: new Date(),
                deduplicationKey: null,
                userProvidedDeduplicationKey: false,
              },
            });
            const credentialId = existing.configuration?.credentialId;
            if (!credentialId) return;
            await tx.$queryRawUnsafe(
              'SELECT "id" FROM "Credential" WHERE "id" = $1::uuid FOR UPDATE',
              credentialId,
            );
            const remaining = await tx.alertChannelConfiguration.count({
              where: {
                credentialId,
                channel: { deletedAt: null, enabled: true },
              },
            });
            if (remaining === 0) {
              await secretStore.revokeInTransaction(tx, {
                authorization,
                credentialId,
              });
            }
          });
          const result = {
            deleted: true,
            id: existing.id,
            type: existing.type,
            name: existing.name,
          };
          auditMutation(reqScope, "alert_channels.delete", { id, type: existing.type }, result, "success", startedAt);
          return result;
        } catch (error: any) {
          const message = error?.message ?? String(error);
          auditMutation(reqScope, "alert_channels.delete", { id }, null, "failed", startedAt, message);
          if (message === "access_denied") return { error: "access_denied" };
          return { error: "delete_failed", message };
        }
      },
    },
    {
      name: "alert_channels.test",
      description:
        "Send a synthetic test and persist a visible success/failure attempt. Channel credentials are resolved only at dispatch.",
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
        const authorization = await authorize(prisma, reqScope, "secret:mutate");
        const channel = await prisma.alertChannel.findFirst({
          where: {
            id: String(params["id"]),
            environmentId: authorization.environmentId,
            deletedAt: null,
          },
          include: { configuration: true },
        });
        if (!channel?.configuration) return { error: "not_found", id: params["id"] };
        const delivery = await prisma.alertDelivery.create({
          data: {
            environmentId: authorization.environmentId,
            channelId: channel.id,
            kind: "TEST",
            idempotencyKey: `test:${channel.id}:${randomUUID()}`,
          },
        });
        if (!channel.enabled) {
          return finishDelivery(prisma, delivery, channel.type, false, null, "channel_disabled", "Channel is disabled");
        }
        if (channel.type === "EMAIL") {
          const email = channel.configuration.email;
          if (!email) {
            return finishDelivery(
              prisma,
              delivery,
              channel.type,
              false,
              null,
              "missing_configuration",
              "Email configuration is incomplete",
            );
          }
          const emailResult = await sendAlertEmail({
            resolveVariable: (name) => scopedEnv.get(tuple(reqScope), name),
            to: email,
            subject: "Platos alert channel test",
            text: (params["message"] as string | undefined) ?? "Test notification from Platos MCP",
            idempotencyKey: delivery.id,
          });
          return finishDelivery(
            prisma,
            delivery,
            channel.type,
            emailResult.ok,
            emailResult.statusCode,
            emailResult.errorCode,
            emailResult.errorMessage,
          );
        }
        if (channel.type === "SLACK") {
          const credentialId = channel.configuration.credentialId;
          const channelId = channel.configuration.slackChannelId;
          if (!credentialId || !channelId) {
            return finishDelivery(
              prisma,
              delivery,
              channel.type,
              false,
              null,
              "missing_configuration",
              "Slack configuration is incomplete",
            );
          }
          try {
            const runtime = await authorizeEnvironmentRuntime(prisma, {
              actorId: `alert-test:${reqScope.userId}`,
              environmentId: authorization.environmentId,
            });
            const token = await secretStore.readForRuntime({
              authorization: runtime,
              credentialId,
              kind: CredentialKind.CHANNEL_SECRET,
            });
            const response = await fetch("https://slack.com/api/chat.postMessage", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token.reveal()}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                channel: channelId,
                text: (params["message"] as string | undefined) ?? "Test notification from Platos MCP",
                client_msg_id: delivery.id,
              }),
              signal: AbortSignal.timeout(5000),
            });
            const responseBody = (await response.json()) as { ok?: boolean; error?: string };
            return finishDelivery(
              prisma,
              delivery,
              channel.type,
              response.ok && responseBody.ok === true,
              response.status,
              response.ok && responseBody.ok === true ? null : "slack_api_error",
              response.ok && responseBody.ok === true
                ? null
                : (responseBody.error ?? `status ${response.status}`),
            );
          } catch {
            return finishDelivery(
              prisma,
              delivery,
              channel.type,
              false,
              null,
              "slack_fetch_failed",
              "Slack request failed",
            );
          }
        }
        const url = channel.configuration.webhookUrl;
        const credentialId = channel.configuration.credentialId;
        if (!url || !credentialId) {
          return finishDelivery(prisma, delivery, channel.type, false, null, "missing_configuration", "Webhook configuration is incomplete");
        }
        const checked = await validatePublicUrl(url);
        if (!checked.ok) {
          return finishDelivery(
            prisma,
            delivery,
            channel.type,
            false,
            null,
            "url_blocked",
            describeUrlValidationError(checked.error),
          );
        }
        let secret: { reveal(): string };
        try {
          const runtime = await authorizeEnvironmentRuntime(prisma, {
            actorId: `alert-test:${reqScope.userId}`,
            environmentId: authorization.environmentId,
          });
          secret = await secretStore.readForRuntime({
            authorization: runtime,
            credentialId,
            kind: CredentialKind.CHANNEL_SECRET,
          });
        } catch {
          return finishDelivery(
            prisma,
            delivery,
            channel.type,
            false,
            null,
            "credential_unavailable",
            "Webhook credential is unavailable",
          );
        }
        const body = JSON.stringify({
          type: "test",
          message: (params["message"] as string | undefined) ?? "Test notification from Platos MCP",
          channelId: channel.id,
          deliveryId: delivery.id,
          channelName: channel.name,
          sentAt: new Date().toISOString(),
        });
        try {
          const response = await fetchWithValidatedRedirects(url, 3, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": delivery.id,
              "x-trigger-signature-hmacsha256": createHmac("sha256", secret.reveal()).update(body).digest("hex"),
              "x-platos-test": "1",
            },
            body,
            signal: AbortSignal.timeout(5000),
          });
          return finishDelivery(
            prisma,
            delivery,
            channel.type,
            response.ok,
            response.status,
            response.ok ? null : "http_error",
            response.ok ? null : `status ${response.status}`,
          );
        } catch {
          return finishDelivery(prisma, delivery, channel.type, false, null, "fetch_failed", "Webhook request failed");
        }
      },
    },
    {
      name: "alert_channels.get_integration",
      description: "Return safe integration metadata for an Environment-owned channel; credential material is never returned.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const authorization = await authorize(prisma, reqScope, "metadata");
        const channel = await prisma.alertChannel.findFirst({
          where: {
            id: String(params["id"]),
            environmentId: authorization.environmentId,
            deletedAt: null,
          },
          include: { configuration: true },
        });
        if (!channel?.configuration) return { error: "not_found", id: params["id"] };
        const config = channel.configuration;
        if (!config.integrationId) {
          return { linked: false, channelId: channel.id, channelType: channel.type };
        }
        return {
          linked: true,
          channelId: channel.id,
          channelType: channel.type,
          integration: {
            id: config.integrationId,
            friendlyId: config.integrationId,
            provider: config.integrationProvider,
            externalOrganizationId: config.externalOrganizationId,
            hasToken: !!config.credentialId,
            createdAt: config.createdAt,
            updatedAt: config.updatedAt,
            deletedAt: null,
          },
        };
      },
    },
  ];
}

async function authorize(
  prisma: any,
  scope: RequestScope,
  access: "metadata" | "secret:mutate",
): Promise<EnvironmentOperatorAuthorization> {
  if (scope.principal !== "operator" || !scope.userId) throw new Error("access_denied");
  const operator: OperatorAuthorization = {
    sessionId: scope.sessionId || "platos-mcp-alert-channel",
    actorUserId: scope.operatorUserId || scope.userId,
    effectiveUserId: scope.userId,
    email: "",
    expiresAt: new Date(Date.now() + 60_000),
    mfaVerifiedAt: null,
    impersonation: scope.operatorUserId
      ? {
          active: true,
          actorUserId: scope.operatorUserId,
          targetUserId: scope.userId,
        }
      : null,
  };
  try {
    const authorization = await authorizeEnvironmentOperator(prisma, operator, scope.environmentId, access);
    if (
      authorization.organizationId !== scope.organizationId ||
      authorization.projectId !== scope.projectId
    ) throw new Error("access_denied");
    return authorization;
  } catch {
    throw new Error("access_denied");
  }
}

async function validateConfiguration(
  type: ChannelType,
  input: Record<string, unknown>,
  partial = false,
): Promise<{
  email?: string;
  webhookUrl?: string;
  secret?: string;
  channelId?: string;
  channelName?: string;
  integrationId?: string | null;
}> {
  if (type === "EMAIL") {
    if (partial && input["email"] === undefined) return {};
    const email = String(input["email"] ?? "").trim();
    if (!email.includes("@")) throw new Error("invalid_email");
    return { email };
  }
  if (type === "SLACK") {
    const channelId = input["channelId"] === undefined ? undefined : String(input["channelId"]).trim();
    const channelName = input["channelName"] === undefined ? undefined : String(input["channelName"]).trim();
    if (!partial && (!channelId || !channelName)) throw new Error("invalid_slack_payload");
    if ((channelId !== undefined && !channelId) || (channelName !== undefined && !channelName)) {
      throw new Error("invalid_slack_payload");
    }
    return {
      ...(channelId !== undefined ? { channelId } : {}),
      ...(channelName !== undefined ? { channelName } : {}),
      ...(input["integrationId"] !== undefined
        ? { integrationId: input["integrationId"] ? String(input["integrationId"]) : null }
        : {}),
      ...(typeof input["token"] === "string" && input["token"].length > 0
        ? { secret: input["token"] }
        : {}),
    };
  }
  const webhookUrl = input["url"] === undefined ? undefined : String(input["url"]);
  if (!partial && !webhookUrl) throw new Error("invalid_url");
  const secret = input["secret"] === undefined ? undefined : String(input["secret"]);
  if (!partial && !secret) throw new Error("invalid_webhook_secret");
  if (secret !== undefined && !secret) throw new Error("invalid_webhook_secret");
  if (webhookUrl) {
    const checked = await validatePublicUrl(webhookUrl);
    if (!checked.ok) throw new Error(`url_blocked:${describeUrlValidationError(checked.error)}`);
  }
  return {
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(secret ? { secret } : {}),
  };
}

function configData(
  type: ChannelType,
  config: Awaited<ReturnType<typeof validateConfiguration>>,
  credentialId: string | null,
) {
  if (type === "EMAIL") return { email: config.email };
  if (type === "SLACK") {
    return {
      slackChannelId: config.channelId,
      slackChannelName: config.channelName,
      integrationId: config.integrationId ?? null,
      integrationProvider: config.integrationId ? "SLACK" : null,
      credentialId,
    };
  }
  return { webhookUrl: config.webhookUrl, credentialId };
}

async function finishDelivery(
  prisma: any,
  delivery: { id: string; environmentId: string },
  type: ChannelType,
  ok: boolean,
  statusCode: number | null,
  errorCode: string | null,
  errorMessage: string | null,
) {
  const finishedAt = new Date();
  const updated = await prisma.$transaction(async (tx: any) => {
    const current = await tx.alertDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { attemptCount: true },
    });
    const attemptNumber = current.attemptCount + 1;
    await tx.alertDeliveryAttempt.create({
      data: {
        environmentId: delivery.environmentId,
        deliveryId: delivery.id,
        attemptNumber,
        status: ok ? "SUCCEEDED" : "FAILED",
        responseStatus: statusCode,
        errorCode,
        errorMessage,
        finishedAt,
      },
    });
    return tx.alertDelivery.update({
      where: { id: delivery.id },
      data: {
        status: ok ? "SUCCEEDED" : "FAILED",
        attemptCount: attemptNumber,
        lastAttemptAt: finishedAt,
        deliveredAt: ok ? finishedAt : null,
        lastStatusCode: statusCode,
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
      },
      select: {
        id: true,
        status: true,
        attemptCount: true,
        deliveredAt: true,
        lastStatusCode: true,
        lastErrorCode: true,
        lastErrorMessage: true,
      },
    });
  });
  return {
    ok,
    supported: true,
    status: statusCode,
    type,
    delivery: updated,
    ...(errorCode ? { error: errorCode, message: errorMessage } : {}),
  };
}
