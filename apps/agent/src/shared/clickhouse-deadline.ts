// WIN-290 — bounded, observable ClickHouse HTTP operations.
//
// The client deadline covers fetch, response status and complete body
// consumption. ClickHouse also receives max_execution_time, rounded UP so a
// fractional client budget (for example 1500ms) remains authoritative.

export const CLICKHOUSE_OPERATIONS = ["span-read", "span-write"] as const;
export type ClickhouseOperation = (typeof CLICKHOUSE_OPERATIONS)[number];

/** Writes are detached from requests and survive caller disconnects. */
export const CLICKHOUSE_WRITE_DISCONNECT_POLICY = "survive" as const;

/** The server budget must never expire before a non-whole-second client budget. */
export function clickhouseMaxExecutionTimeSeconds(deadlineMs: number): number {
  return Math.max(1, Math.ceil(deadlineMs / 1000));
}

export type ClickhouseAbortSource = "deadline" | "caller";

export interface ClickhouseAbortContext {
  signal: AbortSignal;
  source(): ClickhouseAbortSource | undefined;
  cleanup(): void;
}

/**
 * Create one abort lifecycle without leaving a caller listener or timer behind.
 * Tracking the first source explicitly avoids treating caller cancellation as a
 * deadline merely because both surface as AbortError from fetch/body reads.
 */
export function createClickhouseAbortContext(
  deadlineMs: number,
  callerSignal?: AbortSignal
): ClickhouseAbortContext {
  const controller = new AbortController();
  let abortSource: ClickhouseAbortSource | undefined;
  let cleaned = false;

  const abort = (source: ClickhouseAbortSource, reason?: unknown) => {
    if (abortSource !== undefined) return;
    abortSource = source;
    controller.abort(reason);
  };
  const onCallerAbort = () => abort("caller", callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  const timer = setTimeout(() => {
    const error = Object.assign(new Error("ClickHouse operation deadline elapsed"), {
      name: "TimeoutError",
    });
    abort("deadline", error);
  }, deadlineMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    source: () => abortSource,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

export class ClickhouseTimeoutError extends Error {
  readonly code = "CLICKHOUSE_TIMEOUT";

  constructor(
    readonly operation: ClickhouseOperation,
    readonly deadlineMs: number,
    cause?: unknown
  ) {
    super(`ClickHouse ${operation} exceeded its ${deadlineMs}ms deadline`);
    this.name = "ClickhouseTimeoutError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export class ClickhouseCallerAbortError extends Error {
  readonly code = "CLICKHOUSE_CALLER_ABORT";

  constructor(readonly operation: ClickhouseOperation, cause?: unknown) {
    super(`ClickHouse ${operation} was cancelled by its caller`);
    this.name = "ClickhouseCallerAbortError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function sanitizeClickhouseHttpStatus(status: unknown): number {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 0;
}

export function sanitizeClickhouseNumericCode(code: unknown): number | undefined {
  return typeof code === "number" && Number.isSafeInteger(code) && code >= 0 && code <= 999_999
    ? code
    : undefined;
}

/** Extract only ClickHouse's bounded numeric `Code: N`; discard all body text. */
export function extractClickhouseNumericCode(body: string): number | undefined {
  const match = /(?:^|\s)Code:\s*(\d{1,9})(?:\D|$)/u.exec(body);
  return match ? sanitizeClickhouseNumericCode(Number(match[1])) : undefined;
}

export class ClickhouseStatusError extends Error {
  readonly code = "CLICKHOUSE_HTTP_STATUS";
  readonly statusCode: number;
  readonly clickhouseCode?: number;

  constructor(readonly operation: ClickhouseOperation, status: unknown, clickhouseCode?: unknown) {
    const statusCode = sanitizeClickhouseHttpStatus(status);
    const safeCode = sanitizeClickhouseNumericCode(clickhouseCode);
    super(
      `ClickHouse ${operation} returned HTTP ${statusCode}${
        safeCode === undefined ? "" : ` (code ${safeCode})`
      }`
    );
    this.name = "ClickhouseStatusError";
    this.statusCode = statusCode;
    this.clickhouseCode = safeCode;
  }
}

export class ClickhouseNetworkError extends Error {
  readonly code = "CLICKHOUSE_NETWORK";

  constructor(readonly operation: ClickhouseOperation, cause?: unknown) {
    super(`ClickHouse ${operation} network operation failed`);
    this.name = "ClickhouseNetworkError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export type ClickhouseFailureKind =
  | "auth"
  | "schema"
  | "unavailable"
  | "network"
  | "deadline"
  | "caller-abort";

export function classifyClickhouseFailure(error: unknown): ClickhouseFailureKind {
  if (error instanceof ClickhouseTimeoutError) return "deadline";
  if (error instanceof ClickhouseCallerAbortError) return "caller-abort";
  if (error instanceof ClickhouseNetworkError) return "network";
  if (error instanceof ClickhouseStatusError) {
    if (error.statusCode === 401 || error.statusCode === 403) return "auth";
    if ([400, 404, 409, 422].includes(error.statusCode)) return "schema";
    return "unavailable";
  }
  return "network";
}

/** Numeric-only code safe to persist in DLQ metadata. */
export function clickhouseFailureCode(error: unknown): number {
  if (error instanceof ClickhouseStatusError) return error.clickhouseCode ?? error.statusCode;
  if (error instanceof ClickhouseTimeoutError) return -1;
  if (error instanceof ClickhouseCallerAbortError) return -2;
  return -3;
}

const CLICKHOUSE_CORRELATION = Symbol("clickhouse-correlation");

export function attachClickhouseCorrelation<T extends Error>(error: T, correlationId: string): T {
  Object.defineProperty(error, CLICKHOUSE_CORRELATION, {
    value: correlationId,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return error;
}

export function clickhouseErrorCorrelation(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  return safeIdentifier((error as { [CLICKHOUSE_CORRELATION]?: unknown })[CLICKHOUSE_CORRELATION]);
}

// ─── Correlated, structurally-redacted operation telemetry ──────────────────

export const CLICKHOUSE_OPERATION_EVENT_VERSION = 3;
export type ClickhouseOperationPhase = "start" | "end" | "handled";
export type ClickhouseOutcome = "ok" | "error";
export type ClickhouseDecision =
  | "none"
  | "enqueue-dlq"
  | "retry-dlq"
  | "dead-letter"
  | "fallback-redis";
export type ClickhouseDecisionState = "applied" | "failed";
export type ClickhouseRetrySource = "span-dlq";
export type ClickhouseCallerMapping =
  | "spans"
  | "redis-fallback"
  | "detached-write"
  | "clickhouse-timeout"
  | "clickhouse-caller-abort"
  | "clickhouse-status"
  | "clickhouse-network";

export interface ClickhouseOperationEvent {
  event: "clickhouse.operation";
  v: number;
  phase: ClickhouseOperationPhase;
  operation: ClickhouseOperation | "unknown";
  correlationId: string;
  deadlineMs: number;
  traceId?: string;
  disconnectPolicy?: typeof CLICKHOUSE_WRITE_DISCONNECT_POLICY;
  outcome?: ClickhouseOutcome;
  elapsedMs?: number;
  failureKind?: ClickhouseFailureKind;
  statusCode?: number;
  clickhouseCode?: number;
  plannedDecision?: ClickhouseDecision;
  decision?: ClickhouseDecision;
  decisionState?: ClickhouseDecisionState;
  retrySource?: ClickhouseRetrySource;
  retryCount?: number;
  callerMapping?: ClickhouseCallerMapping;
}

function safeOperation(operation: unknown): ClickhouseOperation | "unknown" {
  return operation === "span-read" || operation === "span-write" ? operation : "unknown";
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

/** Build only fixed-vocabulary fields; messages, bodies, SQL, URLs and rows have no slot. */
export function buildClickhouseOperationEvent(input: {
  phase: ClickhouseOperationPhase;
  operation: ClickhouseOperation;
  correlationId: string;
  deadlineMs: number;
  traceId?: string;
  disconnectPolicy?: typeof CLICKHOUSE_WRITE_DISCONNECT_POLICY;
  outcome?: ClickhouseOutcome;
  elapsedMs?: number;
  failureKind?: ClickhouseFailureKind;
  statusCode?: unknown;
  clickhouseCode?: unknown;
  plannedDecision?: ClickhouseDecision;
  decision?: ClickhouseDecision;
  decisionState?: ClickhouseDecisionState;
  retrySource?: ClickhouseRetrySource;
  retryCount?: unknown;
  callerMapping?: ClickhouseCallerMapping;
}): ClickhouseOperationEvent {
  const event: ClickhouseOperationEvent = {
    event: "clickhouse.operation",
    v: CLICKHOUSE_OPERATION_EVENT_VERSION,
    phase: input.phase === "handled" ? "handled" : input.phase === "end" ? "end" : "start",
    operation: safeOperation(input.operation),
    correlationId: safeIdentifier(input.correlationId) ?? "invalid",
    deadlineMs: Math.max(0, Math.round(input.deadlineMs)),
  };
  const traceId = safeIdentifier(input.traceId);
  if (traceId) event.traceId = traceId;
  if (input.disconnectPolicy === CLICKHOUSE_WRITE_DISCONNECT_POLICY) {
    event.disconnectPolicy = input.disconnectPolicy;
  }
  if (event.phase === "end") {
    event.outcome = input.outcome === "ok" ? "ok" : "error";
    event.elapsedMs = Math.max(0, Math.round(input.elapsedMs ?? 0));
    event.plannedDecision = input.plannedDecision ?? "none";
    if (input.callerMapping) event.callerMapping = input.callerMapping;
    if (event.outcome === "error" && input.failureKind) {
      event.failureKind = input.failureKind;
      if (input.statusCode !== undefined) {
        event.statusCode = sanitizeClickhouseHttpStatus(input.statusCode);
      }
      const clickhouseCode = sanitizeClickhouseNumericCode(input.clickhouseCode);
      if (clickhouseCode !== undefined) event.clickhouseCode = clickhouseCode;
    }
  } else if (event.phase === "handled") {
    event.elapsedMs = Math.max(0, Math.round(input.elapsedMs ?? 0));
    event.decision = input.decision ?? "none";
    event.decisionState = input.decisionState === "failed" ? "failed" : "applied";
    if (input.retrySource === "span-dlq") event.retrySource = input.retrySource;
    if (input.callerMapping) event.callerMapping = input.callerMapping;
    if (
      typeof input.retryCount === "number" &&
      Number.isSafeInteger(input.retryCount) &&
      input.retryCount >= 0
    ) {
      event.retryCount = input.retryCount;
    }
  }
  return event;
}
