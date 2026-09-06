#!/bin/bash
set -o pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
SHA="$1"
WT="/tmp/pl-t5evt-${SHA:0:8}"

# A sibling agent fetches into the same shared clone, so a concurrent ref update
# can lose the race. The object is what matters, not the local ref.
git -C ~/work/platos-oss fetch origin --prune --tags || true
git -C ~/work/platos-oss cat-file -e "$SHA^{commit}" || { echo "MISSING OBJECT $SHA"; exit 1; }

set -eo pipefail
if [ ! -d "$WT" ]; then
  git -C ~/work/platos-oss worktree add --detach "$WT" "$SHA"
fi
echo "BEFORE HEAD: $(git -C "$WT" rev-parse HEAD)"
echo "BEFORE STATUS:"
git -C "$WT" status --porcelain | head -20
echo "--- install ---"
cd "$WT"
pnpm install --ignore-scripts --prefer-offline 2>&1 | tail -3
echo "--- tenancy-database build ---"
pnpm --filter @platos/tenancy-database build 2>&1 | tail -3
echo "--- build:v1 ---"
pnpm build:v1 2>&1 | tail -10
echo "SETUP OK"
