#!/bin/sh
set -xe

if [ -n "$DATABASE_HOST" ]; then
  scripts/wait-for-it.sh ${DATABASE_HOST} -- echo "database is up"
fi

if [ "$SKIP_POSTGRES_MIGRATIONS" != "1" ]; then
  echo "Running prisma migrations"
  pnpm --filter @platos/database db:migrate:deploy
  echo "Prisma migrations done"
else
  echo "SKIP_POSTGRES_MIGRATIONS=1, skipping Postgres migrations."
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
  
  export GOOSE_MIGRATION_DIR=/triggerdotdev/internal-packages/clickhouse/schema
  /usr/local/bin/goose up
  echo "ClickHouse migrations complete."
elif [ "$SKIP_CLICKHOUSE_MIGRATIONS" = "1" ]; then
  echo "SKIP_CLICKHOUSE_MIGRATIONS=1, skipping ClickHouse migrations."
else
  echo "CLICKHOUSE_URL not set, skipping ClickHouse migrations."
fi

# Copy over required prisma files
cp internal-packages/database/prisma/schema.prisma apps/webapp/prisma/
# @prisma/engines isn't in the prod image (devDep); the client has its own
# engine binary in the generated dir which is already on the module path.
cp node_modules/@prisma/engines/*.node apps/webapp/prisma/ 2>/dev/null || true

cd /triggerdotdev/apps/webapp

# The policy wrapper applies WEBAPP_NODE_MAX_OLD_SPACE_SIZE_MB (1536 MiB by
# default) and refuses values that would leave less than 25% / 512 MiB of the
# effective cgroup limit for native memory, buffers, and request handling.
NODE_PATH='/triggerdotdev/node_modules/.pnpm/node_modules' \
  exec dumb-init node /triggerdotdev/scripts/memory-policy.mjs runtime -- node ./build/server.js

