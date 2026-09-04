// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is SOLE WRITER of, the composition root
// injects the array, and `privacy` depends on `tenancy` and the kernel alone.
//
// A CONTEXT THAT OWNS SUBJECT DATA AND PUBLISHES NO TARGET MAKES A MULTI-CONTEXT
// ERASURE SILENTLY INCOMPLETE. `privacy` erases `MessageRating` and cannot reach
// into this context's tables to do it. That is why this file exists, why the
// contract publishes `erasureTarget()`, and why the binder suite obtains the
// target THROUGH the published contract rather than by calling this factory — a
// binder that dropped the method would otherwise leave every test here green.
//
// METHOD, PER MODEL — the decision this file exists to record. All five owned
// models are named. An omitted model is indistinguishable from one nobody
// thought about, so the three that are not erased report as ZERO-COUNT items
// with the reason recorded here rather than being left out.
//
//   MessageRating -> DELETE, counted. It is a named end user's opinion, keyed by
//     `endUserId`, and its `comment` is free text that person wrote. There is no
//     column rewrite that removes a subject from free text, so anonymising would
//     be erasure theatre. Nothing holds a foreign key to a rating, so the row
//     goes outright. This is the one `privacy` is actually asking for.
//
//   SafetyEvent -> ANONYMIZE, counted, and this is the decision most likely to
//     be questioned. A safety event is the record that a control fired: the
//     detector, the action, the severity and the instant. Deleting a subject's
//     safety events would let anybody erase the evidence that they were blocked,
//     which turns a right-to-erasure into a way to launder a security incident.
//     The kernel's `anonymize` is exactly the right method — "identifying
//     columns are overwritten; the row survives for referential truth" — so the
//     subject reference, the free-text detail and the metadata go, and the
//     detector, action, severity and timestamp stay, keeping every rollup taken
//     over that window still true.
//
//   AgentEval -> DELETE, ALWAYS ZERO. An eval embeds a transcript: its
//     `judgePromptUsed` and `rawResponse` carry the conversation verbatim, so it
//     genuinely IS subject data. It is keyed by THREAD, not by subject, and this
//     context may not import `conversations` (ADR M0.3 §1 row 14) so it cannot
//     resolve which threads are a subject's. It does not need to: the schema
//     declares `thread Thread @relation(..., onDelete: Cascade)`, so an eval is
//     destroyed by the database when the thread it scored is. The erasure of a
//     thread belongs to the context that owns it; this target reports the model
//     at zero so a plan reader can see it was considered and see the mechanism
//     that carries it.
//
//   EvalCriterion -> DELETE, ALWAYS ZERO. A criterion is a question an
//     ENVIRONMENT asks; `createdBy` records who wrote it, not whose data it
//     holds. Erasing an author's criteria would delete working evaluation the
//     organization still depends on and that contains none of the subject's
//     personal data.
//
//   GoldenSet -> DELETE, ALWAYS ZERO. Same reasoning: a pinned list of thread
//     ids and criterion ids, authored by somebody, about nobody.
//
// WHICH SUBJECT KINDS MATCH WHICH MODEL, AND WHY THEY DIFFER. `MessageRating`
// is keyed by `EndUser.id`, so only an `end-user` subject can match it —
// comparing an operator's user id against that column would be an id-space
// confusion that silently matches nothing while looking like it worked. The
// safety ledger records the caller's own subject string, whoever it was, so both
// `user` and `end-user` match it. An `entity` subject matches neither, and the
// whole plan is zero rather than the target being omitted.

import type {
  DomainError,
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { erasurePlanForeign, type EndUserId } from "../domain/index.js";
import type { GovernanceDependencies } from "./dependencies.js";
import type { RatingSubjectSelector, SafetySubjectSelector } from "./ports/index.js";

export const GOVERNANCE_ERASURE_TARGET_NAME = "governance";
export const RATING_MODEL = "MessageRating";
export const SAFETY_EVENT_MODEL = "SafetyEvent";
export const EVAL_MODEL = "AgentEval";
export const CRITERION_MODEL = "EvalCriterion";
export const GOLDEN_SET_MODEL = "GoldenSet";

/**
 * Carries a `DomainError` out through a port whose signature has no failure
 * channel.
 *
 * `ErasureTarget.erase` returns `Promise<ErasureReceipt>`. A row that would not
 * be destroyed must NOT produce a receipt claiming it was, so the only truthful
 * option is to reject — which also rolls the caller's transaction back, which is
 * the wanted outcome for a multi-context erasure.
 */
export class GovernanceErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "GovernanceErasureRejected";
    this.domainError = error;
  }
}

/**
 * The kernel's `ErasurePlan` carries `targetName` and `items` and NOTHING about
 * whose data it describes, so a stateless target handed a plan back cannot know
 * what to destroy. Rather than make the target stateful — a plan-id map that
 * leaks on every abandoned plan — the plan this target mints carries its subject
 * as a context-owned rider. It is still exactly an `ErasurePlan` to every other
 * reader, and a plan arriving without the rider is refused rather than guessed.
 */
export interface GovernanceErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
}

export function isGovernanceErasurePlan(plan: ErasurePlan): plan is GovernanceErasurePlan {
  return plan.targetName === GOVERNANCE_ERASURE_TARGET_NAME && "subject" in plan;
}

/** Ratings are keyed by `EndUser.id`; only an end-user subject can match one. */
export function ratingSelectorFor(subject: ErasureSubject): RatingSubjectSelector {
  if (subject.subjectKind !== "end-user") return { scope: subject.scope, endUserId: null };
  return { scope: subject.scope, endUserId: subject.subjectId as EndUserId };
}

/** The ledger records whoever called; an operator and an end user both match. */
export function safetySelectorFor(subject: ErasureSubject): SafetySubjectSelector {
  if (subject.subjectKind === "entity") return { scope: subject.scope, principalId: null };
  return { scope: subject.scope, principalId: subject.subjectId };
}

function deleted(model: string, rowCount: number): ErasurePlanItem {
  // `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
  // evaluate against this plan (ADR M0.3 §1, context 18). This context reports
  // what it holds; it does not adjudicate whether it may go.
  return { model, method: "delete", rowCount, blockedBy: null };
}

function anonymized(model: string, rowCount: number): ErasurePlanItem {
  return { model, method: "anonymize", rowCount, blockedBy: null };
}

function itemsFor(ratings: number, safetyEvents: number): readonly ErasurePlanItem[] {
  return [
    deleted(RATING_MODEL, ratings),
    anonymized(SAFETY_EVENT_MODEL, safetyEvents),
    deleted(EVAL_MODEL, 0),
    deleted(CRITERION_MODEL, 0),
    deleted(GOLDEN_SET_MODEL, 0),
  ];
}

function refuse(error: DomainError): never {
  throw new GovernanceErasureRejected(error);
}

async function buildPlan(
  dependencies: GovernanceDependencies,
  subject: ErasureSubject,
): Promise<GovernanceErasurePlan> {
  const ratingSelector = ratingSelectorFor(subject);
  const safetySelector = safetySelectorFor(subject);

  let ratings = 0;
  if (ratingSelector.endUserId !== null) {
    const counted = await dependencies.ratings.countSubject(ratingSelector);
    if (!counted.ok) refuse(counted.error);
    ratings = counted.value;
  }
  let safetyEvents = 0;
  if (safetySelector.principalId !== null) {
    const counted = await dependencies.safety.countSubject(safetySelector);
    if (!counted.ok) refuse(counted.error);
    safetyEvents = counted.value;
  }
  return { targetName: GOVERNANCE_ERASURE_TARGET_NAME, subject, items: itemsFor(ratings, safetyEvents) };
}

async function carryOutPlan(
  dependencies: GovernanceDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isGovernanceErasurePlan(plan)) refuse(erasurePlanForeign(plan.targetName));
  const ratingSelector = ratingSelectorFor(plan.subject);
  const safetySelector = safetySelectorFor(plan.subject);

  let ratings = 0;
  if (ratingSelector.endUserId !== null) {
    const erased = await dependencies.ratings.eraseSubject(ratingSelector, transaction);
    if (!erased.ok) refuse(erased.error);
    ratings = erased.value;
  }
  let safetyEvents = 0;
  if (safetySelector.principalId !== null) {
    const rewritten = await dependencies.safety.anonymizeSubject(safetySelector, transaction);
    if (!rewritten.ok) refuse(rewritten.error);
    safetyEvents = rewritten.value;
  }
  return {
    targetName: GOVERNANCE_ERASURE_TARGET_NAME,
    erasedAt: dependencies.clock.now(),
    items: itemsFor(ratings, safetyEvents),
  };
}

export function createGovernanceErasureTarget(dependencies: GovernanceDependencies): ErasureTarget {
  return {
    targetName: GOVERNANCE_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) => carryOutPlan(dependencies, plan, transaction),
  };
}
