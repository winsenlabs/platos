#!/bin/bash
set -o pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
SHA="$1"
SUITE="$2"
WT="/tmp/pl-t5evt-${SHA:0:8}"
cd "$WT/packages/adapters/postgres-tenancy"
pnpm exec vitest run "$SUITE" --no-file-parallelism --testTimeout=120000 --hookTimeout=300000 2>&1 | tail -80
