p = "scripts/arch/gen-v1-skeleton.mjs"
s = open(p).read()

old = '''      { port: "BudgetRepository", owner: "cost-monitoring" },
      // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS GET SLOTS.'''
new = '''      { port: "BudgetRepository", owner: "cost-monitoring" },
      // WIN-258 T5 — `governance`'s FIVE canonical-store ports, the SIXTH owner
      // of the one PostgreSQL client. `SafetyEvent`, `MessageRating`,
      // `EvalCriterion`, `AgentEval` and `GoldenSet` live in that same database,
      // so by §15 they are written from the same directory behind the same
      // client. The context publishes five SEPARATE ports rather than one
      // composite, and that is deliberate on its side: an eval is append-only
      // and a criterion is edited, a rating flips in place and a safety event is
      // never touched again. Five ports are five bindings.
      //
      // They are PROPERTIES on the adapter rather than spread-in methods, like
      // tenancy's five below — but for a stronger reason. Tenancy's are
      // properties so a composition root can hand each over under its own name;
      // these five COLLIDE with each other on `findById`, `page`, `create`,
      // `update` and `remove`, so a flat spread would answer four ports from one
      // table.
      { port: "SafetyLedger", owner: "governance" },
      { port: "RatingsRepository", owner: "governance" },
      { port: "CriteriaRepository", owner: "governance" },
      { port: "EvalsRepository", owner: "governance" },
      { port: "GoldenSetsRepository", owner: "governance" },
      // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS GET SLOTS.'''
assert old in s
s = s.replace(old, new)

old = '''export const EXPECTED_ADAPTER_COUNT = 12;
export const EXPECTED_BINDING_COUNT = 22;'''
new = '''//
// 22 -> 27 (WIN-258 T5). `governance` publishes FIVE canonical-store ports and
// the same directory satisfies all five, so one tranche moves this pin by five
// while leaving EXPECTED_ADAPTER_COUNT alone for the fourth time — which is the
// whole point of pinning the two separately. It adds ONE owner edge and one
// project reference, because a reference is per PACKAGE and not per port.
export const EXPECTED_ADAPTER_COUNT = 12;
export const EXPECTED_BINDING_COUNT = 27;'''
assert old in s
s = s.replace(old, new)

open(p, "w").write(s)
print("patched gen-v1-skeleton.mjs")
