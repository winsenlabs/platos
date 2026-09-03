// Turning a person into the only form of them this context may write down.
//
// Every durable value here is a digest. The composition is a domain rule
// (`domain/alias.ts`), the salt is behind a port (`ports/subject-hasher.ts`),
// and this module is the one place the two meet. Keeping it to one module is
// what makes "did anything hash a raw handle by hand" a question with a
// one-file answer.

import type { OrganizationId } from "@platos/kernel";

import {
  aliasDigestInput,
  normalizeAliases,
  subjectDigestInput,
  type AliasHash,
  type SubjectAlias,
  type SubjectKeyHash,
} from "../domain/index.js";
import { asAliasHash, asSubjectKeyHash, type SubjectHasher } from "./ports/index.js";

/**
 * Digest an alias set, de-duplicated and stably ordered.
 *
 * Ordering survives the digest because `normalizeAliases` orders the aliases
 * themselves: two passes over the same person produce byte-identical hash lists,
 * which is what lets a re-seal be recognised as a re-seal.
 *
 * Aliases that normalize away — a blank channel, a whitespace-only handle — are
 * dropped rather than digested. A blank handle would produce a stable digest
 * that every subject with a blank handle shares, and sealing it would refuse
 * writes for all of them.
 */
export function aliasHashes(
  hasher: SubjectHasher,
  organizationId: OrganizationId,
  aliases: readonly SubjectAlias[],
): readonly AliasHash[] {
  return normalizeAliases(aliases).map((alias) =>
    asAliasHash(hasher.digest(aliasDigestInput(alias, organizationId))),
  );
}

/** The operation's own identity: the digest of the handle the caller named. */
export function subjectKeyHash(
  hasher: SubjectHasher,
  organizationId: OrganizationId,
  externalUserId: string,
): SubjectKeyHash {
  return asSubjectKeyHash(hasher.digest(subjectDigestInput(externalUserId, organizationId)));
}

/**
 * The digest of one legal-hold register entry.
 *
 * Uses the SUBJECT composition, not the alias one: a hold entry is a handle an
 * operator wrote, with no channel attached, so there is no channel to namespace
 * it by. It is only ever truncated into a reference, never compared against a
 * tombstone, so the two digest spaces never meet.
 */
export function holdEntryDigest(
  hasher: SubjectHasher,
  organizationId: OrganizationId,
  entry: string,
): string {
  return hasher.digest(subjectDigestInput(entry, organizationId));
}
