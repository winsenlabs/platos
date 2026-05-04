-- +goose Up
-- MC.1 — add Anthropic prompt-cache token columns to the LLM metrics table.
-- These capture the two cache dimensions every Anthropic response returns
-- on the `usage` block:
--   - `cache_creation_input_tokens` → billed at 1.25× input rate (first
--     write of a cacheable prefix; Anthropic holds it for 5 minutes).
--   - `cache_read_input_tokens`     → billed at 0.1× input rate (subsequent
--     requests within the window that hit the same prefix).
--
-- `llm_metrics_v1` already carries a `usage_details Map(LowCardinality(String),
-- UInt64)` column that could technically absorb these, but map access in
-- aggregation queries is expensive + reporting tools struggle to index into
-- it. Promoting the two canonical dimensions to first-class columns makes the
-- monitoring dashboard queries cheap + obvious. Default 0 so existing rows
-- remain valid.
--
-- Platos today writes cost data to Postgres (`PlatosAgentMessage.responseJson`)
-- + Redis (cost:* hashes). This migration adds the columns for the future
-- convergence path where Platos dual-writes into `llm_metrics_v1` alongside
-- the existing trigger.dev writers; the MC.1 ship itself writes cache counters
-- to Postgres + Redis, not here. Keeping the CH columns ready lets us wire
-- Platos into the existing materialized views without a second migration.

ALTER TABLE trigger_dev.llm_metrics_v1
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens UInt64 DEFAULT 0;

ALTER TABLE trigger_dev.llm_metrics_v1
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens UInt64 DEFAULT 0;

-- +goose Down
ALTER TABLE trigger_dev.llm_metrics_v1
  DROP COLUMN IF EXISTS cache_creation_input_tokens;

ALTER TABLE trigger_dev.llm_metrics_v1
  DROP COLUMN IF EXISTS cache_read_input_tokens;
