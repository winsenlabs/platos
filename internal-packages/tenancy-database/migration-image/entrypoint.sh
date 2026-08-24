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
  *)
    echo "usage: $0 {postgres|clickhouse}" >&2
    exit 64
    ;;
esac
