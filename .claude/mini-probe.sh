#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd /tmp/pl-gov-0c0ab44a
F=packages/adapters/postgres-tenancy/src/governance-ratings.ts
cp "$F" /tmp/ratings.bak
python3 - <<'PY'
p="packages/adapters/postgres-tenancy/src/governance-ratings.ts"
s=open(p).read()
old='''          where: { turnId: write.turnId, endUserId: write.endUserId, ...scopedWhere(scope) },
          data: {'''
new='''          where: { turnId: write.turnId, endUserId: write.endUserId },
          data: {'''
assert s.count(old)==1, s.count(old)
open(p,"w").write(s.replace(old,new))
print("mutated")
PY
pnpm --filter @platos/adapter-postgres-tenancy exec vitest run src/governance-rules.integration.test.ts --no-file-parallelism --testTimeout=120000 --hookTimeout=600000 2>&1 | tail -40
cp /tmp/ratings.bak "$F"
echo "restored"
