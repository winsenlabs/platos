import { Injectable, Inject } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import * as crypto from "crypto";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";
import { TELEMETRY_DATABASE } from "../shared/telemetry-namespace";
import {
  CLICKHOUSE_WRITE_DISCONNECT_POLICY,
  attachClickhouseCorrelation,
  ClickhouseCallerAbortError,
  ClickhouseNetworkError,
  ClickhouseStatusError,
  ClickhouseTimeoutError,
  buildClickhouseOperationEvent,
  classifyClickhouseFailure,
  clickhouseErrorCorrelation,
  clickhouseFailureCode,
  clickhouseMaxExecutionTimeSeconds,
  createClickhouseAbortContext,
  extractClickhouseNumericCode,
  type ClickhouseCallerMapping,
  type ClickhouseDecision,
  type ClickhouseDecisionState,
  type ClickhouseOperation,
} from "../shared/clickhouse-deadline";
import {
  boundedSpanDlqMigrationBatch,
  MAX_SPAN_DLQ_RETRIES,
  sanitizeSpanDlqEntry,
  SPAN_DLQ_ACTIVE_KEY,
  SPAN_DLQ_DEAD_KEY,
  SPAN_DLQ_PROCESSING_LEASE_MS,
  SPAN_DLQ_PROCESSING_RUNS_KEY,
  spanDlqProcessingKey,
  spanDlqRetryCount,
} from "./span-dlq";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

interface ClickhouseExecution {
  operation: ClickhouseOperation;
  url: string;
  init: RequestInit;
  callerSignal?: AbortSignal;
  traceId?: string;
  plannedFailureDecision: ClickhouseDecision;
  successCallerMapping: ClickhouseCallerMapping;
  disconnectPolicy?: typeof CLICKHOUSE_WRITE_DISCONNECT_POLICY;
}

interface ClickhouseExecutionResult {
  body: string;
  correlationId: string;
}

const SANITIZE_SPAN_DLQ_TAIL_SCRIPT = `
local current = redis.call("LINDEX", KEYS[1], -1)
if not current or current ~= ARGV[1] then
  return 0
end
if ARGV[2] == "replace" then
  redis.call("LSET", KEYS[1], -1, ARGV[3])
  redis.call("RPOPLPUSH", KEYS[1], KEYS[1])
  redis.call("LTRIM", KEYS[1], 0, tonumber(ARGV[4]) - 1)
else
  redis.call("RPOP", KEYS[1])
end
return 1
`;

// Push the replacement before removing the claimed row. Redis scripts are
// atomic with respect to other clients but do not roll back commands after a
// runtime error, so this ordering intentionally prefers an at-least-once
// duplicate over losing the only durable copy.
const TRANSITION_SPAN_DLQ_PROCESSING_SCRIPT = `
local position = redis.call("LPOS", KEYS[1], ARGV[1])
if not position then
  return 0
end
redis.call("LPUSH", KEYS[2], ARGV[2])
redis.call("LTRIM", KEYS[2], 0, tonumber(ARGV[3]) - 1)
return redis.call("LREM", KEYS[1], 1, ARGV[1])
`;

/**
 * OTel-shaped span record. We do not ship the full OpenTelemetry runtime —
 * the PRD (Theme E §2) explicitly scopes v1 to "stdout OTel exporter only".
 * Integrators plug their own receiver. This service records spans in Redis
 * (keyed by threadId) so the trace viewer can reconstruct a span tree per
 * turn without requiring ClickHouse.
 *
 * The wire shape mirrors OTel's Span model so a future `@opentelemetry/sdk-node`
 * integration is a drop-in replacement for the recorder itself.
 */
export interface PlatosSpan {
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
  events?: Array<{ name: string; timeUnixNano: number; attributes?: Record<string, unknown> }>;
}

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Attribute keys are namespaced per OTel semconv conventions:
 *   platos.org.id / platos.project.id / platos.env.id — Theme A scope tuple
 *   platos.agent.id / platos.thread.id / platos.user.id
 *   platos.model, platos.input_tokens, platos.output_tokens, platos.cost_cents
 *   platos.tool.name, platos.tool.status, platos.tool.latency_ms
 */
@Injectable()
export class SpansService {
  private sampler = 1.0;
  /**
   * WIN-290 — every ClickHouse HTTP call is bounded by this deadline. Injectable
   * `fetchImpl` exists so the slow/hung-server tests can drive a deterministic
   * abort without a real socket.
   */
  private readonly clickhouseDeadlineMs = env.PLATOS_CLICKHOUSE_TIMEOUT_MS;
  fetchImpl: typeof fetch = (...args) => fetch(...args);
  /**
   * WIN-290 observability gate — correlated start/end events for every
   * ClickHouse operation. Overridable so tests can assert the shape directly.
   */
  emitClickhouseEvent: (event: ReturnType<typeof buildClickhouseOperationEvent>) => void = (
    event
  ) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(event));
  };

  private emitSafeClickhouseEvent(event: ReturnType<typeof buildClickhouseOperationEvent>): void {
    try {
      this.emitClickhouseEvent(event);
    } catch {
      // Telemetry must never break the operation it observes.
    }
  }

  /**
   * One lifecycle owns fetch, status inspection and complete body consumption.
   * The terminal event therefore includes time spent waiting for body bytes,
   * and the timer/caller listener are always removed before returning.
   */
  private async executeClickhouse(execution: ClickhouseExecution): Promise<ClickhouseExecutionResult> {
    const deadlineMs = this.clickhouseDeadlineMs;
    const startedAt = Date.now();
    const correlationId = crypto.randomUUID();
    const abort = createClickhouseAbortContext(deadlineMs, execution.callerSignal);
    this.emitSafeClickhouseEvent(
      buildClickhouseOperationEvent({
        phase: "start",
        operation: execution.operation,
        correlationId,
        deadlineMs,
        traceId: execution.traceId,
        disconnectPolicy: execution.disconnectPolicy,
      })
    );

    try {
      const response = await this.fetchImpl(execution.url, {
        ...execution.init,
        signal: abort.signal,
      });
      // Consume even error responses under the SAME deadline. The contents are
      // deliberately discarded for non-2xx responses and never enter an Error.
      const body = await response.text();
      if (!response.ok) {
        throw new ClickhouseStatusError(
          execution.operation,
          response.status,
          extractClickhouseNumericCode(body)
        );
      }

      this.emitSafeClickhouseEvent(
        buildClickhouseOperationEvent({
          phase: "end",
          operation: execution.operation,
          correlationId,
          deadlineMs,
          traceId: execution.traceId,
          disconnectPolicy: execution.disconnectPolicy,
          outcome: "ok",
          elapsedMs: Date.now() - startedAt,
          plannedDecision: "none",
          callerMapping: execution.successCallerMapping,
        })
      );
      return { body, correlationId };
    } catch (error) {
      let failure: Error;
      if (abort.source() === "caller") {
        failure = new ClickhouseCallerAbortError(execution.operation, error);
      } else if (abort.source() === "deadline") {
        failure = new ClickhouseTimeoutError(execution.operation, deadlineMs, error);
      } else if (error instanceof ClickhouseStatusError) {
        failure = error;
      } else {
        // Raw fetch/body errors can contain URLs or response fragments. Keep
        // them only as an unobserved cause and expose a fixed safe message.
        failure = new ClickhouseNetworkError(execution.operation, error);
      }
      const callerMapping: ClickhouseCallerMapping =
        execution.operation === "span-write"
          ? "detached-write"
          : failure instanceof ClickhouseTimeoutError
            ? "clickhouse-timeout"
            : failure instanceof ClickhouseCallerAbortError
              ? "clickhouse-caller-abort"
              : failure instanceof ClickhouseStatusError
                ? "clickhouse-status"
                : "clickhouse-network";
      const correlatedFailure = attachClickhouseCorrelation(failure, correlationId);
      this.emitSafeClickhouseEvent(
        buildClickhouseOperationEvent({
          phase: "end",
          operation: execution.operation,
          correlationId,
          deadlineMs,
          traceId: execution.traceId,
          disconnectPolicy: execution.disconnectPolicy,
          outcome: "error",
          elapsedMs: Date.now() - startedAt,
          failureKind: classifyClickhouseFailure(failure),
          statusCode: failure instanceof ClickhouseStatusError ? failure.statusCode : undefined,
          clickhouseCode:
            failure instanceof ClickhouseStatusError ? failure.clickhouseCode : undefined,
          plannedDecision:
            failure instanceof ClickhouseCallerAbortError
              ? "none"
              : execution.plannedFailureDecision,
          callerMapping,
        })
      );
      throw correlatedFailure;
    } finally {
      abort.cleanup();
    }
  }

  /** Emit the result of an actual handling-layer fallback or queue mutation. */
  reportClickhouseHandling(input: {
    operation: ClickhouseOperation;
    correlationId: string;
    traceId?: string;
    decision: ClickhouseDecision;
    decisionState: ClickhouseDecisionState;
    elapsedMs: number;
    callerMapping: ClickhouseCallerMapping;
    retrySource?: "span-dlq";
    retryCount?: number;
  }): void {
    this.emitSafeClickhouseEvent(
      buildClickhouseOperationEvent({
        phase: "handled",
        operation: input.operation,
        correlationId: input.correlationId,
        deadlineMs: this.clickhouseDeadlineMs,
        traceId: input.traceId,
        elapsedMs: input.elapsedMs,
        decision: input.decision,
        decisionState: input.decisionState,
        callerMapping: input.callerMapping,
        retrySource: input.retrySource,
        retryCount: input.retryCount,
      })
    );
  }
  /**
   * PPR-15 — ClickHouse HTTP endpoint for persistent span storage.
   * When unset, we remain Redis-only (pre-PPR-15 behaviour). When set,
   * we dual-write every sampled span to the configured telemetry database
   * via the HTTP JSONEachRow interface. No new dep — node's `fetch`.
   *
   * Format: `http://default:pwd@host:8123` (basic-auth credentials baked
   * into the URL mirror how the compose stack ships ClickHouse). Parsed
   * once at construction to split creds from the base URL.
   */
  private readonly clickhouseBaseUrl: string | null;
  private readonly clickhouseAuth: { user: string; pass: string } | null;

  constructor(@Inject(REDIS_TOKEN) private readonly redis: Redis) {
    const rate = env.PLATOS_OTEL_SAMPLE_RATE ?? 1;
    this.sampler = isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 1;

    const rawUrl = env.PLATOS_OTEL_CLICKHOUSE_URL?.trim();
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        const user = u.username ? decodeURIComponent(u.username) : "";
        const pass = u.password ? decodeURIComponent(u.password) : "";
        u.username = "";
        u.password = "";
        // Strip trailing slash so we can safely append `/?query=...`.
        this.clickhouseBaseUrl = u.toString().replace(/\/+$/, "");
        this.clickhouseAuth = user ? { user, pass } : null;
      } catch {
        this.clickhouseBaseUrl = null;
        this.clickhouseAuth = null;
      }
    } else {
      this.clickhouseBaseUrl = null;
      this.clickhouseAuth = null;
    }
  }

  /** True when ClickHouse dual-write / read is enabled for this process. */
  isClickhouseEnabled(): boolean {
    return this.clickhouseBaseUrl !== null;
  }

  /**
   * Create a fresh trace id (128-bit) + root span id (64-bit). One call per turn.
   */
  startTrace(): { traceId: string; rootSpanId: string } {
    return { traceId: hex(16), rootSpanId: hex(8) };
  }

  /**
   * Create a child span id (64-bit) under an existing trace.
   */
  nextSpanId(): string {
    return hex(8);
  }

  /**
   * Record a completed span into the per-thread trace list + stdout if
   * PLATOS_OTEL_STDOUT=true.
   *
   * PPR-61 — sampling policy:
   *   - Span enqueue (per-thread trace list) + stdout export ARE sampled
   *     by `PLATOS_OTEL_SAMPLE_RATE`. High-volume orgs shed trace load
   *     without losing the catalog.
   *   - The cost-bearing attributes (`platos.cost_cents`,
   *     `platos.input_tokens`, `platos.output_tokens`) are ALWAYS written
   *     at full fidelity into the dedicated `cost:samples:*` Redis hashes.
   *     Sampling must not silently erase billing signal.
   *
   *   Previously, a single sampler drop nuked both the Redis span write and
   *   stdout log in lockstep — and because cost figures piggy-backed on the
   *   span attributes, lowering the sample rate also lowered the dashboard
   *   cost totals proportionally. That was a correctness bug, not a
   *   load-shedding feature.
   */
  async record(
    scope: ScopeTuple & {
      agentId?: string;
      threadId?: string;
      userId?: string;
      sessionContext?: { user?: { name?: string; email?: string } } | null;
    },
    span: Omit<PlatosSpan, "attributes"> & { attributes?: Record<string, string | number | boolean> },
  ): Promise<void> {
    const record: PlatosSpan = {
      ...span,
      attributes: {
        "platos.org.id": scope.organizationId,
        "platos.project.id": scope.projectId,
        "platos.env.id": scope.environmentId,
        ...(scope.agentId ? { "platos.agent.id": scope.agentId } : {}),
        ...(scope.threadId ? { "platos.thread.id": scope.threadId } : {}),
        ...(scope.userId ? { "platos.user.id": scope.userId } : {}),
        ...(span.attributes || {}),
      },
    };

    // PPR-61 — full-fidelity cost counter, regardless of sample rate. Writes
    // the cost / token numbers into dedicated hashes keyed by (scope, day)
    // so reconcile + dashboards pick up the authoritative-from-spans mirror
    // even when the span itself is sampled out.
    await this.recordCostFullFidelity(scope, record);

    const sampled = Math.random() <= this.sampler;
    if (!sampled) {
      // Span + stdout export drop here; cost hash already updated above.
      return;
    }

    const threadKey = scope.threadId ? `trace:thread:${scope.threadId}` : null;
    if (threadKey) {
      const pipeline = this.redis.pipeline();
      pipeline.rpush(threadKey, JSON.stringify(record));
      // Cap the per-thread span count at 2000 — protects the Redis shard for
      // very long running threads. Older spans are trimmed LRU-style.
      pipeline.ltrim(threadKey, -2000, -1);
      pipeline.expire(threadKey, 86400 * 14); // 14 day retention
      await pipeline.exec();
    }

    if (env.PLATOS_OTEL_STDOUT === true) {
      // eslint-disable-next-line no-console
      console.log(`[otel] ${JSON.stringify(record)}`);
    }

    // PPR-15 — persistent dual-write to ClickHouse. Fire-and-forget so span
    // recording never blocks the agent turn; failures log but don't throw.
    // Redis stays the authoritative source until the async insert lands.
    //
    // EOBD.100 — on failure, push the row onto a Redis DLQ. The scheduled
    // `platos.observability.dlq_drain` task retries entries periodically so
    // transient CH outages don't permanently lose telemetry. Redis is the
    // durable hold-queue until the row lands in CH.
    if (this.clickhouseBaseUrl) {
      this.writeSpanToClickhouse(scope, record).catch(async (err) => {
        // Fixed text + numeric-only code: fetch errors and ClickHouse bodies
        // may contain URLs, SQL, credentials or echoed row/identity fields.
        // eslint-disable-next-line no-console
        console.warn("[Platos Spans] ClickHouse span-write failed", clickhouseFailureCode(err));
        const handlingStartedAt = Date.now();
        const applied = await this.pushSpanToDlq(scope, record, err);
        const correlationId = clickhouseErrorCorrelation(err);
        if (correlationId) {
          this.reportClickhouseHandling({
            operation: "span-write",
            correlationId,
            traceId: record.traceId,
            decision: "enqueue-dlq",
            decisionState: applied ? "applied" : "failed",
            elapsedMs: Date.now() - handlingStartedAt,
            callerMapping: "detached-write",
          });
        }
      });
    }
  }

  /**
   * EOBD.100 — DLQ push. Keeps a bounded list (default 50k entries) of
   * failed span inserts so the drain task can retry without re-walking
   * the full authoritative store. If the list fills, the oldest entries
   * are dropped — telemetry loss is preferable to unbounded memory.
   */
  private async pushSpanToDlq(
    scope: ScopeTuple & {
      agentId?: string;
      threadId?: string;
      userId?: string;
      sessionContext?: { user?: { name?: string; email?: string } } | null;
    },
    record: PlatosSpan,
    error?: unknown,
  ): Promise<boolean> {
    if (!this.redis) return false;
    const entry = sanitizeSpanDlqEntry(
      {
        scope,
        record,
        enqueuedAt: Date.now(),
      },
      { retryCount: 0, errorCode: clickhouseFailureCode(error) }
    );
    return entry
      ? this.writeSpanDlqEntry(SPAN_DLQ_ACTIVE_KEY, entry, 50_000)
      : false;
  }

  private async writeSpanDlqEntry(
    key: "platos:dlq:spans" | "platos:dlq:spans:dead",
    entry: ReturnType<typeof sanitizeSpanDlqEntry> & object,
    maxLength: number
  ): Promise<boolean> {
    try {
      await this.redis.lpush(key, JSON.stringify(entry));
      await this.redis.ltrim(key, 0, maxLength - 1);
      return true;
    } catch {
      return false;
    }
  }

  private async sanitizeDlqList(
    key: "platos:dlq:spans" | "platos:dlq:spans:dead",
    maxBatch: number,
    maxLength: number,
    deadLetter: boolean
  ): Promise<number> {
    if (!this.redis) return 0;
    const requested = boundedSpanDlqMigrationBatch(maxBatch);
    if (requested === 0) return 0;
    if (
      typeof this.redis.llen !== "function" ||
      typeof this.redis.lindex !== "function" ||
      typeof this.redis.eval !== "function"
    ) {
      return 0;
    }
    const existing = await this.redis.llen(key).catch(() => 0);
    const count = Math.min(requested, Math.max(0, Number(existing) || 0));
    let migrated = 0;
    for (let i = 0; i < count; i++) {
      const raw = await this.redis.lindex(key, -1).catch(() => null);
      if (!raw) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const sanitized = sanitizeSpanDlqEntry(parsed, { deadLetter });
      const applied = await this.redis
        .eval(
          SANITIZE_SPAN_DLQ_TAIL_SCRIPT,
          1,
          key,
          raw,
          sanitized ? "replace" : "drop",
          sanitized ? JSON.stringify(sanitized) : "",
          String(maxLength)
        )
        .catch(() => 0);
      if (Number(applied) !== 1) break;
      migrated++;
    }
    return migrated;
  }

  /** Bounded atomic in-place migration for legacy active rows. */
  async sanitizeActiveDlq(maxBatch: number): Promise<number> {
    return this.sanitizeDlqList(SPAN_DLQ_ACTIVE_KEY, maxBatch, 50_000, false);
  }

  /** Bounded atomic in-place migration for legacy dead-letter rows. */
  async sanitizeDeadLetterDlq(maxBatch: number): Promise<number> {
    return this.sanitizeDlqList(SPAN_DLQ_DEAD_KEY, maxBatch, 10_000, true);
  }

  private async cleanupSpanDlqProcessingRun(runId: string, processingKey: string): Promise<void> {
    const remaining = await this.redis.llen(processingKey).catch(() => 1);
    if (Number(remaining) !== 0) return;
    await this.redis.zrem(SPAN_DLQ_PROCESSING_RUNS_KEY, runId).catch(() => 0);
    await this.redis.del(processingKey).catch(() => 0);
  }

  private async claimSpanDlqEntry(
    runId: string,
    processingKey: string,
  ): Promise<string | null> {
    await this.redis.zadd(SPAN_DLQ_PROCESSING_RUNS_KEY, Date.now(), runId);
    const raw = await this.redis.rpoplpush(SPAN_DLQ_ACTIVE_KEY, processingKey);
    if (!raw) await this.cleanupSpanDlqProcessingRun(runId, processingKey);
    return raw;
  }

  private async acknowledgeSpanDlqEntry(processingKey: string, raw: string): Promise<boolean> {
    const removed = await this.redis.lrem(processingKey, 1, raw).catch(() => 0);
    return Number(removed) === 1;
  }

  private async transitionSpanDlqEntry(
    processingKey: string,
    raw: string,
    destinationKey: typeof SPAN_DLQ_ACTIVE_KEY | typeof SPAN_DLQ_DEAD_KEY,
    replacement: ReturnType<typeof sanitizeSpanDlqEntry> & object,
    maxLength: number,
  ): Promise<boolean> {
    const applied = await this.redis
      .eval(
        TRANSITION_SPAN_DLQ_PROCESSING_SCRIPT,
        2,
        processingKey,
        destinationKey,
        raw,
        JSON.stringify(replacement),
        String(maxLength),
      )
      .catch(() => 0);
    return Number(applied) === 1;
  }

  /**
   * Recover rows left in per-run processing lists by a terminated worker.
   * A row may already have reached ClickHouse before the worker died, so replay
   * is deliberately at-least-once. RPOPLPUSH makes recovery lossless; a crash
   * after the move can only leave the row in the active list for another retry.
   */
  async recoverAbandonedDlq(maxBatch: number, now = Date.now()): Promise<number> {
    if (!this.redis) return 0;
    const requested = boundedSpanDlqMigrationBatch(maxBatch);
    if (requested === 0) return 0;
    const cutoff = now - SPAN_DLQ_PROCESSING_LEASE_MS;
    const runIds = await this.redis
      .zrangebyscore(
        SPAN_DLQ_PROCESSING_RUNS_KEY,
        "-inf",
        String(cutoff),
        "LIMIT",
        0,
        requested,
      )
      .catch(() => [] as string[]);
    let recovered = 0;
    for (const runId of runIds) {
      if (!/^[a-f0-9-]{36}$/iu.test(runId)) {
        await this.redis.zrem(SPAN_DLQ_PROCESSING_RUNS_KEY, runId).catch(() => 0);
        continue;
      }
      const processingKey = spanDlqProcessingKey(runId);
      while (recovered < requested) {
        const raw = await this.redis
          .rpoplpush(processingKey, SPAN_DLQ_ACTIVE_KEY)
          .catch(() => null);
        if (!raw) break;
        recovered++;
        await this.redis.ltrim(SPAN_DLQ_ACTIVE_KEY, 0, 49_999).catch(() => undefined);
      }
      await this.cleanupSpanDlqProcessingRun(runId, processingKey);
      if (recovered >= requested) break;
    }
    return recovered;
  }

  /**
   * EOBD.100 — DLQ drain. Each row first moves atomically from the active
   * queue into a per-run processing list. Success acknowledges that exact
   * claim; failures atomically requeue or dead-letter it. A terminated worker
   * therefore leaves a recoverable processing row instead of losing an RPOP.
   */
  async drainDlq(maxBatch: number): Promise<{ retried: number; dead: number }> {
    if (!this.redis) {
      return { retried: 0, dead: 0 };
    }
    const batch = boundedSpanDlqMigrationBatch(maxBatch);
    await this.sanitizeActiveDlq(batch);
    await this.sanitizeDeadLetterDlq(batch);
    await this.recoverAbandonedDlq(batch);
    if (!this.clickhouseBaseUrl) return { retried: 0, dead: 0 };
    let retried = 0;
    let dead = 0;
    const runId = crypto.randomUUID();
    const processingKey = spanDlqProcessingKey(runId);
    try {
      for (let i = 0; i < batch; i++) {
        const raw = await this.claimSpanDlqEntry(runId, processingKey).catch(() => null);
        if (!raw) break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          if (!(await this.acknowledgeSpanDlqEntry(processingKey, raw))) break;
          continue;
        }
        const entry = sanitizeSpanDlqEntry(parsed);
        if (!entry) {
          if (!(await this.acknowledgeSpanDlqEntry(processingKey, raw))) break;
          continue;
        }
        const retryCount = spanDlqRetryCount(entry) + 1;
        const handlingStartedAt = Date.now();
        try {
          const result = await this.writeSpanToClickhouse(
            entry.scope,
            entry.record as PlatosSpan,
            retryCount >= MAX_SPAN_DLQ_RETRIES ? "dead-letter" : "retry-dlq",
          );
          const applied = await this.acknowledgeSpanDlqEntry(processingKey, raw);
          if (applied) retried++;
          this.reportClickhouseHandling({
            operation: "span-write",
            correlationId: result.correlationId,
            traceId: entry.record.traceId,
            decision: "retry-dlq",
            decisionState: applied ? "applied" : "failed",
            elapsedMs: Date.now() - handlingStartedAt,
            callerMapping: "detached-write",
            retrySource: "span-dlq",
            retryCount,
          });
          if (!applied) break;
        } catch (err: any) {
          const correlationId = clickhouseErrorCorrelation(err);
          const deadLetter = retryCount >= MAX_SPAN_DLQ_RETRIES;
          const sanitized = sanitizeSpanDlqEntry(entry, {
            retryCount,
            ...(deadLetter
              ? { lastErrorCode: clickhouseFailureCode(err), deadLetter: true }
              : {}),
          });
          const applied = sanitized
            ? await this.transitionSpanDlqEntry(
                processingKey,
                raw,
                deadLetter ? SPAN_DLQ_DEAD_KEY : SPAN_DLQ_ACTIVE_KEY,
                sanitized,
                deadLetter ? 10_000 : 50_000,
              )
            : false;
          if (applied && deadLetter) dead++;
          if (correlationId) {
            this.reportClickhouseHandling({
              operation: "span-write",
              correlationId,
              traceId: entry.record.traceId,
              decision: deadLetter ? "dead-letter" : "retry-dlq",
              decisionState: applied ? "applied" : "failed",
              elapsedMs: Date.now() - handlingStartedAt,
              callerMapping: "detached-write",
              retrySource: "span-dlq",
              retryCount,
            });
          }
          if (!applied) break;
        }
      }
    } finally {
      await this.cleanupSpanDlqProcessingRun(runId, processingKey);
    }
    return { retried, dead };
  }

  /**
   * PPR-15 — JSONEachRow insert into the configured telemetry database.
   * Uses node's built-in `fetch` so we avoid adding a new dependency; the
   * ClickHouse HTTP interface accepts basic-auth credentials out of band
   * via the `Authorization` header.
   */
  private async writeSpanToClickhouse(
    scope: ScopeTuple & {
      agentId?: string;
      threadId?: string;
      userId?: string;
      // Optional — lifted from JWT userMeta by ScopeGuard. When present the
      // visitor's name + email get folded into the span's `attrs` JSON so
      // ClickHouse queries can `JSONExtractString(attrs, 'user.name')`
      // instead of joining through PlatosEndUser in Postgres. PII stays
      // out of the indexed `user_id` column (still the SHA256-hashed
      // `lead-<hash>`); this lives in attrs only.
      sessionContext?: { user?: { name?: string; email?: string } } | null;
    },
    record: PlatosSpan,
    failureDecision: ClickhouseDecision = "enqueue-dlq",
  ): Promise<ClickhouseExecutionResult> {
    if (!this.clickhouseBaseUrl) return { body: "", correlationId: "disabled" };
    const durationMs = Math.max(
      0,
      Math.round((record.endTimeUnixNano - record.startTimeUnixNano) / 1_000_000),
    );
    // PRELAUNCH-A1-6 — promote token + provider attributes onto first-class
    // columns. The attribute map on the span carries the source-of-truth
    // values; this lifts the most-queried subset onto the row so dashboard
    // aggregates don't need JSONExtract.
    const attrs = (record.attributes ?? {}) as Record<string, unknown>;
    const numAttr = (key: string): number => {
      const v = attrs[key];
      return typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0;
    };
    const strAttr = (key: string): string => {
      const v = attrs[key];
      return typeof v === "string" ? v : "";
    };
    const row = {
      organization_id: scope.organizationId,
      project_id: scope.projectId,
      environment_id: scope.environmentId,
      agent_id: scope.agentId ?? "",
      thread_id: scope.threadId ?? "",
      user_id: scope.userId ?? "",
      trace_id: record.traceId,
      span_id: record.spanId,
      parent_span_id: record.parentSpanId ?? "",
      name: record.name,
      kind: record.kind,
      start_ns: record.startTimeUnixNano,
      end_ns: record.endTimeUnixNano,
      duration_ms: durationMs,
      status: record.status,
      error_message: record.errorMessage ?? "",
      // PRELAUNCH-A1-6 — first-class token / provider columns.
      input_tokens: Math.max(0, Math.floor(numAttr("platos.input_tokens"))),
      output_tokens: Math.max(0, Math.floor(numAttr("platos.output_tokens"))),
      cache_read_input_tokens: Math.max(0, Math.floor(numAttr("platos.cache_read_input_tokens"))),
      cache_creation_input_tokens: Math.max(0, Math.floor(numAttr("platos.cache_creation_input_tokens"))),
      reasoning_tokens: Math.max(0, Math.floor(numAttr("platos.reasoning_tokens"))),
      provider: strAttr("platos.provider"),
      model: strAttr("platos.model"),
      // Visitor identity (when supplied via JWT userMeta) lives in dedicated
      // columns added by migration 030_platos_spans_user_identity.sql so
      // analytics queries don't need JSONExtract. user_id stays as the
      // SHA256-hashed lead-id (indexed); these PII columns are separate so
      // a GDPR wipe can null them without touching the canonical id.
      user_display_name: scope.sessionContext?.user?.name ?? "",
      user_email: scope.sessionContext?.user?.email ?? "",
      // Also fold into attrs JSON so traces predating the migration still
      // surface the same data via JSONExtractString(attrs, 'user.name').
      attrs: JSON.stringify({
        ...(record.attributes ?? {}),
        ...(scope.sessionContext?.user?.name
          ? { "user.name": scope.sessionContext.user.name }
          : {}),
        ...(scope.sessionContext?.user?.email
          ? { "user.email": scope.sessionContext.user.email }
          : {}),
      }),
    };
    const query = `INSERT INTO ${TELEMETRY_DATABASE}.platos_spans_v1 FORMAT JSONEachRow`;
    const url = `${this.clickhouseBaseUrl}/?query=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.clickhouseAuth) {
      headers["Authorization"] =
        "Basic " +
        Buffer.from(`${this.clickhouseAuth.user}:${this.clickhouseAuth.pass}`).toString("base64");
    }
    // WIN-290 write disconnect policy: writes are intentionally detached from
    // the originating request. A caller disconnect does NOT cancel persistence;
    // the write survives, bounded by its own deadline, then enters the canonical
    // Redis DLQ on failure.
    const deadlineMs = this.clickhouseDeadlineMs;
    return this.executeClickhouse({
      operation: "span-write",
      url: `${url}&max_execution_time=${clickhouseMaxExecutionTimeSeconds(deadlineMs)}`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(row) + "\n",
      },
      traceId: record.traceId,
      plannedFailureDecision: failureDecision,
      successCallerMapping: "detached-write",
      disconnectPolicy: CLICKHOUSE_WRITE_DISCONNECT_POLICY,
    });
  }

  /**
   * PPR-15 — scope-filtered read from ClickHouse. Returns null when the
   * ClickHouse env var isn't set, signalling the caller to fall back to
   * Redis. The 2000-row cap mirrors the Redis-side ltrim.
   */
  async getThreadSpansFromClickhouse(
    scope: ScopeTuple,
    threadId: string,
    callerSignal?: AbortSignal,
  ): Promise<PlatosSpan[] | null> {
    if (!this.clickhouseBaseUrl) return null;
    const sql = `
      SELECT
        trace_id, span_id, parent_span_id, name, kind,
        start_ns, end_ns, duration_ms, status, error_message, attrs
      FROM ${TELEMETRY_DATABASE}.platos_spans_v1
      WHERE organization_id = {org:String}
        AND project_id = {project:String}
        AND environment_id = {env:String}
        AND thread_id = {thread:String}
      ORDER BY start_ns ASC
      LIMIT 2000
      FORMAT JSONEachRow
    `.trim();
    const params = new URLSearchParams();
    params.set("query", sql);
    params.set("param_org", scope.organizationId);
    params.set("param_project", scope.projectId);
    params.set("param_env", scope.environmentId);
    params.set("param_thread", threadId);
    const url = `${this.clickhouseBaseUrl}/?${params.toString()}`;
    const headers: Record<string, string> = {};
    if (this.clickhouseAuth) {
      headers["Authorization"] =
        "Basic " +
        Buffer.from(`${this.clickhouseAuth.user}:${this.clickhouseAuth.pass}`).toString("base64");
    }
    // WIN-290 — the real caller signal participates in the same lifecycle as
    // the deadline, while source tracking keeps caller-abort distinguishable.
    const readDeadlineMs = this.clickhouseDeadlineMs;
    const { body } = await this.executeClickhouse({
      operation: "span-read",
      url: `${url}&max_execution_time=${clickhouseMaxExecutionTimeSeconds(readDeadlineMs)}`,
      init: { method: "GET", headers },
      callerSignal,
      plannedFailureDecision: "fallback-redis",
      successCallerMapping: "spans",
    });
    const spans: PlatosSpan[] = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const r = JSON.parse(trimmed);
        let attributes: Record<string, string | number | boolean> = {};
        try {
          const parsed = typeof r.attrs === "string" ? JSON.parse(r.attrs) : r.attrs ?? {};
          if (parsed && typeof parsed === "object") attributes = parsed;
        } catch {
          attributes = {};
        }
        spans.push({
          traceId: String(r.trace_id),
          spanId: String(r.span_id),
          parentSpanId: r.parent_span_id ? String(r.parent_span_id) : undefined,
          name: String(r.name),
          kind: (r.kind as PlatosSpan["kind"]) || "internal",
          // ClickHouse returns UInt64 as strings in JSON — coerce.
          startTimeUnixNano: Number(r.start_ns),
          endTimeUnixNano: Number(r.end_ns),
          durationMs: Number(r.duration_ms ?? 0),
          status: r.status === "error" ? "error" : "ok",
          errorMessage: r.error_message ? String(r.error_message) : undefined,
          attributes,
        });
      } catch {
        // Skip malformed rows; Redis fallback is still available.
      }
    }
    return spans;
  }

  /**
   * PPR-61 — extract cost-bearing attributes from a span and write them to
   * `cost:samples:scope:<scope>:<day>` + `cost:samples:agent:<scope>:<agentId>:<day>`
   * as full-fidelity hashes. This is deliberately a separate namespace from
   * `cost:scope:*` (maintained by `CostService.recordUsage`) so the two
   * sources can be cross-checked during reconciliation without one
   * overwriting the other.
   *
   * No-op when the span carries no cost attributes — non-LLM spans don't
   * produce billing signal.
   */
  private async recordCostFullFidelity(
    scope: ScopeTuple & { agentId?: string },
    record: PlatosSpan,
  ): Promise<void> {
    const attrs = record.attributes || {};
    // EOBD.31 — only the llm.inference span carries authoritative cost
    // for a given LLM call. agent.turn also sets platos.turn.cost_cents
    // aggregating its children, which duplicated the same dollars when
    // both spans matched here via the `??` fallback — dashboards showed
    // 2× reality. Require `platos.cost_cents` explicitly; skip the
    // rollup span (its turn cost is already accounted via its child
    // llm.inference span that fired earlier in this same pipeline).
    const costCents = Number(attrs["platos.cost_cents"] ?? 0);
    const inputTokens = Number(attrs["platos.input_tokens"] ?? 0);
    const outputTokens = Number(attrs["platos.output_tokens"] ?? 0);
    if (costCents <= 0 && inputTokens <= 0 && outputTokens <= 0) return;

    const day = new Date().toISOString().slice(0, 10);
    const s = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}`;
    const pipeline = this.redis.pipeline();
    const scopeKey = `cost:samples:scope:${s}:${day}`;
    pipeline.hincrby(scopeKey, "input_tokens", inputTokens);
    pipeline.hincrby(scopeKey, "output_tokens", outputTokens);
    pipeline.hincrbyfloat(scopeKey, "cost_cents", costCents);
    pipeline.expire(scopeKey, 86400 * 90);
    if (scope.agentId) {
      const agentKey = `cost:samples:agent:${s}:${scope.agentId}:${day}`;
      pipeline.hincrby(agentKey, "input_tokens", inputTokens);
      pipeline.hincrby(agentKey, "output_tokens", outputTokens);
      pipeline.hincrbyfloat(agentKey, "cost_cents", costCents);
      pipeline.hincrby(agentKey, "calls", 1);
      pipeline.expire(agentKey, 86400 * 90);
    }
    try {
      await pipeline.exec();
    } catch {
      // Best-effort — Redis hiccups must never hide a span.
    }
  }

  /**
   * Convenience: record a span around a sync/async operation. Caller gets the
   * return value; the span is stamped with duration + status automatically.
   */
  async withSpan<T>(
    scope: ScopeTuple & { agentId?: string; threadId?: string; userId?: string },
    traceId: string,
    parentSpanId: string | undefined,
    name: string,
    kind: PlatosSpan["kind"],
    attributes: Record<string, string | number | boolean>,
    fn: (ctx: { spanId: string }) => Promise<T>,
  ): Promise<T> {
    const spanId = this.nextSpanId();
    const startTimeUnixNano = Date.now() * 1_000_000;
    try {
      const result = await fn({ spanId });
      const endTimeUnixNano = Date.now() * 1_000_000;
      await this.record(scope, {
        traceId,
        spanId,
        parentSpanId,
        name,
        kind,
        startTimeUnixNano,
        endTimeUnixNano,
        durationMs: Math.round((endTimeUnixNano - startTimeUnixNano) / 1_000_000),
        status: "ok",
        attributes,
      });
      return result;
    } catch (err: any) {
      const endTimeUnixNano = Date.now() * 1_000_000;
      await this.record(scope, {
        traceId,
        spanId,
        parentSpanId,
        name,
        kind,
        startTimeUnixNano,
        endTimeUnixNano,
        durationMs: Math.round((endTimeUnixNano - startTimeUnixNano) / 1_000_000),
        status: "error",
        errorMessage: err?.message ?? String(err),
        attributes,
      });
      throw err;
    }
  }

  /**
   * Read all spans for a thread — used by the trace-viewer endpoint.
   */
  async getThreadSpans(threadId: string): Promise<PlatosSpan[]> {
    const raw = await this.redis.lrange(`trace:thread:${threadId}`, 0, -1);
    return raw
      .map((s) => {
        try {
          return JSON.parse(s) as PlatosSpan;
        } catch {
          return null;
        }
      })
      .filter((s): s is PlatosSpan => s !== null);
  }

  /**
   * Current sampling knob (for /monitoring/diagnostics).
   */
  getSampleRate(): number {
    return this.sampler;
  }
}
