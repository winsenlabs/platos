#!/bin/bash
set -o pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
OLD="$1"
NEW="$2"
WT="/tmp/pl-t5evt-${OLD:0:8}"
git -C ~/work/platos-oss fetch origin --prune --tags || true
git -C ~/work/platos-oss cat-file -e "$NEW^{commit}" || { echo "MISSING OBJECT $NEW"; exit 1; }
set -eo pipefail
git -C "$WT" checkout --detach "$NEW"
echo "HEAD: $(git -C "$WT" rev-parse HEAD)"
echo "STATUS:"
git -C "$WT" status --porcelain | head -20
cd "$WT"
pnpm install --ignore-scripts --prefer-offline 2>&1 | tail -2
pnpm --filter @platos/tenancy-database build 2>&1 | tail -2
pnpm build:v1 2>&1 | tail -6
echo "SYNC OK"
