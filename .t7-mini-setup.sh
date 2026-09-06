#!/bin/bash
# WIN-258 T7 — prepare a detached worktree on the Mac mini and install.
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
SHA="$1"
DIR="/tmp/pl-t7json-$SHA"
REPO="$HOME/work/platos-oss"

node -v
"$(command -v git)" -C "$REPO" fetch origin --prune --tags
if [ ! -d "$DIR" ]; then
  "$(command -v git)" -C "$REPO" worktree add --detach "$DIR" "$SHA"
fi
cd "$DIR"
"$(command -v git)" rev-parse HEAD
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -20
echo "SETUP-OK $DIR"
