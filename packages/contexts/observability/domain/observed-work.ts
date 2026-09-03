// What one committed Turn looks like on the way in.
//
// These are the shapes a producer describes its finished work with. They are
// deliberately NOT the row shapes: a producer names a Turn, a Step, a Tool Call
// and a usage fact, and this context alone decides which columns those become.
// Keeping the two apart is what lets a column be added, renamed or split without
// every producer in the DAG learning about it.
//
// SUBJECT IS SPLIT THREE WAYS, AND THE SPLIT IS THE PRIVACY DESIGN.
//
//   subjectKeyHash   the keyed pseudonymous join key. SURVIVES erasure, so
//                    aggregates stay continuous after a person is unlinked.
//   endUserId        the canonical id. CLEARED by erasure.
//   display name /   present ONLY when an entity signed them onto the work.
//   email address    Absent is the default and the common case; they carry
//                    their own short expiry and are cleared independently.
//
// Every field a producer may omit is optional here rather than nullable-required,
// because the projection's job is to turn "not reported" into the column's own
// default — and a required `null` makes every producer restate that default.

import type { EnvironmentScope } from "@platos/kernel";

import type {
  AgentId,
  AgentVersionId,
  EndUserId,
  SkillId,
  SpanId,
  StepId,
  SubjectKeyHash,
  ThreadId,
  ToolCallId,
  ToolId,
  TraceId,
  TurnId,
  UsageEventId,
} from "./identifiers.js";
import type { ObservedAttributes } from "./attributes.js";
import type { ObservedRates, ObservedTokens } from "./token-lanes.js";

/**
 * How a Turn or a Step ended.
 *
 * Closed at three. A Turn that is still running is not observed at all: the
 * projection is fed on commit, so "in progress" is a state this context can
 * never legitimately be handed.
 */
export const OBSERVED_STATUSES = ["completed", "failed", "cancelled"] as const;
export type ObservedStatus = (typeof OBSERVED_STATUSES)[number];

/**
 * How a Tool Call ended.
 *
 * `denied` is a first-class outcome, not a kind of failure. A policy refusal and
 * a tool that broke are different events with different owners, and collapsing
 * them would hide the approval surface's behaviour entirely.
 */
export const TOOL_CALL_STATUSES = [...OBSERVED_STATUSES, "denied"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/** What kind of work a usage fact charges for. */
export const USAGE_KINDS = ["inference", "embedding", "extraction", "judge", "skill"] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export function isObservedStatus(value: string): value is ObservedStatus {
  return (OBSERVED_STATUSES as readonly string[]).includes(value);
}

export function isToolCallStatus(value: string): value is ToolCallStatus {
  return (TOOL_CALL_STATUSES as readonly string[]).includes(value);
}

export function isUsageKind(value: string): value is UsageKind {
  return (USAGE_KINDS as readonly string[]).includes(value);
}

/** Who the work was for. See this file's header for why it is three fields. */
export interface ObservedSubject {
  readonly endUserId?: EndUserId | null;
  readonly subjectKeyHash?: SubjectKeyHash | null;
  readonly userDisplayName?: string | null;
  readonly userEmail?: string | null;
}

/** Correlation handles, carried through unchanged so a Turn can be traced. */
export interface ObservedTrace {
  readonly traceId?: TraceId | null;
  readonly spanId?: SpanId | null;
  readonly parentSpanId?: SpanId | null;
}

/**
 * Where the work actually ran, when a durable runtime ran it.
 *
 * Both nullable and both opaque: this is a cross-reference for an operator, not
 * a relationship, and vendor vocabulary is not allowed to define a Platos one.
 */
export interface ObservedRuntime {
  readonly runtimeProvider?: string | null;
  readonly runtimeRunId?: string | null;
}

/** One accepted user-to-agent unit of work, as its producer describes it. */
export interface TurnObserved {
  readonly scope: EnvironmentScope;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly agentVersionId?: AgentVersionId | null;
  readonly subject?: ObservedSubject;
  readonly trace?: ObservedTrace;
  readonly status: ObservedStatus;
  readonly acceptedAt: Date;
  readonly completedAt: Date;
  readonly stepCount?: number;
  readonly toolCallCount?: number;
  readonly tokens?: ObservedTokens;
  /** The figure the canonical store billed, in integer cents. */
  readonly costCents?: number | null;
  readonly providerReportedCostUsd?: number | null;
  readonly errorCode?: string | null;
  readonly errorClass?: string | null;
  readonly runtime?: ObservedRuntime;
}

/** One model invocation inside a Turn. */
export interface StepObserved {
  readonly scope: EnvironmentScope;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly subject?: ObservedSubject;
  readonly sequence: number;
  readonly provider: string;
  readonly model: string;
  readonly status: ObservedStatus;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly trace?: ObservedTrace;
  readonly tokens?: ObservedTokens;
  readonly rates?: ObservedRates;
  readonly costCents?: number | null;
  readonly providerReportedCostUsd?: number | null;
  readonly errorCode?: string | null;
  readonly errorClass?: string | null;
  readonly errorMessageRedacted?: string | null;
  readonly attributes?: ObservedAttributes;
}

/** One tool invocation inside a Step. Lifecycle and redacted diagnostics only. */
export interface ToolCallObserved {
  readonly scope: EnvironmentScope;
  readonly toolCallId: ToolCallId;
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly threadId: ThreadId;
  readonly agentId: AgentId;
  readonly subject?: ObservedSubject;
  readonly sequence: number;
  readonly entityId?: string | null;
  readonly toolId?: ToolId | null;
  readonly toolName: string;
  readonly status: ToolCallStatus;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly trace?: ObservedTrace;
  readonly retryCount?: number;
  /** Sizes, never payloads. Enough to find the tool that returns a megabyte. */
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly errorCode?: string | null;
  readonly errorClass?: string | null;
  readonly errorMessageRedacted?: string | null;
  readonly attributes?: ObservedAttributes;
}

/**
 * One immutable charge fact.
 *
 * `turnId`, `stepId` and `toolCallId` are all optional because auxiliary work —
 * an extraction, a judge, an embedding — belongs to an Agent and an Environment
 * and to NO Turn at all. Inventing a parent for it would be a fabricated
 * relationship in a table retained as financial evidence.
 */
export interface UsageObserved {
  readonly scope: EnvironmentScope;
  readonly usageEventId: UsageEventId;
  readonly turnId?: TurnId | null;
  readonly stepId?: StepId | null;
  readonly toolCallId?: ToolCallId | null;
  readonly threadId?: ThreadId | null;
  readonly agentId: AgentId;
  readonly subject?: ObservedSubject;
  readonly usageKind: UsageKind;
  readonly provider: string;
  readonly model?: string | null;
  readonly skillId?: SkillId | null;
  readonly toolName?: string | null;
  readonly occurredAt: Date;
  readonly tokens?: ObservedTokens;
  readonly rates?: ObservedRates;
  /** Non-token lanes: embeddings priced per request, skills priced per run. */
  readonly inputUnits?: number | null;
  readonly outputUnits?: number | null;
  readonly unitType?: string | null;
  readonly inputUnitPriceUsd?: number | null;
  readonly outputUnitPriceUsd?: number | null;
  readonly costCents?: number | null;
  readonly providerReportedCostUsd?: number | null;
  readonly trace?: ObservedTrace;
  readonly runtime?: ObservedRuntime;
}

/** Everything one committed Turn projects into, as one deliverable unit. */
export interface TurnWork {
  readonly turn: TurnObserved;
  readonly steps?: readonly StepObserved[];
  readonly toolCalls?: readonly ToolCallObserved[];
  readonly usage?: readonly UsageObserved[];
}

/** Where one part of a Turn's work claims to live, with the part named. */
export interface ScopedPart {
  readonly part: string;
  readonly scope: EnvironmentScope;
}

/** Every part of a Turn's work, in the canonical table order, with its label. */
export function scopedParts(work: TurnWork): readonly ScopedPart[] {
  return [
    { part: "turn", scope: work.turn.scope },
    ...(work.steps ?? []).map((step, index) => ({ part: `steps[${index}]`, scope: step.scope })),
    ...(work.toolCalls ?? []).map((call, index) => ({ part: `toolCalls[${index}]`, scope: call.scope })),
    ...(work.usage ?? []).map((usage, index) => ({ part: `usage[${index}]`, scope: usage.scope })),
  ];
}

/**
 * The first part of a Turn's work that names a different environment from the
 * Turn itself, or null when every part agrees.
 *
 * Comparison is on the whole triple, not on `environmentId` alone: two
 * organizations can be told apart only by the columns the aggregate groups by,
 * and `environment_id` is the last of the three.
 */
export function firstScopeDisagreement(work: TurnWork): ScopedPart | null {
  const expected = work.turn.scope;
  for (const candidate of scopedParts(work)) {
    if (
      candidate.scope.organizationId !== expected.organizationId ||
      candidate.scope.projectId !== expected.projectId ||
      candidate.scope.environmentId !== expected.environmentId
    ) {
      return candidate;
    }
  }
  return null;
}
