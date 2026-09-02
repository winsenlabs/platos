// The `ApprovalsRepository` port — sole-writer access to `AgentApproval`.
//
// TWO IDENTIFIERS, TWO LOOKUPS. A row has a uuid primary key AND a business
// `approvalId` stored in its JSON metadata (`domain/identifiers.ts`). Every live
// caller holds the SECOND, so `findByApprovalId` is the method the application
// actually uses and `findByRowId` exists for the erasure path, which walks rows
// rather than requests. Both are scoped.
//
// `resolve` IS A CONDITIONAL WRITE, NOT A SAVE. The live implementation is
// `updateMany({ where: { id, status: "PENDING" } })` and reports `count === 1`,
// which is what makes two dashboards clicking Approve at the same instant resolve
// once. Expressing that as `save(approval)` would lose the guard and the race
// would silently produce a last-writer-wins overwrite, so the port keeps the
// precondition in its signature: it returns `false` when the row was no longer
// pending, and the use case turns that into a conflict.

import type { EnvironmentScope, Result, TenantScope, TransactionScope } from "@platos/kernel";

import type {
  Approval,
  ApprovalId,
  ApprovalRowId,
  ApprovalStatus,
  RequestDigest,
} from "../../domain/index.js";

/** The filters the live approvals list supports. */
export interface ApprovalQuery {
  readonly threadId?: string | null;
  readonly agentId?: string | null;
  readonly status?: ApprovalStatus | null;
  readonly source?: string | null;
  /** The live default window is 30 days. */
  readonly sinceDays?: number | null;
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly search?: string | null;
}

export interface ApprovalPage {
  readonly rows: readonly Approval[];
  readonly total: number;
  /** Pending in the WHOLE scope, not just this page — the live semantics. */
  readonly pendingCount: number;
  readonly limit: number;
  readonly offset: number;
}

/** What identifies the subject of an erasure inside this context's rows. */
export interface JobsErasureSelector {
  readonly scope: TenantScope;
  /** Matches `AgentApproval.respondedBy` and the requester in metadata. */
  readonly principalId: string | null;
}

export interface ApprovalsRepository {
  insertApproval(
    scope: EnvironmentScope,
    approval: Approval,
    transaction: TransactionScope,
  ): Promise<Result<Approval>>;

  findByApprovalId(scope: EnvironmentScope, approvalId: ApprovalId): Promise<Result<Approval | null>>;

  findByRowId(scope: EnvironmentScope, rowId: ApprovalRowId): Promise<Result<Approval | null>>;

  /**
   * The dedupe lookup: the most recent PENDING approval in this scope whose
   * digest matches and whose source is `mcp_tool_call`. Ordered by `createdAt`
   * descending, matching the live `findFirst`.
   */
  findPendingByDigest(scope: EnvironmentScope, digest: RequestDigest): Promise<Result<Approval | null>>;

  list(scope: EnvironmentScope, query: ApprovalQuery): Promise<Result<ApprovalPage>>;

  /**
   * Conditional write. Returns `true` when THIS call performed the transition and
   * `false` when the row was already decided. Never overwrites a decision.
   */
  resolve(
    scope: EnvironmentScope,
    approval: Approval,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  /** Every pending row in the scope, for the sweep to judge. */
  findPending(scope: EnvironmentScope): Promise<Result<readonly Approval[]>>;

  /**
   * Every scope that currently holds a pending approval.
   *
   * The sweep runs platform-wide and the live implementation gets here with a
   * `distinct: ["environmentId"]` read that joins up to the organization. It is a
   * READ ACROSS TENANTS, which is why it is its own method rather than a `null`
   * scope on another: an unscoped read should be impossible to write by accident
   * and obvious to find when auditing.
   */
  findScopesWithPending(): Promise<Result<readonly EnvironmentScope[]>>;

  /** Record that an approved call has actually been carried out. */
  markConsumed(
    scope: EnvironmentScope,
    approvalId: ApprovalId,
    outcome: Approval["outcome"],
    at: Date,
    transaction: TransactionScope,
  ): Promise<Result<boolean>>;

  countErasable(selector: JobsErasureSelector): Promise<Result<number>>;

  erase(selector: JobsErasureSelector, transaction: TransactionScope): Promise<Result<number>>;
}
