#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
cd /tmp/pl-t7json
pnpm --filter @platos/adapter-postgres-tenancy exec vitest run json-columns.test 2>&1 | head -120
