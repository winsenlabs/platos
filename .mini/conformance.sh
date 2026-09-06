export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
set -eo pipefail
cd /tmp/pl-t5files/packages/adapters/postgres-tenancy
pnpm exec vitest run src/files-conformance.integration.test.ts --no-file-parallelism --testTimeout=180000 --hookTimeout=300000 2>&1 | tail -80
