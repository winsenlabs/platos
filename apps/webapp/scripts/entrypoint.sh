#!/bin/sh
set -xe

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

if [ -n "$CLICKHOUSE_URL" ] && [ "$SKIP_CLICKHOUSE_MIGRATIONS" != "1" ]; then
  # Run ClickHouse migrations
  echo "Running ClickHouse migrations..."
  export GOOSE_DRIVER=clickhouse
  
  # Ensure secure=true is in the connection string
  if echo "$CLICKHOUSE_URL" | grep -q "secure="; then
    # secure parameter already exists, use as is
    export GOOSE_DBSTRING="$CLICKHOUSE_URL"
  elif echo "$CLICKHOUSE_URL" | grep -q "?"; then
    # URL has query parameters, append secure=true
    export GOOSE_DBSTRING="${CLICKHOUSE_URL}&secure=true"
  else
    # URL has no query parameters, add secure=true
    export GOOSE_DBSTRING="${CLICKHOUSE_URL}?secure=true"
  fi
  
  export GOOSE_MIGRATION_DIR=/platos/internal-packages/clickhouse/schema
  /usr/local/bin/goose up
  echo "ClickHouse migrations complete."
elif [ "$SKIP_CLICKHOUSE_MIGRATIONS" = "1" ]; then
  echo "SKIP_CLICKHOUSE_MIGRATIONS=1, skipping ClickHouse migrations."
else
  echo "CLICKHOUSE_URL not set, skipping ClickHouse migrations."
fi

cd /platos/apps/webapp

# The policy wrapper applies WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB (1536 MiB by
# default) and refuses values that would leave less than 25% / 512 MiB of the
# effective cgroup limit for native memory, buffers, and request handling.
NODE_PATH='/platos/node_modules/.pnpm/node_modules' \
  exec dumb-init node /platos/scripts/memory-policy.mjs runtime -- node ./build/server.js

