#!/bin/bash
# WIN-258 T7 — generate, build V1, run the postgres-tenancy unit suite on the mini.
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
cd "/tmp/pl-t7json-$1"
echo "--- build tenancy-database ---"
pnpm --filter @platos/tenancy-database build 2>&1 | tail -6
echo "--- build:v1 ---"
pnpm build:v1 2>&1 | tail -25
echo "--- unit suite: adapter-postgres-tenancy ---"
pnpm --filter @platos/adapter-postgres-tenancy test 2>&1 | tail -45
