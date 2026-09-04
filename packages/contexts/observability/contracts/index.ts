// The published surface of the `observability` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. No context depends on
// `observability` in the §1 DAG, which is the point: it is a drain and an audit
// sink, and everything reaches it through the outbox or through the composition
// root. That leaves `apps/core-api` as this surface's only consumer, and it is
// the operator surface — the scheduled drain, the status report, the audit
// trail — plus the `ErasureTarget` the composition root collects for `privacy`.
//
// It is types only. Nothing here has a runtime representation, so importing this
// module costs a consumer no code and cannot drag an implementation across a
// context boundary. The implementation is `createObservabilityContract` in
// `application/`.
//
// The driven ports are NOT re-exported here. `ObservabilitySink` is
// adapter-facing and is published from `application/ports/index.js` where its
// one adapter imports it (ADR M0.3 §13), and the other three are wiring.

import type { ErasureTarget, EnvironmentScope, PrincipalId, Result } from "@platos/kernel";

import type {
  AdminAuditId,
  DrainBudget,
  ProjectionRows,
  QueueDepth,
  SinkHealth,
  SinkStatus,
  TurnWork,
} from "../domain/index.js";

// The identifier and vocabulary a caller needs to build a command. Branded
// types, so a `stepId` cannot reach a `turnId` parameter across the boundary any
// more than it can inside it.
export type {
  AdminAuditId,
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvelopeId,
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
} from "../domain/index.js";

export type {
  DrainBudget,
  ObservedAttributes,
  ObservedRates,
  ObservedRuntime,
  ObservedStatus,
  ObservedSubject,
  ObservedTokens,
  ObservedTrace,
  ProjectionRow,
  ProjectionRows,
  ProjectionTable,
  QueueDepth,
  SinkHealth,
  SinkStatus,
  StepObserved,
  ToolCallObserved,
  ToolCallStatus,
  TurnObserved,
  TurnWork,
  UsageKind,
  UsageObserved,
} from "../domain/index.js";

/** One admin action, as every other surface sees it. */
export interface AdminAuditView {
  readonly adminAuditId: AdminAuditId;
  readonly scope: EnvironmentScope;
  /** Null for an action no operator performed — a scheduled sweep. */
  readonly actorUserId: PrincipalId | null;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  /** Redacted object roots, or null when no snapshot was taken. */
  readonly before: { readonly [key: string]: unknown } | null;
  readonly after: { readonly [key: string]: unknown } | null;
  readonly reason: string | null;
  readonly source: string;
  readonly recordedAt: Date;
}

export interface RecordAdminActionRequest {
  readonly scope: EnvironmentScope;
  readonly actorUserId: PrincipalId | null;
  /** A dotted lower-case name — `agent.delete`, `entity.secret.rotate`. */
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId?: string | null;
  /** Redacted object roots. A scalar or an array is refused, never wrapped. */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  /** `ui`, `api`, `scheduled`, or an installation's own word. */
  readonly source?: string | null;
}

export interface ReadAdminTrailRequest {
  readonly scope: EnvironmentScope;
  readonly action?: string | null;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  /** Absent takes the default page; anything larger than the cap is capped. */
  readonly limit?: number | null;
}

/** What one drain pass did. Every claimed envelope has exactly one outcome. */
export interface DrainReportView {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly parked: number;
  /** Acknowledged unwritten: the envelope belongs to another drain. */
  readonly ignored: number;
  readonly discarded: number;
  readonly pruned: number;
  readonly passes: number;
  /** Null when the depth could not be read. NEVER zero in that case. */
  readonly depth: QueueDepth | null;
  readonly stoppedBecause: string | null;
}

export interface DrainProjectionsRequest {
  /** Narrows this call's ceilings. It can never widen the configured budget. */
  readonly budget?: Partial<DrainBudget>;
}

export interface ObservabilityStatusView {
  readonly sink: SinkHealth;
  /** Null when the queue could not be read. NEVER zero in that case. */
  readonly depth: QueueDepth | null;
  readonly depthErrorCode: string | null;
}

export interface TurnProjectionView {
  readonly rows: ProjectionRows;
  readonly rowCount: number;
  /** Tables this Turn actually populated, in canonical order. */
  readonly tables: readonly string[];
}

/**
 * The `observability` capability, as the composition root sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface ObservabilityContract {
  readonly name: "observability";

  /**
   * Project one committed Turn without queueing or delivering it.
   *
   * The direct path, for a diagnostic surface and for a caller that already
   * holds the work. It applies the same rules the drain does, including the
   * refusal of a Turn whose parts name more than one environment.
   */
  projectTurn(work: TurnWork): Promise<Result<TurnProjectionView>>;

  /** Deliver queued projections. Returns a report, never a bare count. */
  drainProjections(request?: DrainProjectionsRequest): Promise<Result<DrainReportView>>;

  /** Sink health plus queue depth. The two halves fail independently. */
  describeStatus(): Promise<Result<ObservabilityStatusView>>;

  /** Record an admin action in a transaction of its own. */
  recordAdminAction(request: RecordAdminActionRequest): Promise<Result<AdminAuditView>>;

  /** One page of the audit trail, newest first, never crossing its scope. */
  readAdminTrail(request: ReadAdminTrailRequest): Promise<Result<readonly AdminAuditView[]>>;

  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one of these per context and injects the array
   * into `privacy` (ADR M0.3 §3).
   */
  erasureTarget(): ErasureTarget;
}
