// The `SafetyLedger` port — the SafetyEvent table, seen only as an interface.
//
// ADR M0.3 §1 row 14 makes this context the SOLE WRITER of `SafetyEvent`. This
// port is where that ownership is expressed: every mutation of that table in the
// V1 system passes through `append`, and there is deliberately no generic
// `save(row)` or `query(where)` escape hatch another context could reach
// sideways.
//
// APPEND-ONLY, AND THAT IS A PROPERTY OF THE PORT RATHER THAN A CONVENTION.
// There is no `update` and no `delete`. The only destructive method is
// `anonymizeSubject`, which the erasure target calls and which overwrites
// identifying columns while leaving the row's detector, action, severity and
// timestamp intact — because a compliance ledger that can be emptied is not a
// compliance ledger, and a right-to-erasure that leaves a subject's identifiers
// in one is not an erasure. See `governance-erasure-target.ts`.
//
// THE AUTHORIZATION IS NOT A PARAMETER HERE. A use case verifies the grant it
// was handed and derives the scope from it (never from an id the caller also
// supplied), then passes the derived scope down. That keeps this port free of a
// peer context's types, which matters because its adapter is shared.
//
// EVERY METHOD RETURNS `Result`. A rejected promise is a defect, not an outcome.

import type { EnvironmentScope, Result, TenantScope, TransactionScope } from "@platos/kernel";

import type {
  AdmittedSafetyEvent,
  AgentId,
  SafetyDetector,
  SafetyEvent,
  SafetyEventId,
  SafetySeverity,
  SafetyTally,
  ThreadId,
} from "../../domain/index.js";

/** The filters the ledger listing supports. Null means "no filter". */
export interface SafetyEventQuery {
  readonly since: Date;
  readonly limit: number;
  readonly offset: number;
  readonly detector: SafetyDetector | null;
  readonly severity: SafetySeverity | null;
  readonly agentId: AgentId | null;
  readonly threadId: ThreadId | null;
  /** Case-insensitive substring over the tool name. Never over `detail`. */
  readonly search: string | null;
}

export interface SafetyEventPage {
  readonly items: readonly SafetyEvent[];
  readonly total: number;
}

/** Per-agent detector counts, for the risk score. Only the two rates it uses. */
export interface AgentDetectorCounts {
  readonly agentId: AgentId;
  readonly piiEvents: number;
  readonly injectionEvents: number;
}

/**
 * Which rows an erasure touches.
 *
 * `principalId` is the subject the ledger recorded on the event's metadata —
 * NOT `SafetyEvent.endUserId`, which the write path never populates and which
 * `domain/safety-event.ts` explains. A null selector matches nothing, and an
 * implementation MUST treat it that way rather than as "match everything".
 */
export interface SafetySubjectSelector {
  readonly scope: TenantScope;
  readonly principalId: string | null;
}

export interface SafetyLedger {
  /** Append one admitted event. The only write. */
  append(
    scope: EnvironmentScope,
    event: AdmittedSafetyEvent,
    transaction: TransactionScope | null,
  ): Promise<Result<SafetyEvent>>;

  page(scope: EnvironmentScope, query: SafetyEventQuery): Promise<Result<SafetyEventPage>>;

  findById(scope: EnvironmentScope, safetyEventId: SafetyEventId): Promise<Result<SafetyEvent | null>>;

  /** The rows a rollup counts, already scoped and windowed. */
  tally(scope: EnvironmentScope, since: Date): Promise<Result<readonly SafetyTally[]>>;

  /** Per-agent PII and injection counts inside the window, for the risk score. */
  countByAgent(scope: EnvironmentScope, since: Date): Promise<Result<readonly AgentDetectorCounts[]>>;

  /** How many rows an anonymisation would touch. MUST NOT mutate. */
  countSubject(selector: SafetySubjectSelector): Promise<Result<number>>;

  /**
   * Overwrite the identifying columns of every matching row, in the caller's
   * transaction. Returns how many rows were rewritten.
   */
  anonymizeSubject(selector: SafetySubjectSelector, transaction: TransactionScope): Promise<Result<number>>;
}
