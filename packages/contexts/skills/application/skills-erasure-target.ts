// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is SOLE WRITER of, and the composition
// root injects the array. `skills` is sole writer of `Skill`, `ProjectSkill` and
// `EnvironmentSkill`.
//
// METHOD, PER MODEL — the decision this file exists to record:
//
//   Skill -> ANONYMIZE, not delete. This is the one place in this context where
//     the answer differs from `files`, and the difference is structural rather
//     than a matter of taste. A skill row is not the subject's data; it is a
//     TOOL the organization runs, and `author` is an attribution on it. Deleting
//     it would remove a capability that other people's agents depend on because
//     the person who uploaded it exercised a right to erasure — the erasure of
//     one subject silently breaking another tenant's production agents. So the
//     attribution is overwritten and the capability survives.
//
//     This is only defensible because of what a skill row CONTAINS. `source`,
//     `manifest` and `promptBlock` are a program and its documentation, authored
//     to be executed by the organization. If they held free-form personal
//     narrative the way an artifact's content does, anonymising the author while
//     leaving the body would be erasure theatre and delete would be the only
//     honest answer — which is exactly the reasoning `files` records for
//     `Artifact`, reaching the opposite conclusion from the same principle.
//
//   ProjectSkill, EnvironmentSkill -> NOT LISTED AT ALL. They carry no subject
//     column. They are keyed by a project or an environment and by the skill,
//     and nothing about them refers to a person. A plan item claiming to erase
//     them would be reporting work that does not exist.
//
// AN ENTITY SUBJECT MATCHES NOTHING HERE, and a zero-row plan is reported rather
// than the target being left out of the operation. "This context holds nothing
// for this subject" is a finding a privacy operator needs to see; silence is
// indistinguishable from a context that failed to answer.

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
import type { SkillsDependencies } from "./dependencies.js";
import type { SkillsErasureSelector } from "./ports/index.js";

export const SKILLS_ERASURE_TARGET_NAME = "skills";
export const SKILL_MODEL = "Skill";

/**
 * Carries a `DomainError` out through a port whose signature has no failure
 * channel.
 *
 * `ErasureTarget.erase` returns `Promise<ErasureReceipt>`. Rows that were not
 * anonymised must NOT produce a receipt claiming they were, so the only truthful
 * option is to reject — which also rolls the caller's transaction back, which is
 * the wanted outcome for a multi-context erasure.
 */
export class SkillsErasureRejected extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(`${error.code}: ${error.message}`);
    this.name = "SkillsErasureRejected";
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
export interface SkillsErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
}

export function isSkillsErasurePlan(plan: ErasurePlan): plan is SkillsErasurePlan {
  return plan.targetName === SKILLS_ERASURE_TARGET_NAME && "subject" in plan;
}

/**
 * Translate a kernel subject into this context's columns.
 *
 * Only an operator `user` matches: a skill is uploaded by an operator, and
 * `author` is a principal. An `end-user` never authors one and an `entity` is
 * not a person, so both select nothing.
 */
export function selectorFor(subject: ErasureSubject): SkillsErasureSelector {
  if (subject.subjectKind === "user") {
    return { scope: subject.scope, principalId: subject.subjectId };
  }
  return { scope: subject.scope, principalId: null };
}

export function selectorIsVacuous(selector: SkillsErasureSelector): boolean {
  return selector.principalId === null;
}

function planItem(rowCount: number): ErasurePlanItem {
  // `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
  // evaluate against this plan (ADR M0.3 §1, context 18). This context reports
  // what it holds; it does not adjudicate whether it may go.
  return { model: SKILL_MODEL, method: "anonymize", rowCount, blockedBy: null };
}

function planFor(subject: ErasureSubject, rowCount: number): SkillsErasurePlan {
  return {
    targetName: SKILLS_ERASURE_TARGET_NAME,
    subject,
    items: [planItem(rowCount)],
  };
}

function refuse(error: DomainError): never {
  throw new SkillsErasureRejected(error);
}

async function buildPlan(
  dependencies: SkillsDependencies,
  subject: ErasureSubject,
): Promise<SkillsErasurePlan> {
  const selector = selectorFor(subject);
  if (selectorIsVacuous(selector)) return planFor(subject, 0);
  const authored = await dependencies.repository.countAuthoredSkills(selector);
  if (!authored.ok) refuse(authored.error);
  return planFor(subject, authored.value);
}

async function carryOutPlan(
  dependencies: SkillsDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isSkillsErasurePlan(plan)) refuse(erasurePlanForeign(plan.targetName));
  const selector = selectorFor(plan.subject);
  if (selectorIsVacuous(selector)) {
    return { targetName: SKILLS_ERASURE_TARGET_NAME, erasedAt: dependencies.clock.now(), items: plan.items };
  }
  const anonymized = await dependencies.repository.anonymizeAuthoredSkills(selector, transaction);
  if (!anonymized.ok) refuse(anonymized.error);
  return {
    targetName: SKILLS_ERASURE_TARGET_NAME,
    erasedAt: dependencies.clock.now(),
    // The receipt reports what was ACTUALLY changed, which may differ from the
    // plan's count if rows moved in between. A receipt that echoed the plan
    // would be a forecast wearing a receipt's name.
    items: [planItem(anonymized.value)],
  };
}

export function createSkillsErasureTarget(dependencies: SkillsDependencies): ErasureTarget {
  return {
    targetName: SKILLS_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) =>
      carryOutPlan(dependencies, plan, transaction),
  };
}
