// `privacy`'s canonical store — one port, two tables, one connection, in the one
// directory ADR M0.3 §15 gives the ORM.
//
// ONE COMPOSITE AND NOT TWO PROPERTIES. `PrivacyRepository` is declared as
// `interface PrivacyRepository extends OperationRepository, TombstoneRepository`
// — the port itself is the composite, and its ten method names collide with
// nothing this adapter already publishes across twelve owners. So it is SPREAD
// into `PostgresTenancyAdapter` like `tools`', `agents`', `cost-monitoring`'s,
// `channels`' and `providers`', and `PORT_SATISFACTION` in the composition root
// resolves `Satisfies<PostgresTenancyAdapter, PrivacyRepository>` at compile
// time. A nested property could not satisfy that.
//
// ONE TRANSACTION ACROSS BOTH TABLES, AND ACROSS THE OTHER TWELVE OWNERS, AND
// THAT IS THE WHOLE POINT OF THIS CONTEXT BEING HERE. `run-erasure-pass.ts` opens
// ONE unit of work and, inside it, asks every injected `ErasureTarget` to carry
// out its plan and then writes this context's own progress row. The targets are
// `conversations`' `ConversationsErasureStore`, `memory`'s two stores,
// `governance`'s ledger and `skills`' anonymiser — all of which resolve to THIS
// directory and THIS `TenancyTransactions`. A thirteenth adapter package holding
// only `privacy`'s repository would have had its own pool and its own
// `AsyncLocalStorage` frame, so the `TransactionScope` the pass minted would
// reach the targets as a token their frame had never seen and be refused
// `scope_unknown` — a refusal naming the right fact and the wrong cause. The
// erasure would not have been atomic; it would not have run at all.
//
// AND THE BARRIER IS DELIBERATELY *NOT* IN THAT TRANSACTION. `seal-subject.ts`
// runs in its own unit of work BEFORE the destructive pass, because a barrier
// that committed with the destruction would be open for exactly as long as the
// destruction takes. Both units of work are this same client, so "sealed" is a
// fact the destructive transaction can read; a second pool would have made the
// seal invisible to the pass it exists to protect.
//
// WHAT IS NOT HERE, AND WHY. `privacy` declares FOUR driven ports and this
// satisfies the ONE that is a canonical store.
//
//   `subject-directory.ts` resolves a handle into every scope and alias a person
//   occupies, and every row it must read — `EndUser`, `EndUserIdentity`,
//   `EndUserSession` — is `identity-access`', ADR M0.3 §1 row 1. Reads are
//   unrestricted, so this directory could PHYSICALLY answer it; it must not.
//   The port's own header says the resolution is the reason `privacy` is kept off
//   every other context's surface and that "it is the composition root — not this
//   package — that is allowed to know identity-access exists". An implementation
//   tagged `privacy` reading another owner's identity graph would put that
//   knowledge back in the adapter under a different name. It is a peer-read
//   adapter for the composition root to assemble, not this context's store.
//
//   `subject-hasher.ts` is SYNCHRONOUS, returns no `Result`, and its own header
//   says the SALT is "a per-installation SECRET" whose absence must be refused
//   because "are we in production is not a domain question". It writes no row,
//   opens no connection, and a PostgreSQL client is the wrong custodian for a
//   key: `secrets` owns credential material (§1 row 3) and this digest is
//   `node:crypto` over a value that never leaves the process.
//
//   `legal-hold-register.ts` is INSTALLATION CONFIGURATION a human edits between
//   requests — its header says a hold added five minutes ago "has to stop the
//   next erasure without a redeploy" — and there is no canonical row for it. No
//   model in `internal-packages/tenancy-database/prisma/schema.prisma` holds a
//   hold entry, and `scripts/arch/table-ownership.mjs` gives `privacy` exactly
//   two rows. Backing it from here would mean inventing a thirteenth table for a
//   context the ADR gives two, which is a schema decision and not an adapter's
//   to make.

import type { PrivacyRepository } from "@platos/context-privacy/application/ports/index.js";

import { createPrivacyOperationStore } from "./privacy-operations.js";
import { createPrivacyTombstoneStore } from "./privacy-tombstones.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the store over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right fact
 * and the wrong cause.
 */
export function createPrivacyRepository(transactions: TenancyTransactions): PrivacyRepository {
  return {
    ...createPrivacyOperationStore(transactions),
    ...createPrivacyTombstoneStore(transactions),
  };
}
