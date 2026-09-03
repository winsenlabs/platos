// An in-memory `ObservabilityRepository` and `ErasedSubjectRegister`.
//
// Both are small, and both hold a behaviour that matters more than their size:
// the repository UNLINKS an audit row rather than deleting it, and the register
// can be made to REFUSE, which is the only way to prove the drain fails closed
// rather than treating "we could not ask" as "nobody is erased".

import {
  err,
  ok,
  type ErasureSubject,
  type PrincipalId,
  type Result,
  type TransactionScope,
} from "@platos/kernel";

import {
  repositoryUnavailable,
  type AdminAuditQuery,
  type AdminAuditRecord,
} from "../../domain/index.js";
import type {
  AdminAuditActorSelector,
  ErasedSubjectQuery,
  ErasedSubjectRegister,
  ObservabilityRepository,
  SubjectLocators,
  SubjectLocatorSource,
} from "../ports/index.js";

/**
 * The record, plus the actor column held SEPARATELY.
 *
 * The record is frozen by the domain, and the erasure path's whole job is to
 * empty one of its columns while the rest survives. Holding the mutable column
 * beside the frozen row is what lets this double model an unlink rather than a
 * rewrite — and it is the same split the real table has.
 */
interface StoredAudit {
  record: AdminAuditRecord;
  actorUserId: PrincipalId | null;
}

export class InMemoryObservabilityRepository implements ObservabilityRepository {
  private readonly audits: StoredAudit[] = [];
  readonly transactions: TransactionScope[] = [];
  /**
   * Every query it was asked, verbatim.
   *
   * The page limit is resolved in the application layer, and a test that only
   * counts the returned rows cannot tell a capped limit from a small table.
   */
  readonly queries: AdminAuditQuery[] = [];

  /** Set to make every write refuse. */
  writeFails = false;
  /** Set to make every read refuse. */
  readFails = false;

  all(): readonly AdminAuditRecord[] {
    return this.audits.map((entry) => ({ ...entry.record, actorUserId: entry.actorUserId }));
  }

  get size(): number {
    return this.audits.length;
  }

  async recordAdminAudit(
    record: AdminAuditRecord,
    transaction: TransactionScope,
  ): Promise<Result<AdminAuditRecord>> {
    if (this.writeFails) return err(repositoryUnavailable("audit write refused"));
    this.transactions.push(transaction);
    this.audits.push({ record, actorUserId: record.actorUserId });
    return ok(record);
  }

  async listAdminAudit(query: AdminAuditQuery): Promise<Result<readonly AdminAuditRecord[]>> {
    this.queries.push(query);
    if (this.readFails) return err(repositoryUnavailable("audit read refused"));
    const matches = this.all()
      .filter((record) => record.scope.environmentId === query.scope.environmentId)
      .filter((record) => (query.action ? record.action === query.action : true))
      .filter((record) => (query.subjectType ? record.subjectType === query.subjectType : true))
      .filter((record) => (query.subjectId ? record.subjectId === query.subjectId : true))
      .sort((left, right) => right.recordedAt.getTime() - left.recordedAt.getTime())
      .slice(0, query.limit);
    return ok(matches);
  }

  async countAdminAuditForActor(selector: AdminAuditActorSelector): Promise<Result<number>> {
    if (this.readFails) return err(repositoryUnavailable("audit count refused"));
    return ok(this.matching(selector).length);
  }

  async clearAdminAuditActor(
    selector: AdminAuditActorSelector,
    transaction: TransactionScope,
  ): Promise<Result<number>> {
    if (this.writeFails) return err(repositoryUnavailable("audit unlink refused"));
    this.transactions.push(transaction);
    const matches = this.matching(selector);
    // Unlink, never delete: the action and its snapshots survive the actor.
    for (const entry of matches) entry.actorUserId = null;
    return ok(matches.length);
  }

  private matching(selector: AdminAuditActorSelector): StoredAudit[] {
    return this.audits.filter(
      (entry) =>
        entry.actorUserId === selector.actorUserId &&
        entry.record.scope.organizationId === selector.organizationId,
    );
  }
}

export class InMemoryErasedSubjectRegister implements ErasedSubjectRegister {
  private readonly erased = new Map<string, Set<string>>();
  readonly queries: ErasedSubjectQuery[] = [];

  /** Set to make every lookup refuse, proving the drain fails CLOSED. */
  lookupFails = false;

  /** Mark one subject erased in one organization. */
  markErased(organizationId: string, endUserId: string): void {
    const known = this.erased.get(organizationId) ?? new Set<string>();
    known.add(endUserId);
    this.erased.set(organizationId, known);
  }

  async erasedSubjects(query: ErasedSubjectQuery): Promise<Result<readonly string[]>> {
    this.queries.push(query);
    if (this.lookupFails) return err(repositoryUnavailable("erased-subject register refused"));
    const known = this.erased.get(query.organizationId) ?? new Set<string>();
    return ok(query.endUserIds.filter((endUserId) => known.has(endUserId)));
  }
}

/**
 * An in-memory `SubjectLocatorSource`, keyed BY SUBJECT.
 *
 * Keyed rather than fixed, because the defect this port exists to prevent is
 * exactly a source that answers the same thing for everyone. A double that held
 * one list could not tell the two designs apart.
 */
export class InMemorySubjectLocatorSource implements SubjectLocatorSource {
  private readonly bySubject = new Map<string, SubjectLocators>();
  readonly asked: ErasureSubject[] = [];

  /** Set to make every lookup refuse, so a plan is rejected rather than narrowed. */
  lookupFails = false;

  setLocators(subjectId: string, locators: Partial<SubjectLocators>): void {
    this.bySubject.set(subjectId, {
      threadIds: locators.threadIds ?? [],
      subjectKeyHashes: locators.subjectKeyHashes ?? [],
    });
  }

  async locatorsFor(subject: ErasureSubject): Promise<Result<SubjectLocators>> {
    this.asked.push(subject);
    if (this.lookupFails) return err(repositoryUnavailable("subject locator source refused"));
    return ok(this.bySubject.get(subject.subjectId) ?? { threadIds: [], subjectKeyHashes: [] });
  }
}
