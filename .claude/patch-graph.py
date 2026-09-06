p = "scripts/arch/v1-project-graph.mjs"
s = open(p).read()

old = '''// 98 -> 99 (WIN-258 T5, a fifth time). The directory gained a FIFTH owner edge,
// to `packages/contexts/cost-monitoring`, whose six canonical rows are in that
// same PostgreSQL database. `cost-monitoring` depends on `tenancy` and
// `providers` and nothing depends on it, so `EXPECTED_CONTEXT_DEPENDS_ON` below
// is again unchanged and no cycle is possible.
export const EXPECTED_EDGE_COUNT = 99;'''
new = '''// 98 -> 99 (WIN-258 T5, a fifth time). The directory gained a FIFTH owner edge,
// to `packages/contexts/cost-monitoring`, whose six canonical rows are in that
// same PostgreSQL database. `cost-monitoring` depends on `tenancy` and
// `providers` and nothing depends on it, so `EXPECTED_CONTEXT_DEPENDS_ON` below
// is again unchanged and no cycle is possible.
//
// 99 -> 100 (WIN-258 T5, a sixth time). The directory gained a SIXTH owner edge,
// to `packages/contexts/governance`, whose five canonical rows are in that same
// PostgreSQL database. It is ONE edge carrying FIVE bindings — `SafetyLedger`,
// `RatingsRepository`, `CriteriaRepository`, `EvalsRepository` and
// `GoldenSetsRepository` — because a project reference is per PACKAGE, not per
// port; it is the same one-edge-many-bindings shape `agents` introduced, at five
// instead of two. `governance` depends on `tenancy` and `agents` and nothing
// depends on it, so `EXPECTED_CONTEXT_DEPENDS_ON` below is again unchanged and
// no cycle is possible.
export const EXPECTED_EDGE_COUNT = 100;'''
assert old in s
s = s.replace(old, new)

old = '''  "postgres-tenancy": ["tenancy", "identity-access", "tools", "agents", "cost-monitoring"],
  outbox: ["kernel"],'''
new = '''  "postgres-tenancy": [
    "tenancy",
    "identity-access",
    "tools",
    "agents",
    "cost-monitoring",
    "governance",
  ],
  outbox: ["kernel"],'''
assert old in s
s = s.replace(old, new)

old = '''export const EXPECTED_MULTI_OWNER_ADAPTERS = { "postgres-tenancy": 5 };'''
new = '''export const EXPECTED_MULTI_OWNER_ADAPTERS = { "postgres-tenancy": 6 };'''
assert old in s
s = s.replace(old, new)

old = '''// PostgreSQL database it has the client for — two at T2, three since T5 bound
// `cost-monitoring`, and the shape has not had to change to say so.'''
new = '''// PostgreSQL database it has the client for — two at T2, and six since tranche 5
// bound `tools`, `agents`, `cost-monitoring` and `governance`, and the shape has
// not had to change to say so.'''
assert old in s
s = s.replace(old, new)

open(p, "w").write(s)
print("patched v1-project-graph.mjs")
