// `secrets`' TWO canonical-store ports, in the one directory ADR M0.3 §15 gives
// the ORM.
//
// TWO PORTS, TWO OBJECTS, ONE CONNECTION. `SecretsRepository` and
// `EnvironmentVariableRepository` are separate interfaces because
// `environment-variable-repository.ts` says they are: "so the two aggregates
// keep separate vocabularies, and so a composition root may back them with
// different stores without either port growing a conditional". They are
// nonetheless built from the SAME `TenancyTransactions`, because
// `setEnvironmentVariable` seals a credential, writes an envelope, points the
// credential at it, writes the variable row and appends two audit records inside
// ONE `UnitOfWork.run` — and two `TenancyTransactions` would make the variable
// row's write invisible to the `countReferences` that decides whether to revoke.
//
// THEY ARE NOT SPREAD INTO `PostgresTenancyAdapter`, AND THAT IS FORCED RATHER
// THAN CHOSEN. Every other composite in this directory is spread in flat so the
// composition root can resolve `Satisfies<PostgresTenancyAdapter, Port>` at
// compile time. `SecretsRepository.appendAudit(draft, transaction)` and
// `ToolsRepository.appendAudit(scope, entry)` are BOTH top-level members with
// the same name and different signatures, so an interface extending both is a
// TypeScript error — "cannot simultaneously extend" — and a spread would have
// silently let whichever came last win. The two stores are therefore named
// PROPERTIES, exactly as tranche 3 did for tenancy's five non-repository ports,
// and the composition root proves each binding by indexing the property that
// carries it.
//
// WHAT IS NOT HERE, AND WHY. `secrets` declares FIVE driven ports and this
// satisfies TWO of them.
//
//   `KeyRing` holds ROOT KEY BYTES. ADR M0.3 §1 row 3 makes this context the
//   only holder of data-encryption keys, and `domain/key-ring.ts` records that
//   the extraction source loads the ring from `PLATOS_CREDENTIAL_ROOT_KEYS`.
//   Putting it here would move the keys that decrypt every envelope into the
//   process that holds the database connection, so a single credential leak
//   would yield both halves. It belongs to a key-management adapter.
//
//   `AeadCipher` is cryptography, not storage. It writes no canonical row —
//   `insertSecretVersion` above stores the envelope the cipher already made —
//   and it owns randomness: `crypto.ts`'s own header says "the port owns
//   randomness: `seal` produces the salt and the nonce, so no caller can supply
//   a reused one". A store implementing it would be a store with an entropy
//   source.
//
//   `Hasher` is the same argument one column over. It exists for the
//   transitional `Credential.secretHash` verifier the schema flags, it must be
//   constant-time, and it writes nothing.
//
// None of the three is a canonical store, so none is `CANONICAL_STORE_ADAPTERS`'
// business and none belongs behind the sole-writer delegation this tranche adds.

import type {
  EnvironmentVariableRepository,
  SecretsRepository,
} from "@platos/context-secrets/application/ports/index.js";

import { createEnvironmentVariableStore } from "./secrets-variables.js";
import { createSecretsCredentialStore } from "./secrets-credentials.js";
import { createSecretsVersionStore } from "./secrets-versions.js";
import type { TenancyTransactions } from "./transaction.js";

/**
 * Build the vault's repository over already-open transaction machinery.
 *
 * It takes `TenancyTransactions` rather than a client for the reason every other
 * composite in this package does: a caller that built its own would get a second
 * `AsyncLocalStorage` frame, and a write carrying a scope minted by one would be
 * refused by the other with `scope_unknown` — a refusal that names the right
 * fact and the wrong cause.
 */
export function createSecretsRepository(transactions: TenancyTransactions): SecretsRepository {
  return {
    ...createSecretsCredentialStore(transactions),
    ...createSecretsVersionStore(transactions),
  };
}

/** The sibling port over `EnvironmentVariable`, on the same transactions. */
export function createEnvironmentVariableRepository(
  transactions: TenancyTransactions,
): EnvironmentVariableRepository {
  return createEnvironmentVariableStore(transactions);
}
