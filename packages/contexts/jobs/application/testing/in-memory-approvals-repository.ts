// An in-memory `ApprovalsRepository`.
//
// The property this double exists to make real is the CONDITIONAL RESOLVE. The
// live `resolve` is `updateMany({ where: { id, status: "PENDING" } })` reporting
// `count === 1`, so a second decision lands on nothing. A double that simply
// stored whatever it was handed would make every double-resolve test pass
// vacuously — the race defence would be untested precisely where it matters.
//
// The dedupe lookup is likewise real: most-recent-first, pending only, and
// `mcp_tool_call` only, matching the live `findFirst`.

import { err, ok, type EnvironmentScope, type JsonValue, type Result, type TransactionScope } from "@platos/kernel";

import {
  environmentFallsWithin,
  repositoryUnavailable,
  type Approval,
  type ApprovalId,
  type ApprovalRowId,
  type RequestDigest,
} from "../../domain/index.js";
import type {
  ApprovalPage,
  ApprovalQuery,
  ApprovalsRepository,
  JobsErasureSelector,
} from "../ports/index.js";

interface Stored {
  readonly scope: EnvironmentScope;
  approval: Approval;
}

export class InMemoryApprovalsRepository implements ApprovalsRepository {
  private readonly rows: Stored[] = [];
  private pendingFailure: string | null = null;
  private findPendingFailure: string | null = null;
  private resolveFailure: string | null = null;
  private beforeResolve: (() => void) | null = null;

  /** Make the NEXT call — whichever it is — fail, once. */
  failNext(reason = "injected"): void {
    this.pendingFailure = reason;
  }

  /**
   * Make the next per-scope `findPending` fail, once, leaving the cross-tenant
   * scope enumeration intact. Targeted rather than call-counted so a test can say
   * "this ONE scope is broken" without depending on call order.
   */
  failNextFindPending(reason = "injected"): void {
    this.findPendingFailure = reason;
  }

  /**
   * Make the next `resolve` fail, once.
   *
   * Targeted rather than using `failNext`, for the same reason
   * `failNextFindPending` is: a sweep calls `findPending` and then `resolve`, so
   * an untargeted one-shot is always consumed by the read and the write-failure
   * branch is unreachable.
   */
  failNextResolve(reason = "injected"): void {
    this.resolveFailure = reason;
  }

  /**
   * Run `rival` exactly once, immediately BEFORE the next guarded update.
   *
   * This is the only way to express the race the conditional write defends
   * against: two callers both read a pending row, then both write. Resolving
   * twice through the use case cannot reach it — the second call re-reads a row
   * that is no longer pending and is refused by the domain before any write.
   * One-shot, so a rival that itself resolves does not recurse.
   */
  beforeNextResolve(rival: () => void): void {
    this.beforeResolve = rival;
  }

  private takeFailure<Value>(): Result<Value> | null {
    if (this.pendingFailure === null) return null;
    const reason = this.pendingFailure;
    this.pendingFailure = null;
    return err(repositoryUnavailable(reason));
  }

  private inScope(scope: EnvironmentScope): Stored[] {
    return this.rows.filter(
      (row) =>
        row.scope.organizationId === scope.organizationId &&
        row.scope.projectId === scope.projectId &&
        row.scope.environmentId === scope.environmentId,
    );
  }

  async insertApproval(
    scope: EnvironmentScope,
    approval: Approval,
    _transaction: TransactionScope,
  ): Promise<Result<Approval>> {
    const failure = this.takeFailure<Approval>();
    if (failure) return failure;
    this.rows.push({ scope, approval });
    return ok(approval);
  }

  async findByApprovalId(scope: EnvironmentScope, approvalId: ApprovalId): Promise<Result<Approval | null>> {
    const failure = this.takeFailure<Approval | null>();
    if (failure) return failure;
    const row = this.inScope(scope).find((candidate) => candidate.approval.approvalId === approvalId);
    return ok(row ? row.approval : null);
  }

  async findByRowId(scope: EnvironmentScope, rowId: ApprovalRowId): Promise<Result<Approval | null>> {
    const failure = this.takeFailure<Approval | null>();
    if (failure) return failure;
    const row = this.inScope(scope).find((candidate) => candidate.approval.rowId === rowId);
    return ok(row ? row.approval : null);
  }

  async findPendingByDigest(
    scope: EnvironmentScope,
    digest: RequestDigest,
  ): Promise<Result<Approval | null>> {
    const failure = this.takeFailure<Approval | null>();
    if (failure) return failure;
    const matches = this.inScope(scope)
      .filter(
        (row) =>
          row.approval.status === "pending" &&
          row.approval.requestDigest === digest &&
          row.approval.source === "mcp_tool_call",
      )
      .sort((left, right) => right.approval.createdAt.getTime() - left.approval.createdAt.getTime());
    return ok(matches.length > 0 ? (matches[0] as Stored).approval : null);
  }

  async list(scope: EnvironmentScope, query: ApprovalQuery): Promise<Result<ApprovalPage>> {
    const failure = this.takeFailure<ApprovalPage>();
    if (failure) return failure;
    const all = this.inScope(scope).map((row) => row.approval);
    const filtered = all.filter((approval) => {
      if (query.threadId && approval.threadId !== query.threadId) return false;
      if (query.agentId && approval.agentId !== query.agentId) return false;
      if (query.status && approval.status !== query.status) return false;
      if (query.source && approval.source !== query.source) return false;
      if (query.search && !approval.action.toLowerCase().includes(query.search.toLowerCase())) return false;
      return true;
    });
    const ordered = [...filtered].sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    return ok({
      rows: ordered.slice(offset, offset + limit),
      total: ordered.length,
      // Pending across the WHOLE scope, not the filtered page — live semantics.
      pendingCount: all.filter((approval) => approval.status === "pending").length,
      limit,
      offset,
    });
  }

  async resolve(
    scope: EnvironmentScope,
    approval: Approval,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    if (this.beforeResolve !== null) {
      const rival = this.beforeResolve;
      this.beforeResolve = null;
      rival();
    }
    if (this.resolveFailure !== null) {
      const reason = this.resolveFailure;
      this.resolveFailure = null;
      return err(repositoryUnavailable(reason));
    }
    const failure = this.takeFailure<boolean>();
    if (failure) return failure;
    const row = this.inScope(scope).find((candidate) => candidate.approval.rowId === approval.rowId);
    if (!row) return ok(false);
    // THE GUARD: only a still-pending row transitions.
    if (row.approval.status !== "pending") return ok(false);
    row.approval = approval;
    return ok(true);
  }

  async findPending(scope: EnvironmentScope): Promise<Result<readonly Approval[]>> {
    if (this.findPendingFailure !== null) {
      const reason = this.findPendingFailure;
      this.findPendingFailure = null;
      return err(repositoryUnavailable(reason));
    }
    const failure = this.takeFailure<readonly Approval[]>();
    if (failure) return failure;
    return ok(this.inScope(scope).filter((row) => row.approval.status === "pending").map((row) => row.approval));
  }

  async findScopesWithPending(): Promise<Result<readonly EnvironmentScope[]>> {
    const failure = this.takeFailure<readonly EnvironmentScope[]>();
    if (failure) return failure;
    const seen = new Map<string, EnvironmentScope>();
    for (const row of this.rows) {
      if (row.approval.status !== "pending") continue;
      const key = `${row.scope.organizationId}/${row.scope.projectId}/${row.scope.environmentId}`;
      if (!seen.has(key)) seen.set(key, row.scope);
    }
    return ok([...seen.values()]);
  }

  async markConsumed(
    scope: EnvironmentScope,
    approvalId: ApprovalId,
    outcome: JsonValue | null,
    at: Date,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const failure = this.takeFailure<boolean>();
    if (failure) return failure;
    const row = this.inScope(scope).find((candidate) => candidate.approval.approvalId === approvalId);
    if (!row) return ok(false);
    row.approval = { ...row.approval, consumedAt: at, outcome, updatedAt: at };
    return ok(true);
  }

  private erasable(selector: JobsErasureSelector): Stored[] {
    if (selector.principalId === null) return [];
    return this.rows.filter(
      (row) =>
        environmentFallsWithin(selector.scope, row.scope) &&
        (row.approval.requestedBy === selector.principalId ||
          row.approval.resolution?.respondedBy === selector.principalId),
    );
  }

  async countErasable(selector: JobsErasureSelector): Promise<Result<number>> {
    const failure = this.takeFailure<number>();
    if (failure) return failure;
    return ok(this.erasable(selector).length);
  }

  async erase(selector: JobsErasureSelector, _transaction: TransactionScope): Promise<Result<number>> {
    const failure = this.takeFailure<number>();
    if (failure) return failure;
    const doomed = new Set(this.erasable(selector));
    let erased = 0;
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (doomed.has(this.rows[index] as Stored)) {
        this.rows.splice(index, 1);
        erased += 1;
      }
    }
    return ok(erased);
  }

  size(): number {
    return this.rows.length;
  }

  /**
   * Overwrite the stored row for an approval, without going through `resolve`.
   *
   * Only for arranging the RIVAL half of a race: the other caller's write has
   * already landed by the time ours reaches the guard. Going through `resolve`
   * would re-enter the hook that scheduled it.
   */
  forceStored(scope: EnvironmentScope, approval: Approval): void {
    const row = this.inScope(scope).find((candidate) => candidate.approval.rowId === approval.rowId);
    if (row) row.approval = approval;
  }
}
