// `observability`'s door into this directory: ONE canonical-store port, built
// over the transaction machinery every other owner here already shares.
//
// ONE PORT OUT OF FOUR, AND THE OTHER THREE ARE DECLINED WITH REASONS.
// `packages/contexts/observability/application/ports/index.ts` publishes four
// driven ports. Exactly one of them is a canonical store:
//
//   `ObservabilityRepository` — the `AdminAudit` row, ADR M0.3 §1 row 12. IT.
//
//   `ObservabilitySink` — the four ANALYTICAL tables. They are not Prisma rows
//   at all: the ownership map's own comment on row 12 says "Its ClickHouse
//   projections are not Prisma rows", `boundary-rules.mjs` gives that vendor a
//   single home in `packages/adapters/clickhouse-observability/`, and the
//   composition root already binds `clickhouse-observability:ObservabilitySink`.
//   Satisfying it from here would put a second implementation of one port behind
//   two different stores with two different failure models.
//
//   `ProjectionOutbox` — the drain side of the ONE physical outbox. ADR M0.3 §1's
//   closing note and §7 decision 8 make the kernel outbox adapter its only
//   writer, and `scripts/arch/table-ownership.mjs` records the same split by
//   giving `Event` and `ObservabilityOutbox` the `<kernel-outbox-adapter>`
//   pseudo-owner rather than this context. A `settle` issued from an
//   `observability`-tagged module would be this directory writing another
//   owner's row, which `sole-writer.mjs` refuses — correctly.
//
//   `ErasedSubjectRegister` and `SubjectLocatorSource` — READS of two other
//   contexts' rows. The tombstone register is `privacy`'s `ErasureTombstone` and
//   the thread ids are `conversations`' `Thread`; the ports' own headers say the
//   composition root resolves them "over whatever holds the tombstone register",
//   precisely so this context imports neither. They are read-only, so the
//   sole-writer rule does not forbid them here — but a store in this file that
//   answered them would make `observability`'s adapter a reader of `privacy`'s
//   table under `observability`'s name, which is the sideways access ADR M0.3
//   §5.2 forbids and which the narrow-peer-port shape (`Pick<UserStore,
//   "findById">`) exists to avoid. They are left to the owners.
//
// IT TAKES `TenancyTransactions` RATHER THAN A CLIENT, for the reason every
// composite in this package does: a caller that built its own would get a second
// `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
// refused by the other with `scope_unknown` — a refusal that names the right
// fact and the wrong cause. It also matters here more than usual, because
// `record-admin-action.ts` puts the audit write INSIDE the admin action's own
// unit of work: the action and its evidence commit together or neither does,
// and that is only true while both resolve through the same frame.

import type { ObservabilityRepository } from "@platos/context-observability/application/ports/index.js";

import { createObservabilityRepository } from "./observability-audit.js";
import type { TenancyTransactions } from "./transaction.js";

/** The one canonical store, under the name `ObservabilityDependencies` uses. */
export interface ObservabilityStores {
  readonly observability: ObservabilityRepository;
}

/**
 * Build it over already-open transaction machinery.
 *
 * A named property rather than a spread, and forced rather than chosen:
 * `ObservabilityDependencies`' slot is called `repository`, and `repository`
 * alone is not a name a directory serving thirteen owners can give to one of
 * them. Spelling the owner in front is what lets a composition root hand this
 * port to the context under its own name without a bundle assembled from key
 * order putting one owner's store in another's slot.
 */
export function createObservabilityStores(
  transactions: TenancyTransactions,
): ObservabilityStores {
  return { observability: createObservabilityRepository(transactions) };
}
