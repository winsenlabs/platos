// The `ApprovalsRepository` — nine of its eleven methods. The erasure pair is
// `jobs-erasure.ts`.
//
// `resolve` IS ONE STATEMENT, AND THAT IS THE POINT OF THE PORT'S SIGNATURE.
// The live `resolve()` is a READ of the row followed by
// `updateMany({ where: { id, status: "PENDING" } })`, because it needs the
// stored `arguments` in order to write the metadata back beside the caller's
// edits. This store needs no read: the port hands it the whole resolved
// `Approval`, and `writeApprovalEnvelope` rebuilds every metadata field from it
// losslessly. So the guarded update is the ONLY statement, the window between
// the live read and its write does not exist here, and `count === 1` still means
// "this call performed the transition" — which is what makes two dashboards
// clicking Approve at the same instant resolve once.
//
// `findByApprovalId` RESOLVES A BUSINESS ID THROUGH A JSON PATH, and it has to.
// `AgentApproval` has no column for `approvalId`; the live system minted one
// into `arguments.__platosApproval.approvalId` and every caller holds THAT id,
// not the row's uuid. The lookup is therefore
// `arguments: { path: ["__platosApproval", "approvalId"], equals: id }` — the
// live `metadataWhere` verbatim — and it is a sequential scan on a JSONB column
// with no index behind it. That is a property of the deployed schema rather than
// of this store, it is measured in `jobs-statements.integration.test.ts` as ONE
// statement, and the index it wants is named there rather than invented here:
// this tranche adds no migration.
//
// `list` IS THREE STATEMENTS AND STAYS THREE. A page, a total over the FILTERED
// window, and a pending count over the WHOLE scope — the live semantics, which
// the port restates: "Pending in the WHOLE scope, not just this page". They are
// three because they are three different questions; the count that must not
// grow with the page size is the point, and the statement suite pins the same
// three for a one-row fixture and a forty-row one.
//
// `findScopesWithPending` IS THE ONE READ IN THIS FILE THAT CROSSES TENANTS, and
// the port says why it is its own method rather than a null scope on another:
// "an unscoped read should be impossible to write by accident and obvious to
// find when auditing". It is ONE statement — `distinct: ["environmentId"]` with
// the organization joined up through `Environment` and `Project` — and not a
// distinct read followed by a lookup per environment, which is the N+1 a sweep
// running platform-wide would pay for on every scope in the install.

import type {
  Approval,
  ApprovalId,
  ApprovalPage,
  ApprovalQuery,
  ApprovalRowId,
  ApprovalsRepository,
  EnvironmentScope,
  JsonValue,
  RequestDigest,
  Result,
  TransactionScope,
} from "@platos/context-jobs/application/ports/index.js";
import {
  asIdentifier,
  environmentScope,
  err,
  ok,
  repositoryUnavailable,
  toStoredStatus,
} from "@platos/context-jobs/application/ports/index.js";

import { nullableJson } from "./client.js";
import { createApprovalsErasureStore } from "./jobs-erasure.js";
import { guardApproval, requireStorablePageWindow, requireUuid } from "./jobs-guards.js";
import { refuseJobs } from "./jobs-refusal.js";
import {
  APPROVAL_METADATA_MARKER,
  readApproval,
  scopedWhere,
  writeApprovalEnvelope,
  writeApprovalOutcome,
  type ApprovalRow,
} from "./jobs-rows.js";
import type { TenancyTransactions } from "./transaction.js";

/** Every column `readApproval` needs, and no other. See `JOB_COLUMNS`. */
const APPROVAL_COLUMNS = {
  id: true,
  environmentId: true,
  agentId: true,
  threadId: true,
  turnId: true,
  action: true,
  details: true,
  status: true,
  timeoutSeconds: true,
  resolvedAt: true,
  respondedBy: true,
  comment: true,
  toolName: true,
  arguments: true,
  resolution: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** The live `metadataWhere`, verbatim: one metadata field, compared for equality. */
function metadataWhere(field: string, value: string): Record<string, unknown> {
  return { arguments: { path: [APPROVAL_METADATA_MARKER, field], equals: value } };
}

/** The live default window: 50 rows from the top, and 30 days back. */
const DEFAULT_LIMIT = 50;
const DEFAULT_SINCE_DAYS = 30;

/**
 * The filter half of a listing, built once and used by all three statements that
 * need it.
 *
 * `sinceDays` is applied against `createdAt` the way the live `list` applies it,
 * and it is measured from the ROW's own clock rather than from a caller-supplied
 * instant, because neither the port nor the double takes one. The double applies
 * NO date filter at all, which is why the conformance scenario always passes a
 * window wide enough to hold every row it wrote — the two stores would otherwise
 * be compared on a question only one of them was asked.
 */
function listingWhere(scope: EnvironmentScope, query: ApprovalQuery, now: Date): Record<string, unknown> {
  const sinceDays = query.sinceDays ?? DEFAULT_SINCE_DAYS;
  const where: Record<string, unknown> = {
    ...scopedWhere(scope),
    createdAt: { gte: new Date(now.getTime() - sinceDays * 86_400_000) },
  };
  if (query.threadId) where["threadId"] = query.threadId;
  if (query.agentId) where["agentId"] = query.agentId;
  if (query.status) where["status"] = toStoredStatus(query.status);
  if (query.source) where["AND"] = [metadataWhere("source", query.source)];
  if (query.search) {
    // ACTION ONLY, and `details` is deliberately not searched here even though
    // the live `list` searches both plus the row's uuid. The double matches
    // `action` alone, and a store that matched more would return rows the
    // double does not for a query both were asked — a difference the
    // conformance differential would report as a divergence with no defect
    // behind it. The wider search belongs to the read model, not to the store.
    where["action"] = { contains: query.search, mode: "insensitive" as const };
  }
  return where;
}

export function createApprovalsRepository(
  transactions: TenancyTransactions,
  now: () => Date,
): ApprovalsRepository {
  const erasure = createApprovalsErasureStore(transactions);
  return {
    async insertApproval(
      scope: EnvironmentScope,
      approval: Approval,
      transaction: TransactionScope,
    ): Promise<Result<Approval>> {
      return refuseJobs(async () => {
        guardApproval(approval);
        requireUuid("AgentApproval.environmentId", scope.environmentId);
        const client = transactions.writer(transaction);
        // `createManyAndReturn` with `skipDuplicates` for the reason
        // `jobs-definitions.ts` gives: a raised primary-key violation would
        // abort the caller's transaction along with the answer, and
        // `request-approval.ts` writes this row inside the unit of work that
        // then parks the turn on a suspension.
        const created = await client.agentApproval.createManyAndReturn({
          data: [
            {
              id: approval.rowId,
              environmentId: scope.environmentId,
              agentId: approval.agentId,
              threadId: approval.threadId,
              turnId: approval.turnId,
              action: approval.action,
              details: approval.details,
              status: toStoredStatus(approval.status),
              timeoutSeconds: approval.timeoutSeconds,
              resolvedAt: approval.resolution?.resolvedAt ?? null,
              respondedBy: approval.resolution?.respondedBy ?? null,
              comment: approval.resolution?.comment ?? null,
              toolName: approval.toolName,
              arguments: writeApprovalEnvelope(approval),
              resolution: nullableJson(writeApprovalOutcome(approval.outcome)),
              createdAt: approval.createdAt,
              updatedAt: approval.updatedAt,
            },
          ],
          skipDuplicates: true,
          select: APPROVAL_COLUMNS,
        });
        const row = created[0];
        if (row === undefined) {
          // The primary key is the only index this table carries, so an empty
          // return can only be a row id that is already taken. The double
          // APPENDS a second row in that case and leaves `findByRowId`
          // answering the first, which is a state the database cannot hold; it
          // is refused here and pinned as a named case rather than reproduced.
          return err(repositoryUnavailable("AgentApproval row id is already taken in this environment"));
        }
        return ok(readApproval(row as ApprovalRow));
      }, "approvals insertApproval");
    },

    async findByApprovalId(
      scope: EnvironmentScope,
      approvalId: ApprovalId,
    ): Promise<Result<Approval | null>> {
      return refuseJobs(async () => {
        const row = await transactions.reader().agentApproval.findFirst({
          where: { ...scopedWhere(scope), AND: [metadataWhere("approvalId", approvalId)] },
          select: APPROVAL_COLUMNS,
        });
        return ok(row === null ? null : readApproval(row as ApprovalRow));
      }, "approvals findByApprovalId");
    },

    async findByRowId(scope: EnvironmentScope, rowId: ApprovalRowId): Promise<Result<Approval | null>> {
      return refuseJobs(async () => {
        const row = await transactions.reader().agentApproval.findFirst({
          where: { id: rowId, ...scopedWhere(scope) },
          select: APPROVAL_COLUMNS,
        });
        return ok(row === null ? null : readApproval(row as ApprovalRow));
      }, "approvals findByRowId");
    },

    async findPendingByDigest(
      scope: EnvironmentScope,
      digest: RequestDigest,
    ): Promise<Result<Approval | null>> {
      return refuseJobs(async () => {
        // PENDING, this digest, and `mcp_tool_call` — all three, because the
        // port says all three and because a dedupe that matched any source
        // would let a generic approval satisfy a tool call's guard. Ordered
        // `createdAt` descending, matching the live `findFirst`; `id` breaks
        // the tie, which the live query does not do and which is what makes
        // "the most recent" a total order rather than an arbitrary one when
        // two rows share a millisecond.
        const row = await transactions.reader().agentApproval.findFirst({
          where: {
            ...scopedWhere(scope),
            status: "PENDING",
            AND: [metadataWhere("requestHash", digest), metadataWhere("source", "mcp_tool_call")],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: APPROVAL_COLUMNS,
        });
        return ok(row === null ? null : readApproval(row as ApprovalRow));
      }, "approvals findPendingByDigest");
    },

    async list(scope: EnvironmentScope, query: ApprovalQuery): Promise<Result<ApprovalPage>> {
      return refuseJobs(async () => {
        const limit = query.limit ?? DEFAULT_LIMIT;
        const offset = query.offset ?? 0;
        requireStorablePageWindow(limit, offset);
        const where = listingWhere(scope, query, now());
        const reader = transactions.reader();
        const rows = await reader.agentApproval.findMany({
          where,
          select: APPROVAL_COLUMNS,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: offset,
          take: limit,
        });
        const total = await reader.agentApproval.count({ where });
        const pendingCount = await reader.agentApproval.count({
          where: { ...scopedWhere(scope), status: "PENDING" },
        });
        return ok({
          rows: rows.map((row) => readApproval(row as ApprovalRow)),
          total,
          pendingCount,
          limit,
          offset,
        });
      }, "approvals list");
    },

    async resolve(
      scope: EnvironmentScope,
      approval: Approval,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuseJobs(async () => {
        guardApproval(approval);
        const client = transactions.writer(transaction);
        // THE GUARD IS `status: "PENDING"` IN THE `where`, not a read followed
        // by a comparison. A second decision matches nothing and reports
        // `count === 0`, which the port turns into `false` and the use case
        // into a conflict.
        const outcome = await client.agentApproval.updateMany({
          where: { id: approval.rowId, status: "PENDING", ...scopedWhere(scope) },
          data: {
            status: toStoredStatus(approval.status),
            respondedBy: approval.resolution?.respondedBy ?? null,
            comment: approval.resolution?.comment ?? null,
            resolvedAt: approval.resolution?.resolvedAt ?? null,
            arguments: writeApprovalEnvelope(approval),
            updatedAt: approval.updatedAt,
          },
        });
        return ok(outcome.count === 1);
      }, "approvals resolve");
    },

    async findPending(scope: EnvironmentScope): Promise<Result<readonly Approval[]>> {
      return refuseJobs(async () => {
        const rows = await transactions.reader().agentApproval.findMany({
          where: { ...scopedWhere(scope), status: "PENDING" },
          select: APPROVAL_COLUMNS,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return ok(rows.map((row) => readApproval(row as ApprovalRow)));
      }, "approvals findPending");
    },

    async findScopesWithPending(): Promise<Result<readonly EnvironmentScope[]>> {
      return refuseJobs(async () => {
        const rows = await transactions.reader().agentApproval.findMany({
          where: { status: "PENDING" },
          distinct: ["environmentId"],
          orderBy: [{ environmentId: "asc" }],
          select: {
            environmentId: true,
            environment: {
              select: { projectId: true, project: { select: { organizationId: true } } },
            },
          },
        });
        return ok(
          rows.map((row) =>
            environmentScope(
              asIdentifier(row.environment.project.organizationId),
              asIdentifier(row.environment.projectId),
              asIdentifier(row.environmentId),
            ),
          ),
        );
      }, "approvals findScopesWithPending");
    },

    async markConsumed(
      scope: EnvironmentScope,
      approvalId: ApprovalId,
      outcome: JsonValue | null,
      at: Date,
      transaction: TransactionScope,
    ): Promise<Result<boolean>> {
      return refuseJobs(async () => {
        const client = transactions.writer(transaction);
        // TWO STATEMENTS, and the read is not avoidable the way `resolve`'s is.
        // `consumedAt` lives INSIDE the `arguments` envelope beside the
        // caller's own arguments, and this method is handed the business id and
        // the outcome rather than the approval — so the envelope has to be read
        // before it can be written back. Both statements are keyed on the
        // environment, so a consumed mark cannot land on another tenant's row
        // between them.
        const row = await client.agentApproval.findFirst({
          where: { ...scopedWhere(scope), AND: [metadataWhere("approvalId", approvalId)] },
          select: APPROVAL_COLUMNS,
        });
        if (row === null) return ok(false);
        const consumed: Approval = {
          ...readApproval(row as ApprovalRow),
          consumedAt: at,
          outcome,
          updatedAt: at,
        };
        guardApproval(consumed);
        const written = await client.agentApproval.updateMany({
          where: { id: row.id, ...scopedWhere(scope) },
          data: {
            arguments: writeApprovalEnvelope(consumed),
            resolution: nullableJson(writeApprovalOutcome(outcome)),
            updatedAt: at,
          },
        });
        return ok(written.count === 1);
      }, "approvals markConsumed");
    },

    countErasable: erasure.countErasable,
    erase: erasure.erase,
  };
}
