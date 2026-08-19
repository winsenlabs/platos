import { Prisma, type Job } from "@platos/tenancy-database";
import { configureExternalTriggerSdk } from "../../shared/external-trigger-config";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
} from "../../shared/database.provider";
import type { McpToolHandler } from "../mcp-router";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

const TASK_ID_RE = /^[a-z0-9-]{1,64}$/;
const TRIGGER_TYPES = new Set(["manual", "schedule", "webhook", "agent-spawn"]);

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
    taskId: job.externalId ?? job.id,
    displayName: job.displayName,
    description: job.description,
    triggerType: job.triggerType,
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
    lastRunAt: job.lastStartedAt?.toISOString() ?? null,
  };
}

export function buildPlatosTaskToolHandlers(deps: {
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
        console.warn("[platos_tasks] tool audit write failed");
      });
  }

  return [
    {
      name: "platos_tasks.list",
      description: "List canonical jobs in the current Environment. Handler source is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          triggerType: { type: "string", enum: [...TRIGGER_TYPES] },
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
            ...(typeof params["triggerType"] === "string"
              ? { triggerType: params["triggerType"] }
              : {}),
            ...(typeof params["isActive"] === "boolean"
              ? { status: params["isActive"] ? "ACTIVE" : { not: "ACTIVE" } }
              : {}),
          },
          orderBy: { createdAt: "desc" },
          take: Math.min(500, Math.max(1, Number(params["limit"] ?? 100))),
        });
        return { tasks: jobs.map((job) => publicJob(job, false)) };
      },
    },
    {
      name: "platos_tasks.get",
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
        return job ? { task: publicJob(job, true) } : { error: "not_found", id };
      },
    },
    {
      name: "platos_tasks.create",
      description: "Create a canonical Environment-owned job after syntax validation.",
      inputSchema: {
        type: "object",
        required: ["taskId", "displayName", "handler"],
        properties: {
          taskId: { type: "string", minLength: 1, maxLength: 64 },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          triggerType: { type: "string", enum: [...TRIGGER_TYPES] },
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
        const taskId = String(params["taskId"] ?? "").trim();
        const displayName = String(params["displayName"] ?? "").trim();
        const handler = String(params["handler"] ?? "");
        const triggerType = String(params["triggerType"] ?? "manual");
        const auditArgs = {
          taskId,
          displayName,
          triggerType,
          handlerLength: handler.length,
        };

        if (!TASK_ID_RE.test(taskId)) {
          auditMutation(requestScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, "invalid_task_id");
          return { error: "invalid_task_id", message: "taskId must be 1-64 lowercase alphanumeric + hyphens" };
        }
        if (!displayName || !handler.trim()) {
          auditMutation(requestScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, "invalid_input");
          return { error: "invalid_input", message: "displayName and handler are required" };
        }
        if (!TRIGGER_TYPES.has(triggerType)) {
          auditMutation(requestScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, "invalid_trigger_type");
          return { error: "invalid_trigger_type" };
        }
        const duplicate = await prisma.job.findFirst({
          where: { externalId: taskId, ...environmentScopeWhere(requestScope) },
          select: { id: true },
        });
        if (duplicate) return { error: "already_exists" };

        const syntaxError = checkSyntax(handler);
        try {
          const job = await prisma.job.create({
            data: {
              environmentId: requestScope.environmentId,
              externalId: taskId,
              displayName,
              description: typeof params["description"] === "string" ? params["description"].trim() : null,
              triggerType,
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
            },
          });
          const result = { task: publicJob(job, true), syntaxError };
          auditMutation(requestScope, "platos_tasks.create", auditArgs, { id: job.id }, "success", startedAt);
          return result;
        } catch {
          auditMutation(requestScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, "create_failed");
          return { error: "create_failed", message: "The task could not be created." };
        }
      },
    },
    {
      name: "platos_tasks.update",
      description: "Update canonical job fields. Handler changes are syntax checked.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 2000 },
          triggerType: { type: "string", enum: [...TRIGGER_TYPES] },
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
        if (params["triggerType"] !== undefined) {
          const triggerType = String(params["triggerType"]);
          if (!TRIGGER_TYPES.has(triggerType)) return { error: "invalid_trigger_type" };
          data.triggerType = triggerType;
          changedFields.push("triggerType");
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
          const result = { task: publicJob(job, true), syntaxError };
          auditMutation(
            requestScope,
            "platos_tasks.update",
            { id, taskId: existing.externalId, changedFields },
            { id },
            "success",
            startedAt,
          );
          return result;
        } catch {
          auditMutation(requestScope, "platos_tasks.update", { id, changedFields }, null, "failed", startedAt, "update_failed");
          return { error: "update_failed", message: "The task could not be updated." };
        }
      },
    },
    {
      name: "platos_tasks.delete",
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
          taskId: existing.externalId ?? id,
          displayName: existing.displayName,
        };
        auditMutation(requestScope, "platos_tasks.delete", { id }, result, "success", startedAt);
        return result;
      },
    },
    {
      name: "platos_tasks.run",
      description: "Dispatch an active canonical job through Trigger.dev.",
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
          return { queued: false, message: "Task execution is unavailable.", taskId: job.externalId ?? id };
        }
        try {
          const run = await triggerSdk.tasks.trigger(
            "platos-custom-task",
            {
              taskRowId: id,
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
            queued: true,
            runId: run.id,
            taskId: job.externalId ?? id,
            displayName: job.displayName,
          };
          auditMutation(requestScope, "platos_tasks.run", { id, payloadKeys: Object.keys(payload) }, result, "success", startedAt);
          return result;
        } catch {
          auditMutation(requestScope, "platos_tasks.run", { id }, null, "failed", startedAt, "dispatch_failed");
          return { error: "dispatch_failed", message: "The task could not be dispatched." };
        }
      },
    },
    {
      name: "platos_tasks.get_runs",
      description: "Run history is unavailable through the canonical control database.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["id"]);
        const job = await prisma.job.findFirst({
          where: { id, ...environmentScopeWhere(scope as RequestScope) },
          select: { id: true },
        });
        if (!job) return { error: "not_found", id };
        return {
          error: "unsupported",
          message: "Task run history is not available through the canonical control database.",
        };
      },
    },
    {
      name: "platos_tasks.get_run",
      description: "Run details are unavailable through the canonical control database.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
        additionalProperties: false,
      },
      async execute() {
        return {
          error: "unsupported",
          message: "Task run details are not available through the canonical control database.",
        };
      },
    },
    {
      name: "platos_tasks.set_enabled",
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
          return { id, taskId: job.externalId ?? id, isActive: enabled, changed: false };
        }
        const updated = await prisma.job.update({
          where: { id },
          data: { status: nextStatus },
        });
        const result = {
          id,
          taskId: updated.externalId ?? id,
          isActive: updated.status === "ACTIVE",
          changed: true,
        };
        auditMutation(requestScope, "platos_tasks.set_enabled", { id, enabled }, result, "success", startedAt);
        return result;
      },
    },
    {
      name: "platos_tasks.validate_handler",
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
