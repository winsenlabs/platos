/**
 * Theme MCPF-W4 — PlatosTask management MCP tools (10 tools).
 *
 * Wraps the operator-authored custom-task surface introduced by PIFSP-12.
 * Each handler is scope-pinned via the verified MCP token and hits Prisma
 * directly through the shared client (no separate service layer — the
 * existing PlatosTasksController is also a thin Prisma wrapper).
 *
 * Tools:
 *   • `platos_tasks.list`              — list custom tasks in scope
 *   • `platos_tasks.get`               — fetch one task (handler source included)
 *   • `platos_tasks.create`            — create + syntax-check + activate (gated)
 *   • `platos_tasks.update`            — patch fields / replace handler (gated)
 *   • `platos_tasks.delete`            — drop a task (gated)
 *   • `platos_tasks.run`               — manually dispatch via trigger.dev (gated)
 *   • `platos_tasks.get_runs`          — list recent TaskRun rows for a task
 *   • `platos_tasks.get_run`           — fetch a single TaskRun (scope-checked)
 *   • `platos_tasks.set_enabled`       — toggle isActive flag (gated)
 *   • `platos_tasks.validate_handler`  — syntax-check a handler source (read-only)
 *
 * Tier-1 require_approval (set in `permission-gateway.service.ts`
 * PLATFORM_TIER_MINIMUMS):
 *   - platos_tasks.create
 *   - platos_tasks.update
 *   - platos_tasks.delete
 *   - platos_tasks.run
 *   - platos_tasks.set_enabled
 *
 * Audit logging mirrors `entities.ts`: mutations record metadata only —
 * never the raw handler source (it can carry secrets the operator hardcoded
 * before SecretStore was an option). Read-only tools (`list`, `get`,
 * `get_runs`, `get_run`, `validate_handler`) skip the audit pipe entirely.
 */

import type { McpToolHandler } from "../mcp-router";
import type { RequestScope } from "../../auth/scope.guard";
import type { ToolAuditService } from "../../monitoring/tool-audit.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

function tuple(scope: RequestScope): ScopeTuple {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

function scopeWhere(scope: RequestScope) {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  };
}

const TASK_ID_RE = /^[a-z0-9-]{1,64}$/;
const TRIGGER_TYPES = new Set(["manual", "schedule", "webhook", "agent-spawn"]);

/**
 * Compile-check operator JS without executing it. Returns null on clean
 * parse, otherwise a one-line error message.
 */
function checkSyntax(source: string): string | null {
  try {
    // eslint-disable-next-line no-new-func
    new Function("payload", "ctx", source);
    return null;
  } catch (err: any) {
    return err?.message ?? "Syntax error";
  }
}

/**
 * MCPF-followup — detect ESM-only syntax in operator handler source.
 * `new Function(...)` runs in a CommonJS-style context, so `export
 * default`, top-level `import`, and bare `import.meta` references
 * surface as opaque "Unexpected token 'export'" parse errors. Returning
 * a more specific hint short-circuits the user-facing error message.
 *
 * Returns the matched hint or null when no ESM-specific syntax found.
 * False positives are acceptable here — the call site only runs this
 * when the underlying parse fails or as a pre-check before
 * `checkSyntax`.
 */
function detectEsmSyntax(source: string): string | null {
  // Strip line + block comments to keep the regex tight without
  // pulling a parser dependency. Conservative — only handles the
  // obvious cases.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, "$1");
  if (/(^|\n)\s*export\s+(default|const|let|var|function|class|async\s+function|\{)/.test(stripped)) {
    return "ESM `export` statement detected";
  }
  if (/(^|\n)\s*import\s+[\w*{}\s,]+\s+from\s+['"][^'"]+['"]/.test(stripped)) {
    return "ESM `import ... from ...` statement detected";
  }
  if (/import\.meta\b/.test(stripped)) {
    return "ESM `import.meta` reference detected";
  }
  return null;
}

/**
 * Strip server-side artifacts before returning a row through MCP. The
 * `compiledHandler` column is an internal cache — operator-facing tools
 * should always echo the canonical `handler` source.
 */
function publicTask<T extends Record<string, any>>(row: T): Omit<T, "compiledHandler"> {
  const { compiledHandler: _drop, ...rest } = row;
  void _drop;
  return rest;
}

function toIso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return String(d);
}

export function buildPlatosTaskToolHandlers(deps: {
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
      name: "platos_tasks.list",
      description:
        "List operator-authored custom tasks (`PlatosTask`) in the current " +
        "scope. Returns metadata only — `handler` source is omitted to keep " +
        "the response small + avoid leaking embedded secrets in bulk reads. " +
        "Use `platos_tasks.get` to fetch a specific task with handler code.",
      inputSchema: {
        type: "object",
        properties: {
          triggerType: {
            type: "string",
            enum: ["manual", "schedule", "webhook", "agent-spawn"],
          },
          isActive: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 500 },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const where: Record<string, unknown> = scopeWhere(scope as RequestScope);
        if (typeof params["triggerType"] === "string") {
          where["triggerType"] = String(params["triggerType"]);
        }
        if (typeof params["isActive"] === "boolean") {
          where["isActive"] = params["isActive"];
        }
        const limit = (params["limit"] as number | undefined) ?? 100;
        const tasks = await prisma.platosTask.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          select: {
            id: true,
            taskId: true,
            displayName: true,
            description: true,
            triggerType: true,
            scheduleCron: true,
            scheduleTimezone: true,
            allowedAgentIds: true,
            isActive: true,
            handlerVersion: true,
            timeout: true,
            maxRetries: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            lastRunAt: true,
          },
        });
        return {
          tasks: (tasks as Array<Record<string, any>>).map((t) => ({
            ...t,
            createdAt: toIso(t["createdAt"]),
            updatedAt: toIso(t["updatedAt"]),
            lastRunAt: toIso(t["lastRunAt"]),
          })),
        };
      },
    },

    {
      name: "platos_tasks.get",
      description:
        "Fetch a single `PlatosTask` by id. Includes the raw `handler` " +
        "source. Returns `{ error: 'not_found' }` for unknown / cross-scope " +
        "ids — never echoes the row. Server-side `compiledHandler` cache is " +
        "stripped before returning.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const id = String(params["id"]);
        const row = await prisma.platosTask.findFirst({
          where: { id, ...scopeWhere(scope as RequestScope) },
        });
        if (!row) return { error: "not_found", id };
        const safe = publicTask(row as Record<string, any>);
        return {
          task: {
            ...safe,
            createdAt: toIso(safe["createdAt"]),
            updatedAt: toIso(safe["updatedAt"]),
            lastRunAt: toIso(safe["lastRunAt"]),
          },
        };
      },
    },

    {
      name: "platos_tasks.create",
      description:
        "Create a new operator-authored task. Required: `taskId` (1-64 " +
        "lowercase alphanumeric + hyphens, unique within scope), " +
        "`displayName`, `handler` (raw JavaScript source — must `export " +
        "function run(payload, ctx)`). Optional: `triggerType` " +
        "(manual|schedule|webhook|agent-spawn, default 'manual'), " +
        "`scheduleCron`, `scheduleTimezone`, `allowedAgentIds`, " +
        "`payloadSchema`, `timeout` (seconds, default 300), `maxRetries` " +
        "(default 3). The handler is syntax-checked before save; rows with " +
        "syntax errors are stored with `isActive=false` + a `syntaxError` " +
        "field surfaced in the response. Audit-logged " +
        "(`taskId`, `displayName`, `handlerLength` only — never the " +
        "handler source itself).",
      inputSchema: {
        type: "object",
        required: ["taskId", "displayName", "handler"],
        properties: {
          taskId: { type: "string", minLength: 1, maxLength: 64 },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: "string", maxLength: 2000 },
          triggerType: {
            type: "string",
            enum: ["manual", "schedule", "webhook", "agent-spawn"],
          },
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
        const reqScope = scope as RequestScope;
        const taskId = String(params["taskId"]).trim();
        const displayName = String(params["displayName"]).trim();
        const handler = String(params["handler"]);
        const description = (params["description"] as string | undefined)?.trim();
        const triggerType = (params["triggerType"] as string | undefined) ?? "manual";
        const scheduleCron = params["scheduleCron"] as string | undefined;
        const scheduleTimezone = params["scheduleTimezone"] as string | undefined;
        const allowedAgentIds = (params["allowedAgentIds"] as string[] | undefined) ?? [];
        const payloadSchema = params["payloadSchema"] as Record<string, unknown> | undefined;
        const timeout = (params["timeout"] as number | undefined) ?? 300;
        const maxRetries = (params["maxRetries"] as number | undefined) ?? 3;
        // Audit shape — everything except the handler body itself.
        const auditArgs = {
          taskId,
          displayName,
          triggerType,
          handlerLength: handler.length,
          allowedAgentIdsCount: allowedAgentIds.length,
          isScheduled: !!scheduleCron,
        };

        if (!TASK_ID_RE.test(taskId)) {
          const err = "taskId must be 1-64 lowercase alphanumeric + hyphens";
          auditMutation(reqScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_task_id", message: err };
        }
        if (!TRIGGER_TYPES.has(triggerType)) {
          const err = `triggerType must be one of ${[...TRIGGER_TYPES].join(", ")}`;
          auditMutation(reqScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, err);
          return { error: "invalid_trigger_type", message: err };
        }
        if (!handler.trim()) {
          const err = "handler source is required";
          auditMutation(reqScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, err);
          return { error: "handler_required", message: err };
        }

        const existing = await prisma.platosTask.findFirst({
          where: { taskId, ...scopeWhere(reqScope) },
          select: { id: true },
        });
        if (existing) {
          auditMutation(
            reqScope,
            "platos_tasks.create",
            auditArgs,
            null,
            "failed",
            startedAt,
            "duplicate_task_id",
          );
          return { error: "already_exists", message: "A task with this taskId already exists in this scope." };
        }

        const syntaxError = checkSyntax(handler);
        const isActive = syntaxError === null;
        try {
          const created = await prisma.platosTask.create({
            data: {
              ...scopeWhere(reqScope),
              taskId,
              displayName,
              description: description ?? null,
              triggerType,
              scheduleCron: scheduleCron ?? null,
              scheduleTimezone: scheduleTimezone ?? null,
              allowedAgentIds,
              payloadSchema: payloadSchema ?? null,
              handler,
              compiledHandler: isActive ? handler : null,
              isActive,
              timeout,
              maxRetries,
              createdBy: reqScope.userId ?? "mcp:platform",
            },
          });
          const safe = publicTask(created as Record<string, any>);
          const result = {
            task: {
              ...safe,
              createdAt: toIso(safe["createdAt"]),
              updatedAt: toIso(safe["updatedAt"]),
              lastRunAt: toIso(safe["lastRunAt"]),
            },
            syntaxError,
          };
          auditMutation(
            reqScope,
            "platos_tasks.create",
            auditArgs,
            { id: created.id, isActive: created.isActive, syntaxError },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "platos_tasks.create", auditArgs, null, "failed", startedAt, message);
          if (/unique/i.test(message) || err?.code === "P2002") {
            return { error: "already_exists", message: "A task with this taskId already exists in this scope." };
          }
          return { error: "create_failed", message };
        }
      },
    },

    {
      name: "platos_tasks.update",
      description:
        "Patch a task by id. Any field omitted is left untouched. " +
        "If `handler` is supplied AND differs from the stored value, it is " +
        "syntax-checked, `handlerVersion` is bumped, and `isActive` flips " +
        "based on the syntax check (a clean handler reactivates a " +
        "previously-broken task). Audit-logged (changed fields + new " +
        "`handlerLength` if rewritten — never the handler source).",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          description: { type: ["string", "null"], maxLength: 2000 },
          triggerType: {
            type: "string",
            enum: ["manual", "schedule", "webhook", "agent-spawn"],
          },
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
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);

        const existing = await prisma.platosTask.findFirst({
          where: { id, ...scopeWhere(reqScope) },
          select: { id: true, handlerVersion: true, handler: true, taskId: true },
        });
        if (!existing) {
          auditMutation(reqScope, "platos_tasks.update", { id }, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }

        const data: Record<string, unknown> = {};
        const changedFields: string[] = [];
        const setIf = (key: string, value: unknown) => {
          data[key] = value;
          changedFields.push(key);
        };
        if (params["displayName"] !== undefined) setIf("displayName", String(params["displayName"]).trim());
        if (params["description"] !== undefined) {
          setIf(
            "description",
            params["description"] === null ? null : String(params["description"]).trim(),
          );
        }
        if (params["triggerType"] !== undefined) {
          const t = String(params["triggerType"]);
          if (!TRIGGER_TYPES.has(t)) {
            auditMutation(reqScope, "platos_tasks.update", { id, triggerType: t }, null, "failed", startedAt, "invalid_trigger_type");
            return { error: "invalid_trigger_type", message: `triggerType must be one of ${[...TRIGGER_TYPES].join(", ")}` };
          }
          setIf("triggerType", t);
        }
        if (params["scheduleCron"] !== undefined) setIf("scheduleCron", params["scheduleCron"]);
        if (params["scheduleTimezone"] !== undefined) setIf("scheduleTimezone", params["scheduleTimezone"]);
        if (params["allowedAgentIds"] !== undefined) setIf("allowedAgentIds", params["allowedAgentIds"]);
        if (params["payloadSchema"] !== undefined) setIf("payloadSchema", params["payloadSchema"]);
        if (params["timeout"] !== undefined) setIf("timeout", params["timeout"]);
        if (params["maxRetries"] !== undefined) setIf("maxRetries", params["maxRetries"]);
        if (params["isActive"] !== undefined) setIf("isActive", params["isActive"]);

        let syntaxError: string | null = null;
        let newHandlerLength: number | undefined;
        if (typeof params["handler"] === "string" && params["handler"] !== existing.handler) {
          const handler = String(params["handler"]);
          syntaxError = checkSyntax(handler);
          data["handler"] = handler;
          data["compiledHandler"] = syntaxError === null ? handler : null;
          data["isActive"] = syntaxError === null;
          data["handlerVersion"] = existing.handlerVersion + 1;
          newHandlerLength = handler.length;
          changedFields.push("handler", "handlerVersion", "isActive");
        }

        if (Object.keys(data).length === 0) {
          auditMutation(reqScope, "platos_tasks.update", { id }, null, "failed", startedAt, "no_op");
          return { error: "no_changes", message: "supply at least one field to update" };
        }

        const auditArgs = {
          id,
          taskId: existing.taskId,
          changedFields: Array.from(new Set(changedFields)),
          ...(newHandlerLength !== undefined ? { handlerLength: newHandlerLength } : {}),
        };

        try {
          const updated = await prisma.platosTask.update({ where: { id }, data });
          const safe = publicTask(updated as Record<string, any>);
          const result = {
            task: {
              ...safe,
              createdAt: toIso(safe["createdAt"]),
              updatedAt: toIso(safe["updatedAt"]),
              lastRunAt: toIso(safe["lastRunAt"]),
            },
            syntaxError,
          };
          auditMutation(
            reqScope,
            "platos_tasks.update",
            auditArgs,
            { id: updated.id, handlerVersion: updated.handlerVersion, isActive: updated.isActive, syntaxError },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "platos_tasks.update", auditArgs, null, "failed", startedAt, message);
          return { error: "update_failed", message };
        }
      },
    },

    {
      name: "platos_tasks.delete",
      description:
        "Delete a task by id. Removes the row + cascades nothing (TaskRun " +
        "rows are not joined to PlatosTask — they remain in the trigger " +
        "engine's history). Returns `{ error: 'not_found' }` for unknown / " +
        "cross-scope ids. Audit-logged.",
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
        const existing = await prisma.platosTask.findFirst({
          where: { id, ...scopeWhere(reqScope) },
          select: { id: true, taskId: true, displayName: true },
        });
        if (!existing) {
          auditMutation(reqScope, "platos_tasks.delete", { id }, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }
        try {
          await prisma.platosTask.delete({ where: { id } });
          const result = { deleted: true, id, taskId: existing.taskId, displayName: existing.displayName };
          auditMutation(
            reqScope,
            "platos_tasks.delete",
            { id, taskId: existing.taskId },
            result,
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "platos_tasks.delete", { id }, null, "failed", startedAt, message);
          return { error: "delete_failed", message };
        }
      },
    },

    {
      name: "platos_tasks.run",
      description:
        "Manually dispatch a task via trigger.dev. Refuses if `isActive` " +
        "is false. Requires `TRIGGER_SECRET_KEY` set in the agent " +
        "environment (returns `{ queued: false, message: ... }` if " +
        "missing). Optional `payload` is JSON-stringified into the " +
        "execution context. Returns `{ queued: true, runId, taskId }` on " +
        "success. Audit-logged (taskId + payload-key list — payload values " +
        "are NOT echoed in the audit row to avoid leaking PII).",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          payload: { type: "object" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const payload = (params["payload"] as Record<string, unknown> | undefined) ?? {};
        const auditArgs = {
          id,
          payloadKeys: Object.keys(payload).slice(0, 50),
        };

        const task = await prisma.platosTask.findFirst({
          where: { id, ...scopeWhere(reqScope), isActive: true },
          select: { id: true, taskId: true, displayName: true },
        });
        if (!task) {
          auditMutation(reqScope, "platos_tasks.run", auditArgs, null, "failed", startedAt, "not_found_or_inactive");
          return { error: "not_found_or_inactive", id };
        }

        const triggerSecretKey = process.env["TRIGGER_SECRET_KEY"];
        if (!triggerSecretKey) {
          const message =
            "TRIGGER_SECRET_KEY not configured — task execution unavailable. " +
            "Set it in the docker-compose env to enable durable task dispatch.";
          auditMutation(
            reqScope,
            "platos_tasks.run",
            auditArgs,
            null,
            "failed",
            startedAt,
            "trigger_unavailable",
          );
          return { queued: false, message, taskId: task.taskId };
        }

        try {
          // Lazy import — same pattern as PlatosTasksController.run().
          const { tasks } = await import("@trigger.dev/sdk");
          const run = await tasks.trigger("platos-custom-task", {
            taskRowId: id,
            payload,
            scope: {
              organizationId: reqScope.organizationId,
              projectId: reqScope.projectId,
              environmentId: reqScope.environmentId,
              userId: reqScope.userId,
            },
            invokedBy: "manual",
          // Per-org queue isolation matches Wave-3 scaling commits + the
          // PlatosTasksController dispatch path (no queue arg in the
          // controller today; using SDK default to stay consistent).
          }, {
            // L7 — stamp trigger-time scope so get_run_details / replay_run can
            // verify ownership; without it, a run dispatched via this MCP tool
            // would be DENIED to its own owner (fail-closed).
            tags: [
              `org:${reqScope.organizationId}`,
              `project:${reqScope.projectId}`,
              `env:${reqScope.environmentId}`,
              `user:${reqScope.userId}`,
            ],
            metadata: {
              organizationId: reqScope.organizationId,
              projectId: reqScope.projectId,
              environmentId: reqScope.environmentId,
              userId: reqScope.userId,
            },
          });
          const result = { queued: true, runId: run.id, taskId: task.taskId, displayName: task.displayName };
          auditMutation(
            reqScope,
            "platos_tasks.run",
            auditArgs,
            { runId: run.id, taskId: task.taskId },
            "success",
            startedAt,
          );
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "platos_tasks.run", auditArgs, null, "failed", startedAt, message);
          return { error: "dispatch_failed", message };
        }
      },
    },

    {
      name: "platos_tasks.get_runs",
      description:
        "List recent `TaskRun` rows for a `PlatosTask`. Filters " +
        "`taskIdentifier='platos-custom-task'` + the agent's environment, " +
        "then matches each run's `payload.taskRowId` against the supplied " +
        "task `id`. Returns runs ordered most-recent first. Optional " +
        "`status` narrows the underlying enum (PENDING, EXECUTING, " +
        "COMPLETED_SUCCESSFULLY, FAILED, etc.). Default limit 50, max 200.",
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
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const status = params["status"] as string | undefined;
        const limit = (params["limit"] as number | undefined) ?? 50;

        // Confirm the task exists in scope before exposing run data.
        const task = await prisma.platosTask.findFirst({
          where: { id, ...scopeWhere(reqScope) },
          select: { id: true, taskId: true },
        });
        if (!task) return { error: "not_found", id };

        // Fetch a generous slice of recent platos-custom-task runs for the
        // env, then filter on the embedded `taskRowId`. We over-fetch by
        // a 5x factor so that even when many tasks share one env, the
        // requested limit is reachable.
        const rawRuns = await prisma.taskRun.findMany({
          where: {
            taskIdentifier: "platos-custom-task",
            runtimeEnvironmentId: reqScope.environmentId,
            projectId: reqScope.projectId,
            ...(status ? { status: String(status) } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: Math.min(limit * 5, 500),
          select: {
            id: true,
            friendlyId: true,
            status: true,
            payload: true,
            payloadType: true,
            createdAt: true,
            startedAt: true,
            completedAt: true,
            usageDurationMs: true,
            costInCents: true,
            attemptNumber: true,
          },
        });

        const matched: Array<Record<string, unknown>> = [];
        for (const r of rawRuns as Array<Record<string, any>>) {
          if (matched.length >= limit) break;
          let parsedPayload: any = null;
          if (typeof r["payload"] === "string") {
            try {
              parsedPayload = JSON.parse(r["payload"]);
            } catch {
              continue;
            }
          }
          const rowId = parsedPayload?.taskRowId;
          if (rowId !== id) continue;
          matched.push({
            id: r["id"],
            friendlyId: r["friendlyId"],
            status: r["status"],
            attemptNumber: r["attemptNumber"],
            usageDurationMs: r["usageDurationMs"],
            costInCents: r["costInCents"],
            createdAt: toIso(r["createdAt"]),
            startedAt: toIso(r["startedAt"]),
            completedAt: toIso(r["completedAt"]),
            invokedBy: parsedPayload?.invokedBy ?? null,
          });
        }
        return { taskId: task.taskId, runs: matched };
      },
    },

    {
      name: "platos_tasks.get_run",
      description:
        "Fetch a single `TaskRun` (by friendly id `run_*` or full cuid). " +
        "Restricted to runs whose `taskIdentifier='platos-custom-task'` and " +
        "whose `runtimeEnvironmentId` + `projectId` match the caller's " +
        "scope. Returns the parsed payload + status + timings. Returns " +
        "`{ error: 'not_found' }` for cross-scope or non-platos-task runs.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: { runId: { type: "string" } },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const reqScope = scope as RequestScope;
        const runId = String(params["runId"]).trim();
        const isFriendly = runId.startsWith("run_");
        const where: Record<string, unknown> = {
          taskIdentifier: "platos-custom-task",
          runtimeEnvironmentId: reqScope.environmentId,
          projectId: reqScope.projectId,
        };
        where[isFriendly ? "friendlyId" : "id"] = runId;
        const run = await prisma.taskRun.findFirst({
          where,
          select: {
            id: true,
            friendlyId: true,
            status: true,
            statusReason: true,
            payload: true,
            payloadType: true,
            taskIdentifier: true,
            attemptNumber: true,
            createdAt: true,
            queuedAt: true,
            startedAt: true,
            executedAt: true,
            completedAt: true,
            usageDurationMs: true,
            costInCents: true,
            traceId: true,
            spanId: true,
          },
        });
        if (!run) return { error: "not_found", runId };
        let parsedPayload: unknown = null;
        if (typeof run.payload === "string") {
          try {
            parsedPayload = JSON.parse(run.payload);
          } catch {
            parsedPayload = null;
          }
        }
        // Confirm the run belongs to a task in this scope (defence in depth —
        // taskRowId in the payload must match a PlatosTask in the same scope).
        const taskRowId = (parsedPayload as any)?.taskRowId;
        if (taskRowId) {
          const task = await prisma.platosTask.findFirst({
            where: { id: String(taskRowId), ...scopeWhere(reqScope) },
            select: { id: true, taskId: true },
          });
          if (!task) return { error: "not_found", runId };
          return {
            run: {
              id: run.id,
              friendlyId: run.friendlyId,
              status: run.status,
              statusReason: run.statusReason,
              attemptNumber: run.attemptNumber,
              usageDurationMs: run.usageDurationMs,
              costInCents: run.costInCents,
              traceId: run.traceId,
              spanId: run.spanId,
              createdAt: toIso(run.createdAt),
              queuedAt: toIso(run.queuedAt),
              startedAt: toIso(run.startedAt),
              executedAt: toIso(run.executedAt),
              completedAt: toIso(run.completedAt),
              taskRowId: task.id,
              taskId: task.taskId,
              invokedBy: (parsedPayload as any)?.invokedBy ?? null,
              payload: (parsedPayload as any)?.payload ?? null,
            },
          };
        }
        return { error: "not_found", runId };
      },
    },

    {
      name: "platos_tasks.set_enabled",
      description:
        "Toggle the `isActive` flag on a task. Disabling a task makes it " +
        "non-dispatchable via `platos_tasks.run` and " +
        "`run_platos_task` meta-tool. Re-enabling will run a fresh " +
        "syntax check on the stored handler — if it fails, the call " +
        "rejects with `{ error: 'syntax_error' }` and `isActive` stays " +
        "false. Audit-logged.",
      inputSchema: {
        type: "object",
        required: ["id", "enabled"],
        properties: {
          id: { type: "string" },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      async execute(params, scope) {
        const startedAt = Date.now();
        const reqScope = scope as RequestScope;
        const id = String(params["id"]);
        const enabled = !!params["enabled"];
        const auditArgs = { id, enabled };

        const existing = await prisma.platosTask.findFirst({
          where: { id, ...scopeWhere(reqScope) },
          select: { id: true, taskId: true, handler: true, isActive: true },
        });
        if (!existing) {
          auditMutation(reqScope, "platos_tasks.set_enabled", auditArgs, null, "failed", startedAt, "not_found");
          return { error: "not_found", id };
        }
        if (existing.isActive === enabled) {
          // Idempotent no-op — audit + return without write.
          auditMutation(
            reqScope,
            "platos_tasks.set_enabled",
            auditArgs,
            { id, isActive: enabled, noOp: true },
            "success",
            startedAt,
          );
          return { id, taskId: existing.taskId, isActive: enabled, changed: false };
        }
        if (enabled) {
          const syntaxError = checkSyntax(existing.handler ?? "");
          if (syntaxError) {
            auditMutation(
              reqScope,
              "platos_tasks.set_enabled",
              auditArgs,
              null,
              "failed",
              startedAt,
              "syntax_error",
            );
            return { error: "syntax_error", message: syntaxError };
          }
        }
        try {
          const updated = await prisma.platosTask.update({
            where: { id },
            data: {
              isActive: enabled,
              ...(enabled
                ? { compiledHandler: existing.handler }
                : { compiledHandler: null }),
            },
            select: { id: true, taskId: true, isActive: true },
          });
          const result = { id: updated.id, taskId: updated.taskId, isActive: updated.isActive, changed: true };
          auditMutation(reqScope, "platos_tasks.set_enabled", auditArgs, result, "success", startedAt);
          return result;
        } catch (err: any) {
          const message = err?.message ?? String(err);
          auditMutation(reqScope, "platos_tasks.set_enabled", auditArgs, null, "failed", startedAt, message);
          return { error: "set_enabled_failed", message };
        }
      },
    },

    {
      name: "platos_tasks.validate_handler",
      description:
        "Compile-check a JavaScript handler source without executing it. " +
        "Uses `new Function(payload, ctx, source)` to surface parse errors. " +
        "Returns `{ valid: true }` on a clean parse, " +
        "`{ valid: false, error: '...' }` otherwise. No DB writes, no " +
        "audit — pure utility for the dashboard editor + agent IDE flows.\n\n" +
        "**SYNTAX: CommonJS only.** The runtime executor (platos-custom-task) " +
        "wraps the handler in a function expression, so use either:\n" +
        "  • a bare expression body that returns a value, or\n" +
        "  • `module.exports = async (payload, ctx) => { … }`\n" +
        "ESM syntax (`export default`, top-level `import`, top-level `await` " +
        "outside an async fn) WILL fail to compile here and at runtime — " +
        "this is intentional, the executor uses CommonJS-style `new Function` " +
        "rather than dynamic `import()`. If you need npm modules, use " +
        "`require(\"name\")` from inside the handler body.",
      inputSchema: {
        type: "object",
        required: ["handler"],
        properties: {
          handler: { type: "string", minLength: 1, maxLength: 200_000 },
        },
        additionalProperties: false,
      },
      async execute(params) {
        const handler = String(params["handler"]);
        // MCPF-followup — pre-detect ESM syntax + return a clearer error
        // than "Unexpected token 'export'". Matches the most common
        // failure modes; not a full parser. False positives are
        // acceptable because the handler executor would reject them
        // anyway.
        const esmHint = detectEsmSyntax(handler);
        if (esmHint) {
          return {
            valid: false,
            error: `${esmHint} — platos_tasks handlers run in a CommonJS context. Rewrite as \`module.exports = async (payload, ctx) => { … }\` and use \`require(...)\` for imports.`,
          };
        }
        const err = checkSyntax(handler);
        if (err === null) return { valid: true };
        return { valid: false, error: err };
      },
    },
  ];
}
