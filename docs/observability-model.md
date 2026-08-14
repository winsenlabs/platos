# Platos observability model

Platos observability is **Thread → Turn → Step → Tool Call**. A Trigger task or run may execute work durably, but it is external runtime metadata and never the shape, key, or billing unit of Platos telemetry.

This document defines the target boundary and schema. It does not repair or deploy the current ClickHouse installation.

## Storage decision

**Postgres remains the transactional source of truth; ClickHouse is the optional analytical projection.**

At current scale, Postgres is sufficient for authoritative Thread, Turn, message, approval, artifact, and billing-ledger records. Correctness-critical behavior—budgets, invoices, user-visible history, idempotency, and erasure discovery—must not depend on ClickHouse availability or eventual consistency.

ClickHouse remains the right wired analytical store for high-cardinality Steps, Tool Calls, usage events, trace timelines, and long-window aggregates. The application writes one versioned observability event through a single client boundary; a Postgres outbox guarantees delivery when ClickHouse is configured. With ClickHouse absent, Platos boots and all turns complete. The outbox is retained, metrics and error logs report the unavailable sink loudly, and no write is silently discarded.

The ClickHouse database is `platos_observability`. No table, column, or client API uses `trigger_dev`, task-run, queue, attempt, waitpoint, worker, or deployment vocabulary.

## Event hierarchy

### Thread

A **Thread** is the durable Postgres conversation and parent of Turns. ClickHouse tables carry `thread_id` for analytical joins but do not duplicate mutable thread content.

### Turn

A **Turn** is one accepted user-to-agent unit of work. It begins when Platos accepts an input and ends in `completed`, `failed`, or `cancelled`. It contains zero or more Steps and Tool Calls.

One completed Turn is one billable unit of work. Tool Calls, retries, and model Steps never increment the billable-unit count. A failed Turn that performed chargeable provider work records usage and cost but does not count as completed work.

### Step

A **Step** is one model invocation within a Turn. Each Step records provider/model attribution, status, timing, token lanes, and the immutable prices used for every lane.

### Tool Call

A **Tool Call** is one invocation of a Tool during a Step. It records lifecycle and redacted diagnostics, not arbitrary request/response payloads or secrets.

### Usage event

A **Usage Event** is an immutable charge fact. It covers `inference`, `embedding`, `extraction`, `judge`, and `skill` lanes. It may belong to a Step or Tool Call; background auxiliary work may belong only to an Agent and Environment.

## Cost and token attribution

Every charge row stores both quantity and the exact unit rate used at write time. Historical cost is never recomputed from the current model catalogue.

Inference separates these quantities and prices:

- fresh input tokens and `fresh_input_usd_per_million`;
- cache-read input tokens and `cache_read_usd_per_million`;
- cache-write input tokens and `cache_write_usd_per_million`;
- output tokens and `output_usd_per_million`;
- reasoning tokens, recorded separately even when included in provider output billing.

Cache-read tokens are a subset of total provider input. `fresh_input_tokens = total_input_tokens - cache_read_input_tokens - cache_write_input_tokens`; no aggregate adds cache counters back to total input. Cache multipliers are materialized into the corresponding unit rates, including providers whose writes cost more than fresh input.

All money columns use `Decimal(24, 12)` US dollars. The writer calculates each lane independently, sums without per-row cent rounding, and stores:

- the catalogue/provider/version that supplied the rates;
- each unit rate;
- each extended lane cost;
- calculated total cost; and
- provider-reported cost when available.

Invoices and budgets consume the immutable Postgres usage ledger. ClickHouse projects the same event IDs and values for analysis; it is not a second calculator.

## Identity and privacy

Analytical rows carry:

- `subject_key_hash`: a keyed, stable pseudonymous subject key used by erasure discovery;
- `end_user_id`: the Platos canonical EndUser ID, nullable for system work;
- `user_display_name` and `user_email`: nullable plaintext convenience fields; and
- no raw channel handle, provider credential, prompt, tool arguments, tool result, or message body.

The hash is not anonymous data. It remains personal data because it is linkable through Platos, but retaining it after plaintext erasure preserves aggregate continuity. The HMAC key is versioned and separate from admin/authentication secrets.

Free-form attributes pass an allow-list and redaction boundary before insertion. Identity-bearing attributes are forbidden; adding a new plaintext identity column requires adding it to the erasure mutation and its negative verification test in the same change.

### Hard erasure

Given all subject aliases discovered before Postgres identity deletion, the ClickHouse executor performs mutations in this order:

```sql
ALTER TABLE platos_observability.turns_v1
  UPDATE end_user_id = '', user_display_name = NULL, user_email = NULL
  WHERE organization_id = {organization_id:String}
    AND subject_key_hash IN {subject_hashes:Array(String)};

ALTER TABLE platos_observability.steps_v1
  UPDATE end_user_id = ''
  WHERE organization_id = {organization_id:String}
    AND subject_key_hash IN {subject_hashes:Array(String)};

ALTER TABLE platos_observability.tool_calls_v1
  UPDATE end_user_id = ''
  WHERE organization_id = {organization_id:String}
    AND subject_key_hash IN {subject_hashes:Array(String)};

ALTER TABLE platos_observability.usage_events_v1
  UPDATE end_user_id = ''
  WHERE organization_id = {organization_id:String}
    AND subject_key_hash IN {subject_hashes:Array(String)};
```

After each mutation reports complete, verification queries assert zero non-empty `end_user_id`, `user_display_name`, and `user_email` values for the subject hashes. The salted/HMAC subject hash and non-identifying aggregate facts remain. A mutation that is queued, incomplete, unverified, or pointed at an unavailable store yields a pending/failed receipt, never success.

If policy requires unlinkability rather than pseudonymization, a second mutation replaces `subject_key_hash` with `HMAC(erasure_operation_id, old_hash)` after verification. Legal holds are checked before any mutation.

## Retention

| Data | Retention | Reason |
| --- | ---: | --- |
| Turn summaries | 365 days | Billing audit, budgets, and longitudinal reliability. |
| Usage events and immutable unit rates | 7 years | Financial audit period; tenant policy may shorten where legally allowed. |
| Step detail | 90 days | Model debugging and trace analysis. |
| Tool Call detail | 90 days | Tool reliability and security investigation. |
| Plaintext display name/email | 30 days maximum | Debugging convenience only; nullable and erasable. |
| Postgres transactional Threads/Turns/messages | Tenant retention policy | Authoritative product data, independent of ClickHouse TTL. |
| Delivery outbox | Until acknowledged, then 7 days | Prevent silent loss and support replay/debugging. |

TTL deletes are partition-aligned where possible. Tenant-specific shorter retention is implemented by scheduled bounded deletes and recorded policy execution, not by pretending one table TTL can differ per tenant.

## ClickHouse DDL

The schema is deliberately explicit and versioned. IDs are application-generated UUIDs; retries insert the same ID. `ReplacingMergeTree(inserted_at)` provides idempotent eventual projection, while queries use `FINAL` only where exact deduplication is required.

```sql
CREATE DATABASE IF NOT EXISTS platos_observability;

CREATE TABLE IF NOT EXISTS platos_observability.turns_v1
(
  organization_id LowCardinality(String),
  project_id LowCardinality(String),
  environment_id String CODEC(ZSTD(1)),
  turn_id UUID,
  thread_id String CODEC(ZSTD(1)),
  agent_id String CODEC(ZSTD(1)),
  agent_version_id String DEFAULT '' CODEC(ZSTD(1)),
  end_user_id String DEFAULT '' CODEC(ZSTD(1)),
  subject_key_hash String DEFAULT '' CODEC(ZSTD(1)),
  user_display_name Nullable(String) CODEC(ZSTD(1)),
  user_email Nullable(String) CODEC(ZSTD(1)),
  trace_id String DEFAULT '' CODEC(ZSTD(1)),
  root_span_id String DEFAULT '' CODEC(ZSTD(1)),
  status Enum8('completed' = 1, 'failed' = 2, 'cancelled' = 3),
  accepted_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  completed_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  duration_ms UInt64,
  step_count UInt32 DEFAULT 0,
  tool_call_count UInt32 DEFAULT 0,
  billable_unit UInt8 MATERIALIZED if(status = 'completed', 1, 0),
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
  total_input_tokens UInt64 DEFAULT 0,
  fresh_input_tokens UInt64 DEFAULT 0,
  cache_read_input_tokens UInt64 DEFAULT 0,
  cache_write_input_tokens UInt64 DEFAULT 0,
  output_tokens UInt64 DEFAULT 0,
  reasoning_tokens UInt64 DEFAULT 0,
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
  attributes_json String DEFAULT '{}' CODEC(ZSTD(3)),
  inserted_at DateTime64(6, 'UTC') DEFAULT now64(6),
  INDEX idx_step_turn turn_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_step_trace trace_id TYPE bloom_filter(0.001) GRANULARITY 1,
  INDEX idx_step_subject subject_key_hash TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (organization_id, project_id, environment_id, turn_id, sequence, step_id)
TTL toDateTime(started_at) + INTERVAL 90 DAY DELETE;

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
  status Enum8('completed' = 1, 'failed' = 2, 'cancelled' = 3, 'denied' = 4),
  started_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  completed_at DateTime64(6, 'UTC') CODEC(Delta(8), ZSTD(1)),
  duration_ms UInt64,
  trace_id String DEFAULT '' CODEC(ZSTD(1)),
  span_id String DEFAULT '' CODEC(ZSTD(1)),
  parent_span_id String DEFAULT '' CODEC(ZSTD(1)),
  retry_count UInt16 DEFAULT 0,
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
TTL toDateTime(started_at) + INTERVAL 90 DAY DELETE;

CREATE TABLE IF NOT EXISTS platos_observability.usage_events_v1
(
  organization_id LowCardinality(String),
  project_id LowCardinality(String),
  environment_id String CODEC(ZSTD(1)),
  usage_event_id UUID,
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
TTL toDateTime(occurred_at) + INTERVAL 7 YEAR DELETE;
```

## Client and delivery boundary

One `ObservabilitySink` interface owns projection writes:

```ts
interface ObservabilitySink {
  writeTurn(event: TurnObserved): Promise<void>;
  writeStep(event: StepObserved): Promise<void>;
  writeToolCall(event: ToolCallObserved): Promise<void>;
  writeUsage(event: UsageObserved): Promise<void>;
  health(): Promise<{ configured: boolean; available: boolean; detail: string }>;
}
```

The runtime commits authoritative Postgres state and an outbox event in one transaction. A bounded worker delivers to ClickHouse and marks the event acknowledged. Behavior is explicit:

- unconfigured: startup logs `observability sink=disabled`; product behavior remains available;
- configured and healthy: delivery proceeds and lag/error metrics are emitted;
- configured and unavailable: startup and each bounded retry window log at warn/error, health reports degraded, and events remain in the outbox;
- outbox capacity pressure: reject additional observability projection work loudly while preserving the authoritative Turn; never report a successful projection and never evict unacknowledged events silently;
- reads: analytical screens return a clear unavailable/degraded state, not an empty success response that looks like zero activity.

Credentials and URLs are read through configuration at call/reconnect time so rotation does not require rebuilding. The client never prints credentials. ClickHouse is not a required Docker Compose service for Platos.

## What Platos does not need from Trigger's event model

Platos does not model:

- task runs or task identifiers;
- run attempts;
- background workers, worker deployments, or promotions;
- queues or queue concurrency;
- waitpoints or checkpoints;
- deployed code versions;
- run replication or realtime run chunks; or
- Trigger's generic task-event attribute namespace.

External durable execution correlation is limited to nullable `runtime_provider` and `runtime_run_id`. Those columns help an operator cross-reference the vendor without allowing vendor vocabulary to define Platos relationships, billing, routes, or UI labels.

## Migration and verification constraints

This is a clean-slate schema: no historical ClickHouse data is migrated. Existing `trigger_dev.platos_spans_v1`, `llm_metrics_v1`, task-event tables, and their current breakage are not repaired by this work.

Implementation verification must prove:

1. Platos boots and completes direct Turns with no ClickHouse configuration.
2. A configured-but-unreachable sink leaves durable outbox rows, emits visible degraded health/logs, and does not fail the Turn.
3. Replaying an event ID produces one logical analytical row.
4. A completed Turn yields `billable_unit = 1` regardless of Step or Tool Call count.
5. Cache lanes sum correctly without double-counting total input, and changing the current catalogue does not change historical cost.
6. Hard erasure removes all plaintext identity and canonical end-user IDs, waits for mutations, and verifies zero survivors.
7. Queries are scope-filtered by Organization, Project, and Environment before execution.

Per project instruction, these paths are wired and compiled without standing up ClickHouse locally. Criteria requiring a running ClickHouse remain blocked until a separate approved integration environment exists.
