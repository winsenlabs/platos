// What "one person" means to this context, and how a handle becomes a digest.
//
// A subject is not an id. A subject is a person who can be addressed by several
// handles — an external id, a channel handle, an email, a session, and the
// canonical row id underneath all of them — and an erasure that blocks one while
// the same person walks back in through another is not a barrier. So every rule
// in this package works over an ALIAS SET, never over the id the caller happened
// to name.
//
// TWO NORMALISATIONS, BOTH DELIBERATE
//
// Keyed by (channel, subject) rather than the full (issuer, channel, subject)
// tuple, because issuer strings are constructed differently per write path —
// `channel:slack` on one, `channel:slack:<realm>` on another — so binding to the
// issuer would let the same handle through the other door.
//
// Case-folded, because the write paths do not agree on casing: one stores a
// channel handle verbatim, another lowercases emails. Comparing raw would let
// `Alice@Example.com` back in after `alice@example.com` was erased. Folding can
// in principle block a genuinely different handle that differs only by case;
// that is the safe direction, and it is the direction this whole context leans.
//
// NOTHING HERE HASHES. Composing the digest INPUT is a domain rule — it is what
// makes two installations agree on what a tombstone means — but the digest itself
// needs a per-installation salt, and a secret has no business in a frozen domain
// module. `SubjectHasher` (application/ports) holds the salt and prepends it.

import type { OrganizationId } from "@platos/kernel";

/**
 * The byte that separates digest components: NUL.
 *
 * Built with `String.fromCharCode` rather than written as a literal so this file
 * stays printable ASCII — a source file carrying a raw NUL is treated as binary
 * by the repository's own text tooling.
 *
 * A separator that cannot occur in a handle is what stops `("ab", "c")` and
 * `("a", "bc")` from digesting identically, which would let one erased alias
 * refuse an unrelated one.
 */
export const DIGEST_SEPARATOR = String.fromCharCode(0);

/** Namespaces an alias digest, so an erased email cannot refuse an external id. */
export const ALIAS_DIGEST_NAMESPACE = "alias";

/**
 * Synthetic channel for the canonical end-user row id.
 *
 * Sealed alongside the real handles so an asynchronous writer that captured the
 * row id before the sweep — a tool-call audit, a memory extraction landing
 * minutes later — is checked against the register too.
 */
export const CANONICAL_ALIAS_CHANNEL = "platos:end-user";

/** One handle the subject can be addressed by. */
export interface SubjectAlias {
  /** Identity channel: "external", "session", "slack", "email", … */
  readonly channel: string;
  /** The handle within that channel. */
  readonly subject: string;
}

export function subjectAlias(channel: string, subject: string): SubjectAlias {
  return { channel, subject };
}

/** The alias form of a canonical end-user row id. */
export function canonicalAlias(endUserId: string): SubjectAlias {
  return { channel: CANONICAL_ALIAS_CHANNEL, subject: endUserId };
}

/**
 * Reduce an alias to the one form both sides of the barrier agree on, or reject
 * it.
 *
 * Rejecting the empty forms matters more than it looks: an alias whose subject
 * folds to `""` would digest to a stable value that every subject with a blank
 * handle shares, and one erasure would then refuse writes for all of them.
 */
export function normalizeAlias(alias: SubjectAlias): SubjectAlias | null {
  const channel = alias.channel.trim().toLowerCase();
  const subject = alias.subject.trim().toLowerCase();
  if (channel === "" || subject === "") return null;
  return { channel, subject };
}

/**
 * The digest input for one alias, WITHOUT the salt.
 *
 * The adapter implementing `SubjectHasher` prepends the salt and one separator,
 * so the digested sequence is exactly
 * `salt <sep> organizationId <sep> alias <sep> channel <sep> subject`.
 *
 * Scoped by organization so the same person erased in two tenants does not
 * produce a correlatable value, and namespaced by channel so an erased email
 * address does not also refuse an unrelated external id that happens to be the
 * same string.
 */
export function aliasDigestInput(alias: SubjectAlias, organizationId: OrganizationId): string {
  return [organizationId, ALIAS_DIGEST_NAMESPACE, alias.channel, alias.subject].join(DIGEST_SEPARATOR);
}

/**
 * The digest input for the subject as the CALLER named it — the value that
 * becomes `ErasureOperation.subjectKeyHash`.
 *
 * Not namespaced, and that is not an oversight: this digest is the operation's
 * own identity and is compared only against other subject digests, never against
 * an alias digest. Namespacing it would change a value already written into
 * every persisted receipt.
 */
export function subjectDigestInput(externalUserId: string, organizationId: OrganizationId): string {
  return [organizationId, externalUserId].join(DIGEST_SEPARATOR);
}

/**
 * Normalize, de-duplicate and stably order an alias set.
 *
 * Ordering matters beyond tidiness: two passes over the same person must produce
 * byte-identical alias sets, or a retry is indistinguishable from a new request.
 */
export function normalizeAliases(aliases: readonly SubjectAlias[]): readonly SubjectAlias[] {
  const byKey = new Map<string, SubjectAlias>();
  for (const raw of aliases) {
    const alias = normalizeAlias(raw);
    if (alias === null) continue;
    byKey.set(`${alias.channel}${DIGEST_SEPARATOR}${alias.subject}`, alias);
  }
  return [...byKey.keys()]
    .sort()
    .map((key) => byKey.get(key))
    .filter((alias): alias is SubjectAlias => alias !== undefined);
}

/**
 * The raw handles a legal-hold register is matched against, and the values the
 * content-free guards must refuse to find in anything durable.
 *
 * This is the ONLY function in the context that yields raw handles as a list. It
 * is deliberately one call, so the places that must never touch one are the
 * places that never call it.
 */
export function rawHandles(aliases: readonly SubjectAlias[]): readonly string[] {
  return normalizeAliases(aliases).map((alias) => alias.subject);
}
