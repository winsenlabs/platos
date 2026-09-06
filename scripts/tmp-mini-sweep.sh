#!/bin/bash
set -o pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
SHA="$1"
ONLY="$2"
WT="/tmp/pl-t5evt-${SHA:0:8}"
cd "$WT"
node /tmp/pl-t5evt-sweep-driver.mjs "$WT/packages/adapters/postgres-tenancy" "$ONLY"
echo "--- worktree clean? ---"
git -C "$WT" status --porcelain
