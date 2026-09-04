// The `SubjectHasher` port — where the salt lives.
//
// Composing a digest INPUT is a domain rule: it is what makes two installations
// agree on what a tombstone means, and `domain/alias.ts` owns it. Producing the
// digest is not, because it needs a per-installation SECRET, and a secret has no
// business in a frozen domain module or in a policy object that gets logged.
//
// So the split is: the domain hands over a NUL-separated composition of
// non-secret parts, and this port prepends the salt and digests the result. The
// digested sequence is exactly
//
//   salt <NUL> organizationId <NUL> alias <NUL> channel <NUL> subject
//
// for an alias, and `salt <NUL> organizationId <NUL> externalUserId` for the
// subject key. An implementation that changed the prefix, the separator or the
// order would silently invalidate every tombstone already sealed — the register
// would stop matching and erased subjects would become writable again — so the
// composition is fixed by the domain and this port contributes only the salt.
//
// The salt is MANDATORY in a live installation. An unsalted digest of an email is
// reversible with a wordlist, which would turn the register from a barrier
// protecting erased people into a directory of them. Enforcing that is the
// adapter's job, because "are we in production" is not a domain question.
//
// SYNCHRONOUS AND PURE. Digesting is CPU work with no I/O, and making it
// synchronous keeps the alias-set composition a single expression rather than a
// loop of awaits — which is also what lets the barrier be exercised in memory
// with a deterministic double.

import type { AliasHash, SubjectKeyHash } from "../../domain/index.js";

export interface SubjectHasher {
  /**
   * Salt, then digest, one composed input.
   *
   * MUST be deterministic for a given input and MUST NOT be reversible. Callers
   * pass the output of `aliasDigestInput` or `subjectDigestInput` and nothing
   * else; passing a raw handle here would produce a value that matches nothing
   * and looks exactly like one that does.
   */
  digest(input: string): string;
}

/** Tag a digest as an alias hash. The composition is the caller's assertion. */
export function asAliasHash(digest: string): AliasHash {
  return digest as AliasHash;
}

/** Tag a digest as the operation's subject key. */
export function asSubjectKeyHash(digest: string): SubjectKeyHash {
  return digest as SubjectKeyHash;
}
