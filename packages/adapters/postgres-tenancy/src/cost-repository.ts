// The `BudgetRepository` composite — `cost-monitoring`'s canonical store, in the
// one directory ADR M0.3 §15 gives the ORM.
//
// THREE STORES, ONE OBJECT, ONE CONNECTION. `Budget` and `BudgetThresholdEvent`
// are in `cost-budgets.ts`, `AlertChannel` and its configuration in
// `cost-channels.ts`, `AlertDelivery` and its send records in
// `cost-deliveries.ts`. The split is by lifecycle rather than by method count —
// a cap is edited, a crossing is immutable, a delivery is claimed — and it is
// what keeps each of the three inside ADR M0.3 §6's file budget. They are handed
// the SAME `TenancyTransactions`, so a use case that appends a crossing and fans
// out its deliveries in one `UnitOfWork.run` gets one transaction across all
// three, which is the property `detect-crossings.ts` exists to state.
//
// AND ONE TRANSACTION WITH THE OTHER TWO OWNERS IN THIS DIRECTORY. `tenancy` and
// `identity-access` already share it, for the reason §15 gives: one PostgreSQL
// database is one client is one adapter directory. A third owner joining changes
// nothing about that — ownership is carried by the owner TAG on the row and
// `sole-writer.mjs` asks, per WRITE, whether this directory is one of
// `ownerDirectories(OWNER[model])`. A write to `Memory` from here still fails,
// because `memory` has no entry in `CANONICAL_STORE_ADAPTERS`; what the new
// entry grants is exactly the six rows `cost-monitoring` owns.
//
// WHAT IS NOT HERE, AND WHY. `cost-monitoring` declares four driven ports and
// this satisfies ONE of them.
//
//   `SpendLedger` is NOT a canonical store and its own header says so: daily
//   buckets "incremented as work completes, expiring after a retention window",
//   APPEND-ONLY and explicitly NOT idempotent, with "the canonical Postgres
//   ledger remains the source of truth for billing". It writes none of
//   `cost-monitoring`'s six rows — it writes no canonical row at all — so
//   implementing it here would put a counter keyspace inside the canonical
//   store's directory and give this adapter a second, incompatible durability
//   contract. It belongs to a counters adapter.
//
//   `BudgetCapCache` is a cache. ADR M0.3 §7 decision 3(b) chose it so the
//   pre-spend guard would not read the canonical store on the hot turn path;
//   satisfying it from the canonical store would undo the decision exactly.
//
//   `Notifier` is a transport. ADR M0.3 §4 already binds it to
//   `packages/adapters/notifier-email` and `packages/adapters/notifier-webhook`,
//   and its own header explains that the adapter — not this context and not this
//   directory — is what holds the vault grant that resolves a `CredentialRef`.

import type { BudgetRepository } from "@platos/context-cost-monitoring/application/ports/index.js";

import { createAlertChannelStore } from "./cost-channels.js";
import { createAlertDeliveryStore } from "./cost-deliveries.js";
import { createBudgetStore } from "./cost-budgets.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the repository over an already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason the other
 * three composites in this package do: a caller that built its own would get a
 * second `AsyncLocalStorage` frame, and a write carrying a scope minted by one
 * would be refused by the other with `scope_unknown` — a refusal that names the
 * right fact and the wrong cause.
 */
export function createCostMonitoringRepository(
  transactions: TenancyTransactions,
): BudgetRepository {
  return {
    ...createBudgetStore(transactions),
    ...createAlertChannelStore(transactions),
    ...createAlertDeliveryStore(transactions),
  };
}
