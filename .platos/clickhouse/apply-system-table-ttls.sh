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

# Each system log table has a slightly different schema. Use
# `IF EXISTS` so we don't fail on tables this build doesn't have, and
# wrap each in its own statement so one failure doesn't abort the rest.
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
    trace_log \
    opentelemetry_span_log; do
  echo "[apply-system-table-ttls] ALTER system.${table}"
  clickhouse-client \
    --host "${CLICKHOUSE_HOST}" \
    --port "${CLICKHOUSE_PORT}" \
    --user "${CLICKHOUSE_USER}" \
    --password "${CLICKHOUSE_PASSWORD}" \
    --query "ALTER TABLE IF EXISTS system.${table} MODIFY TTL event_date + INTERVAL ${TTL_DAYS} DAY DELETE" \
    || echo "[apply-system-table-ttls]   (skipped: table may use a different time column or not exist)"
done

echo "[apply-system-table-ttls] done"
