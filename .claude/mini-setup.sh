#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
SHA=d6ae1972c503b630b0aaf4b94c723a48ea41a45c
echo "node: $(node -v)"
echo "BEFORE shared HEAD: $(git -C ~/work/platos-oss rev-parse HEAD)"
echo "BEFORE shared status:"
git -C ~/work/platos-oss status --porcelain | head -5
git -C ~/work/platos-oss fetch origin --prune --tags >/dev/null 2>&1
git -C ~/work/platos-oss worktree add --detach "/tmp/pl-gov-${SHA:0:8}" "$SHA"
echo "worktree HEAD: $(git -C /tmp/pl-gov-${SHA:0:8} rev-parse HEAD)"
echo "AFTER shared HEAD: $(git -C ~/work/platos-oss rev-parse HEAD)"
