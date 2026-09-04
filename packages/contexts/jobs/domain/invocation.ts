// How a job may be started, and who is allowed to start it.
//
// THE TWO VOCABULARIES ARE NOT THE SAME SET, and conflating them is the defect
// this module exists to prevent. The live system has:
//
//   stored on the row   manual | schedule | webhook | agent-spawn
//                       (`INVOCATION_TYPES` in the MCP jobs tool — the enum a
//                       caller may persist)
//   claimed by a caller manual | schedule | webhook | agent
//                       (`INVOCATION_TYPES` in the job-execution service — the
//                       `invokedBy` a dispatch may assert)
//
// `agent-spawn` can be STORED but never CLAIMED; `agent` can be CLAIMED but never
// STORED. Every other member appears in both. So the authorization rule is not
// equality — it is equality PLUS the single documented bridge:
//
//     stored === claimed  ||  (claimed === "agent" && stored === "agent-spawn")
//
// That bridge is `job-execution.service.ts`:
//
//     jobInvocationType(job) !== request.invokedBy &&
//     !(request.invokedBy === "agent" && jobInvocationType(job) === "agent-spawn")
//
// Written as a table rather than a boolean expression because the asymmetry is
// the whole content of the rule, and a table cannot be misread as symmetric.
//
// ON THE COLUMN NAME. The persisted Prisma field is `invocationType`; its
// database column still carries the pre-cutover vendor name behind an `@map`.
// This layer names only
// the domain concept, and an adapter is responsible for the column.
//
// A NOTE FOR WHOEVER WRITES THAT ADAPTER. The live `apps/agent` reads and writes
// this field through `agent-runtime/job-persistence.ts`, which assembles the
// pre-cutover column name at runtime from string fragments. `@map` renames
// the COLUMN, not the Prisma client property, so that helper addresses a field
// the generated client does not have. Do not copy it. The client property is
// `invocationType`; the adapter needs nothing else. This is reported as a live
// defect against the v1 line rather than fixed here, because `apps/agent` is
// outside this context's boundary.

import { err, ok, type Result } from "@platos/kernel";

import { invocationTypeInvalid, jobNotAuthorized } from "./errors.js";

/** What a `Job` row may record as its invocation type. */
export const STORED_INVOCATION_TYPES = ["manual", "schedule", "webhook", "agent-spawn"] as const;

export type StoredInvocationType = (typeof STORED_INVOCATION_TYPES)[number];

/** What a dispatch may claim as its invoker. */
export const CLAIMED_INVOKERS = ["agent", "manual", "schedule", "webhook"] as const;

export type ClaimedInvoker = (typeof CLAIMED_INVOKERS)[number];

export function isStoredInvocationType(value: string): value is StoredInvocationType {
  return (STORED_INVOCATION_TYPES as readonly string[]).includes(value);
}

export function isClaimedInvoker(value: string): value is ClaimedInvoker {
  return (CLAIMED_INVOKERS as readonly string[]).includes(value);
}

export function parseStoredInvocationType(value: string): Result<StoredInvocationType> {
  return isStoredInvocationType(value)
    ? ok(value)
    : err(invocationTypeInvalid(value, STORED_INVOCATION_TYPES));
}

/**
 * The complete claimed -> stored acceptance table. Exhaustive by construction:
 * one entry per claimed invoker, listing every stored type it may start.
 */
const ACCEPTS: Readonly<Record<ClaimedInvoker, readonly StoredInvocationType[]>> = Object.freeze({
  // The one asymmetric row: an agent dispatch starts an `agent-spawn` job, and
  // `agent` is never itself a storable type.
  agent: ["agent-spawn"],
  manual: ["manual"],
  schedule: ["schedule"],
  webhook: ["webhook"],
});

/** True when a caller claiming `invoker` may start a job stored as `stored`. */
export function invokerMayStart(invoker: ClaimedInvoker, stored: StoredInvocationType): boolean {
  return ACCEPTS[invoker].includes(stored);
}

/**
 * The authorization decision, as a `Result` so a refusal carries the live
 * `JOB_NOT_AUTHORIZED` code rather than a bare false.
 */
export function authorizeInvocation(
  invoker: ClaimedInvoker,
  stored: StoredInvocationType,
): Result<StoredInvocationType> {
  if (invokerMayStart(invoker, stored)) return ok(stored);
  return err(
    jobNotAuthorized("this invoker may not start a job of that invocation type", {
      invokedBy: invoker,
      invocationType: stored,
    }),
  );
}

/**
 * The agent allow-list on the row. An EMPTY list means "any agent", which is the
 * live default (`allowedAgentIds String[] @default([])`) — so a populated list is
 * a restriction and an empty one is not. Only consulted for an `agent` dispatch;
 * a manual or scheduled start is never filtered by it.
 */
export function authorizeAgent(
  invoker: ClaimedInvoker,
  allowedAgentIds: readonly string[],
  agentId: string | null,
): Result<null> {
  if (invoker !== "agent") return ok(null);
  if (allowedAgentIds.length === 0) return ok(null);
  if (agentId !== null && allowedAgentIds.includes(agentId)) return ok(null);
  return err(
    jobNotAuthorized("agent is not on this job's allow-list", {
      agentId: agentId ?? "(none)",
    }),
  );
}
