export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
set -eo pipefail
cd /tmp/pl-t5files
pnpm install --frozen-lockfile --ignore-scripts 2>&1 | tail -5
pnpm --filter @platos/tenancy-database build 2>&1 | tail -3
pnpm --filter "@platos/context-files..." build 2>&1 | tail -3
pnpm --filter "@platos/adapter-postgres-tenancy..." build 2>&1 | tail -3
echo "INSTALL-OK"
