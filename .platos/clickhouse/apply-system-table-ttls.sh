#!/bin/sh
# Apply 7-day TTL to ClickHouse's *own* system log tables.
#
# Why this exists (2026-05-19 outage post-mortem): a week of write churn
# drove `system.metric_log` to 1.2 M rows / ~300 MiB across 108 unmerged
# parts. When a single merge needed more memory than the container's
# `mem_limit`, the server got OOM-killed and lost merge progress —
# 523 restarts in 12 days. The 4 GiB `mem_limit` bump gives years of
# headroom, but TTL is the durable fix: nothing accumulates forever.
#
# Runs as a one-shot sidecar via docker-compose, depends on the
# clickhouse service being healthy. Idempotent — `ALTER TABLE ...
# MODIFY TTL` is a no-op when the TTL is already set to the same value.
#
# We use SQL `ALTER TABLE` rather than the `<engine>` override XML
# approach because:
#   1. SQL is portable across ClickHouse versions; the XML schema for
#      system-log overrides changes between releases (caught us once
#      already — see the .disabled file in this directory).
#   2. SQL retroactively applies TTL to tables that already exist
#      (the XML config only sets defaults for tables yet to be
#      created — useless on an upgraded install).
set -e

: "${CLICKHOUSE_HOST:=clickhouse}"
: "${CLICKHOUSE_PORT:=9000}"
: "${CLICKHOUSE_USER:=default}"
: "${TTL_DAYS:=7}"

echo "[apply-system-table-ttls] target=${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT} ttl=${TTL_DAYS}d"

# Each system log table has a slightly different schema. We can't use
# `ALTER TABLE IF EXISTS` — ClickHouse rejects that form on MODIFY TTL —
# so each ALTER runs in its own statement and the shell `||` swallows
# failures (UNKNOWN_TABLE when the table isn't enabled on this build,
# or column-mismatch when a table uses a non-default time column).
run_alter() {
  table="$1"
  time_col="${2:-event_date}"
  echo "[apply-system-table-ttls] ALTER system.${table} (TTL on ${time_col})"
  clickhouse-client \
    --host "${CLICKHOUSE_HOST}" \
    --port "${CLICKHOUSE_PORT}" \
    --user "${CLICKHOUSE_USER}" \
    --password "${CLICKHOUSE_PASSWORD}" \
    --query "ALTER TABLE system.${table} MODIFY TTL ${time_col} + INTERVAL ${TTL_DAYS} DAY DELETE" \
    2>&1 | grep -v "^$" || echo "[apply-system-table-ttls]   (skipped: table may not exist on this build)"
}

# Tables that use `event_date` as the time column (the common case).
for table in \
    metric_log \
    asynchronous_metric_log \
    query_log \
    query_metric_log \
    query_thread_log \
    latency_log \
    error_log \
    processors_profile_log \
    part_log \
    text_log \
    trace_log; do
  run_alter "${table}"
done

# `opentelemetry_span_log` uses `finish_date` instead of `event_date`
# (the row is dated when the span finishes, not when the event starts).
run_alter "opentelemetry_span_log" "finish_date"

echo "[apply-system-table-ttls] done"
