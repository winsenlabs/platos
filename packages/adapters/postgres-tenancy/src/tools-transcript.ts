// `ToolCall`, `ToolHealth` and `ToolCallAudit` — what happened, three ways.
//
// `ToolCall` HAS NO TENANT COLUMN AND ITS ANCESTRY IS THREE JOINS DEEP. The row
// hangs off `Step -> Turn -> Thread -> Environment`, so the tenant clause is a
// nested filter through all three; a method keyed on `stepId` alone would read
// and write another environment's transcript for anyone holding a step uuid.
// The clause is IN the read's own statement and is a separate resolve before
// the write, for the reason `./tools-mcp.ts` gives: a read of a foreign step and
// a read of an absent one must look the same, and a write must not.
//
// `ToolHealth`'s UNIQUE KEY DOES NOT BIND WHEN `entityExternalId` IS NULL, and
// this is the sharpest thing the real database said that the double does not.
// `@@unique([environmentId, toolId, entityExternalId])` becomes a PostgreSQL
// unique index, and PostgreSQL's default is NULLS DISTINCT: two rows carrying
// `(env, tool, NULL)` do not collide. The generated client agrees from the other
// direction — its compound-unique input types `entityExternalId` as `string`,
// not `string | null` — so the key cannot even be NAMED for such a row. The
// double's `healthKey` encodes null as its own case and therefore dedupes it.
// So `saveHealth` is an upsert on the PRIMARY KEY, which is the only key that
// addresses every row, and the RACE the compound key would otherwise have closed
// stays open for entity-less tools: two concurrent folds that both miss the read
// mint two ids and insert two rows. It is pinned as a named case rather than
// papered over, because the fix is a partial unique index in a migration and
// this adapter may not write one.
//
// THE AUDIT WINDOW IS ENFORCED HERE AND NOWHERE ELSE. `AuditQuery.sinceDays` is
// a number of days rather than an instant, so somebody has to read a clock; the
// port hands this store no `Clock`, and `ToolsDependencies` keeps its own for the
// use cases. Ignoring the field would have been the quiet option and the wrong
// one — an operator who asked for seven days would get everything — so the wall
// clock is read here, once per call, and `auditWindowStart` (the domain rule)
// turns it into the bound. The in-memory double implements none of the four
// filters except `toolName`; that gap is pinned separately rather than copied.

import type {
  AuditEntry,
  AuditQuery,
  EnvironmentScope,
  ExternalEntityId,
  Result,
  ToolCall,
  ToolHealth,
  ToolId,
} from "@platos/context-tools/application/ports/index.js";
import {
  auditWindowStart,
  err,
  ok,
  repositoryUnavailable,
} from "@platos/context-tools/application/ports/index.js";

import { TENANCY_JSON_DB_NULL } from "./client.js";
import {
  toAuditEntry,
  toToolCall,
  writeAuditArguments,
  writeResult,
  type AuditRow,
  type ToolCallRow,
} from "./tools-audit-rows.js";
import { toHealth, type ToolHealthRow } from "./tools-rows.js";
import { inScope } from "./tools-scope.js";
import type { TenancyTransactions } from "./transaction.js";

/** A step whose thread is in another environment, or in none. */
export const TOOLS_STEP_FOREIGN = "step_out_of_scope";

export interface ToolsTranscript {
  listStepCalls(scope: EnvironmentScope, stepId: string): Promise<Result<readonly ToolCall[]>>;
  saveCall(scope: EnvironmentScope, call: ToolCall): Promise<Result<ToolCall>>;
  findHealth(
    scope: EnvironmentScope,
    toolId: ToolId,
    entityExternalId: ExternalEntityId | null,
  ): Promise<Result<ToolHealth | null>>;
  saveHealth(scope: EnvironmentScope, health: ToolHealth): Promise<Result<ToolHealth>>;
  appendAudit(scope: EnvironmentScope, entry: AuditEntry): Promise<Result<AuditEntry>>;
  pageAudit(scope: EnvironmentScope, query: AuditQuery): Promise<Result<readonly AuditEntry[]>>;
}

/**
 * The fourteen columns `ToolCallRow` declares, and the sixteen `AuditRow` does.
 *
 * WIN-258 T7. Both tables carry TWO JSONB columns, and `ToolCallAudit.result`
 * holds whatever a tool returned — the largest documents this schema stores.
 * `pageAudit` reads a window of them per page, so an unprojected read there is
 * the one place in this package where widening the table would be felt as
 * megabytes rather than as bytes. Both assertions below already named the
 * columns; the selects make them true of the statement.
 */
const CALL_SELECT = {
  id: true,
  stepId: true,
  toolId: true,
  sequence: true,
  toolName: true,
  arguments: true,
  result: true,
  status: true,
  retryCount: true,
  error: true,
  latencyMs: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
} as const;

const AUDIT_SELECT = {
  id: true,
  environmentId: true,
  toolId: true,
  toolName: true,
  agentId: true,
  threadId: true,
  endUserId: true,
  traceId: true,
  arguments: true,
  result: true,
  error: true,
  status: true,
  latencyMs: true,
  costCents: true,
  createdAt: true,
} as const;

/**
 * A value the client will accept for a NULLABLE `Json` column.
 *
 * `null` is not one: the client refuses it as a validation error rather than
 * storing SQL NULL, and its OTHER sentinel would store the JSON scalar `null`,
 * which the json-root CHECK refuses. See `./client.ts`.
 */
function writeJson(value: unknown): never {
  return (value === null || value === undefined ? TENANCY_JSON_DB_NULL : value) as never;
}

export function createToolsTranscript(transactions: TenancyTransactions): ToolsTranscript {
  /** `Step -> Turn -> Thread -> Environment`, spelled once. */
  const stepInScope = (scope: EnvironmentScope) => ({
    turn: { thread: { environmentId: scope.environmentId } },
  });

  return {
    async listStepCalls(scope, stepId) {
      return inScope(transactions, scope, "listStepCalls", async () => {
        const rows = (await transactions.reader().toolCall.findMany({
          where: { stepId, step: stepInScope(scope) },
          orderBy: { sequence: "asc" },
          select: CALL_SELECT,
        })) as unknown as readonly ToolCallRow[];
        return ok(rows.map(toToolCall));
      });
    },

    async saveCall(scope, call) {
      return inScope(transactions, scope, "saveCall", async () => {
        const step = await transactions.reader().step.findFirst({
          where: { id: call.stepId, ...stepInScope(scope) },
          select: { id: true },
        });
        if (step === null) return err(repositoryUnavailable(`${TOOLS_STEP_FOREIGN}:saveCall`));
        const mutable = {
          toolId: call.toolId,
          sequence: call.sequence,
          toolName: call.toolName,
          arguments: { ...call.arguments } as never,
          // The json-root CHECK admits only an object or an array, and the
          // record's `result` is `unknown`. See `./tools-audit-rows.ts`.
          result: writeJson(writeResult(call.result)),
          status: call.status,
          retryCount: call.retryCount,
          error: call.error,
          latencyMs: call.latencyMs,
          startedAt: call.startedAt,
          completedAt: call.completedAt,
        };
        const row = (await transactions.atomic((client) =>
          client.toolCall.upsert({
            where: { id: call.toolCallId },
            create: { id: call.toolCallId, stepId: call.stepId, ...mutable, createdAt: call.createdAt },
            // `stepId` and `createdAt` are NOT updated. A call belongs to the
            // step it was made in, and moving one would rewrite a transcript.
            update: mutable,
          }),
        )) as unknown as ToolCallRow;
        return ok(toToolCall(row));
      });
    },

    async findHealth(scope, toolId, entityExternalId) {
      return inScope(transactions, scope, "findHealth", async () => {
        const row = (await transactions.reader().toolHealth.findFirst({
          // `findFirst`, not `findUnique`: the compound key cannot express the
          // null case at all. See the header.
          where: { environmentId: scope.environmentId, toolId, entityExternalId },
          orderBy: { id: "asc" },
        })) as ToolHealthRow | null;
        return ok(row === null ? null : toHealth(row));
      });
    },

    async saveHealth(scope, health) {
      return inScope(transactions, scope, "saveHealth", async () => {
        const mutable = {
          lastCalledAt: health.lastCalledAt,
          lastStatus: health.lastStatus,
          failCount: health.failCount,
          totalCalls: health.totalCalls,
          totalFailures: health.totalFailures,
          avgLatencyMs: health.avgLatencyMs,
          p95LatencyMs: health.p95LatencyMs,
        };
        const row = (await transactions.atomic((client) =>
          client.toolHealth.upsert({
            // THE PRIMARY KEY, because it is the only key that addresses a row
            // whose `entityExternalId` is null. The caller minted this id after
            // a `findHealth` that missed, so an upsert on it is the same
            // read-modify-write the fold already performed.
            where: { id: health.toolHealthId },
            create: {
              id: health.toolHealthId,
              environmentId: health.environmentId,
              toolId: health.toolId,
              entityExternalId: health.entityExternalId,
              ...mutable,
            },
            update: mutable,
          }),
        )) as ToolHealthRow;
        return ok(toHealth(row));
      });
    },

    async appendAudit(scope, entry) {
      return inScope(transactions, scope, "appendAudit", async () => {
        const row = (await transactions.atomic((client) =>
          client.toolCallAudit.create({
            data: {
              id: entry.toolCallAuditId,
              environmentId: entry.environmentId,
              toolId: entry.toolId,
              toolName: entry.toolName,
              agentId: entry.agentId,
              threadId: entry.threadId,
              endUserId: entry.endUserId,
              traceId: entry.traceId,
              arguments: writeAuditArguments(entry) as never,
              result: writeJson(writeResult(entry.result)),
              error: entry.error,
              status: entry.status,
              latencyMs: entry.latencyMs,
              costCents: entry.costCents,
              createdAt: entry.createdAt,
            },
          }),
        )) as unknown as AuditRow;
        return ok(toAuditEntry(row));
      });
    },

    async pageAudit(scope, query) {
      return inScope(transactions, scope, "pageAudit", async () => {
        const rows = (await transactions.reader().toolCallAudit.findMany({
          where: {
            environmentId: scope.environmentId,
            createdAt: { gte: auditWindowStart(query, new Date()) },
            ...(query.toolName ? { toolName: query.toolName } : {}),
            ...(query.agentId ? { agentId: query.agentId } : {}),
            ...(query.threadId ? { threadId: query.threadId } : {}),
            ...(query.status ? { status: query.status } : {}),
          },
          // Newest first, then by id — the order `byAuditOrder` states. The id
          // tie-break is what makes it TOTAL: a step's calls are dispatched in
          // parallel, so several rows sharing a millisecond is the common case,
          // and a paged listing whose order is not total drops and repeats.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: AUDIT_SELECT,
          skip: query.offset,
          take: query.limit,
        })) as unknown as readonly AuditRow[];
        return ok(rows.map(toAuditEntry));
      });
    },
  };
}
