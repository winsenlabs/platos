export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -eo pipefail
cd ~/work/platos-oss
git fetch origin --prune 2>&1 | tail -2
SHA=$(git rev-parse origin/tejas/win-258-t5-files)
cd /tmp/pl-t5files
git checkout --detach "$SHA" 2>&1 | tail -2
echo "WT HEAD=$(git rev-parse HEAD)"
git status --porcelain | head -5
pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -2
pnpm --filter @platos/tenancy-database build 2>&1 | tail -1
pnpm --filter "@platos/context-files..." build 2>&1 | tail -1
pnpm --filter "@platos/adapter-postgres-tenancy..." build 2>&1 | tail -1
echo "SYNC-OK"
cd ~/work/platos-oss
echo "SHARED HEAD=$(git rev-parse HEAD)"
