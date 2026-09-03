// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is SOLE WRITER of, and the composition
// root injects the array.
//
// METHOD, PER MODEL — the decision this file exists to record:
//
//   AgentApproval -> delete. The row records that a NAMED HUMAN authorised a
//     specific action with specific arguments. Its identifying content is spread
//     across `respondedBy`, the requester in metadata, `comment` (free text a
//     person wrote) and `arguments` (whatever the tool was called with). There is
//     no column rewrite that removes a subject from free text, so anonymising
//     would be erasure theatre. Nothing holds a foreign key TO an approval, so
//     the row can go outright.
//
//   Job -> NOT ERASED, and this is the decision most likely to be questioned.
//     A `Job` is a definition of automation owned by an ENVIRONMENT, not by a
//     person; `createdBy` records who authored it, not whose data it holds.
//     Erasing an author's jobs would delete working automation that the
//     organization still depends on and that contains none of the subject's
//     personal data. The row therefore reports as a ZERO-COUNT item rather than
//     being omitted, so a plan reader can see the model was considered and see
//     the count it was judged against — an omitted model is indistinguishable
//     from one nobody thought about.
//
// A `user` SUBJECT MATCHES, an `entity` SUBJECT DOES NOT. Approvals are decided
// by operators and requested by principals, so both halves of the selector are a
// principal id. This context owns no Entity-keyed row, and reporting a zero-row
// plan is more honest than omitting the target from the operation altogether.

import type {
  DomainError,
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { erasurePlanForeign } from "../domain/index.js";
import type { JobsDependencies } from "./dependencies.js";
import type { JobsErasureSelector } from "./ports/index.js";

export const JOBS_ERASURE_TARGET_NAME = "jobs";
export const APPROVAL_MODEL = "AgentApproval";
export const JOB_MODEL = "Job";

/**
 * Carries a `DomainError` out through a port whose signature has no failure
 * channel.
 *
 * `ErasureTarget.erase` returns `Promise<ErasureReceipt>`. A row that would not
 * be destroyed must NOT produce a receipt claiming it was, so the only truthful
 * option is to reject — which also rolls the caller's transaction back, which is
 * the wanted outcome for a multi-context erasure.
 */
export class JobsErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "JobsErasureRejected";
    this.domainError = error;
  }
}

/**
 * The kernel's `ErasurePlan` carries `targetName` and `items` and NOTHING about
 * whose data it describes, so a stateless target handed a plan back cannot know
 * what to destroy. Rather than make the target stateful (a plan-id map that leaks
 * on every abandoned plan), the plan this target mints carries its subject as a
 * context-owned rider. It is still exactly an `ErasurePlan` to every other
 * reader, and a plan arriving without the rider is refused rather than guessed.
 */
export interface JobsErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
}

export function isJobsErasurePlan(plan: ErasurePlan): plan is JobsErasurePlan {
  return plan.targetName === JOBS_ERASURE_TARGET_NAME && "subject" in plan;
}

export function selectorFor(subject: ErasureSubject): JobsErasureSelector {
  if (subject.subjectKind === "entity") return { scope: subject.scope, principalId: null };
  return { scope: subject.scope, principalId: subject.subjectId };
}

export function selectorIsVacuous(selector: JobsErasureSelector): boolean {
  return selector.principalId === null;
}

function planItem(model: string, rowCount: number): ErasurePlanItem {
  // `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
  // evaluate against this plan (ADR M0.3 §1, context 18). This context reports
  // what it holds; it does not adjudicate whether it may go.
  return { model, method: "delete", rowCount, blockedBy: null };
}

/** `Job` is always a zero-count item; see the header for why it is listed at all. */
function planFor(subject: ErasureSubject, approvals: number): JobsErasurePlan {
  return {
    targetName: JOBS_ERASURE_TARGET_NAME,
    subject,
    items: [planItem(APPROVAL_MODEL, approvals), planItem(JOB_MODEL, 0)],
  };
}

function refuse(error: DomainError): never {
  throw new JobsErasureRejected(error);
}

async function buildPlan(dependencies: JobsDependencies, subject: ErasureSubject): Promise<JobsErasurePlan> {
  const selector = selectorFor(subject);
  if (selectorIsVacuous(selector)) return planFor(subject, 0);
  const approvals = await dependencies.approvals.countErasable(selector);
  if (!approvals.ok) refuse(approvals.error);
  return planFor(subject, approvals.value);
}

async function carryOutPlan(
  dependencies: JobsDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isJobsErasurePlan(plan)) refuse(erasurePlanForeign(plan.targetName));
  const selector = selectorFor(plan.subject);
  if (selectorIsVacuous(selector)) {
    return { targetName: JOBS_ERASURE_TARGET_NAME, erasedAt: dependencies.clock.now(), items: plan.items };
  }
  const erased = await dependencies.approvals.erase(selector, transaction);
  if (!erased.ok) refuse(erased.error);
  return {
    targetName: JOBS_ERASURE_TARGET_NAME,
    erasedAt: dependencies.clock.now(),
    items: [planItem(APPROVAL_MODEL, erased.value), planItem(JOB_MODEL, 0)],
  };
}

export function createJobsErasureTarget(dependencies: JobsDependencies): ErasureTarget {
  return {
    targetName: JOBS_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) => carryOutPlan(dependencies, plan, transaction),
  };
}
