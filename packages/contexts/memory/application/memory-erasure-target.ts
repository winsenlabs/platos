// This context's implementation of the kernel `ErasureTarget` port.
//
// ADR M0.3 §3 hosts the port in the kernel precisely so that `privacy` never
// imports anyone and nobody implements a `privacy`-defined interface: each
// context implements it for the rows it is sole writer of, the composition root
// injects the array. `memory` is sole writer of `Memory`, `MemoryEntity` and
// `MemoryRelationship`, so those are the three plan items below and there are no
// others.
//
// METHOD, PER MODEL — the decision this file exists to record. All three are
// DELETE, and anonymisation was considered and rejected for each:
//
//   Memory -> delete. The identifying content is the CONTENT: a memory is a
//     sentence about a person, and no column rewrite removes the person from it.
//     Overwriting `endUserId` while leaving "prefers to be called Sam and works
//     at Acme" intact would be erasure theatre.
//
//   MemoryEntity -> delete. A node's `label` and `aliases` are usually the
//     subject's own name or the names of people around them. The same argument.
//
//   MemoryRelationship -> delete, and BEFORE the nodes. The schema cascades from
//     both endpoints, so a store would remove them anyway — but a cascade
//     reports nothing, and a receipt that claimed a count it did not observe
//     would be a receipt nobody can audit. Deleting them explicitly is what
//     makes the number in the receipt a number this context actually saw.
//
// THE SUBJECT MUST BE AN END USER. Every row in this context is keyed by
// `endUserId`. An operator `user` subject and an `entity` subject match nothing
// here, and reporting a zero-row plan is more honest than omitting the target
// from the operation altogether — an omitted target looks like a context that
// was never asked.

import type {
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { asMemoryIdentifier, type EndUserId } from "../domain/index.js";
import type { MemoryDependencies } from "./dependencies.js";
import type { MemoryErasureSelector } from "./ports/index.js";

export const MEMORY_ERASURE_TARGET_NAME = "memory";
export const MEMORY_MODEL = "Memory";
export const MEMORY_ENTITY_MODEL = "MemoryEntity";
export const MEMORY_RELATIONSHIP_MODEL = "MemoryRelationship";

/**
 * Carries a failure out through a port whose signature has no failure channel.
 *
 * `ErasureTarget.erase` returns `Promise<ErasureReceipt>`. A row that would not
 * be destroyed must NOT produce a receipt claiming it was, so the only truthful
 * option is to reject — which also rolls the caller's transaction back, which is
 * the wanted outcome for a multi-context erasure.
 */
export class MemoryErasureRejected extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "MemoryErasureRejected";
    this.code = code;
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
export interface MemoryErasurePlan extends ErasurePlan {
  readonly subject: ErasureSubject;
}

export function isMemoryErasurePlan(plan: ErasurePlan): plan is MemoryErasurePlan {
  return plan.targetName === MEMORY_ERASURE_TARGET_NAME && "subject" in plan;
}

/** Translate a kernel subject into this context's one keyed column. */
export function selectorFor(subject: ErasureSubject): MemoryErasureSelector | null {
  if (subject.subjectKind !== "end-user") return null;
  if (subject.scope.level !== "environment") return null;
  return {
    environment: subject.scope,
    endUserId: asMemoryIdentifier<EndUserId>(subject.subjectId),
  };
}

/**
 * `blockedBy` stays null: legal hold and retention policy are `privacy`'s to
 * evaluate against this plan (ADR M0.3 §1, context 18). This context reports
 * what it holds; it does not adjudicate whether it may go.
 */
function planItem(model: string, rowCount: number): ErasurePlanItem {
  return { model, method: "delete", rowCount, blockedBy: null };
}

function planFor(
  subject: ErasureSubject,
  memories: number,
  entities: number,
  relationships: number,
): MemoryErasurePlan {
  return {
    targetName: MEMORY_ERASURE_TARGET_NAME,
    subject,
    items: [
      planItem(MEMORY_MODEL, memories),
      planItem(MEMORY_ENTITY_MODEL, entities),
      planItem(MEMORY_RELATIONSHIP_MODEL, relationships),
    ],
  };
}

async function buildPlan(
  dependencies: MemoryDependencies,
  subject: ErasureSubject,
): Promise<MemoryErasurePlan> {
  const selector = selectorFor(subject);
  if (selector === null) return planFor(subject, 0, 0, 0);

  const memories = await dependencies.repository.countMemoriesForSubject(selector);
  if (!memories.ok) throw new MemoryErasureRejected(memories.error.code, memories.error.message);
  const entities = await dependencies.graph.countEntitiesForSubject(selector);
  if (!entities.ok) throw new MemoryErasureRejected(entities.error.code, entities.error.message);
  const relationships = await dependencies.graph.countRelationshipsForSubject(selector);
  if (!relationships.ok) {
    throw new MemoryErasureRejected(relationships.error.code, relationships.error.message);
  }
  return planFor(subject, memories.value, entities.value, relationships.value);
}

async function carryOutPlan(
  dependencies: MemoryDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
): Promise<ErasureReceipt> {
  if (!isMemoryErasurePlan(plan)) {
    throw new MemoryErasureRejected(
      "MEMORY_ERASURE_PLAN_FOREIGN",
      `plan belongs to ${plan.targetName}, not to ${MEMORY_ERASURE_TARGET_NAME}`,
    );
  }
  const selector = selectorFor(plan.subject);
  const erasedAt = dependencies.clock.now();
  if (selector === null) {
    return { targetName: MEMORY_ERASURE_TARGET_NAME, erasedAt, items: plan.items };
  }

  // Edges, then nodes, then memories. Edges first because their endpoints are
  // about to go; memories last because a relationship's `sourceMemoryId` is
  // `SetNull`, and destroying the memories first would blank a provenance this
  // operation is about to destroy anyway — work with no reader.
  const relationships = await dependencies.graph.deleteRelationshipsForSubject(selector, transaction);
  if (!relationships.ok) {
    throw new MemoryErasureRejected(relationships.error.code, relationships.error.message);
  }
  const entities = await dependencies.graph.deleteEntitiesForSubject(selector, transaction);
  if (!entities.ok) throw new MemoryErasureRejected(entities.error.code, entities.error.message);
  const memories = await dependencies.repository.deleteMemoriesForSubject(selector, transaction);
  if (!memories.ok) throw new MemoryErasureRejected(memories.error.code, memories.error.message);

  return {
    targetName: MEMORY_ERASURE_TARGET_NAME,
    erasedAt,
    items: [
      planItem(MEMORY_MODEL, memories.value),
      planItem(MEMORY_ENTITY_MODEL, entities.value),
      planItem(MEMORY_RELATIONSHIP_MODEL, relationships.value),
    ],
  };
}

export function createMemoryErasureTarget(dependencies: MemoryDependencies): ErasureTarget {
  return {
    targetName: MEMORY_ERASURE_TARGET_NAME,
    plan: (subject: ErasureSubject) => buildPlan(dependencies, subject),
    erase: (plan: ErasurePlan, transaction: TransactionScope) =>
      carryOutPlan(dependencies, plan, transaction),
  };
}
