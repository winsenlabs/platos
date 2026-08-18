#!/bin/sh
set -e

echo "========================================="
echo "  Platos Agent — Starting"
echo "========================================="

# Apply standalone SQL to create Platos tables (idempotent — uses IF NOT EXISTS)
if [ -f ./prisma-init.sql ]; then
  node -e "
    const { Client } = require('pg');
    const fs = require('fs');
    (async () => {
      const client = new Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const sql = fs.readFileSync('./prisma-init.sql', 'utf-8');
      await client.query(sql);
      await client.end();
      console.log('  Database tables ready');
    })().catch(e => console.log('  DB init:', e.message));
  " 2>/dev/null || echo "  DB init skipped"
fi

# pnpm deploy didn't include a generated client. Generate against the
# @platos/database workspace-installed schema so the output lands in
# node_modules/@platos/database/generated/prisma/ where dist/index.js
# expects it (re-exports via require("../generated/prisma")).
if [ ! -f ./node_modules/@platos/database/generated/prisma/index.js ]; then
  echo "  Generating Prisma client..."
  ./node_modules/.bin/prisma generate \
    --schema=./node_modules/@platos/database/prisma/schema.prisma 2>&1 || \
    echo "  Prisma generate failed — agent may fail on DB calls"
fi

echo "[1/2] Initializing database..."
echo "[2/2] Starting agent service..."
exec node dist/main.js
