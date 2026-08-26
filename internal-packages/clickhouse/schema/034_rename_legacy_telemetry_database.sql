-- +goose Up
-- WIN-144 / WIN-150: move the inherited analytics namespace without
-- rewriting the 33 migrations that have already been applied in production.
--
-- ClickHouse stores fully-qualified TO and FROM references in materialized-view
-- metadata. RENAME DATABASE does not rewrite those references, so drop only the
-- seven views first and recreate them without POPULATE after the metadata rename.
-- Their destination tables, UUIDs, engines, and existing aggregate rows remain
-- untouched.
DROP VIEW IF EXISTS trigger_dev.mv_task_event_usage_by_minute_v2;
DROP VIEW IF EXISTS trigger_dev.mv_task_event_v2_usage_by_minute;
DROP VIEW IF EXISTS trigger_dev.task_events_search_mv_v1;
DROP VIEW IF EXISTS trigger_dev.errors_mv_v1;
DROP VIEW IF EXISTS trigger_dev.error_occurrences_mv_v1;
DROP VIEW IF EXISTS trigger_dev.llm_model_aggregates_mv_v1;
DROP VIEW IF EXISTS trigger_dev.mv_task_event_usage_by_hour_v1;

RENAME DATABASE trigger_dev TO platos_telemetry;

-- Create the downstream hourly view first so every new minute rollup can flow
-- through the complete chain as soon as its source view is attached.
CREATE MATERIALIZED VIEW platos_telemetry.mv_task_event_usage_by_hour_v1
TO platos_telemetry.task_event_usage_by_hour_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfHour(bucket_start) AS bucket_start,
  sum(event_count) AS event_count
FROM platos_telemetry.task_event_usage_by_minute_v1
GROUP BY organization_id, project_id, environment_id, bucket_start;

CREATE MATERIALIZED VIEW platos_telemetry.mv_task_event_usage_by_minute_v2
TO platos_telemetry.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM platos_telemetry.task_events_v1
WHERE kind != 'DEBUG_EVENT' AND kind != 'ANCESTOR_OVERRIDE' AND status != 'PARTIAL'
GROUP BY organization_id, project_id, environment_id, bucket_start;

CREATE MATERIALIZED VIEW platos_telemetry.mv_task_event_v2_usage_by_minute
TO platos_telemetry.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM platos_telemetry.task_events_v2
WHERE kind != 'DEBUG_EVENT' AND kind != 'ANCESTOR_OVERRIDE' AND status != 'PARTIAL'
GROUP BY organization_id, project_id, environment_id, bucket_start;

CREATE MATERIALIZED VIEW platos_telemetry.task_events_search_mv_v1
TO platos_telemetry.task_events_search_v1 AS
SELECT
  environment_id,
  organization_id,
  project_id,
  trace_id,
  span_id,
  run_id,
  task_identifier,
  start_time,
  inserted_at,
  message,
  kind,
  status,
  duration,
  parent_span_id,
  attributes_text,
  fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)) AS triggered_timestamp
FROM platos_telemetry.task_events_v2
WHERE
  trace_id != ''
  AND kind != 'DEBUG_EVENT'
  AND status != 'PARTIAL'
  AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
  AND kind != 'ANCESTOR_OVERRIDE'
  AND message != 'trigger.dev/start';

CREATE MATERIALIZED VIEW platos_telemetry.errors_mv_v1
TO platos_telemetry.errors_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  any(coalesce(nullIf(toString(error.data.type), ''), nullIf(toString(error.data.name), ''), 'Error')) AS error_type,
  any(coalesce(nullIf(substring(toString(error.data.message), 1, 500), ''), 'Unknown error')) AS error_message,
  any(coalesce(substring(toString(error.data.stack), 1, 2000), '')) AS sample_stack_trace,
  toDateTime(max(created_at)) AS last_seen_date,
  min(created_at) AS first_seen,
  max(created_at) AS last_seen,
  sumState(toUInt64(1)) AS occurrence_count,
  uniqState(task_version) AS affected_task_versions,
  anyState(run_id) AS sample_run_id,
  anyState(friendly_id) AS sample_friendly_id,
  sumMapState([status], [toUInt64(1)]) AS status_distribution
FROM platos_telemetry.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint;

CREATE MATERIALIZED VIEW platos_telemetry.error_occurrences_mv_v1
TO platos_telemetry.error_occurrences_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  toStartOfMinute(created_at) AS minute,
  any(coalesce(nullIf(toString(error.data.type), ''), nullIf(toString(error.data.name), ''), 'Error')) AS error_type,
  any(coalesce(nullIf(substring(toString(error.data.message), 1, 500), ''), 'Unknown error')) AS error_message,
  any(coalesce(substring(toString(error.data.stack), 1, 2000), '')) AS stack_trace,
  count() AS count
FROM platos_telemetry.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  minute;

CREATE MATERIALIZED VIEW platos_telemetry.llm_model_aggregates_mv_v1
TO platos_telemetry.llm_model_aggregates_v1 AS
SELECT
  response_model,
  base_response_model,
  gen_ai_system,
  toStartOfMinute(start_time) AS minute,
  count() AS call_count,
  sum(input_tokens) AS total_input_tokens,
  sum(output_tokens) AS total_output_tokens,
  sum(total_cost) AS total_cost,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(ms_to_first_chunk, ms_to_first_chunk > 0) AS ttfc_quantiles,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(tokens_per_second, tokens_per_second > 0) AS tps_quantiles,
  quantilesState(0.5, 0.9, 0.95, 0.99)(duration) AS duration_quantiles,
  sumMap(map(finish_reason, toUInt64(1))) AS finish_reason_counts
FROM platos_telemetry.llm_metrics_v1
WHERE response_model != ''
GROUP BY response_model, base_response_model, gen_ai_system, minute;

-- +goose Down
-- Recreate the same seven view definitions against the rollback namespace. As
-- above, destination tables are renamed in place and are never dropped.
DROP VIEW IF EXISTS platos_telemetry.mv_task_event_usage_by_minute_v2;
DROP VIEW IF EXISTS platos_telemetry.mv_task_event_v2_usage_by_minute;
DROP VIEW IF EXISTS platos_telemetry.task_events_search_mv_v1;
DROP VIEW IF EXISTS platos_telemetry.errors_mv_v1;
DROP VIEW IF EXISTS platos_telemetry.error_occurrences_mv_v1;
DROP VIEW IF EXISTS platos_telemetry.llm_model_aggregates_mv_v1;
DROP VIEW IF EXISTS platos_telemetry.mv_task_event_usage_by_hour_v1;

RENAME DATABASE platos_telemetry TO trigger_dev;

CREATE MATERIALIZED VIEW trigger_dev.mv_task_event_usage_by_hour_v1
TO trigger_dev.task_event_usage_by_hour_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfHour(bucket_start) AS bucket_start,
  sum(event_count) AS event_count
FROM trigger_dev.task_event_usage_by_minute_v1
GROUP BY organization_id, project_id, environment_id, bucket_start;

CREATE MATERIALIZED VIEW trigger_dev.mv_task_event_usage_by_minute_v2
TO trigger_dev.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM trigger_dev.task_events_v1
WHERE kind != 'DEBUG_EVENT' AND kind != 'ANCESTOR_OVERRIDE' AND status != 'PARTIAL'
GROUP BY organization_id, project_id, environment_id, bucket_start;

CREATE MATERIALIZED VIEW trigger_dev.mv_task_event_v2_usage_by_minute
TO trigger_dev.task_event_usage_by_minute_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  toStartOfMinute(start_time) AS bucket_start,
  count() AS event_count
FROM trigger_dev.task_events_v2
WHERE kind != 'DEBUG_EVENT' AND kind != 'ANCESTOR_OVERRIDE' AND status != 'PARTIAL'
GROUP BY organization_id, project_id, environment_id, bucket_start;

CREATE MATERIALIZED VIEW trigger_dev.task_events_search_mv_v1
TO trigger_dev.task_events_search_v1 AS
SELECT
  environment_id,
  organization_id,
  project_id,
  trace_id,
  span_id,
  run_id,
  task_identifier,
  start_time,
  inserted_at,
  message,
  kind,
  status,
  duration,
  parent_span_id,
  attributes_text,
  fromUnixTimestamp64Nano(toUnixTimestamp64Nano(start_time) + toInt64(duration)) AS triggered_timestamp
FROM trigger_dev.task_events_v2
WHERE
  trace_id != ''
  AND kind != 'DEBUG_EVENT'
  AND status != 'PARTIAL'
  AND NOT (kind = 'SPAN_EVENT' AND attributes_text = '{}')
  AND kind != 'ANCESTOR_OVERRIDE'
  AND message != 'trigger.dev/start';

CREATE MATERIALIZED VIEW trigger_dev.errors_mv_v1
TO trigger_dev.errors_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  any(coalesce(nullIf(toString(error.data.type), ''), nullIf(toString(error.data.name), ''), 'Error')) AS error_type,
  any(coalesce(nullIf(substring(toString(error.data.message), 1, 500), ''), 'Unknown error')) AS error_message,
  any(coalesce(substring(toString(error.data.stack), 1, 2000), '')) AS sample_stack_trace,
  toDateTime(max(created_at)) AS last_seen_date,
  min(created_at) AS first_seen,
  max(created_at) AS last_seen,
  sumState(toUInt64(1)) AS occurrence_count,
  uniqState(task_version) AS affected_task_versions,
  anyState(run_id) AS sample_run_id,
  anyState(friendly_id) AS sample_friendly_id,
  sumMapState([status], [toUInt64(1)]) AS status_distribution
FROM trigger_dev.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint;

CREATE MATERIALIZED VIEW trigger_dev.error_occurrences_mv_v1
TO trigger_dev.error_occurrences_v1 AS
SELECT
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  toStartOfMinute(created_at) AS minute,
  any(coalesce(nullIf(toString(error.data.type), ''), nullIf(toString(error.data.name), ''), 'Error')) AS error_type,
  any(coalesce(nullIf(substring(toString(error.data.message), 1, 500), ''), 'Unknown error')) AS error_message,
  any(coalesce(substring(toString(error.data.stack), 1, 2000), '')) AS stack_trace,
  count() AS count
FROM trigger_dev.task_runs_v2
WHERE
  error_fingerprint != ''
  AND status IN ('SYSTEM_FAILURE', 'CRASHED', 'INTERRUPTED', 'COMPLETED_WITH_ERRORS', 'TIMED_OUT')
  AND _is_deleted = 0
GROUP BY
  organization_id,
  project_id,
  environment_id,
  task_identifier,
  error_fingerprint,
  task_version,
  minute;

CREATE MATERIALIZED VIEW trigger_dev.llm_model_aggregates_mv_v1
TO trigger_dev.llm_model_aggregates_v1 AS
SELECT
  response_model,
  base_response_model,
  gen_ai_system,
  toStartOfMinute(start_time) AS minute,
  count() AS call_count,
  sum(input_tokens) AS total_input_tokens,
  sum(output_tokens) AS total_output_tokens,
  sum(total_cost) AS total_cost,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(ms_to_first_chunk, ms_to_first_chunk > 0) AS ttfc_quantiles,
  quantilesStateIf(0.5, 0.9, 0.95, 0.99)(tokens_per_second, tokens_per_second > 0) AS tps_quantiles,
  quantilesState(0.5, 0.9, 0.95, 0.99)(duration) AS duration_quantiles,
  sumMap(map(finish_reason, toUInt64(1))) AS finish_reason_counts
FROM trigger_dev.llm_metrics_v1
WHERE response_model != ''
GROUP BY response_model, base_response_model, gen_ai_system, minute;
