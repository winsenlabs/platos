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

echo "[1/2] Initializing database..."
echo "[2/2] Starting agent service..."
exec node dist/main.js
