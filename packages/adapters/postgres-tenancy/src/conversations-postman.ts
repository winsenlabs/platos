// The `PostmanRepository` — `PostmanExecution`, the one row this context writes
// on an OPERATOR's behalf rather than an end user's.
//
// TWO LOOKUPS, TWO CONSTRAINTS, AND THE NULL TEMPLATE IS THE INTERESTING ONE.
// `findByRequest` answers `@@unique([templateId, requestId])`. In PostgreSQL a
// UNIQUE index treats NULLs as DISTINCT, so a null `templateId` makes that
// constraint vacuous — two ad-hoc requests carrying the same `requestId` are
// both accepted. The port says so and says what to do about it: a null template
// answers null and the caller creates. This store therefore answers null
// WITHOUT SENDING A STATEMENT, which is stronger than filtering on null would
// be: a filter would find the row a previous ad-hoc request left behind and
// report a replay the constraint never prevented.
//
// `findByHandle` answers `contextHandle @unique`, and the handle is a
// CAPABILITY. `domain/postman-execution.ts` brands it for that reason, and
// nothing here logs it or puts it in a refusal message; the guard that checks
// its shape names the FIELD and never the value.
//
// ---------------------------------------------------------------------------
// `saveExecution` WRITES EIGHT COLUMNS, AND THE OTHER SEVEN ARE FORBIDDEN
// ---------------------------------------------------------------------------
//
// `prevent_postman_execution_attribution_mutation` fires BEFORE UPDATE and
// raises SQLSTATE 55000 — not 23514, which every CHECK in this schema raises —
// if `environmentId`, `agentId`, `requestId`, `requestFingerprint`,
// `actorUserId`, `contextHandle` or `createdAt` differs from the stored row. It
// is a FORENSIC record of who ran what against which agent, and the rule says
// so in its own message. So the update names the eight columns a settlement may move
// and nothing else, and `conversations-rules.integration.test.ts` proves the
// database refuses a write to one of the seven.
//
// THE ANCESTRY RULE ADDS ONE MORE COUPLING NOTHING ELSE STATES: the `LEFT JOIN`
// that resolves `turnId` requires the turn to belong to the row's own `threadId`,
// so a `turnId` with a null `threadId` can never resolve and the row is refused
// as crossing its ancestry. `guardExecutionWrite` refuses that pair before the
// statement, with its own code, because the database's message would say
// "crosses its canonical owner ancestry" and name neither column.

import {
  err,
  ok,
  postmanNotFound,
  type EnvironmentScope,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type PostmanPage,
  type PostmanPageQuery,
  type PostmanRepository,
  type PostmanTemplateId,
  type Result,
} from "@platos/context-conversations/application/ports/index.js";

import { guardExecutionWrite } from "./conversations-guards.js";
import { refuse } from "./conversations-refusal.js";
import {
  readPostmanExecution,
  scopedWhere,
  type PostmanExecutionRow,
} from "./conversations-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** Every column `readPostmanExecution` reads. One place, so no read is wider. */
const EXECUTION_COLUMNS = {
  id: true,
  agentId: true,
  templateId: true,
  requestId: true,
  requestFingerprint: true,
  actorUserId: true,
  simulatedEndUserId: true,
  contextHandle: true,
  contextExpiresAt: true,
  status: true,
  threadId: true,
  turnId: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function createPostmanRepository(transactions: TenancyTransactions): PostmanRepository {
  return {
    async findExecution(
      scope: EnvironmentScope,
      executionId: PostmanExecutionId,
    ): Promise<Result<PostmanExecution | null>> {
      return refuse(async () => {
        const row = await transactions.reader().postmanExecution.findFirst({
          where: { id: executionId, ...scopedWhere(scope) },
          select: EXECUTION_COLUMNS,
        });
        return ok(row === null ? null : readPostmanExecution(row as PostmanExecutionRow));
      }, "postman findExecution");
    },

    async findByRequest(
      scope: EnvironmentScope,
      templateId: PostmanTemplateId | null,
      requestId: string,
    ): Promise<Result<PostmanExecution | null>> {
      return refuse(async () => {
        // NO STATEMENT AT ALL for a null template; see the header. The
        // constraint the caller is asking about does not exist for this row, and
        // reporting a row it did not prevent would be a replay refusal for a
        // request that is not one.
        if (templateId === null) return ok(null);
        const row = await transactions.reader().postmanExecution.findFirst({
          where: { templateId, requestId, ...scopedWhere(scope) },
          select: EXECUTION_COLUMNS,
        });
        return ok(row === null ? null : readPostmanExecution(row as PostmanExecutionRow));
      }, "postman findByRequest");
    },

    async findByHandle(
      scope: EnvironmentScope,
      handle: PostmanContextHandle,
    ): Promise<Result<PostmanExecution | null>> {
      return refuse(async () => {
        // SCOPED, though `contextHandle` is unique INSTALLATION-WIDE. Without the
        // environment in the WHERE, a handle minted in one tenant would resolve
        // an execution in another for whoever holds it — and the handle is a
        // capability, so "whoever holds it" is the whole threat model.
        const row = await transactions.reader().postmanExecution.findFirst({
          where: { contextHandle: handle, ...scopedWhere(scope) },
          select: EXECUTION_COLUMNS,
        });
        return ok(row === null ? null : readPostmanExecution(row as PostmanExecutionRow));
      }, "postman findByHandle");
    },

    async pageExecutions(query: PostmanPageQuery): Promise<Result<PostmanPage>> {
      return refuse(async () => {
        const where = {
          ...scopedWhere(query.scope),
          ...(query.actorUserId === null ? {} : { actorUserId: query.actorUserId }),
        };
        const reader = transactions.reader();
        const rows = await reader.postmanExecution.findMany({
          where,
          select: EXECUTION_COLUMNS,
          // `createdAt` descending is the order `PostmanExecution_environmentId_createdAt_idx`
          // and `PostmanExecution_actorUserId_createdAt_idx` both exist for, and
          // `id` breaks the tie so the order is TOTAL over a `timestamp(3)`.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: query.offset,
          take: query.limit,
        });
        const total = await reader.postmanExecution.count({ where });
        return ok({
          items: rows.map((row) => readPostmanExecution(row as PostmanExecutionRow)),
          total,
        });
      }, "postman pageExecutions");
    },

    async createExecution(
      scope: EnvironmentScope,
      execution: PostmanExecution,
    ): Promise<Result<PostmanExecution>> {
      return refuse(async () => {
        guardExecutionWrite(execution);
        const row = await transactions.reader().postmanExecution.create({
          data: {
            id: execution.executionId,
            environmentId: scope.environmentId,
            agentId: execution.agentId,
            templateId: execution.templateId,
            requestId: execution.requestId,
            requestFingerprint: execution.requestFingerprint,
            actorUserId: execution.actorUserId,
            simulatedEndUserId: execution.simulatedEndUserId,
            contextHandle: execution.contextHandle,
            contextExpiresAt: execution.contextExpiresAt,
            status: execution.status,
            threadId: execution.threadId,
            turnId: execution.turnId,
            completedAt: execution.completedAt,
            createdAt: execution.createdAt,
            updatedAt: execution.updatedAt,
          },
          select: EXECUTION_COLUMNS,
        });
        return ok(readPostmanExecution(row as PostmanExecutionRow));
      }, "postman createExecution");
    },

    async saveExecution(
      scope: EnvironmentScope,
      execution: PostmanExecution,
    ): Promise<Result<PostmanExecution>> {
      return refuse(async () => {
        guardExecutionWrite(execution);
        return transactions.atomic(async (client) => {
          const updated = await client.postmanExecution.updateMany({
            where: { id: execution.executionId, ...scopedWhere(scope) },
            // EIGHT COLUMNS, and they are exactly the ones the rule leaves
            // alone. The other seven — `environmentId`, `agentId`, `requestId`,
            // `requestFingerprint`, `actorUserId`, `contextHandle`, `createdAt`
            // — are the forensic attribution, immutable under a rule of their
            // own; see the header.
            data: {
              templateId: execution.templateId,
              simulatedEndUserId: execution.simulatedEndUserId,
              contextExpiresAt: execution.contextExpiresAt,
              status: execution.status,
              threadId: execution.threadId,
              turnId: execution.turnId,
              completedAt: execution.completedAt,
              updatedAt: execution.updatedAt,
            },
          });
          if (updated.count === 0) return err(postmanNotFound(execution.executionId));
          const row = await client.postmanExecution.findFirst({
            where: { id: execution.executionId, ...scopedWhere(scope) },
            select: EXECUTION_COLUMNS,
          });
          if (row === null) return err(postmanNotFound(execution.executionId));
          return ok(readPostmanExecution(row as PostmanExecutionRow));
        });
      }, "postman saveExecution");
    },
  };
}
