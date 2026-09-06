#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
OLD=/tmp/pl-gov-d6ae1972
NEW=/tmp/pl-gov-0c0ab44a
if [ -d "$OLD" ]; then
  git -C ~/work/platos-oss worktree remove --force "$OLD"
fi
git -C ~/work/platos-oss fetch origin --prune >/dev/null 2>&1
if [ ! -d "$NEW" ]; then
  git -C ~/work/platos-oss worktree add --detach "$NEW" 0c0ab44ae018ac4acdb6a09617b026bb83a09521
fi
cd "$NEW"
echo "== HEAD: $(git rev-parse HEAD)"
echo "== status:"; git status --porcelain | head -5
pnpm install --frozen-lockfile 2>&1 | tail -1
pnpm --filter @platos/tenancy-database build 2>&1 | tail -1
for c in tenancy identity-access tools agents cost-monitoring governance; do
  pnpm --filter "@platos/context-$c..." build 2>&1 | tail -1
done
echo "== sweep"
node .claude/mutate.mjs 2>&1 | tail -200
echo "== outcomes"
cat /tmp/mut-outcomes.json
