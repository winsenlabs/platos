#!/bin/bash
set -uo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
R=~/work/platos-oss
echo "=== BEFORE ==="
git -C "$R" rev-parse HEAD
git -C "$R" status --porcelain | head -5
git -C "$R" worktree list
echo "=== FETCH ==="
git -C "$R" fetch origin --prune --tags 2>&1 | tail -3
git -C "$R" rev-parse origin/tejas/win-258-t5-providers
