#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
echo "node: $(node -v)"
echo "shared HEAD: $(git -C ~/work/platos-oss rev-parse HEAD)"
echo "shared status:"
git -C ~/work/platos-oss status --porcelain | head -5
echo "worktrees:"
git -C ~/work/platos-oss worktree list
echo "containers:"
docker ps --format '{{.Names}} {{.Ports}}' 2>&1 | head -20
