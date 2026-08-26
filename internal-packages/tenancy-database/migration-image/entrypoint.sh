#!/bin/sh
set -eu

case "${1:-}" in
  postgres)
    exec pnpm exec prisma migrate deploy --schema /migrations/prisma/schema.prisma
    ;;
  clickhouse)
    : "${GOOSE_DRIVER:?GOOSE_DRIVER is required for ClickHouse migrations}"
    : "${GOOSE_DBSTRING:?GOOSE_DBSTRING is required for ClickHouse migrations}"
    exec goose -dir /migrations/clickhouse up
    ;;
  clickhouse-namespace-rehearsal)
    : "${GOOSE_DRIVER:?GOOSE_DRIVER is required for ClickHouse migrations}"
    : "${GOOSE_DBSTRING:?GOOSE_DBSTRING is required for ClickHouse migrations}"
    exec node /migrations/rehearse-clickhouse-namespace.mjs
    ;;
  memory-profile-dry-run)
    shift
    exec node /migrations/migrate-memory-profiles.mjs memory-profile-dry-run "$@"
    ;;
  memory-profile-bootstrap-empty)
    shift
    exec node /migrations/migrate-memory-profiles.mjs memory-profile-bootstrap-empty "$@"
    ;;
  memory-profile-apply)
    shift
    exec node /migrations/migrate-memory-profiles.mjs memory-profile-apply "$@"
    ;;
  memory-profile-verify)
    shift
    exec node /migrations/migrate-memory-profiles.mjs memory-profile-verify "$@"
    ;;
  *)
    echo "usage: $0 {postgres|clickhouse|clickhouse-namespace-rehearsal|memory-profile-bootstrap-empty|memory-profile-dry-run|memory-profile-apply --digest SHA256|memory-profile-verify}" >&2
    exit 64
    ;;
esac
