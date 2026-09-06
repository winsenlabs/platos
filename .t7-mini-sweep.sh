#!/bin/bash
# WIN-258 T7 — run the mutation sweep on the mini, after a clean build.
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd /tmp/pl-t7json
GIT="$(command -v git)"
"$GIT" -C "$HOME/work/platos-oss" fetch origin --prune
"$GIT" checkout --detach "$1" >/dev/null 2>&1
"$GIT" rev-parse HEAD
# REBUILD FIRST. A sweep over a stale dist reports vacuous kills — tranche 1's
# whole first sweep was one.
pnpm build:v1 2>&1 | tail -5
node /tmp/t7-sweep.mjs "$2"
