// The erasure half of this context's stores, kept apart from the read/write half.
//
// WHY IT IS A SEPARATE PORT. `privacy` calls `plan` and then `erase` inside ITS
// transaction (the kernel `ErasureTarget` takes a `TransactionScope`), and the
// two methods are the only ones in this package that delete rows. Putting them
// on `ThreadRepository` would hand every use case in the context a `deleteAll`
// it has no business holding, and would make the one dangerous surface
// indistinguishable from the ordinary ones at every call site.
//
// COUNTS BEFORE DELETES, ALWAYS. `plan` must not mutate — the kernel port says
// so — because a plan is what a legal hold is evaluated against and what an
// operator reviews before anything is destroyed. So the counting methods and the
// destroying methods are different methods, and the destroying ones take the
// plan.
//
// THE THREE MODELS ARE NOT ERASED THE SAME WAY, AND THE PORT SHOWS IT.
// `Thread` is deleted; `Turn` and `Step` go with it by cascade, so they appear
// on the plan with a count and are erased by the thread's own delete rather than
// by a statement of their own. `PostmanExecution` is ANONYMIZED, not deleted: it
// carries `actorUserId` restricted to `User`, so an operator's erasure cannot
// delete the row without orphaning an audit trail, and it is the simulated end
// user's link that is severed. `conversations-erasure-target.ts` states the
// choice per model and this port is shaped to it.

import type { Result, TransactionScope } from "@platos/kernel";

import type { EndUserId, ThreadId } from "../../domain/index.js";

/** What a subject's data amounts to, counted and not touched. */
export interface ErasureCensus {
  readonly threadCount: number;
  readonly turnCount: number;
  readonly stepCount: number;
  readonly postmanExecutionCount: number;
}

export interface ConversationsErasureStore {
  /** Count only. MUST NOT mutate: `plan` is what a legal hold is judged against. */
  censusForEndUser(subjectId: EndUserId, organizationId: string): Promise<Result<ErasureCensus>>;
  /** The operator half: postman executions this user launched. */
  censusForActor(subjectId: string, organizationId: string): Promise<Result<ErasureCensus>>;

  /**
   * Delete a subject's threads inside the caller's transaction.
   *
   * `Turn` and `Step` cascade from `Thread`; the adapter does not delete them
   * itself and MUST NOT, because a partial cascade is how a step outlives the
   * turn it belongs to.
   */
  deleteThreadsForEndUser(
    subjectId: EndUserId,
    organizationId: string,
    transaction: TransactionScope,
  ): Promise<Result<number>>;

  /**
   * Sever a simulated end user from the executions that named them.
   *
   * ANONYMIZE, not delete. `PostmanExecution.actorUserId` is `onDelete: Restrict`
   * to `User` and the row is an operator audit trail, so the row survives with
   * `simulatedEndUserId` nulled — which is exactly what the column's own
   * `onDelete: SetNull` already says should happen.
   */
  anonymizeExecutionsForEndUser(
    subjectId: EndUserId,
    organizationId: string,
    transaction: TransactionScope,
  ): Promise<Result<number>>;

  /** The same severing for an operator subject, on `actorUserId`. */
  anonymizeExecutionsForActor(
    subjectId: string,
    organizationId: string,
    transaction: TransactionScope,
  ): Promise<Result<number>>;

  /** Threads an operator hold or retention rule blocks. Named on the plan. */
  findHeldThreads(subjectId: EndUserId, organizationId: string): Promise<Result<readonly ThreadId[]>>;
}
