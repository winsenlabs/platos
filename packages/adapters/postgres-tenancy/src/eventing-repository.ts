// `eventing`'s canonical store — one port, ONE table, one connection, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// ONE TABLE IS THE SMALLEST GRANT THIS MAP HAS MADE, and it is worth saying why
// the delegation is needed at all for a single row. Without an entry in
// `CANONICAL_STORE_ADAPTERS`, `ownerDirectories("eventing")` is
// `packages/contexts/eventing` alone — and ADR M0.3 §2 forbids that package's
// `domain/` and `application/` from importing the ORM. The one package permitted
// to write `NotificationRule` would be the one package unable to. That is the
// same sentence the other twelve entries stand on; the row count does not change
// it.
//
// THE COMPOSITE IS SPREAD, NOT NESTED, AND THAT IS AVAILABLE RATHER THAN
// PREFERRED. Nine method names — `insertRule`, `updateRule`, `deleteRule`,
// `findRule`, `findRuleByName`, `listRules`, `listEnabledRules`,
// `countRulesForSubject`, `anonymizeRulesForSubject` — and not one of them
// collides with anything `PostgresTenancyAdapter` already publishes across
// sixteen owners. So the adapter EXTENDS `NotificationRuleRepository` and the
// composition root proves it against the adapter itself, exactly as it does for
// `ProvidersRepository`. `governance`'s five, `secrets`' two, `skills`' one,
// `conversations`' four and `memory`'s two are properties because they collide;
// this one does not have to be.
//
// ONE TRANSACTION ACROSS THE OTHER TWELVE OWNERS. It is handed the SAME
// `TenancyTransactions`, which is what makes a multi-context erasure atomic:
// `privacy` opens one unit of work and hands the same `TransactionScope` to
// every `ErasureTarget` in the array, so this context's `createdBy` scrub and
// `governance`'s and `memory`'s commit or roll back together. A thirteenth
// adapter package holding only this repository would have had its own pool and
// its own ambient frame, and an erasure that failed after this target had run
// would have left one context scrubbed and the rest intact.
//
// WHAT IS NOT HERE, AND WHY. `eventing` declares THREE driven ports and this
// satisfies the ONE that is a canonical store.
//
//   `destination-screen.ts` is the SSRF BOUNDARY. Its own header says the
//   question it answers "requires DNS resolution, which is I/O", names the
//   adapter that satisfies it as "the sole holder of the resolver", and adds an
//   obligation no store can meet — the delivery adapter must "re-screen and pin
//   the address into the socket", because "a bare fetch re-resolves DNS and is
//   rebindable to IMDS/private space between the validatePublicUrl check above
//   and the connect". A PostgreSQL client opens no sockets and resolves no
//   names; satisfying this interface from here would put an SSRF-defence
//   contract in a package that cannot honour a single clause of it.
//
//   `notification-queue.ts` is a HAND-OFF FOR DELIVERY, and its own header says
//   what it needs: `availableAt` is "the retry mechanism", and the port exists
//   because the legacy in-process `setTimeout` "loses every scheduled retry if
//   the process restarts inside the window". What that asks for is a DELAYED
//   QUEUE that holds a due time durably and hands the item back when it comes
//   round — ADR M0.3 §7 decision 10's durable work, behind
//   `packages/adapters/durable-runtime`. A canonical store could hold the rows
//   and could not hold the schedule, and a queue whose consumer polls a table
//   the routing pass also writes is the arrangement the outbox exists to avoid.
//   `EVENTING_QUEUE_UNAVAILABLE` is deliberately a different code from
//   `EVENTING_REPOSITORY_UNAVAILABLE` for the same reason: "the queue refused
//   the work" and "a table is down" are separate incidents, and satisfying the
//   queue from the store would merge exactly those two.

import type { NotificationRuleRepository } from "@platos/context-eventing/application/ports/index.js";

import { createEventingErasure } from "./eventing-erasure.js";
import { createNotificationRules } from "./eventing-rules.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the store over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right
 * fact and the wrong cause.
 *
 * IT STAMPS NOTHING, unlike `skills`' and `governance`'s stores, and the
 * difference is in the port rather than in the taste. Those two are handed
 * DRAFTS and have to mint an id and an instant; every method here is handed a
 * whole `NotificationRule` that `createNotificationRule` or
 * `editNotificationRule` already stamped from the context's own `Clock` and
 * `IdGenerator`. A store that minted either would be overwriting a value the
 * domain computed — and `registerNotificationRule` returns the rule it built, so
 * the two would disagree in the same breath.
 */
export function createNotificationRuleRepository(
  transactions: TenancyTransactions,
): NotificationRuleRepository {
  return {
    ...createNotificationRules(transactions),
    ...createEventingErasure(transactions),
  };
}
