#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
W=/tmp/pl-gov-d6ae1972
cd "$W"
echo "== HEAD: $(git rev-parse HEAD)"
echo "== status:"; git status --porcelain | head -5
echo "== install"
pnpm install --frozen-lockfile 2>&1 | tail -3
echo "== build tenancy-database"
pnpm --filter @platos/tenancy-database build 2>&1 | tail -2
echo "== build the contexts the adapter resolves at runtime"
for c in tenancy identity-access tools agents cost-monitoring governance; do
  pnpm --filter "@platos/context-$c..." build 2>&1 | tail -1
done
echo "== governance integration suites"
pnpm --filter @platos/adapter-postgres-tenancy exec vitest run governance --no-file-parallelism --testTimeout=120000 --hookTimeout=600000 2>&1 | tail -120
