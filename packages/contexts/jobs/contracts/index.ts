// The published surface of the `jobs` context.
//
// ADR M0.3 §2: another context may import THIS entrypoint and nothing else —
// never `domain/`, never `application/`, never an adapter. The one context
// permitted to reach it by the §1 DAG is `conversations`, and the composition
// root wires it.
//
// It is types only. Nothing here has a runtime representation, so importing this
// module costs a consumer no code and cannot drag an implementation across a
// context boundary. The implementation is `createJobsContract` in `application/`,
// and it is reached only through the composition root.
//
// The four driven ports are NOT re-exported here. They are adapter-facing, not
// context-facing, and they are published from `application/ports/index.js` where
// their adapters import them (ADR M0.3 §13).

import type { EnvironmentScope, ErasureTarget, JsonValue, JobId as RuntimeJobId, ResumeToken, Result } from "@platos/kernel";

// The identifier and status vocabulary a caller needs to build a command.
// Branded types, so a `jobId` cannot reach an `approvalId` parameter across the
// boundary any more than it can inside it.
export type {
  AgentId,
  ApprovalId,
  ApprovalRowId,
  ExecutionRequestId,
  JobId,
  JobKey,
  RequestDigest,
  ThreadId,
  TurnId,
} from "../domain/index.js";

export type {
  ApprovalDecision,
  ApprovalSource,
  ApprovalStatus,
  ClaimedInvoker,
  StoredInvocationType,
} from "../domain/index.js";

export type { JobSourceView, JobView, ApprovalView } from "../application/views.js";
export type { ApprovalPageView } from "../application/read-approvals.js";
export type { SweepReport, SweepScopeReport } from "../application/sweep-expired-approvals.js";

import type { ApprovalId, ApprovalDecision, ApprovalStatus, JobId, JobKey } from "../domain/index.js";
import type { ApprovalView, JobSourceView, JobView } from "../application/views.js";
import type { ApprovalPageView } from "../application/read-approvals.js";
import type { SweepReport, SweepScopeReport } from "../application/sweep-expired-approvals.js";

/** A job definition, as a caller submits it. Every bound is checked. */
export interface RegisterJob {
  readonly scope: EnvironmentScope;
  readonly jobKey: string;
  readonly displayName: string;
  readonly handler: string;
  readonly createdBy: string;
  readonly description?: string | null;
  readonly invocationType?: string | null;
  readonly scheduleCron?: string | null;
  readonly scheduleTimezone?: string | null;
  readonly allowedAgentIds?: readonly string[] | null;
  readonly payloadSchema?: JsonValue | null;
  readonly timeoutSeconds?: number | null;
  readonly maxRetries?: number | null;
}

export interface RegisteredJobView {
  readonly job: JobView;
  /**
   * Non-null when the handler did not parse. The row EXISTS and is inactive —
   * callers must not treat a non-null value here as "nothing was created".
   */
  readonly syntaxError: string | null;
}

/**
 * One execution request, still untrusted.
 *
 * `body` is deliberately `unknown`: admission is this context's job and a caller
 * that had already parsed it would have had to duplicate the closed-key rule.
 */
export interface RequestJobExecution {
  readonly scope: EnvironmentScope;
  readonly body: unknown;
}

export interface JobExecutionView {
  readonly value: JsonValue | null;
  /** True when this outcome was replayed from a reservation, not re-run. */
  readonly replayed: boolean;
}

export interface RequestJobRead {
  readonly scope: EnvironmentScope;
  readonly jobId: JobId;
}

export interface RequestJobReadByKey {
  readonly scope: EnvironmentScope;
  readonly jobKey: JobKey;
}

/** Opening an approval, and optionally parking a run on it. */
export interface RequestApprovalCommandView {
  readonly scope: EnvironmentScope;
  readonly approvalId: ApprovalId;
  readonly source: string;
  /**
   * What a human is being asked to approve.
   *
   * OPTIONAL ONLY FOR THE MCP TOOL-CALL PATH, which does not compose the string
   * itself: omitting it means "use the canonical MCP label", which is
   * `domain/approval-request.ts`'s `mcpActionLabel` and requires a tool name.
   * Omitting both is refused rather than defaulted — an approval whose action
   * nobody can read is a question no human can answer.
   */
  readonly action?: string | null;
  readonly details?: string | null;
  readonly agentId?: string | null;
  readonly threadId?: string | null;
  readonly turnId?: string | null;
  readonly toolName?: string | null;
  readonly arguments?: JsonValue | null;
  readonly requestedBy?: string | null;
  readonly requestedByTokenId?: string | null;
  readonly timeoutSeconds?: number | null;
  /**
   * Set for the MCP tool-call path. Two concurrent requests sharing a digest
   * collapse onto ONE approval, so a human is asked once.
   */
  readonly deduplicateOn?: { readonly toolName: string; readonly arguments: JsonValue } | null;
  /** The durable run to suspend until the decision lands. */
  readonly parkRunId?: RuntimeJobId | null;
}

export interface ApprovalRequestedView {
  readonly approval: ApprovalView;
  /** Null when nothing was parked. */
  readonly resumeToken: ResumeToken | null;
  readonly deduplicated: boolean;
}

export interface ResolveApproval {
  readonly scope: EnvironmentScope;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
  readonly respondedBy?: string | null;
  readonly comment?: string | null;
  readonly editedArguments?: JsonValue | null;
  readonly editedBy?: string | null;
  readonly resumeToken?: ResumeToken | null;
}

export interface ApprovalResolvedView {
  readonly approval: ApprovalView;
  /** Edits when a human made them, otherwise the originals. Null on rejection. */
  readonly effectiveArguments: JsonValue | null;
  readonly resume: "resumed" | "already-resolved" | "expired" | null;
}

export interface ListApprovals {
  readonly scope: EnvironmentScope;
  readonly threadId?: string | null;
  readonly agentId?: string | null;
  readonly status?: ApprovalStatus | null;
  readonly source?: string | null;
  readonly sinceDays?: number | null;
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly search?: string | null;
}

export interface MarkApprovalConsumed {
  readonly scope: EnvironmentScope;
  readonly approvalId: ApprovalId;
  readonly outcome?: JsonValue | null;
}

/**
 * The `jobs` capability, as every other context sees it.
 *
 * Every method returns the kernel's `Result`: a failure a caller must handle is
 * visible in the type, and no vendor exception crosses this boundary.
 */
export interface JobsContract {
  readonly name: "jobs";

  // --- Job: the definition of durable work ----------------------------------

  /** Admit a definition and store it. A handler that does not parse still lands. */
  registerJob(request: RegisterJob): Promise<Result<RegisteredJobView>>;

  /** Resolve, authorize, reserve, then run. Idempotent on the request id. */
  execute(request: RequestJobExecution): Promise<Result<JobExecutionView>>;

  /** The safe projection: never carries the handler source. */
  describeJob(request: RequestJobRead): Promise<Result<JobView>>;

  describeJobByKey(request: RequestJobReadByKey): Promise<Result<JobView>>;

  /** The projection WITH the handler source. A deliberate, separate call. */
  readJobSource(request: RequestJobRead): Promise<Result<JobSourceView>>;

  listJobs(scope: EnvironmentScope): Promise<Result<readonly JobView[]>>;

  // --- AgentApproval: a human decision a turn waits on ----------------------

  /** Create the approval and, when asked, suspend a run until it is decided. */
  requestApproval(request: RequestApprovalCommandView): Promise<Result<ApprovalRequestedView>>;

  /** Record a decision and resume whatever was parked on it. */
  resolveApproval(request: ResolveApproval): Promise<Result<ApprovalResolvedView>>;

  describeApproval(scope: EnvironmentScope, approvalId: ApprovalId): Promise<Result<ApprovalView>>;

  listApprovals(request: ListApprovals): Promise<Result<ApprovalPageView>>;

  /** Record that an approved call was actually carried out. */
  markApprovalConsumed(request: MarkApprovalConsumed): Promise<Result<boolean>>;

  /** Flip elapsed pending approvals in one environment. */
  sweepApprovals(scope: EnvironmentScope): Promise<Result<SweepScopeReport>>;

  /** Flip elapsed pending approvals everywhere. The scheduled sweep. */
  sweepAllApprovals(): Promise<Result<SweepReport>>;

  /**
   * This context's `ErasureTarget` for the rows it is sole writer of. The
   * composition root collects one of these per context and injects the array
   * into `privacy` (ADR M0.3 §3).
   */
  erasureTarget(): ErasureTarget;
}
