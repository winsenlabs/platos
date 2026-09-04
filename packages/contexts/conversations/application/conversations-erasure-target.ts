// This context's `ErasureTarget`, for the four rows it is sole writer of.
//
// WHY IT EXISTS AT ALL. ADR M0.3 §3 rejects both obvious shapes for
// right-to-erasure — a port `privacy` defines is a fan-in cycle, and `privacy`
// importing every context is a ten-way fan-out — and hosts the port in the
// kernel instead. Each context implements it for its own rows and the
// composition root injects `ErasureTarget[]`.
//
// AND IT MATTERS MORE HERE THAN ANYWHERE. `Turn.inputText` is literally WHAT A
// SUBJECT SAID. A right-to-erasure operation that omitted this context would
// leave the subject's own words in the database while reporting success — which
// is the exact defect another context shipped this week: the factory existed,
// was tested directly, and was reachable from nowhere because the contract
// declared no `erasureTarget()` and `package.json` publishes only two
// entrypoints. `conversations-erasure-target.test.ts` reaches this target ONLY
// through `createConversationsContract(...).erasureTarget()` for that reason: a
// binder that stops publishing it turns the whole suite red rather than leaving
// it green against a factory nobody wires.
//
// ---------------------------------------------------------------------------
// FOUR MODELS, THREE METHODS, AND THE CHOICE IS DIFFERENT FOR EACH
// ---------------------------------------------------------------------------
//
//   Thread            DELETE. It hangs off `EndUser` with `onDelete: Cascade`,
//                     so the subject's threads are the subject's data and go.
//   Turn              DELETE, BY CASCADE. `Turn.thread` is
//                     `onDelete: Cascade`, so deleting the thread takes them.
//                     It is named on the plan with its real count anyway,
//                     because a plan is what an operator reviews and "the turns
//                     go too" must be visible rather than implied.
//   Step              DELETE, BY CASCADE, one level further down. Same
//                     reasoning, same visibility.
//   PostmanExecution  ANONYMIZE. This is the one row here written on an
//                     OPERATOR's behalf, and `actorUserId` is
//                     `onDelete: Restrict` to `User`: the row is an audit trail
//                     and deleting it would erase the record that an operator
//                     ran an agent, which is not the subject's data to erase.
//                     What goes is the LINK — `simulatedEndUserId`, whose own
//                     column is already `onDelete: SetNull`. So the row
//                     survives, stripped.
//
// A `user` SUBJECT GETS A DIFFERENT PLAN FROM AN `end-user` SUBJECT, and this is
// the only context in the tree where that is true. Erasing an operator does not
// touch a single thread — an operator has none — and touches only the
// executions they launched. Erasing an end user touches everything else. A
// target that answered the same plan for both would either destroy an audit
// trail or leave a subject's words behind.
//
// `plan` MUST NOT MUTATE. The kernel port says so, and it is not a formality: a
// plan is what a legal hold is evaluated against and what an operator reviews
// before anything is destroyed. The census methods count; the erase methods
// destroy; they are different methods on the store for exactly that reason.

import type {
  ErasurePlan,
  ErasurePlanItem,
  ErasureReceipt,
  ErasureSubject,
  ErasureTarget,
  TransactionScope,
} from "@platos/kernel";

import { erasurePlanForeign, type EndUserId } from "../domain/index.js";
import type { ConversationsDependencies } from "./dependencies.js";

export const CONVERSATIONS_ERASURE_TARGET_NAME = "conversations";

const THREAD_MODEL = "Thread";
const TURN_MODEL = "Turn";
const STEP_MODEL = "Step";
const POSTMAN_MODEL = "PostmanExecution";

function item(
  model: string,
  method: ErasurePlanItem["method"],
  rowCount: number,
  blockedBy: string | null = null,
): ErasurePlanItem {
  return { model, method, rowCount, blockedBy };
}

/**
 * A refusal `privacy` sees as a thrown error rather than a `Result`.
 *
 * The kernel port's `plan` and `erase` return bare promises, so a refusal here
 * has to throw. It carries the domain error's code so the two vocabularies do
 * not diverge: what an operator reads in a log is the same string every other
 * refusal in this package produces.
 */
export class ConversationsErasureRejected extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConversationsErasureRejected";
    this.code = code;
  }
}

async function buildPlan(
  dependencies: ConversationsDependencies,
  subject: ErasureSubject,
): Promise<ErasurePlan> {
  const organizationId = subject.scope.organizationId;

  if (subject.subjectKind === "end-user") {
    const census = await dependencies.erasureStore.censusForEndUser(
      subject.subjectId as EndUserId,
      organizationId,
    );
    if (!census.ok) throw new ConversationsErasureRejected(census.error.code, census.error.message);

    const held = await dependencies.erasureStore.findHeldThreads(
      subject.subjectId as EndUserId,
      organizationId,
    );
    if (!held.ok) throw new ConversationsErasureRejected(held.error.code, held.error.message);
    const blockedBy = held.value.length > 0 ? `legal-hold:${held.value.length}` : null;

    return {
      targetName: CONVERSATIONS_ERASURE_TARGET_NAME,
      items: [
        item(THREAD_MODEL, "delete", census.value.threadCount, blockedBy),
        item(TURN_MODEL, "delete", census.value.turnCount, blockedBy),
        item(STEP_MODEL, "delete", census.value.stepCount, blockedBy),
        item(POSTMAN_MODEL, "anonymize", census.value.postmanExecutionCount),
      ],
    };
  }

  /**
   * An operator or an entity subject. NO THREADS, and the three zeros are
   * deliberate rather than an omission: an operator authors no conversation, so
   * the plan says so with a count rather than by leaving the models out. A
   * reader comparing two plans can then see that the difference is the subject
   * and not a target that forgot a model.
   */
  const census = await dependencies.erasureStore.censusForActor(subject.subjectId, organizationId);
  if (!census.ok) throw new ConversationsErasureRejected(census.error.code, census.error.message);
  return {
    targetName: CONVERSATIONS_ERASURE_TARGET_NAME,
    items: [
      item(THREAD_MODEL, "delete", 0),
      item(TURN_MODEL, "delete", 0),
      item(STEP_MODEL, "delete", 0),
      item(POSTMAN_MODEL, "anonymize", census.value.postmanExecutionCount),
    ],
  };
}

async function carryOutPlan(
  dependencies: ConversationsDependencies,
  plan: ErasurePlan,
  transaction: TransactionScope,
  subject: ErasureSubject,
): Promise<ErasureReceipt> {
  if (plan.targetName !== CONVERSATIONS_ERASURE_TARGET_NAME) {
    const error = erasurePlanForeign(plan.targetName);
    throw new ConversationsErasureRejected(error.code, error.message);
  }

  const organizationId = subject.scope.organizationId;
  if (subject.subjectKind === "end-user") {
    const threads = await dependencies.erasureStore.deleteThreadsForEndUser(
      subject.subjectId as EndUserId,
      organizationId,
      transaction,
    );
    if (!threads.ok) throw new ConversationsErasureRejected(threads.error.code, threads.error.message);

    const stripped = await dependencies.erasureStore.anonymizeExecutionsForEndUser(
      subject.subjectId as EndUserId,
      organizationId,
      transaction,
    );
    if (!stripped.ok) {
      throw new ConversationsErasureRejected(stripped.error.code, stripped.error.message);
    }

    const planned = new Map(plan.items.map((entry) => [entry.model, entry]));
    return {
      targetName: CONVERSATIONS_ERASURE_TARGET_NAME,
      erasedAt: dependencies.clock.now(),
      items: [
        item(THREAD_MODEL, "delete", threads.value),
        item(TURN_MODEL, "delete", planned.get(TURN_MODEL)?.rowCount ?? 0),
        item(STEP_MODEL, "delete", planned.get(STEP_MODEL)?.rowCount ?? 0),
        item(POSTMAN_MODEL, "anonymize", stripped.value),
      ],
    };
  }

  const stripped = await dependencies.erasureStore.anonymizeExecutionsForActor(
    subject.subjectId,
    organizationId,
    transaction,
  );
  if (!stripped.ok) throw new ConversationsErasureRejected(stripped.error.code, stripped.error.message);
  return {
    targetName: CONVERSATIONS_ERASURE_TARGET_NAME,
    erasedAt: dependencies.clock.now(),
    items: [
      item(THREAD_MODEL, "delete", 0),
      item(TURN_MODEL, "delete", 0),
      item(STEP_MODEL, "delete", 0),
      item(POSTMAN_MODEL, "anonymize", stripped.value),
    ],
  };
}

/**
 * The target, built once per contract.
 *
 * A STABLE INSTANCE, matching `files` and `governance` rather than the
 * fresh-per-call form `jobs` and `memory` use. A composition root that received
 * a new target on every call could inject two of them into `privacy` and count
 * the same rows twice, and `conversations-erasure-target.test.ts` asserts
 * identity across two calls so that stays true.
 *
 * THE SUBJECT IS CARRIED FROM `plan` TO `erase`. The kernel's `erase` takes only
 * the plan and the transaction, and a plan does not name its subject — so a
 * target that forgot which subject it planned for would have to guess. This one
 * remembers the last subject it planned, keyed by the plan it produced, which is
 * why `erase` refuses a plan it did not build.
 */
export function createConversationsErasureTarget(
  dependencies: ConversationsDependencies,
): ErasureTarget {
  const subjects = new WeakMap<ErasurePlan, ErasureSubject>();

  return {
    targetName: CONVERSATIONS_ERASURE_TARGET_NAME,
    plan: async (subject: ErasureSubject) => {
      const built = await buildPlan(dependencies, subject);
      subjects.set(built, subject);
      return built;
    },
    erase: async (plan: ErasurePlan, transaction: TransactionScope) => {
      const subject = subjects.get(plan);
      if (subject === undefined) {
        const error = erasurePlanForeign(plan.targetName);
        throw new ConversationsErasureRejected(
          error.code,
          "this plan was not produced by this target",
        );
      }
      return carryOutPlan(dependencies, plan, transaction, subject);
    },
  };
}
