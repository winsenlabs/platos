// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so `privacy` never imports
// anyone and nobody implements a `privacy`-defined interface: each context
// implements it for the rows it is SOLE WRITER of, and the composition root
// injects the array. This context is sole writer of the four analytical tables
// and of `AdminAudit`, so those are the five plan items and there are no others.
//
// METHOD, PER MODEL — the decision this file exists to record. Every one is
// `anonymize`, and `domain/subject-erasure.ts` states why per model. In short:
// the analytical tables are a projection of work the canonical store already
// owns, `usage_events_v1` is retained for years as financial evidence, and
// `AdminAudit` is the record of who changed what. Deleting any of them to remove
// an identifier that can be removed on its own destroys the evidence to serve
// the erasure.
//
// THE CLAIM ON THE RECEIPT IS THE RE-COUNT, NOT THE MUTATION.
//
// A column store's erasure is asynchronous: the statement returning means the
// work was accepted. So every table is counted BEFORE ("found N"), cleared, and
// counted AGAIN ("now find 0") using the SAME predicate — including its residue
// clause, without which the second count would be a tautology, since the
// mutation empties the very columns the locator matches on.
//
// UNVERIFIED IS NOT CLEAN. A count that could not be read, or a change the store
// has not confirmed, REJECTS the erasure. `ErasureTarget.erase` returns a
// receipt with no failure channel, so producing a receipt that claims rows are
// gone when nobody checked is the one outcome this file may never have — and
// rejecting also rolls the caller's transaction back, which is the wanted
// behaviour for a multi-context erasure.

import type {
  DomainError,
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import {
  addressIsVacuous,
  addressSubject,
  adminAuditActorFor,
  ADMIN_AUDIT_MODEL,
  buildSubjectPredicate,
  ERASABLE_TABLES,
  erasurePlanForeign,
  ERASURE_METHOD,
  erasureResidue,
  erasureUnverified,
  type SubjectAddress,
} from "../domain/index.js";
import type { ObservabilityDependencies } from "./dependencies.js";

export const OBSERVABILITY_ERASURE_TARGET_NAME = "observability";

/**
 * Carries a `DomainError` out through a port whose signature has no failure
 * channel.
 *
 * `ErasureTarget.plan` and `.erase` both return bare values. An unverifiable
 * erasure must NOT produce a receipt claiming it happened, so the only truthful
 * option is to reject.
 */
export class ObservabilityErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "ObservabilityErasureRejected";
    this.domainError = error;
  }
}

function refuse(error: DomainError): never {
  throw new ObservabilityErasureRejected(error);
}

/**
 * The kernel's `ErasurePlan` carries `targetName` and `items` and NOTHING about
 * whose data it describes, so a stateless target handed a plan back cannot know
 * what to unlink. Rather than make the target stateful — a plan-id map that
 * leaks on every abandoned plan — the plan this target mints carries its subject
 * and its resolved address as context-owned riders. It is still exactly an
 * `ErasurePlan` to every other reader, and a plan arriving without the riders is
 * refused rather than guessed.
 */
export interface ObservabilityErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
  readonly address: SubjectAddress;
}

export function isObservabilityErasurePlan(plan: ErasurePlan): plan is ObservabilityErasurePlan {
  return plan.targetName === OBSERVABILITY_ERASURE_TARGET_NAME && "subject" in plan && "address" in plan;
}

function planItem(model: string, rowCount: number): ErasurePlanItem {
  // `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
  // evaluate against this plan (ADR M0.3 §1, context 18). This context reports
  // what it holds; it does not adjudicate whether it may go.
  return { model, method: ERASURE_METHOD, rowCount, blockedBy: null };
}

async function countTables(
  dependencies: ObservabilityDependencies,
  address: SubjectAddress,
): Promise<ErasurePlanItem[]> {
  const items: ErasurePlanItem[] = [];
  for (const table of ERASABLE_TABLES) {
    const predicate = buildSubjectPredicate(table, address);
    if (predicate === null) {
      items.push(planItem(table.table, 0));
      continue;
    }
    const counted = await dependencies.sink.countSubjectRows({ table: table.table, predicate });
    if (!counted.ok) refuse(counted.error);
    items.push(planItem(table.table, counted.value));
  }
  return items;
}

async function countAdminAudit(
  dependencies: ObservabilityDependencies,
  subject: ErasureSubject,
): Promise<ErasurePlanItem> {
  const actorUserId = adminAuditActorFor(subject);
  if (actorUserId === null) return planItem(ADMIN_AUDIT_MODEL, 0);
  const counted = await dependencies.repository.countAdminAuditForActor({
    organizationId: subject.scope.organizationId,
    actorUserId,
  });
  if (!counted.ok) refuse(counted.error);
  return planItem(ADMIN_AUDIT_MODEL, counted.value);
}

async function buildPlan(
  dependencies: ObservabilityDependencies,
  subject: ErasureSubject,
): Promise<ObservabilityErasurePlan> {
  // Asked PER SUBJECT. See `application/ports/erased-subject-register.ts` for
  // why binding these at construction would give every subject in the
  // installation the same — and therefore wrong — set of threads.
  const locators = await dependencies.subjectLocators.locatorsFor(subject);
  if (!locators.ok) refuse(locators.error);
  const address = addressSubject(subject, locators.value.threadIds, locators.value.subjectKeyHashes);
  const analytical = addressIsVacuous(address)
    ? // Nothing to address in the analytical store. A zero-row plan is more
      // honest than omitting this target: it says the target was consulted.
      ERASABLE_TABLES.map((table) => planItem(table.table, 0))
    : await countTables(dependencies, address);
  const audit = await countAdminAudit(dependencies, subject);
  return {
    targetName: OBSERVABILITY_ERASURE_TARGET_NAME,
    subject,
    address,
    items: [...analytical, audit],
  };
}

/**
 * Clear one table and PROVE it.
 *
 * The returned count is what the receipt reports as unlinked, and it is the
 * BEFORE count — the number of rows that carried identity and no longer do.
 * Reporting the after-count would report zero on success, which is a true
 * statement that answers no question anyone asked.
 */
async function clearAndVerify(
  dependencies: ObservabilityDependencies,
  address: SubjectAddress,
  table: (typeof ERASABLE_TABLES)[number],
): Promise<number> {
  const predicate = buildSubjectPredicate(table, address);
  if (predicate === null) return 0;

  const before = await dependencies.sink.countSubjectRows({ table: table.table, predicate });
  if (!before.ok) refuse(before.error);

  const cleared = await dependencies.sink.clearSubjectColumns({
    table: table.table,
    predicate,
    cleared: table.cleared,
  });
  if (!cleared.ok) refuse(cleared.error);
  if (!cleared.value.confirmed) {
    refuse(erasureUnverified(table.table, `store did not confirm the change: ${cleared.value.detail}`));
  }

  const after = await dependencies.sink.countSubjectRows({ table: table.table, predicate });
  if (!after.ok) refuse(erasureUnverified(table.table, after.error.code));
  if (after.value > 0) refuse(erasureResidue(table.table, after.value));

  return before.value;
}

async function carryOutPlan(
  dependencies: ObservabilityDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isObservabilityErasurePlan(plan)) refuse(erasurePlanForeign(plan.targetName));

  const items: ErasurePlanItem[] = [];
  if (addressIsVacuous(plan.address)) {
    for (const table of ERASABLE_TABLES) items.push(planItem(table.table, 0));
  } else {
    for (const table of ERASABLE_TABLES) {
      items.push(planItem(table.table, await clearAndVerify(dependencies, plan.address, table)));
    }
  }

  const actorUserId = adminAuditActorFor(plan.subject);
  if (actorUserId === null) {
    items.push(planItem(ADMIN_AUDIT_MODEL, 0));
  } else {
    const unlinked = await dependencies.repository.clearAdminAuditActor(
      { organizationId: plan.subject.scope.organizationId, actorUserId },
      transaction,
    );
    if (!unlinked.ok) refuse(unlinked.error);
    items.push(planItem(ADMIN_AUDIT_MODEL, unlinked.value));
  }

  return { targetName: OBSERVABILITY_ERASURE_TARGET_NAME, erasedAt: dependencies.clock.now(), items };
}

/**
 * Build the target.
 *
 * Stateless per call: the plan a subject gets is built from THAT subject's own
 * locators, resolved through a port at plan time, and carried on the plan so the
 * erasure that follows acts on exactly what was reviewed.
 */
export function createObservabilityErasureTarget(dependencies: ObservabilityDependencies): ErasureTarget {
  return {
    targetName: OBSERVABILITY_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) =>
      carryOutPlan(dependencies, plan, transaction),
  };
}
