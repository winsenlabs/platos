// `providers`' canonical-store port, in the one directory ADR M0.3 §15 gives the
// ORM.
//
// THREE STORES, ONE OBJECT, ONE CONNECTION. `ProviderKey` is in
// `providers-keys.ts`, `EnvironmentProvider` in `providers-links.ts`, `Model`
// and `ModelPrice` in `providers-catalogue.ts`. The split is by SCOPING REGIME
// rather than by method count, because the port itself is split that way and
// says so: the first two are environment-scoped and every read takes a scope;
// the last two are installation-global and have none. Keeping them in one file
// would have put a method with a scope parameter next to one without and made
// the missing parameter look like an oversight.
//
// AND ONE TRANSACTION WITH THE EIGHT OWNERS ALREADY IN THIS DIRECTORY.
// `providers` is the NINTH, on the sentence none of the eight changed: one
// PostgreSQL database is one client is one adapter DIRECTORY (ADR M0.3 §15).
// Nine owners resolving to one directory is not nine owners losing their
// boundaries — ownership is carried by the owner TAG on the row and
// `sole-writer.mjs` asks, per WRITE, whether this directory is one of
// `ownerDirectories(OWNER[model])`. A write to `Memory` from here still fails.
//
// AND IT IS WHAT MAKES `register-provider-key.ts` ATOMIC AT ALL. That use case
// creates a `Credential` and its first `CredentialSecretVersion` through
// `secrets`, and then writes the `ProviderKey` that points at them, in ONE
// `UnitOfWork.run`. `secrets` was delegated to this directory by the tranche
// before this one, so both halves are the same client and the same transaction;
// a thirteenth adapter package holding only `providers`' repository would have
// had its own pool, and `ProviderKey_credential_provider_integrity` — a BEFORE
// INSERT trigger that RE-READS the credential from inside the key's write —
// would have looked for a row that was still uncommitted on another connection
// and refused a key that was correct. That is the same shape as the
// `EnvironmentVariable` seam one tranche back, one table over.
//
// WHAT IS NOT HERE, AND WHY. `providers` declares THREE driven ports and this
// satisfies ONE of them.
//
//   `ModelRouter` is the provider SDK boundary. ADR M0.3 §1 row 4 makes this
//   context "sole holder of provider SDKs behind `ModelRouter`" and §5.1 rule
//   (h) pins the implementation to `packages/adapters/model-router-providers`,
//   which `ADAPTER_BINDINGS` already names. It writes no canonical row — its own
//   header says the credential is "supplied per call and never stored" — so it
//   is not `CANONICAL_STORE_ADAPTERS`' business, and satisfying it from the
//   package that holds the database connection would put an outbound HTTP client
//   inside the canonical store.
//
//   `ProviderProbeCache` is a cache, and its own header records that it exists
//   because §13's map has no home for it. It stores "a liveness result for five
//   minutes and a model list for ten"; backing that with the canonical store
//   would mean writing a provider's transient answers into the database this
//   port exists to keep them out of, and would undo the reason the port was
//   introduced — that without it "every page load calls every configured
//   provider" — by replacing one hot-path cost with another.

import type { ProvidersRepository } from "@platos/context-providers/application/ports/index.js";

import { createProviderCatalogueStore } from "./providers-catalogue.js";
import { createProviderKeyStore } from "./providers-keys.js";
import { createProviderLinkStore } from "./providers-links.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the repository over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every other
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right fact
 * and the wrong cause. Here it is also the only way `touchProviderKey` can be
 * correct: it needs the POOL rather than the ambient transaction, and
 * `TenancyTransactions.pool()` is where that distinction lives.
 */
export function createProvidersRepository(
  transactions: TenancyTransactions,
): ProvidersRepository {
  return {
    ...createProviderKeyStore(transactions),
    ...createProviderLinkStore(transactions),
    ...createProviderCatalogueStore(transactions),
  };
}
