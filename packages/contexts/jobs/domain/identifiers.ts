// Identifiers owned by the `jobs` context (ADR M0.3 §1, context 15).
//
// The kernel brands the tenancy tree; these brand the rows this context is sole
// writer of — `Job` and `AgentApproval` — plus the ids it references but never
// writes.
//
// TWO PAIRS ARE DELIBERATELY DISTINCT TYPES, because in the live system they are
// both `string` and both routinely in scope at the same call site:
//
//   JobId  / JobKey       `Job.id` (uuid) vs `Job.externalId` (the registered
//                         name a caller dispatches by). `publicJob` in the live
//                         MCP tool emits `jobId: job.externalId ?? job.id`, so
//                         one field has carried BOTH values depending on the row.
//   ApprovalRowId /       `AgentApproval.id` (uuid) vs the `approvalId` minted
//   ApprovalId            into the row's JSON metadata. Every live lookup by
//                         approval takes the SECOND one and resolves it through a
//                         JSON path; `resolve()` then updates by the FIRST.
//
// Branding is what stops those four from substituting for each other silently.

import type { Branded } from "@platos/kernel";

/** `Job.id` — uuid, the primary key. */
export type JobId = Branded<string, "JobId">;

/**
 * `Job.externalId` — the registered name a job is dispatched by, unique inside an
 * environment. Constrained to `^[a-z0-9-]{1,64}$`; see `domain/job-key.ts`.
 */
export type JobKey = Branded<string, "JobKey">;

/** `AgentApproval.id` — uuid, the primary key. */
export type ApprovalRowId = Branded<string, "ApprovalRowId">;

/**
 * The business identifier of an approval, minted by the requester and stored
 * inside the row's `arguments` JSON under `__platosApproval.approvalId`. It is
 * what a waiting caller keys its resume channel by, so it is the id that appears
 * on the wire — not the row's uuid.
 */
export type ApprovalId = Branded<string, "ApprovalId">;

/**
 * The caller-supplied correlation id of ONE execution. It is the idempotency
 * subject: two dispatches sharing it are the same execution.
 */
export type ExecutionRequestId = Branded<string, "ExecutionRequestId">;

// Rows this context references but never writes. They are branded here because
// `jobs` must not import another context's domain to name them (ADR M0.3 §2).
export type AgentId = Branded<string, "AgentId">;
export type ThreadId = Branded<string, "ThreadId">;
export type TurnId = Branded<string, "TurnId">;

/**
 * A digest over a normalised request, used to tell "the same call again" from "a
 * different call reusing an id". Branded because it is a hex string that would
 * otherwise substitute for any other hex string.
 */
export type RequestDigest = Branded<string, "RequestDigest">;
