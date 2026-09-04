// `ToolCallAudit` — the durable, scope-stamped record of every dispatch.
//
// It is NOT a duplicate of `ToolCall`. A `ToolCall` belongs to a `Step` of a
// `Turn` and is erased with the thread that owns it; an audit row belongs to an
// ENVIRONMENT, outlives every conversation in it, and is what an operator reads
// when asking what a customer's backend was asked to do last Tuesday. The
// foreign keys say so: `ToolCall.stepId` cascades, while every optional key on
// this row is `SetNull`, so deleting an agent, an end user or a thread leaves
// the audit intact and merely anonymous.
//
// THE ROW HOLDS MORE FIELDS THAN THE TABLE HAS COLUMNS, AND THE OVERFLOW IS
// STRUCTURED RATHER THAN LOST. The source packs ten identity and provenance
// fields into an envelope inside the `arguments` Json column, under a reserved
// key, beside the value. That is transcribed here as an explicit
// `AuditEnvelope`, because the alternative — a bag of fields the adapter
// invents a layout for — is how a replay endpoint and a list endpoint end up
// disagreeing about where `endUserId` lives.
//
// TWO FIELDS ARE ENCRYPTED AND THE THIRD IS NOT, AND THE SOURCE SAYS WHY.
// `arguments` and `result` routinely carry the user's question and rows from
// the backend, so they go through the crypto envelope; `error` is a `String`
// column holding stack traces and status codes, so it does not. That asymmetry
// is a real gap and it is recorded on `AuditEntry.error` rather than being
// quietly closed here — closing it is a storage change, not a domain one.
//
// THE ENCRYPTION ITSELF IS NOT THIS LAYER'S. `secrets` is the encryption
// boundary (ADR M0.3 §1 row 3) and the only holder of data keys. What this file
// owns is WHICH fields are sensitive and WHAT an audit row means; the envelope
// is applied at the seam in `application/`.

import type { EnvironmentId } from "@platos/kernel";

import type {
  ActorId,
  AgentId,
  EndUserId,
  ExternalEntityId,
  ThreadId,
  ToolCallAuditId,
  ToolId,
  ToolName,
} from "./identifiers.js";
import type { CallStatus } from "./call.js";
import type { HealthOutcome } from "./health.js";

/** Where a dispatch came from. Null on rows written before the tag existed. */
export const DISPATCH_SOURCES = ["turn", "skill", "mcp", "operator", "replay"] as const;

export type DispatchSource = (typeof DISPATCH_SOURCES)[number];

/**
 * The identity and provenance an audit row carries beside its columns.
 *
 * Every field is nullable because every one of them is genuinely absent on some
 * real path: a wire dispatch has no `mcpClientId`, an operator replay has no
 * `endUserId`, and a pre-tagging row has none of them.
 */
export interface AuditEnvelope {
  readonly externalEntityId: ExternalEntityId | null;
  readonly endUserId: EndUserId | null;
  readonly actorUserId: ActorId | null;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
  readonly source: DispatchSource | null;
  /** The MCP principal, verbatim — `mcp:pat:<id>` or an OIDC subject. */
  readonly mcpPrincipalId: string | null;
  readonly mcpClientId: string | null;
}

export const EMPTY_AUDIT_ENVELOPE: AuditEnvelope = Object.freeze({
  externalEntityId: null,
  endUserId: null,
  actorUserId: null,
  spanId: null,
  parentSpanId: null,
  source: null,
  mcpPrincipalId: null,
  mcpClientId: null,
});

export interface AuditEntry {
  readonly toolCallAuditId: ToolCallAuditId;
  readonly environmentId: EnvironmentId;
  readonly toolId: ToolId | null;
  readonly toolName: ToolName;
  readonly agentId: AgentId | null;
  readonly threadId: ThreadId | null;
  readonly endUserId: EndUserId | null;
  readonly traceId: string | null;
  /** Sensitive. Sealed by `secrets` before it reaches the store. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Sensitive. Sealed by `secrets` before it reaches the store. */
  readonly result: unknown;
  /** NOT sealed — a `String` column. See the header note. */
  readonly error: string | null;
  readonly status: CallStatus;
  readonly latencyMs: number;
  /** Canonical `Decimal(18, 6)` cents as a string. Never a number. */
  readonly costCents: string | null;
  readonly envelope: AuditEnvelope;
  readonly createdAt: Date;
}

/**
 * The dispatch outcome, as the audit column spells it.
 *
 * A TIMEOUT IS A FAILURE HERE AND IS NOT ONE IN `ToolHealth`. The audit column
 * is `WorkStatus`, which has no timeout member, so both land as `FAILED`;
 * health keeps its own three-valued outcome because a timeout and a refusal
 * send an operator to different places. Mapping in one direction only is what
 * lets both be true, and doing it in one named function is what stops a
 * transport inventing a sixth `WorkStatus`.
 */
export function auditStatusFor(outcome: HealthOutcome): CallStatus {
  return outcome === "success" ? "SUCCEEDED" : "FAILED";
}

/**
 * Latency is clamped and rounded before it is stored.
 *
 * `Int`, non-negative, transcribed from `Math.max(0, Math.round(...))`. A
 * negative measurement is reachable across a clock adjustment, and a
 * non-integer one would be rejected by the column rather than by anything that
 * could explain itself.
 */
export function auditLatency(latencyMs: number): number {
  return Math.max(0, Math.round(latencyMs));
}

/** The two fields a caller must seal before writing, named once. */
export const SENSITIVE_AUDIT_FIELDS = ["arguments", "result"] as const;

export interface AuditQuery {
  /** Newest-first window. The source defaults to thirty days. */
  readonly sinceDays: number;
  readonly limit: number;
  readonly offset: number;
  readonly toolName?: ToolName | null;
  readonly agentId?: AgentId | null;
  readonly threadId?: ThreadId | null;
  readonly status?: CallStatus | null;
}

export const DEFAULT_AUDIT_WINDOW_DAYS = 30;
export const DEFAULT_AUDIT_PAGE = 50;
export const MAX_AUDIT_PAGE = 200;

/**
 * Admit a query's paging and window.
 *
 * Clamped rather than refused: an audit listing is a diagnostic surface, and an
 * operator who typed a limit of ten thousand wants the first two hundred rows
 * far more than they want an error.
 */
export function admitAuditQuery(query: Partial<AuditQuery>): AuditQuery {
  return {
    sinceDays: Math.max(1, Math.trunc(query.sinceDays ?? DEFAULT_AUDIT_WINDOW_DAYS)),
    limit: Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_AUDIT_PAGE), 1), MAX_AUDIT_PAGE),
    offset: Math.max(Math.trunc(query.offset ?? 0), 0),
    toolName: query.toolName ?? null,
    agentId: query.agentId ?? null,
    threadId: query.threadId ?? null,
    status: query.status ?? null,
  };
}

/** The oldest instant a query may see, from its window and the clock. */
export function auditWindowStart(query: AuditQuery, now: Date): Date {
  return new Date(now.getTime() - query.sinceDays * 86_400_000);
}

/**
 * Listing order: newest first, then by id.
 *
 * The id tie-break is what makes the order total. Audit rows are written in
 * bursts — `executeBatch` dispatches a step's calls in parallel — so several
 * sharing a millisecond is the common case, not the edge one, and a paged
 * listing whose order is not total drops and repeats rows across pages.
 */
export function byAuditOrder(left: AuditEntry, right: AuditEntry): number {
  const byTime = right.createdAt.getTime() - left.createdAt.getTime();
  if (byTime !== 0) return byTime;
  if (left.toolCallAuditId === right.toolCallAuditId) return 0;
  return left.toolCallAuditId < right.toolCallAuditId ? -1 : 1;
}
