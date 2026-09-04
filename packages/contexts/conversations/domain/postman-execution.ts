// `PostmanExecution` — one operator-launched request against an agent, and the
// fourth row this context is sole writer of.
//
// WHAT IT IS FOR. An operator wants to run an agent as if they were a particular
// end user, from a saved request or an ad-hoc one, and see the turn it produces.
// So this row is the bridge between an OPERATOR acting and an END USER's thread
// being written: `actorUserId` is who pressed the button, `simulatedEndUserId` is
// whose conversation it lands in, and both are on the row because an audit that
// records only one of them cannot answer either question.
//
// IT IS THE ONE ROW HERE WRITTEN ON AN OPERATOR'S BEHALF. Everything else in
// this context hangs off an end user. That is why it is the only row whose
// erasure plan has a `user` subject as well as an `end-user` one, and
// `conversations-erasure-target.ts` says which method each gets.
//
// THREE UNIQUENESS RULES, THREE REFUSALS, AND THEY ARE NOT THE SAME REFUSAL.
//
//   `@@unique([templateId, requestId])` — the SAME saved request launched twice.
//   That is a replay, and a caller retrying a timed-out request is the common
//   case, so it answers with its own code and the existing execution can be
//   handed back rather than a second one created.
//   THE FINGERPRINT — one `requestId`, two different bodies. The constraint
//   above cannot see this: both rows would collide identically. Answering the
//   first execution would hand a caller somebody else's result, so it is a
//   distinct refusal with a distinct code, and `requestFingerprint` exists on
//   the row for exactly this comparison.
//   `contextHandle @unique` with `contextExpiresAt` — the handle is a CAPABILITY
//   with a deadline. Whoever holds it can name this execution, so an expired one
//   is refused rather than renewed. The source has the columns and never checks
//   the expiry.
//
// THE HANDLE IS NEVER LOGGED AND NEVER RETURNED IN A LIST. It is minted once,
// handed to the caller that created the execution, and compared. `PostmanContext
// Handle` is branded so it cannot be assigned into a row id, and the views this
// context publishes carry the execution id instead.

import { err, ok, type Result } from "@platos/kernel";

import {
  postmanAlreadySettled,
  postmanFingerprintMismatch,
  postmanHandleExpired,
} from "./errors.js";
import type {
  ActorId,
  AgentId,
  EndUserId,
  PostmanContextHandle,
  PostmanExecutionId,
  PostmanTemplateId,
  ThreadId,
  TurnId,
} from "./identifiers.js";
import { transition, type WorkStatus } from "./work-status.js";

export interface PostmanExecution {
  readonly executionId: PostmanExecutionId;
  readonly agentId: AgentId;
  readonly templateId: PostmanTemplateId | null;
  /** The caller's own id for this request. Unique per template. */
  readonly requestId: string;
  /** A digest of the request body. What tells a replay from a collision. */
  readonly requestFingerprint: string;
  readonly actorUserId: ActorId;
  readonly simulatedEndUserId: EndUserId | null;
  readonly contextHandle: PostmanContextHandle;
  readonly contextExpiresAt: Date;
  readonly status: WorkStatus;
  readonly threadId: ThreadId | null;
  readonly turnId: TurnId | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PostmanExecutionDraft {
  readonly executionId: PostmanExecutionId;
  readonly agentId: AgentId;
  readonly templateId?: PostmanTemplateId | null;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly actorUserId: ActorId;
  readonly simulatedEndUserId?: EndUserId | null;
  readonly contextHandle: PostmanContextHandle;
  readonly contextExpiresAt: Date;
  readonly at: Date;
}

/** Open an execution. PENDING until a turn settles under it. */
export function openPostmanExecution(draft: PostmanExecutionDraft): PostmanExecution {
  return Object.freeze({
    executionId: draft.executionId,
    agentId: draft.agentId,
    templateId: draft.templateId ?? null,
    requestId: draft.requestId,
    requestFingerprint: draft.requestFingerprint,
    actorUserId: draft.actorUserId,
    simulatedEndUserId: draft.simulatedEndUserId ?? null,
    contextHandle: draft.contextHandle,
    contextExpiresAt: draft.contextExpiresAt,
    status: "PENDING" as WorkStatus,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: draft.at,
    updatedAt: draft.at,
  });
}

/**
 * Check a handle against the clock.
 *
 * Answers the execution so a caller cannot check one and then act on another.
 * `at` is supplied rather than read: nothing in this package reaches for the
 * wall clock, which is what lets a test pin an expiry to the millisecond.
 */
export function requireLiveHandle(execution: PostmanExecution, at: Date): Result<PostmanExecution> {
  if (execution.contextExpiresAt.getTime() <= at.getTime()) {
    return err(postmanHandleExpired(execution.contextHandle, execution.contextExpiresAt));
  }
  return ok(execution);
}

/**
 * Decide what a repeated `requestId` means.
 *
 * A matching fingerprint is a REPLAY and answers the existing execution, which
 * is what a caller retrying wants. A differing one is a collision and is
 * refused: handing back the first execution would give this caller a result
 * computed from a different request.
 */
export function reconcileReplay(
  existing: PostmanExecution,
  requestFingerprint: string,
): Result<PostmanExecution> {
  if (existing.requestFingerprint !== requestFingerprint) {
    return err(postmanFingerprintMismatch(existing.requestId));
  }
  return ok(existing);
}

export interface PostmanSettlement {
  readonly status: WorkStatus;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly at: Date;
}

/** Bind the execution to the turn it produced and settle it. */
export function settlePostmanExecution(
  execution: PostmanExecution,
  settlement: PostmanSettlement,
): Result<PostmanExecution> {
  const moved = transition(execution.executionId, execution.status, settlement.status);
  if (!moved.ok) return err(postmanAlreadySettled(execution.executionId, execution.status));
  return ok(
    Object.freeze({
      ...execution,
      status: moved.value,
      threadId: settlement.threadId,
      turnId: settlement.turnId,
      completedAt: settlement.at,
      updatedAt: settlement.at,
    }),
  );
}
