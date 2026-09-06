#!/bin/bash
# WIN-258 T7 — sync a detached worktree on the mini to a sha, build, and run.
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
SHA="$1"
STAGE="$2"
DIR="/tmp/pl-t7json"
REPO="$HOME/work/platos-oss"
GIT="$(command -v git)"

"$GIT" -C "$REPO" fetch origin --prune
if [ ! -d "$DIR" ]; then
  "$GIT" -C "$REPO" worktree add --detach "$DIR" "$SHA"
fi
cd "$DIR"
"$GIT" checkout --detach "$SHA" >/dev/null 2>&1
"$GIT" rev-parse HEAD

case "$STAGE" in
  install)
    pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -5
    pnpm --filter @platos/tenancy-database build 2>&1 | tail -4
    ;;
  build)
    pnpm build:v1 2>&1 | tail -30
    ;;
  unit)
    pnpm --filter @platos/adapter-postgres-tenancy test 2>&1 | tail -45
    ;;
  integration)
    pnpm --filter @platos/adapter-postgres-tenancy exec vitest run json-columns.integration \
      --no-file-parallelism --testTimeout=120000 --hookTimeout=300000 2>&1 | tail -80
    ;;
  integration-all)
    pnpm test:postgres-tenancy:integration 2>&1 | tail -60
    ;;
esac
echo "STAGE-OK $STAGE"
