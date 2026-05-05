import { Injectable, Inject } from "@nestjs/common";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type Redis from "ioredis";
import * as crypto from "crypto";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

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
   * PPR-15 — ClickHouse HTTP endpoint for persistent span storage.
   * When unset, we remain Redis-only (pre-PPR-15 behaviour). When set,
   * we dual-write every sampled span to `trigger_dev.platos_spans_v1`
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
      this.writeSpanToClickhouse(scope, record).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[Platos Spans] clickhouse write failed:", err?.message || err);
        this.pushSpanToDlq(scope, record, err?.message).catch(() => undefined);
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
    error?: string,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      const payload = JSON.stringify({
        scope,
        record,
        error: error?.slice(0, 400),
        enqueuedAt: Date.now(),
        attempts: 0,
      });
      await this.redis.lpush("platos:dlq:spans", payload);
      await this.redis.ltrim("platos:dlq:spans", 0, 50_000 - 1);
    } catch {
      // DLQ is best-effort — if Redis itself is down, we've already
      // logged the CH failure; nothing more to do.
    }
  }

  /**
   * EOBD.100 — DLQ drain. Called by the scheduled
   * `platos.observability.dlq_drain` task. Pops up to `maxBatch` entries,
   * retries the CH insert. Entries that fail after MAX_ATTEMPTS (5)
   * move to `platos:dlq:spans:dead` for manual review — typically
   * indicates a schema migration drift or a permanently-malformed row.
   */
  async drainDlq(maxBatch: number): Promise<{ retried: number; dead: number }> {
    if (!this.redis || !this.clickhouseBaseUrl) {
      return { retried: 0, dead: 0 };
    }
    const MAX_ATTEMPTS = 5;
    let retried = 0;
    let dead = 0;
    for (let i = 0; i < maxBatch; i++) {
      const raw = await this.redis.rpop("platos:dlq:spans").catch(() => null);
      if (!raw) break;
      let entry: {
        scope: any;
        record: PlatosSpan;
        attempts?: number;
      } | null = null;
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!entry) continue;
      const attempts = (entry.attempts ?? 0) + 1;
      try {
        await this.writeSpanToClickhouse(entry.scope, entry.record);
        retried++;
      } catch (err: any) {
        if (attempts >= MAX_ATTEMPTS) {
          await this.redis
            .lpush(
              "platos:dlq:spans:dead",
              JSON.stringify({
                ...entry,
                attempts,
                lastError: err?.message?.slice(0, 400),
              }),
            )
            .catch(() => undefined);
          await this.redis
            .ltrim("platos:dlq:spans:dead", 0, 10_000 - 1)
            .catch(() => undefined);
          dead++;
        } else {
          await this.redis
            .lpush("platos:dlq:spans", JSON.stringify({ ...entry, attempts }))
            .catch(() => undefined);
        }
      }
    }
    return { retried, dead };
  }

  /**
   * PPR-15 — JSONEachRow insert into `trigger_dev.platos_spans_v1`.
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
  ): Promise<void> {
    if (!this.clickhouseBaseUrl) return;
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
    const query = "INSERT INTO trigger_dev.platos_spans_v1 FORMAT JSONEachRow";
    const url = `${this.clickhouseBaseUrl}/?query=${encodeURIComponent(query)}`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.clickhouseAuth) {
      headers["Authorization"] =
        "Basic " +
        Buffer.from(`${this.clickhouseAuth.user}:${this.clickhouseAuth.pass}`).toString("base64");
    }
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(row) + "\n",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`clickhouse ${res.status}: ${text.slice(0, 200)}`);
    }
  }

  /**
   * PPR-15 — scope-filtered read from ClickHouse. Returns null when the
   * ClickHouse env var isn't set, signalling the caller to fall back to
   * Redis. The 2000-row cap mirrors the Redis-side ltrim.
   */
  async getThreadSpansFromClickhouse(
    scope: ScopeTuple,
    threadId: string,
  ): Promise<PlatosSpan[] | null> {
    if (!this.clickhouseBaseUrl) return null;
    const sql = `
      SELECT
        trace_id, span_id, parent_span_id, name, kind,
        start_ns, end_ns, duration_ms, status, error_message, attrs
      FROM trigger_dev.platos_spans_v1
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
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`clickhouse read ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.text();
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
