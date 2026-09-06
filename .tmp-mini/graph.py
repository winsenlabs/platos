import sys

p = 'scripts/arch/v1-project-graph.mjs'
s = open(p).read()

pairs = [
(
'''// unchanged.
export const EXPECTED_EDGE_COUNT = 102;''',
'''// unchanged.
//
// 102 -> 103 (WIN-258 T5, a NINTH owner). The directory gained one more owner
// edge, to `packages/contexts/providers`, whose four canonical rows —
// `ProviderKey`, `EnvironmentProvider`, `Model` and `ModelPrice` — are in that
// same PostgreSQL database. ONE edge carrying ONE binding, because `providers`
// publishes a single canonical-store port over all four.
//
// IT CANNOT CREATE A CYCLE, and this is the one owner edge where that needed
// checking rather than asserting: `providers` DEPENDS on `secrets`, and
// `secrets` is already an owner of this same directory. A cycle would need
// `secrets` to depend on `providers`, and the §1 DAG has it depending on the
// kernel alone — so `EXPECTED_CONTEXT_DEPENDS_ON` below is unchanged and the
// two owner edges are parallel rather than circular.
export const EXPECTED_EDGE_COUNT = 103;'''
),
(
'''    "governance",
    "secrets",
  ],
  outbox: ["kernel"],''',
'''    "governance",
    "secrets",
    "providers",
  ],
  outbox: ["kernel"],'''
),
(
'''export const EXPECTED_MULTI_OWNER_ADAPTERS = { "postgres-tenancy": 8 };''',
'''export const EXPECTED_MULTI_OWNER_ADAPTERS = { "postgres-tenancy": 9 };'''
),
]

for a, b in pairs:
    if a not in s:
        sys.exit("MISS: " + a[:70])
    s = s.replace(a, b)

open(p, 'w').write(s)
print("ok")
