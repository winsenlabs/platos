import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import type { ControlDatabaseClient } from "../../shared/database.provider";

const CHANNEL_RE = /^[a-z0-9_-]{1,32}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const MANUAL_ISSUER = "platos:mcp-manual";
const EXTERNAL_ISSUER = "platos:external";
const EXTERNAL_CHANNEL = "external";

function sanitizeChannel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const channel = raw.trim().toLowerCase();
  return CHANNEL_RE.test(channel) ? channel : null;
}

function sanitizeHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const handle = raw.trim();
  return handle.length >= 1 && handle.length <= 256 && !CONTROL_CHAR_RE.test(handle)
    ? handle
    : null;
}

function sanitizeExternalId(raw: unknown): string | null {
  return sanitizeHandle(raw);
}

function scopeTuple(scope: RequestScope) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function currentEnvironmentPresence(environmentId: string) {
  return {
    OR: [
      { threads: { some: { environmentId } } },
      { memories: { some: { environmentId } } },
      { messageAttachments: { some: { environmentId } } },
      { toolCallAudits: { some: { environmentId } } },
      { safetyEvents: { some: { environmentId } } },
    ],
  };
}

function projectIdentity(row: {
  channel: string;
  subject: string;
  verifiedAt: Date | null;
  profile: unknown;
  createdAt: Date | string;
}) {
  const profile = row.profile && typeof row.profile === "object" && !Array.isArray(row.profile)
    ? row.profile as Record<string, unknown>
    : null;
  return {
    channel: row.channel,
    handle: row.subject,
    verified: row.verifiedAt !== null,
    sourceEntityId: typeof profile?.["sourceEntityId"] === "string"
      ? profile["sourceEntityId"]
      : null,
    metadata: profile,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export function buildEndUserToolHandlers(deps: {
  prisma: ControlDatabaseClient;
  toolAudit: ToolAuditService;
}): McpToolHandler[] {
  const { prisma, toolAudit } = deps;

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
      scope: scopeTuple(scope),
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
      name: "end_users.get",
      description:
        "Fetch one organization-owned EndUser by exactly one of externalUserId or platosEndUserId, including canonical identities and scope-local thread activity.",
      inputSchema: {
        type: "object",
        properties: {
          externalUserId: { type: "string" },
          platosEndUserId: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const externalUserId = typeof params["externalUserId"] === "string"
          ? params["externalUserId"].trim()
          : "";
        const platosEndUserId = typeof params["platosEndUserId"] === "string"
          ? params["platosEndUserId"].trim()
          : "";
        if (!!externalUserId === !!platosEndUserId) {
          return {
            error: "invalid_params",
            message: "supply exactly one of `externalUserId` or `platosEndUserId`",
          };
        }

        const user = platosEndUserId
          ? await prisma.endUser.findFirst({
              where: {
                id: platosEndUserId,
                organizationId: scope.organizationId,
                ...currentEnvironmentPresence(scope.environmentId),
              },
            })
          : await prisma.endUser.findFirst({
              where: {
                organizationId: scope.organizationId,
                ...currentEnvironmentPresence(scope.environmentId),
                identities: {
                  some: {
                    issuer: EXTERNAL_ISSUER,
                    channel: EXTERNAL_CHANNEL,
                    subject: externalUserId,
                    disabledAt: null,
                  },
                },
              },
            });
        if (!user) {
          return {
            error: "not_found",
            ...(platosEndUserId ? { platosEndUserId } : { externalUserId }),
          };
        }

        const [identities, threadStats] = await Promise.all([
          prisma.endUserIdentity.findMany({
            where: { endUserId: user.id, organizationId: scope.organizationId, disabledAt: null },
            orderBy: { createdAt: "asc" },
          }),
          prisma.thread.aggregate({
            where: { environmentId: scope.environmentId, endUserId: user.id },
            _count: { _all: true },
            _max: { updatedAt: true },
          }),
        ]);
        const externalIdentity = identities.find(
          (identity) => identity.issuer === EXTERNAL_ISSUER && identity.channel === EXTERNAL_CHANNEL,
        );
        const emailIdentity = identities.find((identity) => identity.channel === "email");
        return {
          id: user.id,
          externalUserId: externalIdentity?.subject ?? null,
          displayName: user.displayName ?? null,
          email: emailIdentity?.subject ?? null,
          threadCount: threadStats._count._all,
          lastActiveAt: threadStats._max.updatedAt?.toISOString() ?? null,
          metadata: null,
          identities: identities
            .filter((identity) => identity.issuer !== EXTERNAL_ISSUER)
            .map(projectIdentity),
        };
      },
    },
    {
      name: "end_users.link_identity",
      description:
        "Attach a canonical EndUserIdentity to an organization-owned EndUser. Existing identities are never re-pointed to another person.",
      inputSchema: {
        type: "object",
        required: ["platosEndUserId", "channel", "handle"],
        properties: {
          platosEndUserId: { type: "string" },
          channel: { type: "string" },
          handle: { type: "string" },
          verified: { type: "boolean" },
          metadata: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const platosEndUserId = String(params["platosEndUserId"] ?? "").trim();
        const channel = sanitizeChannel(params["channel"]);
        const handle = sanitizeHandle(params["handle"]);
        if (!platosEndUserId || !channel || !handle) {
          const message = !platosEndUserId
            ? "platosEndUserId required"
            : !channel
              ? "invalid channel"
              : "invalid handle";
          auditMutation(scope, "end_users.link_identity", params, null, "failed", startedAt, "invalid_params");
          return { error: "invalid_params", message };
        }
        if (params["verified"] === true) {
          return {
            error: "trusted_claim_required",
            message: "Manual MCP identities cannot manufacture a verified claim.",
          };
        }
        try {
          const user = await prisma.endUser.findFirst({
            where: {
              id: platosEndUserId,
              organizationId: scope.organizationId,
              ...currentEnvironmentPresence(scope.environmentId),
            },
            select: { id: true },
          });
          if (!user) return { error: "not_found", platosEndUserId };
          const existing = await prisma.endUserIdentity.findUnique({
            where: {
              organizationId_issuer_channel_subject: {
                organizationId: scope.organizationId,
                issuer: MANUAL_ISSUER,
                channel,
                subject: handle,
              },
            },
          });
          if (existing && existing.endUserId !== platosEndUserId) {
            const result = {
              error: "identity_conflict",
              channel,
              handle,
              existingPlatosEndUserId: existing.endUserId,
            };
            auditMutation(scope, "end_users.link_identity", params, result, "failed", startedAt, "identity_conflict");
            return result;
          }
          const metadata = params["metadata"] && typeof params["metadata"] === "object" && !Array.isArray(params["metadata"])
            ? params["metadata"]
            : undefined;
          const row = existing
            ? await prisma.endUserIdentity.update({
                where: { id: existing.id },
                data: {
                  verifiedAt: null,
                  ...(metadata !== undefined ? { profile: metadata } : {}),
                  disabledAt: null,
                },
              })
            : await prisma.endUserIdentity.create({
                data: {
                  endUserId: platosEndUserId,
                  organizationId: scope.organizationId,
                  issuer: MANUAL_ISSUER,
                  channel,
                  subject: handle,
                  verifiedAt: null,
                  ...(metadata !== undefined ? { profile: metadata } : {}),
                },
              });
          const result = {
            ok: true,
            platosEndUserId,
            created: !existing,
            identity: projectIdentity(row),
          };
          auditMutation(scope, "end_users.link_identity", params, result, "success", startedAt);
          return result;
        } catch {
          auditMutation(scope, "end_users.link_identity", params, null, "failed", startedAt, "internal_error");
          return { error: "link_failed", message: "Identity could not be linked." };
        }
      },
    },
    {
      name: "end_users.bind_external_id",
      description:
        "Verify that an authenticated runtime external id belongs to the person behind a verified channel claim. This tool never creates or promotes identity trust.",
      inputSchema: {
        type: "object",
        required: ["channel", "handle", "externalId"],
        properties: {
          channel: { type: "string" },
          handle: { type: "string" },
          externalId: { type: "string" },
          verified: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const channel = sanitizeChannel(params["channel"]);
        const handle = sanitizeHandle(params["handle"]);
        const externalId = sanitizeExternalId(params["externalId"]);
        if (!channel || !handle || !externalId) {
          auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, "invalid_params");
          return { error: "invalid_params", message: "channel, handle, and externalId must be valid" };
        }
        try {
          const claim = await prisma.endUserIdentity.findFirst({
              where: {
                organizationId: scope.organizationId,
                issuer: `channel:${channel}`,
                channel,
                subject: handle,
                disabledAt: null,
                verifiedAt: { not: null },
                endUser: {
                  organizationId: scope.organizationId,
                  ...currentEnvironmentPresence(scope.environmentId),
                },
              },
            });
          if (!claim) {
            const result = {
              error: "trusted_claim_required" as const,
              message: "A verified runtime identity in the current Environment is required.",
            };
            auditMutation(scope, "end_users.bind_external_id", params, result, "failed", startedAt, result.error);
            return result;
          }
          const existingExternal = await prisma.endUserIdentity.findUnique({
              where: {
                organizationId_issuer_channel_subject: {
                  organizationId: scope.organizationId,
                  issuer: EXTERNAL_ISSUER,
                  channel: EXTERNAL_CHANNEL,
                  subject: externalId,
                },
              },
            });
          if (!existingExternal || existingExternal.endUserId !== claim.endUserId || !existingExternal.verifiedAt) {
            const result = {
              error: "trusted_claim_required" as const,
              message: "The external id must already be verified by authenticated runtime persistence.",
            };
            auditMutation(scope, "end_users.bind_external_id", params, result, "failed", startedAt, result.error);
            return result;
          }
          const result = {
            ok: true as const,
            platosEndUserId: claim.endUserId,
            externalId,
            created: false,
          };
          auditMutation(
            scope,
            "end_users.bind_external_id",
            params,
            result,
            "success",
            startedAt,
          );
          return result;
        } catch {
          auditMutation(scope, "end_users.bind_external_id", params, null, "failed", startedAt, "internal_error");
          return { error: "bind_failed", message: "External identity could not be bound." };
        }
      },
    },
    {
      name: "end_users.unlink_identity",
      description: "Detach one channel identity in the token's organization without re-pointing any other identity.",
      inputSchema: {
        type: "object",
        required: ["channel", "handle"],
        properties: { channel: { type: "string" }, handle: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const channel = sanitizeChannel(params["channel"]);
        const handle = sanitizeHandle(params["handle"]);
        if (!channel || !handle) return { error: "invalid_params", message: "invalid channel or handle" };
        try {
          const existing = await prisma.endUserIdentity.findFirst({
            where: {
              organizationId: scope.organizationId,
              issuer: MANUAL_ISSUER,
              channel,
              subject: handle,
              disabledAt: null,
              endUser: {
                organizationId: scope.organizationId,
                ...currentEnvironmentPresence(scope.environmentId),
              },
            },
          });
          if (!existing) {
            const result = { ok: false, error: "not_found", channel, handle };
            auditMutation(scope, "end_users.unlink_identity", params, result, "failed", startedAt, "not_found");
            return result;
          }
          await prisma.endUserIdentity.delete({ where: { id: existing.id } });
          const result = {
            ok: true,
            unlinked: {
              ...projectIdentity(existing),
              platosEndUserId: existing.endUserId,
            },
          };
          auditMutation(scope, "end_users.unlink_identity", params, result, "success", startedAt);
          return result;
        } catch {
          auditMutation(scope, "end_users.unlink_identity", params, null, "failed", startedAt, "internal_error");
          return { error: "unlink_failed", message: "Identity could not be unlinked." };
        }
      },
    },
  ];
}
