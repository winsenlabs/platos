import { Prisma, type Job } from "@platos/tenancy-database";
import { configureExternalTriggerSdk } from "../../shared/external-trigger-config";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
} from "../../shared/database.provider";
import type { McpToolHandler } from "../mcp-router";
import {
  jobInvocationProperty,
  jobInvocationType,
  setJobInvocationType,
} from "../../agent-runtime/job-persistence";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

const JOB_ID_RE = /^[a-z0-9-]{1,64}$/;
const INVOCATION_TYPES = new Set(["manual", "schedule", "webhook", "agent-spawn"]);

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function checkSyntax(source: string): string | null {
  try {
    // eslint-disable-next-line no-new-func
    new Function("payload", "ctx", source);
    return null;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : "Syntax error";
  }
}

function detectEsmSyntax(source: string): string | null {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, "$1");
  if (/(^|\n)\s*export\s+(default|const|let|var|function|class|async\s+function|\{)/.test(stripped)) {
    return "ESM `export` statement detected";
  }
  if (/(^|\n)\s*import\s+[\w*{}\s,]+\s+from\s+['"][^'"]+['"]/.test(stripped)) {
    return "ESM `import ... from ...` statement detected";
  }
  if (/import\.meta\b/.test(stripped)) return "ESM `import.meta` reference detected";
  return null;
}

function publicJob(job: Job, includeHandler: boolean) {
  return {
    id: job.id,
    jobId: job.externalId ?? job.id,
    displayName: job.displayName,
    description: job.description,
    invocationType: jobInvocationType(job),
    scheduleCron: job.scheduleCron,
    scheduleTimezone: job.scheduleTimezone,
    allowedAgentIds: job.allowedAgentIds,
    payloadSchema: job.payloadSchema,
    ...(includeHandler ? { handler: job.handler } : {}),
    timeout: job.timeoutSeconds,
    maxRetries: job.maxRetries,
    isActive: job.status === "ACTIVE",
    createdBy: job.createdBy,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    lastStartedAt: job.lastStartedAt?.toISOString() ?? null,
  };
}

export function buildJobToolHandlers(deps: {
  toolAudit: ToolAuditService;
  prisma: ControlDatabaseClient;
}): McpToolHandler[] {
  const { toolAudit, prisma } = deps;

  function auditMutation(
    scope: RequestScope,
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    status: "success" | "failed",
    startedAt: number,
    errorCode?: string,
  ): void {
    void toolAudit
      .record({
        scope: tuple(scope),
        toolName,
        userId: scope.userId ?? null,
        args,
        result,
        ...(errorCode ? { error: errorCode } : {}),
        status,
        latencyMs: Date.now() - startedAt,
        source: "mcp_platform",
      })
      .catch(() => {
        // eslint-disable-next-line no-console
        console.warn("[jobs] tool audit write failed");
      });
  }

  return [
    {
      name: "jobs.list",
      description: "List canonical jobs in the current Environment. Handler source is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          invocationType: { type: "string", enum: [...INVOCATION_TYPES] },
          isActive: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const requestScope = scope as RequestScope;
        const jobs = await prisma.job.findMany({
          where: {
            ...environmentScopeWhere(requestScope),
            ...(typeof params["invocationType"] === "string"
              ? jobInvocationProperty(params["invocationType"])
              : {}),
            ...(typeof params["isActive"] === "boolean"
              ? { status: params["isActive"] ? "ACTIVE" : { not: "ACTIVE" } }
              : {}),
          },
          orderBy: { createdAt: "desc" },
          take: Math.min(500, Math.max(1, Number(params["limit"] ?? 100))),
        });
        return { jobs: jobs.map((job) => publicJob(job, false)) };
      },
    },
    {
      name: "jobs.get",
      description: "Fetch one canonical job in scope, including its handler source.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["id"]);
        const job = await prisma.job.findFirst({
          where: { id, ...environmentScopeWhere(scope as RequestScope) },
        });
        return job ? { job: publicJob(job, true) } : { error: "not_found", id };
      },
    },
    {
      name: "jobs.create",
      description: "Create a canonical Environment-owned job after syntax validation.",
      inputSchema: {
        type: "object",
        required: ["jobId", "displayName", "handler"],
        properties: {
          jobId: { type: "string", minLength: 1, maxLength: 64 },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          invocationType: { type: "string", enum: [...INVOCATION_TYPES] },
          scheduleCron: { type: "string", maxLength: 200 },
          scheduleTimezone: { type: "string", maxLength: 100 },
          allowedAgentIds: { type: "array", items: { type: "string" }, maxItems: 100 },
          payloadSchema: { type: "object" },
          handler: { type: "string", minLength: 1, maxLength: 200_000 },
          timeout: { type: "integer", minimum: 1, maximum: 3600 },
          maxRetries: { type: "integer", minimum: 0, maximum: 10 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const requestScope = scope as RequestScope;
        const jobId = String(params["jobId"] ?? "").trim();
        const displayName = String(params["displayName"] ?? "").trim();
        const handler = String(params["handler"] ?? "");
        const invocationType = String(params["invocationType"] ?? "manual");
        const auditArgs = {
          jobId,
          displayName,
          invocationType,
          handlerLength: handler.length,
        };

        if (!JOB_ID_RE.test(jobId)) {
          auditMutation(requestScope, "jobs.create", auditArgs, null, "failed", startedAt, "invalid_job_id");
          return { error: "invalid_job_id", message: "jobId must be 1-64 lowercase alphanumeric + hyphens" };
        }
        if (!displayName || !handler.trim()) {
          auditMutation(requestScope, "jobs.create", auditArgs, null, "failed", startedAt, "invalid_input");
          return { error: "invalid_input", message: "displayName and handler are required" };
        }
        if (!INVOCATION_TYPES.has(invocationType)) {
          auditMutation(requestScope, "jobs.create", auditArgs, null, "failed", startedAt, "invalid_invocation_type");
          return { error: "invalid_invocation_type" };
        }
        const duplicate = await prisma.job.findFirst({
          where: { externalId: jobId, ...environmentScopeWhere(requestScope) },
          select: { id: true },
        });
        if (duplicate) return { error: "already_exists" };

        const syntaxError = checkSyntax(handler);
        try {
          const job = await prisma.job.create({
            data: {
              environmentId: requestScope.environmentId,
              externalId: jobId,
              displayName,
              description: typeof params["description"] === "string" ? params["description"].trim() : null,
              ...jobInvocationProperty(invocationType),
              scheduleCron: typeof params["scheduleCron"] === "string" ? params["scheduleCron"] : null,
              scheduleTimezone:
                typeof params["scheduleTimezone"] === "string" ? params["scheduleTimezone"] : null,
              allowedAgentIds: Array.isArray(params["allowedAgentIds"])
                ? params["allowedAgentIds"].filter((value): value is string => typeof value === "string")
                : [],
              payloadSchema:
                params["payloadSchema"] && typeof params["payloadSchema"] === "object"
                  ? (params["payloadSchema"] as Prisma.InputJsonObject)
                  : undefined,
              handler,
              timeoutSeconds: Number(params["timeout"] ?? 300),
              maxRetries: Number(params["maxRetries"] ?? 3),
              status: syntaxError ? "FAILED" : "ACTIVE",
              createdBy: requestScope.userId,
            } as Prisma.JobUncheckedCreateInput,
          });
          const result = { job: publicJob(job, true), syntaxError };
          auditMutation(requestScope, "jobs.create", auditArgs, { id: job.id }, "success", startedAt);
          return result;
        } catch {
          auditMutation(requestScope, "jobs.create", auditArgs, null, "failed", startedAt, "create_failed");
          return { error: "create_failed", message: "The job could not be created." };
        }
      },
    },
    {
      name: "jobs.update",
      description: "Update canonical job fields. Handler changes are syntax checked.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 2000 },
          invocationType: { type: "string", enum: [...INVOCATION_TYPES] },
          scheduleCron: { type: ["string", "null"], maxLength: 200 },
          scheduleTimezone: { type: ["string", "null"], maxLength: 100 },
          allowedAgentIds: { type: "array", items: { type: "string" }, maxItems: 100 },
          payloadSchema: { type: ["object", "null"] },
          handler: { type: "string", minLength: 1, maxLength: 200_000 },
          timeout: { type: "integer", minimum: 1, maximum: 3600 },
          maxRetries: { type: "integer", minimum: 0, maximum: 10 },
          isActive: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const requestScope = scope as RequestScope;
        const id = String(params["id"]);
        const existing = await prisma.job.findFirst({
          where: { id, ...environmentScopeWhere(requestScope) },
        });
        if (!existing) return { error: "not_found", id };

        const data: Prisma.JobUpdateInput = {};
        const changedFields: string[] = [];
        if (params["displayName"] !== undefined) {
          data.displayName = String(params["displayName"]).trim();
          changedFields.push("displayName");
        }
        if (params["description"] !== undefined) {
          data.description = params["description"] === null ? null : String(params["description"]).trim();
          changedFields.push("description");
        }
        if (params["invocationType"] !== undefined) {
          const invocationType = String(params["invocationType"]);
          if (!INVOCATION_TYPES.has(invocationType)) return { error: "invalid_invocation_type" };
          setJobInvocationType(data, invocationType);
          changedFields.push("invocationType");
        }
        if (params["scheduleCron"] !== undefined) {
          data.scheduleCron = params["scheduleCron"] === null ? null : String(params["scheduleCron"]);
          changedFields.push("scheduleCron");
        }
        if (params["scheduleTimezone"] !== undefined) {
          data.scheduleTimezone = params["scheduleTimezone"] === null ? null : String(params["scheduleTimezone"]);
          changedFields.push("scheduleTimezone");
        }
        if (Array.isArray(params["allowedAgentIds"])) {
          data.allowedAgentIds = params["allowedAgentIds"].filter(
            (value): value is string => typeof value === "string",
          );
          changedFields.push("allowedAgentIds");
        }
        if (params["payloadSchema"] !== undefined) {
          data.payloadSchema = params["payloadSchema"] === null
            ? Prisma.JsonNull
            : (params["payloadSchema"] as Prisma.InputJsonObject);
          changedFields.push("payloadSchema");
        }
        if (params["timeout"] !== undefined) {
          data.timeoutSeconds = Number(params["timeout"]);
          changedFields.push("timeout");
        }
        if (params["maxRetries"] !== undefined) {
          data.maxRetries = Number(params["maxRetries"]);
          changedFields.push("maxRetries");
        }
        if (params["isActive"] !== undefined) {
          data.status = params["isActive"] ? "ACTIVE" : "CANCELLED";
          changedFields.push("isActive");
        }

        let syntaxError: string | null = null;
        if (typeof params["handler"] === "string" && params["handler"] !== existing.handler) {
          syntaxError = checkSyntax(params["handler"]);
          data.handler = params["handler"];
          data.status = syntaxError ? "FAILED" : "ACTIVE";
          changedFields.push("handler");
        }
        if (changedFields.length === 0) return { error: "no_changes" };

        try {
          const job = await prisma.job.update({ where: { id }, data });
          const result = { job: publicJob(job, true), syntaxError };
          auditMutation(
            requestScope,
            "jobs.update",
            { id, jobId: existing.externalId, changedFields },
            { id },
            "success",
            startedAt,
          );
          return result;
        } catch {
          auditMutation(requestScope, "jobs.update", { id, changedFields }, null, "failed", startedAt, "update_failed");
          return { error: "update_failed", message: "The job could not be updated." };
        }
      },
    },
    {
      name: "jobs.delete",
      description: "Delete one canonical job in the current Environment.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const requestScope = scope as RequestScope;
        const id = String(params["id"]);
        const existing = await prisma.job.findFirst({
          where: { id, ...environmentScopeWhere(requestScope) },
          select: { externalId: true, displayName: true },
        });
        if (!existing) return { error: "not_found", id };
        const deleted = await prisma.job.deleteMany({
          where: { id, ...environmentScopeWhere(requestScope) },
        });
        if (deleted.count !== 1) return { error: "delete_failed" };
        const result = {
          deleted: true,
          id,
          jobId: existing.externalId ?? id,
          displayName: existing.displayName,
        };
        auditMutation(requestScope, "jobs.delete", { id }, result, "success", startedAt);
        return result;
      },
    },
    {
      name: "jobs.dispatch",
      description: "Dispatch an active canonical Job through the durable runtime.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, payload: { type: "object" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const requestScope = scope as RequestScope;
        const id = String(params["id"]);
        const payload = (params["payload"] as Record<string, unknown> | undefined) ?? {};
        const job = await prisma.job.findFirst({
          where: { id, status: "ACTIVE", ...environmentScopeWhere(requestScope) },
          select: { id: true, externalId: true, displayName: true },
        });
        if (!job) return { error: "not_found_or_inactive", id };

        const triggerSdk = await import("@trigger.dev/sdk");
        if (configureExternalTriggerSdk(triggerSdk).status !== "configured") {
          return {
            accepted: false,
            message: "The durable Job runtime is not configured.",
            jobId: job.externalId ?? id,
          };
        }
        try {
          await triggerSdk.tasks.trigger(
            "platos-custom-task",
            {
              jobId: id,
              payload,
              scope: { ...tuple(requestScope), userId: requestScope.userId },
              invokedBy: "manual",
            },
            {
              tags: [
                `org:${requestScope.organizationId}`,
                `project:${requestScope.projectId}`,
                `env:${requestScope.environmentId}`,
                `user:${requestScope.userId}`,
              ],
              metadata: { ...tuple(requestScope), userId: requestScope.userId },
            },
          );
          const result = {
            accepted: true,
            jobId: job.externalId ?? id,
            displayName: job.displayName,
          };
          auditMutation(requestScope, "jobs.dispatch", { id, payloadKeys: Object.keys(payload) }, result, "success", startedAt);
          return result;
        } catch {
          auditMutation(requestScope, "jobs.dispatch", { id }, null, "failed", startedAt, "dispatch_failed");
          return { error: "dispatch_failed", message: "The job could not be dispatched." };
        }
      },
    },
    {
      name: "jobs.set_enabled",
      description: "Enable or disable a canonical job by changing its WorkStatus.",
      inputSchema: {
        type: "object",
        required: ["id", "enabled"],
        properties: { id: { type: "string" }, enabled: { type: "boolean" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const requestScope = scope as RequestScope;
        const id = String(params["id"]);
        const enabled = params["enabled"] === true;
        const job = await prisma.job.findFirst({
          where: { id, ...environmentScopeWhere(requestScope) },
        });
        if (!job) return { error: "not_found", id };
        if (enabled) {
          const syntaxError = checkSyntax(job.handler);
          if (syntaxError) return { error: "syntax_error", message: syntaxError };
        }
        const nextStatus = enabled ? "ACTIVE" : "CANCELLED";
        if (job.status === nextStatus) {
          return { id, jobId: job.externalId ?? id, isActive: enabled, changed: false };
        }
        const updated = await prisma.job.update({
          where: { id },
          data: { status: nextStatus },
        });
        const result = {
          id,
          jobId: updated.externalId ?? id,
          isActive: updated.status === "ACTIVE",
          changed: true,
        };
        auditMutation(requestScope, "jobs.set_enabled", { id, enabled }, result, "success", startedAt);
        return result;
      },
    },
    {
      name: "jobs.validate_handler",
      description: "Syntax-check CommonJS handler source without executing it.",
      inputSchema: {
        type: "object",
        required: ["handler"],
        properties: { handler: { type: "string", minLength: 1, maxLength: 200_000 } },
        additionalProperties: false,
      },
      async execute(params) {
        const handler = String(params["handler"]);
        const esmHint = detectEsmSyntax(handler);
        if (esmHint) {
          return {
            valid: false,
            error: `${esmHint} — handlers run in a CommonJS context.`,
          };
        }
        const error = checkSyntax(handler);
        return error ? { valid: false, error } : { valid: true };
      },
    },
  ];
}
