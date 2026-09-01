const LEGACY_RETRY_FIELD = ["at", "tempts"].join("");

export const MAX_SPAN_DLQ_RETRIES = 5;
export const MAX_SPAN_DLQ_MIGRATION_BATCH = 1_000;
export const SPAN_DLQ_PROCESSING_LEASE_MS = 5 * 60_000;
export const SPAN_DLQ_ACTIVE_KEY = "platos:dlq:spans";
export const SPAN_DLQ_DEAD_KEY = "platos:dlq:spans:dead";
export const SPAN_DLQ_PROCESSING_RUNS_KEY = "platos:dlq:spans:processing:runs";

export function spanDlqProcessingKey(runId: string): string {
  return `platos:dlq:spans:processing:${runId}`;
}
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TEXT_LENGTH = 8_192;
const MAX_ATTRIBUTE_COUNT = 256;
const MAX_ATTRIBUTE_KEY_LENGTH = 256;

export interface SanitizedSpanDlqEntry {
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    agentId?: string;
    threadId?: string;
    userId?: string;
    sessionContext?: { user?: { name?: string; email?: string } } | null;
  };
  record: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: "internal" | "client" | "server";
    startTimeUnixNano: number;
    endTimeUnixNano: number;
    durationMs: number;
    status: "ok" | "error";
    errorMessage?: string;
    attributes: Record<string, string | number | boolean>;
  };
  errorCode?: number;
  lastErrorCode?: number;
  enqueuedAt: number;
  retryCount: number;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedString(value: unknown, max = MAX_IDENTIFIER_LENGTH): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedFailureCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -3 && value <= 999_999
    ? value
    : undefined;
}

function sanitizeAttributes(value: unknown): Record<string, string | number | boolean> {
  const input = recordOf(value);
  if (!input) return {};
  const attributes: Record<string, string | number | boolean> = {};
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, MAX_ATTRIBUTE_COUNT)) {
    const key = boundedString(rawKey, MAX_ATTRIBUTE_KEY_LENGTH);
    if (!key) continue;
    if (typeof rawValue === "string") attributes[key] = rawValue.slice(0, MAX_TEXT_LENGTH);
    else if (typeof rawValue === "boolean") attributes[key] = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) attributes[key] = rawValue;
  }
  return attributes;
}

function sanitizeScope(value: unknown): SanitizedSpanDlqEntry["scope"] | null {
  const input = recordOf(value);
  if (!input) return null;
  const organizationId = boundedString(input.organizationId);
  const projectId = boundedString(input.projectId);
  const environmentId = boundedString(input.environmentId);
  if (!organizationId || !projectId || !environmentId) return null;
  const scope: SanitizedSpanDlqEntry["scope"] = {
    organizationId,
    projectId,
    environmentId,
  };
  const agentId = boundedString(input.agentId);
  const threadId = boundedString(input.threadId);
  const userId = boundedString(input.userId);
  if (agentId) scope.agentId = agentId;
  if (threadId) scope.threadId = threadId;
  if (userId) scope.userId = userId;

  if (input.sessionContext === null) scope.sessionContext = null;
  else {
    const sessionContext = recordOf(input.sessionContext);
    const user = recordOf(sessionContext?.user);
    if (user) {
      const name = boundedString(user.name, MAX_TEXT_LENGTH);
      const email = boundedString(user.email, MAX_TEXT_LENGTH);
      if (name || email) {
        scope.sessionContext = { user: { ...(name ? { name } : {}), ...(email ? { email } : {}) } };
      }
    }
  }
  return scope;
}

function sanitizeSpan(value: unknown): SanitizedSpanDlqEntry["record"] | null {
  const input = recordOf(value);
  if (!input) return null;
  const traceId = boundedString(input.traceId);
  const spanId = boundedString(input.spanId);
  const name = boundedString(input.name, MAX_TEXT_LENGTH);
  if (!traceId || !spanId || !name) return null;
  const kind =
    input.kind === "client" || input.kind === "server" || input.kind === "internal"
      ? input.kind
      : "internal";
  const status = input.status === "error" ? "error" : "ok";
  const span: SanitizedSpanDlqEntry["record"] = {
    traceId,
    spanId,
    name,
    kind,
    startTimeUnixNano: finiteNumber(input.startTimeUnixNano),
    endTimeUnixNano: finiteNumber(input.endTimeUnixNano),
    durationMs: Math.max(0, finiteNumber(input.durationMs)),
    status,
    attributes: sanitizeAttributes(input.attributes),
  };
  const parentSpanId = boundedString(input.parentSpanId);
  const errorMessage = boundedString(input.errorMessage, MAX_TEXT_LENGTH);
  if (parentSpanId) span.parentSpanId = parentSpanId;
  if (errorMessage) span.errorMessage = errorMessage;
  return span;
}

/** Read old queued rows during the bounded migration window without emitting the old field. */
export function spanDlqRetryCount(value: unknown): number {
  const entry = recordOf(value);
  if (!entry) return 0;
  return nonNegativeInteger(entry.retryCount) ?? nonNegativeInteger(entry[LEGACY_RETRY_FIELD]) ?? 0;
}

/**
 * Allowlist and bound every field before a retry, requeue or dead-letter write.
 * Legacy response/error fields are intentionally unrepresentable in the result.
 */
export function sanitizeSpanDlqEntry(
  value: unknown,
  overrides: {
    retryCount?: number;
    errorCode?: number;
    lastErrorCode?: number;
    deadLetter?: boolean;
  } = {}
): SanitizedSpanDlqEntry | null {
  const input = recordOf(value);
  if (!input) return null;
  const scope = sanitizeScope(input.scope);
  const span = sanitizeSpan(input.record);
  if (!scope || !span) return null;
  const retryCount =
    nonNegativeInteger(overrides.retryCount) ?? spanDlqRetryCount(input);
  const entry: SanitizedSpanDlqEntry = {
    scope,
    record: span,
    enqueuedAt: nonNegativeInteger(input.enqueuedAt) ?? Date.now(),
    retryCount,
  };
  const errorCode = boundedFailureCode(overrides.errorCode ?? input.errorCode);
  if (errorCode !== undefined) entry.errorCode = errorCode;
  if (overrides.deadLetter) {
    const lastErrorCode = boundedFailureCode(overrides.lastErrorCode ?? input.lastErrorCode);
    if (lastErrorCode !== undefined) entry.lastErrorCode = lastErrorCode;
  }
  return entry;
}

export function boundedSpanDlqMigrationBatch(maxBatch: number): number {
  return Number.isFinite(maxBatch)
    ? Math.max(0, Math.min(MAX_SPAN_DLQ_MIGRATION_BATCH, Math.floor(maxBatch)))
    : 0;
}
