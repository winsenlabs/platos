import { Injectable } from "@nestjs/common";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, timingSafeEqual } from "node:crypto";

export const PERFORMANCE_EVIDENCE_ID_HEADER = "x-platos-performance-evidence-id";
export const PERFORMANCE_EVIDENCE_TOKEN_HEADER = "x-platos-performance-evidence-token";

type QueryEvent = {
  query: string;
  params: string;
  duration: number;
};

type SafeParameter = string | number | boolean | null | SafeParameter[];

export type CapturedCandidateQuery = {
  sequence: number;
  durationMs: number;
  normalizedSql: string;
  normalizedSqlSha256: string;
  parameters: SafeParameter[];
  parametersSha256: string;
  parameterMetadata: Array<Record<string, unknown>>;
  replayable: boolean;
  correlation: "request-bound-prisma-extension";
};

export type CandidateRequestEvidence = {
  schemaVersion: 1;
  requestId: string;
  method: "GET";
  path: string;
  statusCode: number;
  durationMs: number;
  correlationStatus: "bound" | "ambiguous";
  queryCount: number;
  queries: CapturedCandidateQuery[];
};

type ActiveCapture = {
  requestId: string;
  method: "GET";
  path: string;
  startedAtNs: bigint;
  queries: CapturedCandidateQuery[];
  correlationError: string | null;
};

type QueryInvocation = { capture: ActiveCapture | null };

const MAX_CAPTURED_QUERIES = 64;
const MAX_COMPLETED_CAPTURES = 32;
const SAFE_ENUM_PARAMETER =
  /^(?:active|paused|current|agent_visible|hidden|private|fact|preference|event|relationship|profile|manual|extracted|imported|rag)$/;
const UUID_PARAMETER = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ISO_DATE_PARAMETER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const FIXTURE_EXTERNAL_ID = /^win235-(?:alpha|beta)-[a-z0-9-]+$/;

@Injectable()
export class PerformanceEvidenceService {
  private readonly storage = new AsyncLocalStorage<ActiveCapture>();
  private readonly active = new Map<string, ActiveCapture>();
  private readonly completed = new Map<string, CandidateRequestEvidence>();
  private readonly queryInvocations = new Set<QueryInvocation>();

  enabled(): boolean {
    return (
      process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED === "1" &&
      Boolean(process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN?.trim())
    );
  }

  authorize(headers: Record<string, unknown>): boolean {
    if (!this.enabled()) return false;
    const expected = process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN?.trim();
    const provided = headers[PERFORMANCE_EVIDENCE_TOKEN_HEADER];
    if (!expected || typeof provided !== "string" || provided.length !== expected.length) {
      return false;
    }
    try {
      return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  validateRequestId(value: unknown): string | null {
    return typeof value === "string" && UUID_PARAMETER.test(value) ? value : null;
  }

  runRequest<T>(input: { requestId: string; method: string; path: string }, callback: () => T): T {
    if (input.method !== "GET") throw new Error("performance evidence only permits GET requests");
    if (!this.isAllowedPath(input.path))
      throw new Error("performance evidence path is not allowed");
    const capture: ActiveCapture = {
      requestId: input.requestId,
      method: "GET",
      path: input.path,
      startedAtNs: process.hrtime.bigint(),
      queries: [],
      correlationError: null,
    };
    this.active.set(input.requestId, capture);
    return this.storage.run(capture, callback);
  }

  async runQueryInvocation<T>(callback: () => Promise<T>): Promise<T> {
    const invocation: QueryInvocation = { capture: this.storage.getStore() ?? null };
    this.queryInvocations.add(invocation);
    try {
      return await callback();
    } finally {
      this.queryInvocations.delete(invocation);
    }
  }

  recordQueryEvent(event: QueryEvent): void {
    const captures = new Set(
      [...this.queryInvocations]
        .map((invocation) => invocation.capture)
        .filter((capture): capture is ActiveCapture => capture !== null)
    );
    if (captures.size === 0) return;
    const hasUncorrelatedInvocation = [...this.queryInvocations].some(
      (invocation) => invocation.capture === null
    );
    if (captures.size !== 1 || hasUncorrelatedInvocation) {
      for (const capture of captures) {
        capture.correlationError = "ambiguous concurrent Prisma query invocation";
      }
      return;
    }
    this.recordCapturedQuery([...captures][0], event);
  }

  private recordCapturedQuery(capture: ActiveCapture, event: QueryEvent): void {
    if (capture.queries.length >= MAX_CAPTURED_QUERIES) {
      throw new Error("performance evidence query bound exceeded");
    }
    const normalizedSql = normalizeSql(event.query);
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SET(?:\s+LOCAL|\s+TRANSACTION)?)(?:\s|$)/i.test(normalizedSql)) {
      return;
    }
    const parsed = JSON.parse(event.params) as unknown;
    const parameters = Array.isArray(parsed) ? parsed.map(sanitizeParameter) : [];
    const replayable = Array.isArray(parsed) && parameters.every((parameter) => parameter.safe);
    const safeValues = parameters.map((parameter) => parameter.value);
    capture.queries.push({
      sequence: capture.queries.length + 1,
      durationMs: event.duration,
      normalizedSql,
      normalizedSqlSha256: sha256(normalizedSql),
      parameters: safeValues,
      parametersSha256: sha256(JSON.stringify(safeValues)),
      parameterMetadata: parameters.map((parameter) => parameter.metadata),
      replayable,
      correlation: "request-bound-prisma-extension",
    });
  }

  complete(requestId: string, statusCode: number): void {
    const capture = this.active.get(requestId);
    if (!capture) return;
    this.active.delete(requestId);
    const evidence: CandidateRequestEvidence = {
      schemaVersion: 1,
      requestId: capture.requestId,
      method: capture.method,
      path: capture.path,
      statusCode,
      durationMs: Number(process.hrtime.bigint() - capture.startedAtNs) / 1_000_000,
      correlationStatus: capture.correlationError ? "ambiguous" : "bound",
      queryCount: capture.queries.length,
      queries: capture.queries,
    };
    this.completed.delete(capture.requestId);
    this.completed.set(capture.requestId, evidence);
    while (this.completed.size > MAX_COMPLETED_CAPTURES) {
      this.completed.delete(this.completed.keys().next().value!);
    }
  }

  consume(requestId: string): CandidateRequestEvidence | null {
    const evidence = this.completed.get(requestId) ?? null;
    this.completed.delete(requestId);
    return evidence;
  }

  private isAllowedPath(path: string): boolean {
    const pathname = path.split("?", 1)[0];
    return (
      pathname === "/api/v1/agent/agents" ||
      pathname === "/api/v1/memory" ||
      pathname === "/api/v1/memory/graph/entities"
    );
  }
}

type SanitizedParameter = {
  safe: boolean;
  value: SafeParameter;
  metadata: Record<string, unknown>;
};

function sanitizeParameter(value: unknown): SanitizedParameter {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return {
      safe: typeof value !== "number" || Number.isFinite(value),
      value: typeof value === "number" && !Number.isFinite(value) ? null : value,
      metadata: { type: value === null ? "null" : typeof value },
    };
  }
  if (Array.isArray(value)) {
    const nested = value.map(sanitizeParameter);
    return {
      safe: nested.every((parameter) => parameter.safe),
      value: nested.map((parameter) => parameter.value),
      metadata: {
        type: "array",
        length: nested.length,
        items: nested.map((parameter) => parameter.metadata),
      },
    };
  }
  if (typeof value === "string") {
    const safe =
      UUID_PARAMETER.test(value) ||
      ISO_DATE_PARAMETER.test(value) ||
      SAFE_ENUM_PARAMETER.test(value) ||
      FIXTURE_EXTERNAL_ID.test(value);
    return {
      safe,
      value: safe ? value : null,
      metadata: {
        type: safe ? "safe-string" : "redacted-string",
        length: value.length,
        sha256: sha256(value),
      },
    };
  }
  const serialized = JSON.stringify(value) ?? String(value);
  return {
    safe: false,
    value: null,
    metadata: { type: "redacted", length: serialized.length, sha256: sha256(serialized) },
  };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const performanceEvidenceService = new PerformanceEvidenceService();
