-- +goose Up
-- PPR-15 — persistent span store for Platos agent traces. The agent's
-- SpansService dual-writes here (fire-and-forget) when
-- PLATOS_OTEL_CLICKHOUSE_URL is configured; the trace-viewer's
-- buildThreadTrace reads from here in preference to Redis so traces
-- survive Redis LRU eviction + the 14-day TTL.
--
-- Column layout mirrors the OTel-shaped `PlatosSpan` record in
-- `apps/agent/src/monitoring/spans.service.ts`:
--   - `start_ns` / `end_ns` stay as UInt64 so we never drop OTel's
--     nanosecond precision; a derived `start_time` DateTime64(9) is
--     materialized for TTL + partitioning.
--   - `attrs` is a JSON string (not Map) — PlatosSpan's attribute values
--     are a union of string|number|boolean and the heterogeneous map
--     types CH offers (Map(String, String)) would force stringification
--     on write. JSON lets us round-trip the original typed values.
--
-- The ORDER BY puts (scope, thread, trace) up front so the two canonical
-- queries — "all spans for this thread" and "all spans for this trace" —
-- hit contiguous parts without needing a skip index.

CREATE TABLE IF NOT EXISTS trigger_dev.platos_spans_v1
(
  -- Scope tuple (SPEC §10.1) — every scoped row carries all three.
  organization_id   LowCardinality(String),
  project_id        LowCardinality(String),
  environment_id    String CODEC(ZSTD(1)),

  -- Per-turn attribution
  agent_id          String CODEC(ZSTD(1)),
  thread_id         String CODEC(ZSTD(1)),
  user_id           String CODEC(ZSTD(1)),

  -- OTel identifiers
  trace_id          String CODEC(ZSTD(1)),
  span_id           String CODEC(ZSTD(1)),
  parent_span_id    String CODEC(ZSTD(1)),

  name              LowCardinality(String),
  kind              LowCardinality(String), -- internal | client | server

  -- Timing — keep OTel's native ns precision + derive a DateTime64 for TTL.
  start_ns          UInt64 CODEC(Delta(8), ZSTD(1)),
  end_ns            UInt64 CODEC(Delta(8), ZSTD(1)),
  duration_ms       UInt32 DEFAULT 0,
  start_time        DateTime64(9) MATERIALIZED toDateTime64(start_ns / 1e9, 9),

  status            LowCardinality(String), -- ok | error
  error_message     String DEFAULT '' CODEC(ZSTD(1)),

  -- OTel attributes as JSON string (see comment above re: mixed types).
  attrs             String DEFAULT '{}' CODEC(ZSTD(1)),

  inserted_at       DateTime64(3) DEFAULT now64(3),

  INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_thread_id thread_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_span_id span_id TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(start_time)
ORDER BY (organization_id, project_id, environment_id, thread_id, trace_id, start_ns)
TTL toDateTime(start_time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS trigger_dev.platos_spans_v1;
