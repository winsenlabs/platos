// An in-memory `PrivacyRepository`.
//
// Three behaviours here are load-bearing rather than convenient, and each mirrors
// a constraint the real schema enforces:
//
//   * `@@unique([organizationId, idempotencyKey])` is upheld — a second insert at
//     an occupied key returns `PRIVACY_IDEMPOTENCY_KEY_CONFLICT`, exactly as the
//     adapter is required to. Without it, the race branch would be untestable.
//
//   * `@@unique([organizationId, aliasHash])` is upheld, and sealing is
//     insert-then-extend rather than delete-then-insert. A double that replaced
//     rows would make the "barrier never momentarily opens" property vacuous.
//
//   * `findActiveTombstones` applies read-time expiry. A double that returned
//     elapsed rows would make every retention test pass for the wrong reason.
//
// `claimLease` is a genuine compare-and-set over one map entry, so two callers
// racing it behave as they would against the row.

import { err, ok, type OrganizationId, type Result, type TransactionScope } from "@platos/kernel";

import {
  idempotencyKeyConflict,
  isActive,
  operationNotFound,
  type AliasHash,
  type ErasureOperationId,
  type ErasureTombstone,
  type ErasureTombstoneId,
  type IdempotencyKey,
  type LeaseToken,
  type PersistedErasureOperation,
  type SubjectKeyHash,
  type TombstoneDraft,
} from "../../domain/index.js";
import { isLeaseFree } from "../../domain/index.js";
import type { OperationProgressWrite, PrivacyRepository } from "../ports/index.js";

function idempotencyKeyOf(organizationId: OrganizationId, key: IdempotencyKey): string {
  return `${organizationId}/${key}`;
}

function tombstoneKeyOf(organizationId: OrganizationId, aliasHash: AliasHash): string {
  return `${organizationId}/${aliasHash}`;
}

export class InMemoryPrivacyRepository implements PrivacyRepository {
  private readonly operations = new Map<string, PersistedErasureOperation>();
  private readonly tombstones = new Map<string, ErasureTombstone>();

  /** Set to fail the next operation read, so the fail-closed paths are reachable. */
  operationReadFails = false;
  /** Set to fail the next tombstone read: the barrier must refuse, not allow. */
  tombstoneReadFails = false;
  /**
   * Return elapsed rows from `findActiveTombstones`, as a PERMISSIVE adapter
   * would.
   *
   * This double honours the port's read-time-expiry requirement, which is
   * correct — and which makes the barrier's own second filter unreachable, so a
   * suite that only ever sees a well-behaved store cannot tell whether that
   * filter is there. Flipping this models the adapter that forgot, and it is the
   * only way to prove the barrier does not simply trust its store.
   */
  returnsElapsedTombstones = false;

  /** Arrange rows without going through a use case. */
  seedOperation(operation: PersistedErasureOperation): void {
    this.operations.set(operation.operationId, operation);
  }

  seedTombstone(tombstone: ErasureTombstone): void {
    this.tombstones.set(tombstoneKeyOf(tombstone.organizationId, tombstone.aliasHash), tombstone);
  }

  allOperations(): readonly PersistedErasureOperation[] {
    return [...this.operations.values()];
  }

  allTombstones(): readonly ErasureTombstone[] {
    return [...this.tombstones.values()];
  }

  async findByIdempotencyKey(
    organizationId: OrganizationId,
    idempotencyKey: IdempotencyKey,
  ): Promise<Result<PersistedErasureOperation | null>> {
    if (this.operationReadFails) return err(operationNotFound("store-unavailable"));
    const wanted = idempotencyKeyOf(organizationId, idempotencyKey);
    for (const operation of this.operations.values()) {
      if (idempotencyKeyOf(operation.organizationId, operation.idempotencyKey) === wanted) {
        return ok(operation);
      }
    }
    return ok(null);
  }

  async findOperation(
    organizationId: OrganizationId,
    operationId: ErasureOperationId,
  ): Promise<Result<PersistedErasureOperation | null>> {
    if (this.operationReadFails) return err(operationNotFound("store-unavailable"));
    const found = this.operations.get(operationId);
    if (found === undefined || found.organizationId !== organizationId) return ok(null);
    return ok(found);
  }

  async insertOperation(
    operation: PersistedErasureOperation,
    _transaction: TransactionScope,
  ): Promise<Result<PersistedErasureOperation>> {
    const wanted = idempotencyKeyOf(operation.organizationId, operation.idempotencyKey);
    for (const existing of this.operations.values()) {
      if (idempotencyKeyOf(existing.organizationId, existing.idempotencyKey) === wanted) {
        return err(idempotencyKeyConflict(existing.operationId));
      }
    }
    this.operations.set(operation.operationId, operation);
    return ok(operation);
  }

  async updateProgress(
    organizationId: OrganizationId,
    operationId: ErasureOperationId,
    progress: OperationProgressWrite,
    _transaction: TransactionScope,
  ): Promise<Result<PersistedErasureOperation>> {
    const found = this.operations.get(operationId);
    if (found === undefined || found.organizationId !== organizationId) {
      return err(operationNotFound(operationId));
    }
    // The identity columns are carried over from the stored row rather than from
    // the caller, which is what makes the port's "immutable half" real here.
    const updated: PersistedErasureOperation = {
      operationId: found.operationId,
      organizationId: found.organizationId,
      idempotencyKey: found.idempotencyKey,
      subjectKeyHash: found.subjectKeyHash,
      scopes: found.scopes,
      policyVersion: found.policyVersion,
      requestedAt: found.requestedAt,
      ...progress,
    };
    this.operations.set(operationId, updated);
    return ok(updated);
  }

  async claimLease(
    organizationId: OrganizationId,
    operationId: ErasureOperationId,
    lease: { readonly token: LeaseToken; readonly expiresAt: Date },
    now: Date,
    _transaction: TransactionScope,
  ): Promise<Result<boolean>> {
    const found = this.operations.get(operationId);
    if (found === undefined || found.organizationId !== organizationId) {
      return err(operationNotFound(operationId));
    }
    if (!isLeaseFree(found.leaseExpiresAt, now)) return ok(false);
    this.operations.set(operationId, {
      ...found,
      leaseToken: lease.token,
      leaseExpiresAt: lease.expiresAt,
    });
    return ok(true);
  }

  async listDueOperations(asOf: Date, limit: number): Promise<Result<readonly PersistedErasureOperation[]>> {
    const due = [...this.operations.values()]
      .filter((operation) => operation.nextRetryAt !== null && operation.nextRetryAt.getTime() <= asOf.getTime())
      .sort((left, right) => (left.nextRetryAt?.getTime() ?? 0) - (right.nextRetryAt?.getTime() ?? 0));
    return ok(due.slice(0, Math.max(0, limit)));
  }

  async listOperationsForSubject(
    organizationId: OrganizationId,
    subjectKeyHash: SubjectKeyHash,
  ): Promise<Result<readonly PersistedErasureOperation[]>> {
    const rows = [...this.operations.values()]
      .filter(
        (operation) =>
          operation.organizationId === organizationId && operation.subjectKeyHash === subjectKeyHash,
      )
      .sort((left, right) => right.requestedAt.getTime() - left.requestedAt.getTime());
    return ok(rows);
  }

  async findActiveTombstones(
    organizationId: OrganizationId,
    aliasHashes: readonly AliasHash[],
    now: Date,
  ): Promise<Result<readonly ErasureTombstone[]>> {
    if (this.tombstoneReadFails) return err(operationNotFound("register-unavailable"));
    const wanted = new Set(aliasHashes.map((hash) => tombstoneKeyOf(organizationId, hash)));
    const found: ErasureTombstone[] = [];
    for (const [key, tombstone] of this.tombstones.entries()) {
      if (!wanted.has(key)) continue;
      if (!this.returnsElapsedTombstones && !isActive(tombstone, now)) continue;
      found.push(tombstone);
    }
    return ok(found);
  }

  async sealTombstones(
    drafts: readonly TombstoneDraft[],
    ids: readonly ErasureTombstoneId[],
    _transaction: TransactionScope,
  ): Promise<Result<{ readonly sealed: number; readonly extended: number }>> {
    let sealed = 0;
    let extended = 0;
    for (const [index, draft] of drafts.entries()) {
      const key = tombstoneKeyOf(draft.organizationId, draft.aliasHash);
      const existing = this.tombstones.get(key);
      if (existing === undefined) {
        const id = ids[index];
        if (id === undefined) continue;
        this.tombstones.set(key, { tombstoneId: id, ...draft });
        sealed += 1;
        continue;
      }
      // Extend in place. The row is never removed and re-added, so there is no
      // instant at which the alias is unsealed.
      this.tombstones.set(key, {
        ...existing,
        expiresAt: draft.expiresAt,
        operationId: draft.operationId,
        policyVersion: draft.policyVersion,
      });
      extended += 1;
    }
    return ok({ sealed, extended });
  }

  async purgeExpiredTombstones(now: Date, _transaction: TransactionScope): Promise<Result<number>> {
    let purged = 0;
    for (const [key, tombstone] of [...this.tombstones.entries()]) {
      if (isActive(tombstone, now)) continue;
      this.tombstones.delete(key);
      purged += 1;
    }
    return ok(purged);
  }
}
