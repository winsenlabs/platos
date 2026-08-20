# Platos observability model

Platos observability is **Thread → Turn → Step → Tool Call**. A Trigger task or run may execute work durably, but it is external runtime metadata and never the shape, key, or billing unit of Platos telemetry.

This document defines the target boundary and schema. It does not repair or deploy the current ClickHouse installation.

## Storage decision

**Decision: Postgres carries observability at Platos's current scale. ClickHouse is wired, optional, and off by default.**

This is the question WIN-133 was asked to settle explicitly, and the answer is not "ClickHouse, eventually" — it is "Postgres now, ClickHouse when a number says so."

### Why not ClickHouse today

Two datastores is a real operational cost, and Platos has already paid it once without getting anything back: the existing `trigger_dev` span pipeline has been broken in production and nothing said so (WIN-150). A second store that no one is watching is worse than no second store, because it converts a visible gap into an invisible one.

At current volume the analytical questions Platos actually asks — cost by model, by agent, by user, over a day or a month — are aggregations over thousands of `Step` rows, not billions. Postgres answers them with an index. ClickHouse's advantage begins where a scan stops fitting in a query budget, and Platos is not there.

Meanwhile, the things that must never be wrong — budgets, invoices, user-visible history, idempotency, and erasure discovery — are exactly the things that must not depend on an eventually consistent replica. Those stay in Postgres regardless of what else exists.

### What was built instead

The projection is defined, wired end to end, and disabled unless an operator configures an endpoint:

- the DDL is committed (`internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql`);
- one `ObservabilitySink` boundary owns every write, and re-resolves its endpoint per call so credentials rotate without a restart;
- `ObservabilityOutbox` is a Postgres table written in the same transaction that finalizes a Turn;
- a startup probe reports, at error level, when a configured endpoint is unreachable or missing its schema.

With no endpoint configured, Platos boots, every turn completes, and **nothing is queued at all**. That last part is deliberate: Postgres already holds every fact the projection contains, so queueing for a store that does not exist would accumulate rows forever in exchange for nothing. The projection can be rebuilt from `Turn`/`Step`/`ToolCall` on the day a store is provisioned. Not writing is the honest option here, and it is why the disabled path costs a boolean instead of a table.

### The trigger that flips this decision

Adopt ClickHouse when one of these is true, not before:

- a single environment's `Step` table passes roughly 50 million rows, or the monitoring page's aggregate queries stop returning inside a second;
- retention requirements force `Step`/`ToolCall` detail to be kept longer than Postgres can hold cheaply;
- someone is on the hook for watching it. A store nobody monitors is the failure this decision is a reaction to.

Until then `platos_observability` exists as schema and as code paths, and is not part of any Compose stack.

### Naming

The ClickHouse database is `platos_observability`. No table, column, or client API uses `trigger_dev`, task-run, queue, attempt, waitpoint, worker, or deployment vocabulary. `observability-erasure-contract.test.ts` enforces this against the committed DDL.

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

## The usage ledger (WIN-134)

`apps/agent/src/monitoring/usage-ledger.ts` is the one module that owns task counting, token totals, cost, the cache split and the per-lane breakdown. Every reporting surface imports from it and does no arithmetic of its own — the usage page, the monitoring endpoints, budget enforcement, per-agent and per-skill rollups, the canary comparison, and the `monitoring.cost.*` MCP tools.

It exists because twelve surfaces each re-derived "cost for this period" from a slightly different field, and each was arithmetically defensible on its own terms. That is why nobody caught it: the failure was not that one surface was wrong, it was that they disagreed.

### Rules the module enforces

- **A task is one completed Turn.** Not a model call, not a tool call, not a message. The rollups carry a `tasks` field bumped once per completed turn and by nothing else. `calls` still counts model invocations and is reported separately — reading `calls` as a task count is the original "Walle ran 322 tasks this week" bug, and auxiliary work (embeddings, compaction, thread auto-naming) bumps it too.
- **Cost is the cache-aware figure, always.** `billableCostCents` prefers `cost_with_cache_cents` and falls back to `cost_cents` only when no cache-adjusted figure exists at all. A zero cache-adjusted figure is genuinely zero and must not fall back. Budget enforcement reads through this rule; it previously parsed `cost_cents` directly and enforced against a number understated by 10x (2.47c against 25.70c measured on 2026-07-31).
- **Every writer writes both cost fields.** Since WIN-125 they carry the same four-rate figure. `recordAuxiliaryCost` and `recordSkillUsage` previously bumped only the naive field, so the cache-aware total excluded every embedding, extraction and skill call in the window.
- **`inputTokens` is inclusive of the cache slice.** `freshInputTokens` is the only subtraction of the cache lanes anywhere. It was being computed at three call sites against three different bases, which is how one turn reported "no-cache tokens 3" on one panel and "9" on another.
- **`inference` is the residual lane.** `embedding`, `extraction`, `judge` and `skill` are tagged at write time; inference is whatever the billable total is not. A residual cannot disagree with the headline; five independently-summed lanes can and eventually will. Untagged auxiliary kinds (compaction, thread auto-naming, route preflight) land in inference rather than vanishing.
- **Round once, at the end, at 0.0001c.** Rounding per row loses sub-cent turns entirely, and cheap models produce a lot of those.

### Known attribution gaps

- **Skill spend has no per-user attribution.** `recordSkillUsage` carries an agent and a thread but no user, so a per-user total is the scope total minus the skill lane. `usage-ledger-cross-surface.test.ts` asserts the exact gap rather than leaving it to be rediscovered.
- **Auxiliary lane tags are not written to the per-user rollup.** Per-user lane splits therefore read as all-inference. The per-scope and per-agent splits are complete.
- **Auxiliary spend has no agent.** `recordAuxiliaryCost` is called without an `agentId` by `EmbeddingService`, so embedding cents land in `cost:scope:*` and in no `cost:agent:*` key. A per-agent total is therefore always less than the scope total, by exactly the un-agented auxiliary spend. Surfaces must read the scope window for "what did this environment cost" and never sum the per-agent rows: that was the environment overview's Spend tile disagreeing with the Spend/day chart twelve lines below it.

Two gaps that used to be here are closed:

- Sub-agent model calls now persist as additional `Step` rows on the parent's `Turn`, priced at the sub-agent's own model and rates. They previously reached Redis and no Postgres row, so a day Redis still held reported more than the same day rebuilt from the ledger, and `reconcileFromPostgres` restored a lost day permanently short.
- Reconciled rollups now carry `tasks`, counted as distinct completed Turns. A rebuilt hash used to carry real cost and zero tasks, which under-reported the task card, `monitoring.cost.daily`/`.range` and any turns-limit budget cap for every reconciled day.

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

**The committed schema is `internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql`.** It is that file, not this block, that ships. Two things there go beyond what is reproduced below:

- `user_display_name` and `user_email` carry a 30-day column TTL, implementing the retention table above. Column TTL resets to the column default, which for a `Nullable(String)` is `NULL` — so an expired value still reads as absent to the erasure residue check.
- `turns_v1` deliberately omits `ttl_only_drop_parts`, because dropping whole parts skips the per-column materialization those expiries depend on. The other three tables set it, since they have no column TTL.

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

One `ObservabilitySink` interface owns projection writes (`apps/agent/src/observability/observability-sink.ts`):

```ts
interface ObservabilitySink {
  writeTurn(event: TurnObserved): Promise<void>;
  writeStep(event: StepObserved): Promise<void>;
  writeToolCall(event: ToolCallObserved): Promise<void>;
  writeUsage(event: UsageObserved): Promise<void>;
  /** Batched form the outbox drain uses; the four above are its one-row case. */
  writeRows(rows: ObservabilityRows): Promise<void>;
  health(): Promise<ObservabilitySinkHealth>;
}
```

Nothing else in the agent holds a ClickHouse client for observability. In particular this does **not** go through `@internal/clickhouse`: every one of that package's consumers is Trigger's task-run and run-replication machinery, and importing it would tie this projection's availability to a pipeline that is currently broken.

### Where the outbox row is written

`ConversationService.storeMessage` calls `ObservabilityService.enqueueTurnBestEffort` **inside the same `prisma.$transaction`** that updates the `Turn` and creates its `Step` and `ToolCall` rows. Either both commit or neither does. `failTurn` does the same for the failed path, so a Turn that spent money without completing is still projected — with `status = 'failed'`, which keeps `billable_unit` at zero while the cost stays visible.

Attaching this to the span path instead would put it behind `PLATOS_OTEL_SAMPLE_RATE`, and a sampled projection reconciled against an unsampled ledger never agrees.

`ObservabilityOutbox.turnId` has an `ON DELETE CASCADE` foreign key to `Turn`. That is a privacy control, not a tidiness one: erasure deletes the subject's Threads and Turns, and an undelivered row surviving that would project a just-erased identity into ClickHouse *after* the erasure mutation had run and been verified.

The cascade is not sufficient on its own, because it only fires when the **Postgres** executor runs — and the execution order is `minio, redis, clickhouse, postgres`. ClickHouse is mutated, polled to `is_done` and negatively verified while the outbox rows still exist, and a Postgres transaction that fails leaves the cascade unrun while the ClickHouse outcome is already settled (retry re-runs Postgres only; it never re-sweeps ClickHouse). So the drain also consults the **erased-subject register** before delivering, and destroys — rather than delivers — any queued projection whose `end_user_id` has been sealed. Fail-closed: a register that cannot be consulted refuses the whole pass, leaving rows `PENDING`.

The projection's plaintext `user_display_name` / `user_email` come from `scope.signedUserMeta`, which the auth layer sets only from a validated entity JWT's `userMeta`. They are deliberately **not** read from `scope.sessionContext.user`: that bag is the prompt-substitution surface, merged by turn time with the Thread row and with a base layer read out of the Postgres `User` table, and on the operator path `scope.userId` is a Platos `User.id` — so sourcing identity from it stamped the operator's own name and email onto every dashboard turn, a class of identity the erasure sweep addresses only by end-user key and can never reach.

### The four states, and what each one does

| State | Startup log | Turns | Outbox |
| --- | --- | --- | --- |
| `disabled` — no endpoint variable set | `log` | complete | **nothing queued** |
| `misconfigured` — set, not a usable http(s) URL | `error` | complete | queued, retained |
| `unreachable` — set, endpoint does not answer | `warn` | complete | queued, retained |
| `schema_missing` — reachable, tables absent | `error` | complete | queued, retained |
| `ready` | `log` | complete | queued and delivered |

`disabled` and `schema_missing` are deliberately different words. The first is a choice; the second is a deployment that believes it has an analytical store and does not. Reporting the second as the first is how the previous pipeline stayed broken without anyone being told.

Startup never throws by default — the product must run with no analytical store. `PLATOS_OBSERVABILITY_REQUIRE_SINK=true` converts a non-`ready` sink into a boot failure for a deployment that has decided losing analytics is not acceptable.

### Delivery, retry, and parking

`platos.observability.dlq_drain` runs every five minutes and POSTs to `/api/v1/agent/monitoring/dlq/drain`, which drains two queues and reports them separately: the legacy Redis span DLQ (best-effort, drops its oldest entries under pressure) and `ObservabilityOutbox` (durable, drops nothing).

One call is a **loop**, not a single read: it keeps claiming batches of `PLATOS_OBSERVABILITY_DRAIN_BATCH_SIZE` until the queue is empty, `PLATOS_OBSERVABILITY_DRAIN_MAX_ROWS` are delivered, or a 45-second deadline passes. Delivery throughput is (rows per call) × (calls per hour) and has to exceed the rate turns are produced, or the queue only grows — a single 500-row read on an hourly schedule capped delivery at 500 projections an hour, and `prune` only deletes `DELIVERED` rows, so anything busier accumulated a backlog no healthy sink could work off.

Every summary carries the **queue depth after the pass**, and the scheduled task reports from that rather than from what the pass happened to park: `parked` counts rows parked during one pass, so a row parked at 09:00 used to be announced once and never again. `GET /api/v1/agent/monitoring/observability/status` (internal-auth) returns sink health, queue depth and the table list on demand.

A drain that **throws** is reported as `failure`, not `skipped`, and the scheduled run fails. `skipped` is the honest answer for an absent or unreachable sink — a state the runtime is designed for, logged at warn — and folding a thrown drain into it made a pass failing every hour indistinguishable from a deployment that has no ClickHouse.

A delivery either succeeds, is rescheduled with exponential back-off from 30 seconds capped at an hour, or is **parked** as `FAILED`. Parking is the loud version of giving up; giving up quietly is the failure mode this design replaced. A payload the current writer cannot interpret — wrong shape, or a `payloadVersion` from a newer writer — is parked immediately rather than retried, because a shape mismatch does not heal with time. Only `DELIVERED` rows are pruned, after seven days. A `PENDING` or `FAILED` row is never removed by age.

Retries are idempotent three ways over: the same `turnId` upserts one outbox row, `insert_deduplicate=1` discards an identical re-POST server-side, and `ReplacingMergeTree` collapses whatever lands twice outside that window.

### Configuration

Endpoint variables, in precedence order:

1. `PLATOS_OBSERVABILITY_CLICKHOUSE_URL`
2. `PLATOS_OTEL_CLICKHOUSE_URL`
3. `CLICKHOUSE_URL`

`apps/agent/src/privacy/clickhouse.ts` reads the same list, in the same order, from its own copy — the erasure module must not import the runtime that produces the data it destroys. A writer pointing at a store the eraser never probes is a store that quietly retains erased people, so `observability-erasure-contract.test.ts` pins the two resolutions equal by running both over the same environments, including the one that matters: Compose passes an unset variable through as the **empty string**, so precedence must be decided by a truthiness loop and never by a `??` chain, which accepts `""` as a value and resolves to it.

Credentials are read at call time so rotation does not require a restart, and travel in a `Authorization: Basic` header because Node's `fetch` refuses a URL carrying credentials. The client never prints credentials, and never lets a ClickHouse error body escape: those bodies quote the failing statement, and a failing `INSERT` quotes the rows. Only the HTTP status and the numeric `Code: <n>` survive.

ClickHouse is not a Docker Compose service for Platos, in any environment.

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

| # | Criterion | Status |
| --- | --- | --- |
| 1 | Platos boots and completes direct Turns with no ClickHouse configuration. | **Verified.** Nothing is queued and no call is made; `observability.service.test.ts`, `clickhouse-observability-sink.test.ts`. |
| 2 | A configured-but-unreachable sink leaves durable outbox rows, emits visible degraded health/logs, and does not fail the Turn. | **Verified** against a scripted transport and a real in-memory outbox enforcing the migration's constraints. |
| 3 | Replaying an event ID produces one logical analytical row. | **Partly verified.** The three mechanisms are exercised — outbox upsert on `turnId`, `insert_deduplicate=1` on the request, derived-stable `usage_event_id`. That `ReplacingMergeTree` then collapses the row is a ClickHouse behaviour and is **blocked** on a live instance. |
| 4 | A completed Turn yields `billable_unit = 1` regardless of Step or Tool Call count. | **Structurally guaranteed, not end-to-end verified.** The column is `MATERIALIZED` from `status`, and the writer is asserted never to emit it, so no writer can disagree with it. Observing the value requires a live instance. |
| 5 | Cache lanes sum correctly without double-counting total input, and changing the current catalogue does not change historical cost. | **Verified.** `resolveLanes` keeps cache a subset of input and clamps a provider over-report; rates are copied from the Step's frozen snapshot and no catalogue is consulted. |
| 6 | Hard erasure removes all plaintext identity and canonical end-user IDs, waits for mutations, and verifies zero survivors. | **Contract verified, execution blocked.** `observability-erasure-contract.test.ts` proves the DDL is addressable by `CLICKHOUSE_ERASURE_PLAN`, that only `turns_v1` declares plaintext identity, and that no identity column is `MATERIALIZED` or non-empty-defaulted. Running the mutation needs a live instance. |
| 7 | Queries are scope-filtered by Organization, Project, and Environment before execution. | **Structural.** All four tables lead their `ORDER BY` with the scope tuple, and every row the writer emits carries all three. There are no read paths yet — M3.1 ships the write side. |

Per project instruction, these paths are wired and compiled without standing up ClickHouse locally, and ClickHouse is not added to any Compose stack. Criteria marked blocked above require a running instance and a separate approved integration environment.

### Known gaps at the end of M3.1

- **Steps are still one-per-Turn.** `ConversationService.storeMessage` writes exactly one `Step` per assistant turn (`sequence: 1`), collapsing a multi-step turn into a single row. The schema and the projection both handle N steps correctly; the Postgres write path does not yet produce them. Until it does, `steps_v1` and `turns_v1` carry the same token totals.
- **Only the `inference` usage lane is routed into the ClickHouse projection.** Each projected `Step` emits one `inference` usage event. The `embedding`, `extraction`, `judge` and `skill` lanes are produced by `CostService.recordAuxiliaryCost` and `recordSkillUsage` and are not wired to the projection yet. They ARE accounted for in the Redis/Postgres usage ledger and appear in the per-lane breakdown described above; it is only the analytical projection that does not carry them.
- **No read surface consumes the projection.** `TraceService` and the monitoring endpoints still read Postgres and Redis. Nothing degrades, because nothing depends on the projection yet.
- **The legacy `trigger_dev.platos_spans_v1` pipeline is untouched.** Its breakage is WIN-150 and is explicitly out of scope here.
