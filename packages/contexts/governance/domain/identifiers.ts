// Identifiers owned by the `governance` context (ADR M0.3 §1, context 14).
//
// The kernel brands the tenancy tree; these brand the five rows this context is
// SOLE WRITER of — SafetyEvent, MessageRating, EvalCriterion, AgentEval,
// GoldenSet — plus the foreign keys those rows carry and this context reads but
// never writes.
//
// FIVE FOREIGN IDS ARE BRANDED HERE RATHER THAN IMPORTED. A context's `domain/`
// may import only its own domain and `@platos/kernel` (ADR M0.3 §2), so it
// cannot name another context's type. Each brand below is deliberately spelled
// with the SAME tag its owner uses, so the two are one type: an `AgentId` that
// crossed the contract boundary from `agents` reaches a repository method here
// without a cast, and an `AgentVersionId` still cannot.
//
//   AgentId, AgentVersionId  `agents` owns them (ADR M0.3 §1 row 5). ALL FIVE
//                            owned rows carry an `agentId` — three of them
//                            required, and a safety event's and a criterion's
//                            nullable, because a control can fire outside an
//                            agent and a criterion may be shared across an
//                            environment. `AgentVersionId` is carried by a
//                            rating and an eval, the two the canary axis is
//                            drawn from. This context writes neither id.
//   ThreadId, TurnId         `conversations` owns them (row 16). Every row here
//                            except a criterion hangs off one, which is why the
//                            AgentEval erasure item is a zero-count item: the
//                            schema cascades those rows from the thread, so
//                            they go when their owner erases the thread.
//   EndUserId                `identity-access` owns it (row 1). A rating is a
//                            named end user's opinion; a safety event's column
//                            for one is deliberately never written (see
//                            `safety-observation.ts`).

import type { Branded } from "@platos/kernel";

/** `SafetyEvent.id` — uuid. Environment-scoped, append-only. */
export type SafetyEventId = Branded<string, "SafetyEventId">;

/** `MessageRating.id` — uuid. One per `[turn, endUser]`. */
export type MessageRatingId = Branded<string, "MessageRatingId">;

/** `EvalCriterion.id` — uuid. Unique by `[environment, name]`. */
export type EvalCriterionId = Branded<string, "EvalCriterionId">;

/** `AgentEval.id` — uuid. One judged score, immutable once written. */
export type AgentEvalId = Branded<string, "AgentEvalId">;

/** `GoldenSet.id` — uuid. Unique by `[environment, agent, name]`. */
export type GoldenSetId = Branded<string, "GoldenSetId">;

/**
 * One queued golden-set run.
 *
 * NOT A COLUMN. The canonical `AgentEval` model carries no run-grouping column,
 * and the extraction source refuses outright when a caller supplies one rather
 * than claiming a grouping it cannot persist. That refusal is kept: this brand
 * names the QUEUED WORK, which the durable seam owns, and never a stored field.
 */
export type EvalRunId = Branded<string, "EvalRunId">;

/** `Agent.id`. Written by `agents` (ADR M0.3 §1 row 5); named by all five rows here. */
export type AgentId = Branded<string, "AgentId">;

/** `AgentVersion.id`. Written by `agents`; the axis a canary is judged along. */
export type AgentVersionId = Branded<string, "AgentVersionId">;

/** `Thread.id`. Written by `conversations` (row 16). */
export type ThreadId = Branded<string, "ThreadId">;

/** `Turn.id`. Written by `conversations`; the thing a rating and an eval score. */
export type TurnId = Branded<string, "TurnId">;

/** `EndUser.id`. Written by `identity-access` (row 1). */
export type EndUserId = Branded<string, "EndUserId">;

/**
 * Whoever acted.
 *
 * Deliberately not the kernel `PrincipalId`, for the reason `agents` gives:
 * `EvalCriterion.createdBy` and `GoldenSet.createdBy` are plain `String` columns
 * recording authorship, and this context may not import identity-access (ADR
 * M0.3 §1 row 14 allows `tenancy`, `agents`, `kernel`), so it names the actor
 * without adopting identity's model of one.
 */
export type ActorId = Branded<string, "ActorId">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asGovernanceIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
