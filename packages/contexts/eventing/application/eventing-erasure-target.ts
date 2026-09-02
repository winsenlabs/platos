// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is SOLE WRITER of, and the composition
// root injects the array.
//
// ONE MODEL, NOT THREE. `domain/legacy-rows.ts` records why: of the three rows
// ADR §1 row 17 names, only `NotificationRule` is canonical. The plan is built
// from `OWNED_CANONICAL_MODELS` rather than from a second literal, so the two
// cannot drift.
//
// METHOD: `anonymize`, NOT `delete`. This is the decision this file exists to
// record, and it is the opposite of the one `files` makes.
//
//   `NotificationRule` has exactly one column that could name a person:
//   `createdBy`, the operator who registered the rule. It is NOT subject data in
//   the sense the rule exists for — the rule is an ENVIRONMENT's standing order
//   about its own operational events, and its content (patterns, destination) is
//   about the environment, not about the person who typed it.
//
//   Deleting the row would therefore silently disable an environment's alerting
//   because an administrator exercised a data right — turning an erasure request
//   into an operational outage, and one nobody would connect to its cause.
//   Overwriting `createdBy` removes the only identifying column while the
//   standing order survives, which is exactly what the kernel defines
//   `anonymize` to mean: "identifying columns are overwritten; the row survives
//   for referential truth".
//
//   The legacy system reaches the same conclusion from the other direction:
//   `apps/agent/src/privacy/subject-graph.ts` puts this family of rows in
//   `OPERATOR_USERID_TABLES`, the set whose userId "is an OPERATOR, not the
//   subject", and excludes them from the erasure sweep entirely. This target is
//   marginally stronger than that — it scrubs rather than skips — and is
//   consistent with it.
//
// ONLY A `user` SUBJECT MATCHES. `createdBy` is an operator principal. An
// `end-user` never registers a notification rule and an `entity` is not a
// person, so both produce a vacuous plan. Reporting a zero-row plan is more
// honest than omitting the target from the operation altogether.

import type {
  DomainError,
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { erasurePlanForeign, NOTIFICATION_RULE_MODEL, OWNED_CANONICAL_MODELS } from "../domain/index.js";
import type { EventingDependencies } from "./dependencies.js";
import type { EventingErasureSelector } from "./ports/index.js";

export const EVENTING_ERASURE_TARGET_NAME = "eventing";

/**
 * What `createdBy` becomes. A fixed sentinel rather than a random token: the
 * column is a plain `String` with no FK, two scrubbed rules should be
 * indistinguishable, and an operator reading the table must be able to tell at a
 * glance that the value is absent by design rather than corrupt.
 */
export const ERASED_PRINCIPAL = "erased:subject-removed";

/**
 * Carries a `DomainError` out through a port whose signature has no failure
 * channel.
 *
 * `ErasureTarget.erase` returns `Promise<ErasureReceipt>`. A row that would not
 * be scrubbed must NOT produce a receipt claiming it was, so the only truthful
 * option is to reject — which also rolls the caller's transaction back, which is
 * the wanted outcome for a multi-context erasure.
 */
export class EventingErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "EventingErasureRejected";
    this.domainError = error;
  }
}

/**
 * The kernel's `ErasurePlan` carries `targetName` and `items` and NOTHING about
 * whose data it describes, so a stateless target handed a plan back cannot know
 * what to act on. Rather than make the target stateful (a plan-id map that leaks
 * on every abandoned plan), the plan this target mints carries its subject as a
 * context-owned rider. It is still exactly an `ErasurePlan` to every other
 * reader, and a plan arriving without the rider is refused rather than guessed.
 */
export interface EventingErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
}

export function isEventingErasurePlan(plan: ErasurePlan): plan is EventingErasurePlan {
  return plan.targetName === EVENTING_ERASURE_TARGET_NAME && "subject" in plan;
}

export function selectorFor(subject: ErasureSubject): EventingErasureSelector {
  if (subject.subjectKind === "user") {
    return { scope: subject.scope, principalId: subject.subjectId };
  }
  return { scope: subject.scope, principalId: null };
}

export function selectorIsVacuous(selector: EventingErasureSelector): boolean {
  return selector.principalId === null;
}

function planItem(model: string, rowCount: number): ErasurePlanItem {
  // `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
  // evaluate against this plan (ADR M0.3 §1, context 18). This context reports
  // what it holds; it does not adjudicate whether it may go.
  return { model, method: "anonymize", rowCount, blockedBy: null };
}

function planFor(subject: ErasureSubject, rules: number): EventingErasurePlan {
  return {
    targetName: EVENTING_ERASURE_TARGET_NAME,
    subject,
    items: OWNED_CANONICAL_MODELS.map((model) => planItem(model, rules)),
  };
}

function refuse(error: DomainError): never {
  throw new EventingErasureRejected(error);
}

async function buildPlan(
  dependencies: EventingDependencies,
  subject: ErasureSubject,
): Promise<EventingErasurePlan> {
  const selector = selectorFor(subject);
  if (selectorIsVacuous(selector)) return planFor(subject, 0);
  const counted = await dependencies.repository.countRulesForSubject(selector);
  if (!counted.ok) refuse(counted.error);
  return planFor(subject, counted.value);
}

async function carryOutPlan(
  dependencies: EventingDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isEventingErasurePlan(plan)) refuse(erasurePlanForeign(plan.targetName));
  const selector = selectorFor(plan.subject);
  if (selectorIsVacuous(selector)) {
    return { targetName: EVENTING_ERASURE_TARGET_NAME, erasedAt: dependencies.clock.now(), items: plan.items };
  }
  const scrubbed = await dependencies.repository.anonymizeRulesForSubject(
    selector,
    ERASED_PRINCIPAL,
    transaction,
  );
  if (!scrubbed.ok) refuse(scrubbed.error);
  return {
    targetName: EVENTING_ERASURE_TARGET_NAME,
    erasedAt: dependencies.clock.now(),
    items: [planItem(NOTIFICATION_RULE_MODEL, scrubbed.value)],
  };
}

export function createEventingErasureTarget(dependencies: EventingDependencies): ErasureTarget {
  return {
    targetName: EVENTING_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) => carryOutPlan(dependencies, plan, transaction),
  };
}
