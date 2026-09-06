export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -eo pipefail
cd ~/work/platos-oss
echo "BEFORE HEAD=$(git rev-parse HEAD)"
git status --porcelain | head -5
git fetch origin --prune --tags 2>&1 | tail -3
SHA=$(git rev-parse origin/tejas/win-258-t5-files)
echo "TARGET=$SHA"
if [ ! -d /tmp/pl-t5files ]; then
  git worktree add --detach /tmp/pl-t5files "$SHA"
else
  cd /tmp/pl-t5files
  git checkout --detach "$SHA"
fi
cd /tmp/pl-t5files
echo "WT HEAD=$(git rev-parse HEAD)"
cd ~/work/platos-oss
echo "AFTER HEAD=$(git rev-parse HEAD)"
git status --porcelain | head -5
