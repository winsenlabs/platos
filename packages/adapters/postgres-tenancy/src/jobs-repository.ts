// `jobs`' canonical store — two ports, one object, one connection, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// TWO NAMED PROPERTIES, NOT A SPREAD, AND THE FIRST HALF IS FORCED.
// `ApprovalsRepository` declares `list`, `resolve` and `erase` at its top level,
// and this directory already publishes a `list` on `SkillsRepository`'s
// neighbours and an `erase` on `ConversationsErasureStore`; a flat spread would
// have let whichever composite came last answer both, with every type in the
// file still checking. The second half is the reason `conversations`' four are
// properties: `JobsDependencies` names TWO SLOTS — `jobs` and `approvals` — and
// a composition root has to hand each port over under its own name, which a
// spread of eighteen loose methods cannot be assembled into without guessing.
//
// ONE TRANSACTION ACROSS BOTH, AND ACROSS THE OTHER TWELVE OWNERS. They are
// handed the SAME `TenancyTransactions`, so `resolve-approval.ts` — which
// records a human's decision and then resumes the parked run in one unit of work
// — commits or rolls back as one, and `privacy`'s erasure counts and destroys
// through a `TransactionScope` minted by THIS ambient frame rather than by a
// second one that would refuse it as `scope_unknown`. A thirteenth adapter
// package holding only these two would have had its own pool and its own frame.
//
// WHAT IS NOT HERE, AND WHY. `jobs` declares FOUR driven ports and this
// satisfies the TWO that are canonical stores.
//
//   `IdempotencyStore` is a RESERVE-ONCE KEYSPACE, not a table. Its own port
//   says so in as many words — "the live implementation is Redis `SET key value
//   EX ttl NX` and this port is that operation's meaning rather than its
//   spelling" — and every one of its three properties is a property PostgreSQL
//   does not have: an atomic claim-or-report in one round trip, a TTL the store
//   enforces rather than a sweep, and an `XX` update that must not resurrect an
//   expired key. Satisfying it from the canonical store would put a per-request
//   reservation into the database the sole-writer rule governs, give it no
//   expiry at all, and make `IDEMPOTENCY_UNAVAILABLE` and
//   `JOB_SERVICE_UNAVAILABLE` the same incident — which is exactly the merge
//   `domain/errors.ts` mints two codes to keep apart. ADR M0.3 §13 puts a
//   keyspace behind `packages/adapters/redis-cache`.
//
//   `JobHandlerRuntime` is AN ISOLATE. Its port's header states the split this
//   file is on the wrong side of: "WHAT THE ADAPTER KEEPS is isolation... drawn
//   so that an adapter cannot weaken a rule and this layer cannot weaken
//   isolation." It runs untrusted handler source in a `node:vm` context inside a
//   worker thread with code generation disabled and an empty environment; it
//   writes no row, and a store that claimed it would be a database package
//   holding the one capability in this system that must not be near one. ADR
//   M0.3 §7 decision 10 puts confined execution behind
//   `packages/adapters/durable-runtime`.
//
// NEITHER OMISSION IS A GAP IN THE OWNERSHIP CLAIM. `Job` and `AgentApproval`
// are the only two canonical rows ADR M0.3 §1 gives this context, and both are
// written from here.

import type {
  ApprovalsRepository,
  JobsRepository,
} from "@platos/context-jobs/application/ports/index.js";

import { createApprovalsRepository } from "./jobs-approvals.js";
import { createJobsRepository } from "./jobs-definitions.js";
import type { TenancyTransactions } from "./transaction.js";

/** The two canonical stores, under the names `JobsDependencies` uses. */
export interface JobsStores {
  readonly jobs: JobsRepository;
  readonly approvals: ApprovalsRepository;
}

/**
 * The reading of the wall clock a listing's date window is measured from.
 *
 * It is an INPUT rather than a call to `Date.now()` inside the store for the
 * reason `governance-repository.ts` makes its instant source one: a store whose
 * behaviour depends on an unnamed global is a store no suite can pin. Here the
 * dependency is narrower than governance's — nothing this store WRITES is
 * stamped by it, because both ports are handed fully-formed aggregates that
 * already carry their own instants — and it is used by exactly one expression,
 * `ApprovalQuery.sinceDays`, which the live `list` measures back from `now`.
 */
export function createListingClock(): () => Date {
  return () => new Date();
}

/**
 * Build both stores over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right
 * fact and the wrong cause.
 */
export function createJobsStores(
  transactions: TenancyTransactions,
  now: () => Date = createListingClock(),
): JobsStores {
  return {
    jobs: createJobsRepository(transactions),
    approvals: createApprovalsRepository(transactions, now),
  };
}
