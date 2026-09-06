#!/bin/bash
set -eo pipefail
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH
export DOCKER_HOST=unix:///Users/tejassuds/.colima/default/docker.sock
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
cd /tmp/pl-gov-0c0ab44a
R=packages/adapters/postgres-tenancy/src/governance-ratings.ts
T=packages/adapters/postgres-tenancy/src/governance-rules.integration.test.ts
cp "$R" /tmp/ratings.bak
cp "$T" /tmp/rules.bak
python3 - <<'PY'
p="packages/adapters/postgres-tenancy/src/governance-ratings.ts"
s=open(p).read()
old='''          where: { turnId: write.turnId, endUserId: write.endUserId, ...scopedWhere(scope) },
          data: {'''
new='''          where: { turnId: write.turnId, endUserId: write.endUserId },
          data: {'''
assert s.count(old)==1
open(p,"w").write(s.replace(old,new))

p="packages/adapters/postgres-tenancy/src/governance-rules.integration.test.ts"
s=open(p).read()
old='''    expect(flip.ok).toBe(false);
    const untouched = await observer.messageRating.findFirst({'''
new='''    console.log("PROBE flip:", JSON.stringify(flip));
    expect(flip.ok).toBe(false);
    const probe = await observer.messageRating.findFirst({
      where: { turnId: foreign.turnId, endUserId: foreign.endUserId },
      select: { comment: true, revision: true, environmentId: true },
    });
    console.log("PROBE row:", JSON.stringify(probe), "scopeEnv:", scope.environmentId, "foreignEnv:", foreign.scope.environmentId);
    const untouched = await observer.messageRating.findFirst({'''
assert s.count(old)==1
open(p,"w").write(s.replace(old,new))
print("mutated+instrumented")
PY
pnpm --filter @platos/adapter-postgres-tenancy exec vitest run src/governance-rules.integration.test.ts --no-file-parallelism --testTimeout=120000 --hookTimeout=600000 2>&1 | grep -E "PROBE|✓|×|Tests " | tail -25
cp /tmp/ratings.bak "$R"
cp /tmp/rules.bak "$T"
echo "restored"
