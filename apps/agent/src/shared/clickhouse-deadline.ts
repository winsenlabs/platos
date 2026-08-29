// WIN-290 (M1.6) — central deadline policy for every ClickHouse HTTP call.
//
// Before this module each ClickHouse `fetch` was unbounded: a hung or
// pathologically slow ClickHouse held the calling request open indefinitely,
// consuming a Node socket and (for read paths) a user-visible request slot with
// no upper bound. Every shipping call site now derives its deadline from here so
// the budget is configured in ONE place, validated, and impossible to set to an
// unsafe value by typo.
//
// Design notes:
//   * Pure and env-injectable so it is trivially testable and usable before the
//     Nest config graph is constructed.
//   * The override is CLAMPED, not trusted: a nonsense value (0, negative, NaN,
//     "abc", 10 hours) falls back to the safe default rather than disabling the
//     bound. Failing safe here matters more than honouring a bad config.
//   * `max_execution_time` is sent to ClickHouse as well, so the SERVER also
//     stops working when we stop waiting. Aborting the client alone leaves the
//     query running and burns ClickHouse CPU for a result nobody will read.

/** Default wall-clock budget for a single ClickHouse HTTP call. */
export const DEFAULT_CLICKHOUSE_DEADLINE_MS = 10_000;
/** Hard bounds for any operator override. */
export const MIN_CLICKHOUSE_DEADLINE_MS = 1_000;
export const MAX_CLICKHOUSE_DEADLINE_MS = 120_000;

/**
 * Resolve the ClickHouse deadline in milliseconds.
 *
 * Reads PLATOS_CLICKHOUSE_TIMEOUT_MS. Anything unparseable or outside
 * [MIN, MAX] yields the safe default — an override can tune the budget but can
 * never remove it.
 */
export function resolveClickhouseDeadlineMs(
  environment: Record<string, string | undefined> = process.env
): number {
  const raw = environment.PLATOS_CLICKHOUSE_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === "")
    return DEFAULT_CLICKHOUSE_DEADLINE_MS;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed)) return DEFAULT_CLICKHOUSE_DEADLINE_MS;
  const rounded = Math.floor(parsed);
  if (rounded < MIN_CLICKHOUSE_DEADLINE_MS || rounded > MAX_CLICKHOUSE_DEADLINE_MS)
    return DEFAULT_CLICKHOUSE_DEADLINE_MS;
  return rounded;
}

/** ClickHouse's own server-side budget, in whole seconds (never below 1). */
export function clickhouseMaxExecutionTimeSeconds(deadlineMs: number): number {
  return Math.max(1, Math.floor(deadlineMs / 1000));
}

/**
 * Build the AbortSignal for one ClickHouse call, propagating a caller's
 * cancellation when one exists so an abandoned HTTP request tears its ClickHouse
 * work down with it instead of orphaning it.
 */
export function clickhouseAbortSignal(deadlineMs: number, callerSignal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(deadlineMs);
  if (!callerSignal) return deadline;
  // `AbortSignal.any` is available on Node 20+; fall back to the deadline alone
  // rather than throwing on an older runtime.
  const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return typeof anyOf === "function" ? anyOf([deadline, callerSignal]) : deadline;
}

/**
 * Raised when a ClickHouse call exceeds its deadline or is cancelled. Distinct
 * from auth/schema/unavailable failures so callers, health checks and dashboards
 * can tell "we gave up waiting" apart from "ClickHouse rejected us" — the two
 * demand different operator responses.
 */
export class ClickhouseTimeoutError extends Error {
  readonly code = "CLICKHOUSE_TIMEOUT";
  readonly operation: string;
  readonly deadlineMs: number;

  constructor(operation: string, deadlineMs: number, cause?: unknown) {
    super(`ClickHouse ${operation} exceeded its ${deadlineMs}ms deadline`);
    this.name = "ClickhouseTimeoutError";
    this.operation = operation;
    this.deadlineMs = deadlineMs;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Classify a thrown value as a deadline/abort failure. `fetch` surfaces these as
 * a TimeoutError or AbortError DOMException depending on runtime and cause, so
 * match on both name and message rather than on identity.
 */
export function isAbortLikeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /aborted|timed?\s?out/i.test(message);
}

// ─── Observability (WIN-290 cross-cutting gate) ─────────────────────────────
//
// Every ClickHouse call emits ONE versioned, redacted event. The version is part
// of the contract: dashboards and alerts match on `event` + `v`, so adding a
// field is safe but changing a meaning requires bumping `v`.
//
// REDACTION IS STRUCTURAL, not best-effort: the emitted object is built from a
// fixed field list that has no place to put SQL, a URL, credentials or row data.
// A caller cannot accidentally widen it.

/** Contract version for `clickhouse.operation` events. Bump on a breaking change. */
export const CLICKHOUSE_OPERATION_EVENT_VERSION = 1;

export type ClickhouseOutcome = "ok" | "timeout" | "error";

export interface ClickhouseOperationEvent {
  event: "clickhouse.operation";
  v: number;
  /** A CONSTANT operation name (e.g. "span-read") — never a query or a URL. */
  operation: string;
  outcome: ClickhouseOutcome;
  elapsedMs: number;
  deadlineMs: number;
  /** Present only for outcome !== "ok"; a short class name, never a message body. */
  errorKind?: string;
  traceId?: string;
}

/**
 * Build the event. Pure, so it is directly assertable in tests — the redaction
 * guarantee is verified rather than trusted.
 */
export function buildClickhouseOperationEvent(input: {
  operation: string;
  outcome: ClickhouseOutcome;
  elapsedMs: number;
  deadlineMs: number;
  error?: unknown;
  traceId?: string;
}): ClickhouseOperationEvent {
  const event: ClickhouseOperationEvent = {
    event: "clickhouse.operation",
    v: CLICKHOUSE_OPERATION_EVENT_VERSION,
    operation: input.operation,
    outcome: input.outcome,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    deadlineMs: input.deadlineMs,
  };
  if (input.outcome !== "ok" && input.error !== undefined) {
    // Only the error CLASS, never its message — messages can carry SQL fragments,
    // hostnames or credentials from the driver.
    const name =
      (input.error as { name?: unknown } | undefined)?.name ??
      (input.error as { constructor?: { name?: string } } | undefined)?.constructor?.name;
    event.errorKind = typeof name === "string" && name.length > 0 ? name : "UnknownError";
  }
  if (input.traceId) event.traceId = input.traceId;
  return event;
}

