// The FOURTEENTH adapter directory: identity-access's one KEYLESS cryptography
// port, behind one object.
//
// WHY IT IS NOT `keyring-envelope`. That directory's own header explains why
// `secrets`' `Hasher` sits beside the root key ring — "the cost parameter that
// decides how expensive an offline search against `Credential.secretHash` is
// belongs with the keys, not with the store that holds the digest". Every clause
// of that argument fails here. `SecretHasher` has NO cost parameter and can
// never acquire one, because the port is synchronous and the secrets it digests
// are 256-bit random tokens rather than human-chosen passwords; and it holds no
// key material at all, so there is nothing for a custodian to be custodian OF.
// Putting a keyless digest inside the one directory ADR M0.3 §15 sets aside for
// AES-256 root key bytes would widen the blast radius of that directory for no
// property in return. It would also not TYPE: `Hasher.hash` and
// `SecretHasher.hash` are two different signatures under one name, so the flat
// `extends KeyRing, AeadCipher, Hasher` shape that directory uses cannot take a
// fourth port that collides with its first.
//
// WHY IT IS NOT `postgres-tenancy` EITHER, which is where §15 sends a new
// binding by default. §15's rule is about ONE VENDOR CLIENT: seventeen contexts'
// repositories share that directory because they share a PostgreSQL connection.
// This holds no client and opens no connection. It is `node:crypto`, and a
// digest computed inside the process that also holds the database pool is a
// digest whose only tie to that pool is that the same process happens to run
// both.
//
// WHAT AN INSTALL WIRES. Nothing. There is no configuration group for this
// directory and there never will be — a SHA-256 has no key, no endpoint, no
// credential and no failure mode an operator can fix. `constructAdapters` builds
// it unconditionally for that reason, and `installation.test.ts` records it as
// the second directory that no configuration group produces.

import type { SecretHasher } from "@platos/context-identity-access/application/ports/index.js";

import { createSecretHasher } from "./secret-hasher.js";

export interface NodeCryptoDigestAdapter extends SecretHasher {
  readonly adapterName: "node-crypto-digest";
}

/**
 * Build the adapter.
 *
 * No `Result` and no arguments, and both absences are the claim. Every other
 * constructor in `packages/adapters/` can fail: a key ring can be malformed, a
 * connection string can be unparseable, a model route can name a provider that
 * is not configured. This one reads nothing, so there is no configuration it
 * could refuse, and a `Result` here would be a failure channel that no input
 * could ever reach — an unfalsifiable branch, which is the shape this repository
 * has a rule about.
 */
export function createNodeCryptoDigestAdapter(): NodeCryptoDigestAdapter {
  const hasher = createSecretHasher();
  return {
    adapterName: "node-crypto-digest",
    hash: hasher.hash,
    equals: hasher.equals,
    deriveCodeChallenge: hasher.deriveCodeChallenge,
  };
}
