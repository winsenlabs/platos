#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
SHA=3288b073ba3afbe6ff7e2e3223e527148ff9671c
WT=/tmp/pl-t5obs-3288b073
cd ~/work/platos-oss
echo "== BEFORE =="
/opt/homebrew/bin/git rev-parse HEAD
/opt/homebrew/bin/git status --porcelain | head -5
/opt/homebrew/bin/git worktree list
echo "== FETCH =="
/opt/homebrew/bin/git fetch origin --prune --tags 2>&1 | tail -3
echo "== ADD WORKTREE =="
/opt/homebrew/bin/git worktree add --detach "$WT" "$SHA" 2>&1 | tail -3
cd "$WT"
echo "== WORKTREE HEAD =="
/opt/homebrew/bin/git rev-parse HEAD
/opt/homebrew/bin/git status --porcelain | head -5
echo "== SHARED REPO AFTER =="
/opt/homebrew/bin/git -C ~/work/platos-oss rev-parse HEAD
