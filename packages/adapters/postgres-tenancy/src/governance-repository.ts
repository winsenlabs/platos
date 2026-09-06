// `governance`'s canonical store — five ports, one object, one connection, in
// the one directory ADR M0.3 §15 gives the ORM.
//
// FIVE NAMED PROPERTIES, NOT A SPREAD, AND THAT IS FORCED RATHER THAN CHOSEN.
// `tools`, `agents` and `cost-monitoring` each publish ONE composite port whose
// method names are disjoint from everything else in this directory, so their
// composites are spread into `PostgresTenancyAdapter` and satisfied
// structurally. `governance` publishes FIVE SEPARATE ports and they collide with
// each other: `findById` is on four of them, `page` on four, `create`, `update`
// and `remove` on two apiece. A flat spread would silently keep whichever came
// last and every other port would be answered by the wrong table.
//
// The names below are `GovernanceDependencies`' own slot names — `safety`,
// `ratings`, `criteria`, `evals`, `goldenSets` — for the reason WIN-258 T3 gives
// for tenancy's five non-repository ports: a composition root has to hand each
// port to the context under its own name, and a bundle assembled from this
// object's keys cannot put one port in another's slot.
//
// ONE TRANSACTION ACROSS ALL FIVE, AND ACROSS THE OTHER FIVE OWNERS. They are
// handed the SAME `TenancyTransactions`, so `governance-erasure-target.ts` —
// which counts a subject's safety events and ratings, then anonymises the first
// and destroys the second — runs in one unit of work rather than two, and an
// erasure that fails half way leaves neither half applied. A thirteenth adapter
// package holding only these five would have had its own pool and its own
// ambient frame, and the plan and the erasure would have been two transactions
// with a window between them.
//
// WHAT IS NOT HERE, AND WHY. `governance` declares TEN driven ports in eight
// modules and this satisfies the FIVE that are canonical stores.
//
//   `read-seams.ts` declares THREE reader ports — `RatingTargetReader`,
//   `TranscriptReader`, `ActivityReader` — and not one of them reads a row this
//   context owns. They answer questions about `Turn`, `Thread`, `ToolCallAudit`
//   and `AgentApproval`, which ADR M0.3 §1 gives to `conversations`, `tools` and
//   `jobs`. Implementing them here would make this directory a reader of four
//   other owners' tables under the name of `governance`'s adapter, which is the
//   sideways access §5.2 forbids and which the port's own header says the
//   composition root resolves "by asking whichever context owns the rows".
//
//   `judge.ts` is the entire vendor surface of the eval pipeline — a model
//   call, priced and timed. It is a transport to a provider, bound where
//   `ModelRouter` is bound, and it writes no row at all.
//
//   `eval-run-queue.ts` is the durable seam a golden-set run is handed to. ADR
//   M0.3 §7 decision 10 puts durable work behind `packages/adapters/durable-runtime`,
//   and its own error constructor — `queueUnavailable`, deliberately distinct
//   from `ledgerUnavailable` — exists so "the dispatcher refused the work" and
//   "a table is down" stay separable. Satisfying it from the canonical store
//   would merge exactly those two incidents.

import type {
  CriteriaRepository,
  EvalsRepository,
  GoldenSetsRepository,
  RatingsRepository,
  SafetyLedger,
} from "@platos/context-governance/application/ports/index.js";

import { createCriteriaRepository } from "./governance-criteria.js";
import { createEvalsRepository } from "./governance-evals.js";
import { createGoldenSetsRepository } from "./governance-golden-sets.js";
import { createRatingsRepository } from "./governance-ratings.js";
import { createSafetyLedger } from "./governance-safety.js";
import type { TenancyTransactions } from "./transaction.js";

/** The five canonical stores, under the names the context's bundle uses. */
export interface GovernanceStores {
  readonly safety: SafetyLedger;
  readonly ratings: RatingsRepository;
  readonly criteria: CriteriaRepository;
  readonly evals: EvalsRepository;
  readonly goldenSets: GoldenSetsRepository;
}

/**
 * A wall-clock reading that never repeats within this process.
 *
 * WHY THE STORE STAMPS THE ROW AT ALL. Four of these five tables order a paged
 * listing by `createdAt`, and every one of those columns is `timestamp(3)` — so
 * two rows written in the same millisecond TIE, and a paged listing whose order
 * is not total repeats rows on one page and drops them from the next. Leaving it
 * to `@default(now())` would be worse still: `now()` is the TRANSACTION's start
 * time on PostgreSQL, so every row an erasure or a golden-set run wrote in one
 * unit of work would carry the identical instant.
 *
 * The listings break the remaining tie on `id`, so the order is total either
 * way; this makes it total in the ORDER THE ROWS WERE WRITTEN, which is what a
 * reader of an append-only ledger means by "most recent first".
 */
export function createInstantSource(): () => Date {
  let previous = 0;
  return () => {
    const now = Date.now();
    previous = now > previous ? now : previous + 1;
    return new Date(previous);
  };
}

/**
 * Build the five stores over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason the four
 * composites in this package do: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right
 * fact and the wrong cause.
 */
export function createGovernanceStores(transactions: TenancyTransactions): GovernanceStores {
  const now = createInstantSource();
  return {
    safety: createSafetyLedger(transactions, now),
    ratings: createRatingsRepository(transactions, now),
    criteria: createCriteriaRepository(transactions, now),
    evals: createEvalsRepository(transactions, now),
    goldenSets: createGoldenSetsRepository(transactions, now),
  };
}
