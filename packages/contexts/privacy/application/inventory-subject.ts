// Enumerating a subject's footprint without destroying any of it.
//
// The read that answers "what would an erasure take" — and, because it is a
// read of a person, the one that most needs a record of who went looking. It
// appends `privacy.erasure.inventoried` for exactly that reason: an enumeration
// that leaves no trace makes "who has been reading this person" unanswerable.
//
// MUST NOT MUTATE. `ErasureTarget.plan` is contractually non-mutating, and this
// use case calls nothing else that writes — no seal, no operation row, no lease.
// The event append is the single write, and it records a read.
//
// AN UNRESOLVED SUBJECT FAILS RATHER THAN RETURNING ZERO. An inventory has no
// record to leave behind, so an empty result is indistinguishable from "this
// person has no data" — which is the misreading this whole context exists to
// prevent. `requestErasure` behaves differently on purpose: there, the request
// itself is the evidence, so an unresolved subject opens a row at
// `verification_failed` rather than vanishing.
//
// THE HOLD IS REPORTED, NOT ENFORCED. Nothing is being destroyed, so there is
// nothing to block; surfacing the reference lets an operator find out that an
// erasure would be refused before they fire one.

import { err, ok, type Result } from "@platos/kernel";

import { plannedRowCount, subjectNotResolved } from "../domain/index.js";
import { PRIVACY_EVENT_NAMES } from "../contracts/events.js";
import type { InventorySubjectQuery, SubjectInventoryView } from "../contracts/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { appendPrivacyEvent, inventoriedEvent } from "./erasure-events.js";
import { planErasure, totalPlannedRows } from "./plan-erasure.js";
import { resolveSubjectContext } from "./resolve-subject.js";

export async function inventorySubject(
  dependencies: PrivacyDependencies,
  query: InventorySubjectQuery,
): Promise<Result<SubjectInventoryView>> {
  const context = await resolveSubjectContext(dependencies, {
    organizationId: query.organizationId,
    externalUserId: query.externalUserId,
  });
  if (!context.ok) return err(context.error);
  if (context.value.subjects.length === 0) return err(subjectNotResolved(context.value.subjectKeyHash));

  const planned = await planErasure(dependencies, context.value.subjects);
  const discovered = totalPlannedRows(planned);
  const view: SubjectInventoryView = {
    subjectKeyHash: context.value.subjectKeyHash,
    resolvedSubjects: context.value.subjects.length,
    scopes: context.value.scopes,
    planned: planned.map((entry) => ({
      target: entry.name,
      rowCount: entry.plans.reduce((total, plan) => total + plannedRowCount(plan), 0),
    })),
    discovered,
    legalHoldPolicyId: context.value.legalHoldPolicyId,
  };

  const appended = await dependencies.unitOfWork.run((transaction) =>
    appendPrivacyEvent(dependencies, {
      name: PRIVACY_EVENT_NAMES.subjectInventoried,
      organizationId: query.organizationId,
      payload: inventoriedEvent({
        subjectKeyHash: context.value.subjectKeyHash,
        policyVersion: dependencies.policy.version,
        resolvedSubjects: context.value.subjects.length,
        discovered,
        targets: planned.map((entry) => entry.name),
      }),
      handles: context.value.handles,
      transaction,
    }),
  );
  if (!appended.ok) return err(appended.error);
  return ok(view);
}
