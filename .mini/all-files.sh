export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd /tmp/pl-t5files/packages/adapters/postgres-tenancy
pnpm exec vitest run src/files-rows.test.ts src/files-conformance.integration.test.ts src/files-constraints.integration.test.ts src/files-rules.integration.test.ts src/files-transaction.integration.test.ts src/files-statements.integration.test.ts --no-file-parallelism --testTimeout=180000 --hookTimeout=600000 2>&1 | tail -40
