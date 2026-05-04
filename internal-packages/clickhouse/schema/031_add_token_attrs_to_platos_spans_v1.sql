-- +goose Up
-- PRELAUNCH-A1-6 — promote per-turn token + provider columns from the
-- `attrs` JSON string into first-class columns on `platos_spans_v1`.
--
-- Until this migration, every per-turn token figure (input/output/cache/
-- reasoning) lived inside the `attrs` JSON column on the span row, which
-- forced the dashboards into JSONExtract calls + table scans whenever
-- they wanted to slice cost by provider/model. Promoting these to first-
-- class columns makes "tokens by provider over the last 7 days" a normal
-- aggregate query.
--
-- The dashboard reader (SpansService) keeps reading the same fields off
-- the row payload; the writer (SpansService.record) is updated in the
-- companion code commit to lift these out of the attribute map onto
-- the row before insert.
--
-- Default 0 / '' on every column so existing rows survive the schema
-- change cleanly. New writes populate the columns; legacy rows stay
-- valid but read 0 for every token field (consistent with the previous
-- behaviour where `attrs` lacked the field).

ALTER TABLE trigger_dev.platos_spans_v1
  ADD COLUMN IF NOT EXISTS input_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reasoning_tokens UInt32 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provider LowCardinality(String) DEFAULT '',
  ADD COLUMN IF NOT EXISTS model LowCardinality(String) DEFAULT '';

-- +goose Down
ALTER TABLE trigger_dev.platos_spans_v1
  DROP COLUMN IF EXISTS input_tokens,
  DROP COLUMN IF EXISTS output_tokens,
  DROP COLUMN IF EXISTS cache_read_input_tokens,
  DROP COLUMN IF EXISTS cache_creation_input_tokens,
  DROP COLUMN IF EXISTS reasoning_tokens,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS model;
