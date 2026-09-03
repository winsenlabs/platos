// Resolving a handle into a person, and asking whether they may be erased.
//
// Two questions that always travel together, because getting either one from a
// narrower input than the other is how a subject slips through: a hold
// registered under someone's Slack handle must stop an erasure requested under
// their email, and a barrier sealed from the requested id alone lets the same
// person back in through every other alias.
//
// So the alias set is resolved ONCE, and both the hold match and the seal are
// driven from it.
//
// THE HOLD REGISTER IS READ SERVER-SIDE, EVERY TIME. A caller-supplied hold id
// still wins if present, but it can only ADD: a caller who knows of no hold must
// not be able to erase a subject the register protects, which is precisely the
// knowledge a register exists because people do not reliably have.
//
// `handles` IS THE ONE PLACE RAW IDENTIFIERS LIVE. It exists so the content-free
// guards have something to search for, and it is never persisted, never logged,
// and never put in an error. Every other value on the resolved context is a
// digest, a count, or a scope.

import { err, ok, type ErasureSubject, type OrganizationId, type Result, type TenantScope } from "@platos/kernel";

import {
  findLegalHold,
  legalHoldReference,
  rawHandles,
  subjectDirectoryUnavailable,
  legalHoldRegisterUnavailable,
  type SubjectAlias,
  type SubjectKeyHash,
} from "../domain/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { holdEntryDigest, subjectKeyHash } from "./subject-digests.js";

export interface ResolvedSubjectContext {
  readonly subjectKeyHash: SubjectKeyHash;
  readonly subjects: readonly ErasureSubject[];
  readonly aliases: readonly SubjectAlias[];
  /** Raw handles, for the content-free guards and the hold match. Never stored. */
  readonly handles: readonly string[];
  readonly scopes: readonly TenantScope[];
  /** A register position plus a truncated digest, or null. Never an entry. */
  readonly legalHoldPolicyId: string | null;
}

/** Distinct scopes the subject occupies, de-duplicated by the kernel's path. */
function scopesOf(subjects: readonly ErasureSubject[]): readonly TenantScope[] {
  const byKey = new Map<string, TenantScope>();
  for (const subject of subjects) {
    const scope = subject.scope;
    const key = `${scope.level}:${JSON.stringify(scope)}`;
    byKey.set(key, scope);
  }
  return [...byKey.values()];
}

export async function resolveSubjectContext(
  dependencies: PrivacyDependencies,
  args: {
    readonly organizationId: OrganizationId;
    readonly externalUserId: string;
    /** A hold the caller already knows about. Adds to the register's answer. */
    readonly callerHoldPolicyId?: string | null;
  },
): Promise<Result<ResolvedSubjectContext>> {
  const digest = subjectKeyHash(dependencies.hasher, args.organizationId, args.externalUserId);

  const resolved = await dependencies.directory.resolve({
    organizationId: args.organizationId,
    externalUserId: args.externalUserId,
  });
  if (!resolved.ok) return err(subjectDirectoryUnavailable(resolved.error.code));

  const register = await dependencies.holds.entries(args.organizationId);
  if (!register.ok) return err(legalHoldRegisterUnavailable(register.error.code));

  // The requested id joins the alias handles: a hold, and a leak guard, must
  // both cover the value the caller named even when the directory resolved
  // nobody by it.
  const handles = [args.externalUserId, ...rawHandles(resolved.value.aliases)];
  const match = findLegalHold(handles, register.value);
  const found =
    match === null
      ? null
      : legalHoldReference(match, holdEntryDigest(dependencies.hasher, args.organizationId, match.value));

  return ok({
    subjectKeyHash: digest,
    subjects: resolved.value.subjects,
    aliases: resolved.value.aliases,
    handles,
    scopes: scopesOf(resolved.value.subjects),
    legalHoldPolicyId: args.callerHoldPolicyId ?? found,
  });
}
