-- +goose Up
-- WIN-133 (M3.1) — the turn-shaped analytical projection.
--
-- Thread -> Turn -> Step -> Tool Call, plus an immutable usage ledger. This is
-- the schema docs/observability-model.md specifies; the prose there is the
-- design record and this file is its executable form.
--
-- DATABASE NAME. `platos_observability`, not `trigger_dev`. Nothing in here
-- names a task run, attempt, queue, waitpoint, worker or deployment. External
-- durable execution appears only as the nullable `runtime_provider` /
-- `runtime_run_id` pair, which lets an operator cross-reference a vendor
-- without letting vendor vocabulary define a Platos relationship.
--
-- THIS IS A PROJECTION, NOT A LEDGER OF RECORD. Postgres owns Thread, Turn,
-- Step and ToolCall; budgets, invoices, history and erasure discovery read
-- Postgres and never wait on ClickHouse. Everything here can be rebuilt from
-- Postgres, which is what makes it safe for the sink to be absent.
--
-- IDEMPOTENCE. Ids are application-generated and stable across retries, so
-- ReplacingMergeTree(inserted_at) collapses a replayed delivery to one logical
-- row. Readers that need exact dedup use FINAL; aggregates over money must,
-- because a double-counted retry is a wrong invoice.
--
-- THE COLUMN NAMES ARE AN ERASURE CONTRACT. apps/agent/src/privacy/
-- clickhouse-erasure.ts addresses these tables by `organization_id`,
-- `end_user_id`, `thread_id` and `subject_key_hash`. Renaming any of them does
-- not break a query — it makes `effectiveTable()` report the table
-- unaddressable, and the erasure receipt then says "schema drift" instead of
-- "erased". Adding a NEW plaintext identity column requires adding it to
-- CLICKHOUSE_ERASURE_PLAN and to its negative verification test in the same
-- change. observability-erasure-contract.test.ts asserts this file and that
-- plan still agree.
--
-- NO DEFAULT-BACKED IDENTITY. Verification proves erasure by counting rows
-- where `coalesce(<identity column>, '') != ''`. A MATERIALIZED or non-empty
-- DEFAULT identity column would repopulate itself after the mutation and make
-- that count a lie, so identity columns default to '' or NULL and nothing else.

CREATE DATABASE IF NOT EXISTS platos_observability;

-- One accepted user-to-agent unit of work. One completed Turn is one billable
-- unit; Steps, Tool Calls and retries never increment that count, which is why
-- `billable_unit` is derived from status alone.
CREATE TABLE IF NOT EXISTS platos_observability.turns_v1
(
  organization_id LowCardinality(String),
  project_id LowCardinality(String),
  environment_id String CODEC(ZSTD(1)),
  turn_id UUID,
  thread_id String CODEC(ZSTD(1)),
  agent_id String CODEC(ZSTD(1)),
  agent_version_id String DEFAULT '' CODEC(ZSTD(1)),

  -- Identity, split three ways. `subject_key_hash` is the keyed pseudonymous
  -- join key and survives erasure so aggregates stay continuous.
  -- `end_user_id` is the canonical EndUser id and is cleared. The two plaintext
  -- columns exist only when an entity signed userMeta, expire on their own
  -- after 30 days, and are cleared independently of everything else.
  end_user_id String DEFAULT '' CODEC(ZSTD(1)),
  subject_key_hash String DEFAULT '' CODEC(ZSTD(1)),
  user_display_name Nullable(String) CODEC(ZSTD(1)) TTL toDateTime(completed_at) + INTERVAL 30 DAY,
  user_email Nullable(String) CODEC(ZSTD(1)) TTL toDateTime(completed_at) + INTERVAL 30 DAY,

  trace_id String DEFAULT '' CODEC(ZSTD(1)),
  root_span_id String DEFAULT '' CODEC(ZSTD(1)),
  status Enum8('completed' = 1, 'failed' = 2, 'cancelled' = 3),
  accepted_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  completed_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  duration_ms UInt64,
  step_count UInt32 DEFAULT 0,
  tool_call_count UInt32 DEFAULT 0,
  billable_unit UInt8 MATERIALIZED if(status = 'completed', 1, 0),

  -- `total_input_tokens` is INCLUSIVE of the cache lanes, exactly as the
  -- provider reports it. No aggregate may add the cache counters back.
  total_input_tokens UInt64 DEFAULT 0,
  total_output_tokens UInt64 DEFAULT 0,
  cache_read_input_tokens UInt64 DEFAULT 0,
  cache_write_input_tokens UInt64 DEFAULT 0,
  reasoning_tokens UInt64 DEFAULT 0,

  calculated_cost_usd Decimal(24, 12) DEFAULT 0,
  provider_reported_cost_usd Nullable(Decimal(24, 12)),
  error_code LowCardinality(String) DEFAULT '',
  error_class LowCardinality(String) DEFAULT '',
  runtime_provider LowCardinality(String) DEFAULT '',
  runtime_run_id String DEFAULT '' CODEC(ZSTD(1)),
  inserted_at DateTime64(6, 'UTC') DEFAULT now64(6),

  INDEX idx_turn_thread thread_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_turn_agent agent_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_turn_subject subject_key_hash TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(completed_at)
ORDER BY (organization_id, project_id, environment_id, completed_at, turn_id)
TTL toDateTime(completed_at) + INTERVAL 365 DAY DELETE;
-- Deliberately no `ttl_only_drop_parts`: the plaintext columns above carry
-- their own 30-day TTL, and whole-part dropping skips the per-column
-- materialization those expiries depend on.

-- One model invocation inside a Turn. A Turn with four Steps is still one
-- billable unit; this table is where the four invocations become visible.
CREATE TABLE IF NOT EXISTS platos_observability.steps_v1
(
  organization_id LowCardinality(String),
  project_id LowCardinality(String),
  environment_id String CODEC(ZSTD(1)),
  step_id UUID,
  turn_id UUID,
  thread_id String CODEC(ZSTD(1)),
  agent_id String CODEC(ZSTD(1)),
  end_user_id String DEFAULT '' CODEC(ZSTD(1)),
  subject_key_hash String DEFAULT '' CODEC(ZSTD(1)),
  sequence UInt32,
  provider LowCardinality(String),
  model LowCardinality(String),
  status Enum8('completed' = 1, 'failed' = 2, 'cancelled' = 3),
  started_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  completed_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  duration_ms UInt64,
  trace_id String DEFAULT '' CODEC(ZSTD(1)),
  span_id String DEFAULT '' CODEC(ZSTD(1)),
  parent_span_id String DEFAULT '' CODEC(ZSTD(1)),

  -- fresh = total - cache_read - cache_write. Stored rather than derived so a
  -- reader cannot reconstruct it from a different base and get a different
  -- answer than the one that was billed.
  total_input_tokens UInt64 DEFAULT 0,
  fresh_input_tokens UInt64 DEFAULT 0,
  cache_read_input_tokens UInt64 DEFAULT 0,
  cache_write_input_tokens UInt64 DEFAULT 0,
  output_tokens UInt64 DEFAULT 0,
  reasoning_tokens UInt64 DEFAULT 0,

  -- WIN-125's four independent rates, frozen at write time. Historical cost is
  -- never recomputed from the current catalogue: re-pricing an old Turn with
  -- today's card silently rewrites an invoice that has already been issued.
  pricing_source LowCardinality(String) DEFAULT '',
  pricing_version String DEFAULT '' CODEC(ZSTD(1)),
  fresh_input_usd_per_million Decimal(24, 12) DEFAULT 0,
  cache_read_usd_per_million Decimal(24, 12) DEFAULT 0,
  cache_write_usd_per_million Decimal(24, 12) DEFAULT 0,
  output_usd_per_million Decimal(24, 12) DEFAULT 0,
  fresh_input_cost_usd Decimal(24, 12) DEFAULT 0,
  cache_read_cost_usd Decimal(24, 12) DEFAULT 0,
  cache_write_cost_usd Decimal(24, 12) DEFAULT 0,
  output_cost_usd Decimal(24, 12) DEFAULT 0,
  calculated_cost_usd Decimal(24, 12) DEFAULT 0,
  provider_reported_cost_usd Nullable(Decimal(24, 12)),

  error_code LowCardinality(String) DEFAULT '',
  error_class LowCardinality(String) DEFAULT '',
  error_message_redacted String DEFAULT '' CODEC(ZSTD(1)),
  -- Allow-listed, redacted attributes only. No prompt, no tool arguments, no
  -- tool result, no message body, no credential, no channel handle.
  attributes_json String DEFAULT '{}' CODEC(ZSTD(3)),
  inserted_at DateTime64(6, 'UTC') DEFAULT now64(6),

  INDEX idx_step_turn turn_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_step_trace trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_step_subject subject_key_hash TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, environment_id, turn_id, sequence, step_id)
TTL toDateTime(started_at) + INTERVAL 90 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- One Tool invocation inside a Step. Lifecycle and redacted diagnostics only.
CREATE TABLE IF NOT EXISTS platos_observability.tool_calls_v1
(
  organization_id LowCardinality(String),
  project_id LowCardinality(String),
  environment_id String CODEC(ZSTD(1)),
  tool_call_id UUID,
  step_id UUID,
  turn_id UUID,
  thread_id String CODEC(ZSTD(1)),
  agent_id String CODEC(ZSTD(1)),
  end_user_id String DEFAULT '' CODEC(ZSTD(1)),
  subject_key_hash String DEFAULT '' CODEC(ZSTD(1)),
  sequence UInt32,
  entity_id String DEFAULT '' CODEC(ZSTD(1)),
  tool_id String CODEC(ZSTD(1)),
  tool_name LowCardinality(String),
  -- `denied` is a first-class outcome: a policy refusal is not a failure, and
  -- collapsing the two would hide the approval surface's behaviour.
  status Enum8('completed' = 1, 'failed' = 2, 'cancelled' = 3, 'denied' = 4),
  started_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  completed_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  duration_ms UInt64,
  trace_id String DEFAULT '' CODEC(ZSTD(1)),
  span_id String DEFAULT '' CODEC(ZSTD(1)),
  parent_span_id String DEFAULT '' CODEC(ZSTD(1)),
  retry_count UInt16 DEFAULT 0,
  -- Sizes, never payloads. Enough to find the tool that returns a megabyte.
  request_bytes UInt64 DEFAULT 0,
  response_bytes UInt64 DEFAULT 0,
  error_code LowCardinality(String) DEFAULT '',
  error_class LowCardinality(String) DEFAULT '',
  error_message_redacted String DEFAULT '' CODEC(ZSTD(1)),
  attributes_json String DEFAULT '{}' CODEC(ZSTD(3)),
  inserted_at DateTime64(6, 'UTC') DEFAULT now64(6),

  INDEX idx_tool_call_turn turn_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_tool_call_step step_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_tool_call_subject subject_key_hash TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, environment_id, turn_id, sequence, tool_call_id)
TTL toDateTime(started_at) + INTERVAL 90 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;

-- An immutable charge fact. Retained for seven years because it is financial
-- evidence, which is why erasure UNLINKS the subject here instead of deleting
-- the row: destroying an invoice line to remove a name is the wrong trade.
CREATE TABLE IF NOT EXISTS platos_observability.usage_events_v1
(
  organization_id LowCardinality(String),
  project_id LowCardinality(String),
  environment_id String CODEC(ZSTD(1)),
  usage_event_id UUID,
  -- All three are nullable: background auxiliary work (an extraction, a judge)
  -- belongs to an Agent and Environment and to no Turn at all.
  turn_id Nullable(UUID),
  step_id Nullable(UUID),
  tool_call_id Nullable(UUID),
  thread_id String DEFAULT '' CODEC(ZSTD(1)),
  agent_id String CODEC(ZSTD(1)),
  end_user_id String DEFAULT '' CODEC(ZSTD(1)),
  subject_key_hash String DEFAULT '' CODEC(ZSTD(1)),
  usage_kind Enum8('inference' = 1, 'embedding' = 2, 'extraction' = 3, 'judge' = 4, 'skill' = 5),
  provider LowCardinality(String),
  model LowCardinality(String) DEFAULT '',
  skill_id String DEFAULT '' CODEC(ZSTD(1)),
  tool_name LowCardinality(String) DEFAULT '',
  occurred_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),

  total_input_tokens UInt64 DEFAULT 0,
  fresh_input_tokens UInt64 DEFAULT 0,
  cache_read_input_tokens UInt64 DEFAULT 0,
  cache_write_input_tokens UInt64 DEFAULT 0,
  output_tokens UInt64 DEFAULT 0,
  reasoning_tokens UInt64 DEFAULT 0,

  -- Non-token lanes (embeddings priced per request, skills priced per run)
  -- carry their quantity here and their unit price below.
  input_units Decimal(24, 6) DEFAULT 0,
  output_units Decimal(24, 6) DEFAULT 0,
  unit_type LowCardinality(String) DEFAULT '',

  pricing_source LowCardinality(String),
  pricing_version String CODEC(ZSTD(1)),
  fresh_input_usd_per_million Decimal(24, 12) DEFAULT 0,
  cache_read_usd_per_million Decimal(24, 12) DEFAULT 0,
  cache_write_usd_per_million Decimal(24, 12) DEFAULT 0,
  output_usd_per_million Decimal(24, 12) DEFAULT 0,
  input_unit_price_usd Decimal(24, 12) DEFAULT 0,
  output_unit_price_usd Decimal(24, 12) DEFAULT 0,
  fresh_input_cost_usd Decimal(24, 12) DEFAULT 0,
  cache_read_cost_usd Decimal(24, 12) DEFAULT 0,
  cache_write_cost_usd Decimal(24, 12) DEFAULT 0,
  output_cost_usd Decimal(24, 12) DEFAULT 0,
  calculated_cost_usd Decimal(24, 12),
  provider_reported_cost_usd Nullable(Decimal(24, 12)),

  trace_id String DEFAULT '' CODEC(ZSTD(1)),
  span_id String DEFAULT '' CODEC(ZSTD(1)),
  runtime_provider LowCardinality(String) DEFAULT '',
  runtime_run_id String DEFAULT '' CODEC(ZSTD(1)),
  inserted_at DateTime64(6, 'UTC') DEFAULT now64(6),

  INDEX idx_usage_turn turn_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_usage_subject subject_key_hash TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (organization_id, project_id, environment_id, occurred_at, usage_event_id)
TTL toDateTime(occurred_at) + INTERVAL 7 YEAR DELETE
SETTINGS ttl_only_drop_parts = 1;

-- +goose Down
DROP TABLE IF EXISTS platos_observability.usage_events_v1;
DROP TABLE IF EXISTS platos_observability.tool_calls_v1;
DROP TABLE IF EXISTS platos_observability.steps_v1;
DROP TABLE IF EXISTS platos_observability.turns_v1;
DROP DATABASE IF EXISTS platos_observability;
