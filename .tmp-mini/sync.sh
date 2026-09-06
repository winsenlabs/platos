#!/bin/bash
# Ship the working tree to the mini worktree at /tmp/pl-t5p-work.
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -a --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
  --exclude 'generated' --exclude '.tmp-mini' --exclude 'artifacts' \
  -e ssh ./ mini:/tmp/pl-t5p-work/
echo "synced"
