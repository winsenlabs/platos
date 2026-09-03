// Identifiers owned or referenced by the `observability` context
// (ADR M0.3 §1, context 12).
//
// This context is a PROJECTION. Almost every id below names a row another
// context is sole writer of — a Turn, a Step, a Tool Call — and this package
// only ever copies them into an analytical column or an audit row. That is
// exactly why they are branded: the projection's whole job is to put four
// different opaque uuids into four adjacent columns of one row, and a `string`
// parameter list is the shape in which `stepId` silently lands in `turn_id`.
//
// The kernel already brands the tenancy tree (`OrganizationId`, `ProjectId`,
// `EnvironmentId`, `EntityId`, `PrincipalId`), so those are imported rather than
// re-declared. Everything else this context names is branded here, because a
// context may not import another context's `domain/` to borrow a type
// (ADR M0.3 §2).

import type { Branded } from "@platos/kernel";

// --- rows this context is sole writer of ------------------------------------

/** `AdminAudit.id` — uuid. */
export type AdminAuditId = Branded<string, "AdminAuditId">;

/**
 * One queued projection, as the drain sees it.
 *
 * Opaque on purpose: the queue row is written by the kernel outbox adapter
 * (ADR M0.3 §1 closing note), and this context settles it by handing the id
 * back. Knowing nothing else about it is what keeps the decision here and the
 * write there.
 */
export type EnvelopeId = Branded<string, "EnvelopeId">;

// --- rows this context projects but never writes -----------------------------

export type TurnId = Branded<string, "TurnId">;
export type StepId = Branded<string, "StepId">;
export type ToolCallId = Branded<string, "ToolCallId">;
export type UsageEventId = Branded<string, "UsageEventId">;
export type ThreadId = Branded<string, "ThreadId">;
export type AgentId = Branded<string, "AgentId">;
export type AgentVersionId = Branded<string, "AgentVersionId">;
export type ToolId = Branded<string, "ToolId">;
export type SkillId = Branded<string, "SkillId">;
export type EndUserId = Branded<string, "EndUserId">;

/**
 * The keyed pseudonymous join key.
 *
 * It is NOT an id of anything: it is a salted, organization-scoped digest, and
 * it deliberately SURVIVES erasure so aggregates stay continuous after a
 * subject is unlinked. Branding it separately from `EndUserId` is what stops
 * the two being swapped in a column list where one is cleared and one is kept.
 */
export type SubjectKeyHash = Branded<string, "SubjectKeyHash">;

// Correlation handles. Free-form strings on the wire, and the two easiest
// values in this whole context to transpose, since they sit side by side in
// every row builder.
export type TraceId = Branded<string, "TraceId">;
export type SpanId = Branded<string, "SpanId">;
