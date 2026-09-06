#!/bin/bash
set -o pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
SHA="$1"
WT="/tmp/pl-t5evt-${SHA:0:8}"
cd "$WT/packages/adapters/postgres-tenancy"
FAIL=0
for suite in eventing-conformance eventing-constraints eventing-rules eventing-transaction eventing-statements; do
  echo "===== $suite ====="
  if pnpm exec vitest run "src/$suite.integration.test.ts" --no-file-parallelism --testTimeout=120000 --hookTimeout=300000 2>&1 | tail -40; then
    echo "GREEN $suite"
  else
    echo "RED $suite"
    FAIL=1
  fi
done
echo "===== unit ====="
pnpm exec vitest run src/eventing-rows.test.ts 2>&1 | tail -8
exit $FAIL
