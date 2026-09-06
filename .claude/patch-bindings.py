p = "apps/core-api/src/composition/adapter-bindings.ts"
s = open(p).read()

# imports
old = '''import type {
  BudgetRepository,
  Notifier,
} from "@platos/context-cost-monitoring/application/ports/index.js";'''
new = '''import type {
  BudgetRepository,
  Notifier,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import type {
  CriteriaRepository,
  EvalsRepository,
  GoldenSetsRepository,
  RatingsRepository,
  SafetyLedger,
} from "@platos/context-governance/application/ports/index.js";'''
assert old in s
s = s.replace(old, new)

# PortSatisfaction interface
old = '''  readonly "postgres-tenancy:BudgetRepository": Satisfies<PostgresTenancyAdapter, BudgetRepository>;'''
new = '''  readonly "postgres-tenancy:BudgetRepository": Satisfies<PostgresTenancyAdapter, BudgetRepository>;
  // WIN-258 T5. `governance` publishes FIVE canonical-store ports and every one
  // is proven through the PROPERTY that carries it rather than through the
  // adapter itself — the same shape tenancy's five non-repository ports use
  // below, and for a STRONGER reason. Tenancy's five are properties because a
  // composition root has to hand each one over under its own name; these five
  // are properties because they COLLIDE. `findById` is declared on four of them,
  // `page` on four, and `create`, `update` and `remove` on two apiece, so a flat
  // spread would keep whichever composite came last and answer four ports from
  // one table. Indexing the property is what makes each obligation the true one.
  readonly "postgres-tenancy:SafetyLedger": Satisfies<PostgresTenancyAdapter["safety"], SafetyLedger>;
  readonly "postgres-tenancy:RatingsRepository": Satisfies<
    PostgresTenancyAdapter["ratings"],
    RatingsRepository
  >;
  readonly "postgres-tenancy:CriteriaRepository": Satisfies<
    PostgresTenancyAdapter["criteria"],
    CriteriaRepository
  >;
  readonly "postgres-tenancy:EvalsRepository": Satisfies<
    PostgresTenancyAdapter["evals"],
    EvalsRepository
  >;
  readonly "postgres-tenancy:GoldenSetsRepository": Satisfies<
    PostgresTenancyAdapter["goldenSets"],
    GoldenSetsRepository
  >;'''
assert old in s
s = s.replace(old, new)

# PORT_SATISFACTION value
old = '''  "postgres-tenancy:BudgetRepository": true,
  "postgres-tenancy:TenancyLocks": true,'''
new = '''  "postgres-tenancy:BudgetRepository": true,
  "postgres-tenancy:SafetyLedger": true,
  "postgres-tenancy:RatingsRepository": true,
  "postgres-tenancy:CriteriaRepository": true,
  "postgres-tenancy:EvalsRepository": true,
  "postgres-tenancy:GoldenSetsRepository": true,
  "postgres-tenancy:TenancyLocks": true,'''
assert old in s
s = s.replace(old, new)

# ADAPTER_BINDINGS rows
old = '''  // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS, the SEVENTH through
  // ELEVENTH bindings of the same directory.'''
new = '''  // WIN-258 T5 (ADR M0.3 §15). The SEVENTH through ELEVENTH bindings of the same
  // directory, and the SIXTH owner of the one PostgreSQL client. They are FIVE
  // rows and not one because `governance` publishes five separate ports over
  // five separate rows, and folding them into one composite is precisely what
  // would let a method acquire an invariant it has no business having: an eval
  // is APPEND-ONLY and a criterion is edited, a rating FLIPS in place and a
  // safety event is never touched again, and a golden set is a pinned sample
  // that shares no invariant with any of them.
  //
  // The context's other five ports get no row here, and that is a claim rather
  // than an omission: `read-seams.ts` declares three READERS of rows
  // `conversations`, `tools` and `jobs` own, `judge.ts` is a provider transport,
  // and `eval-run-queue.ts` is durable work whose own refusal code exists to
  // stay separable from a store outage.
  Object.freeze({ adapter: "postgres-tenancy", port: "SafetyLedger", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "RatingsRepository", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "CriteriaRepository", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "EvalsRepository", owner: "governance" }),
  Object.freeze({ adapter: "postgres-tenancy", port: "GoldenSetsRepository", owner: "governance" }),
  // WIN-258 M2.3 — TENANCY'S FIVE NON-REPOSITORY PORTS, the TWELFTH through
  // SIXTEENTH bindings of the same directory.'''
assert old in s
s = s.replace(old, new)

open(p, "w").write(s)
print("patched adapter-bindings.ts")
