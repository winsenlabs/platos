// AccessKey — the per-environment key, and the overlap that makes rotation safe.
//
// Extracted from `internal-packages/tenancy-database/src/access-key.ts`.
//
// THE ENCODING IS NOT OBVIOUS AND IT MATTERS: `validUntil === null` marks
// THE ONE ACTIVE KEY, not a key that never expires. The database carries a
// partial unique index over `(environmentId) WHERE revokedAt IS NULL AND
// validUntil IS NULL`, so "at most one active key per environment" is a
// constraint rather than a convention. Rotation therefore cannot simply insert:
// it must create the incoming key already-retired (`validUntil = now`), retire
// the outgoing one, and only then clear the incoming key's `validUntil`. The
// intermediate state is transaction-local and is what lets the index hold
// throughout.
//
// The OVERLAP is why rotation is not an outage. For 10 minutes both the outgoing
// and incoming key authenticate, so callers holding the old key keep working
// while they pick up the new one. `acceptsRequestAt` is the predicate that makes
// that true, and it is the only place the two states are treated alike.
//
// THE REVOCATION FENCE. A revoke increments `Environment.accessKeyRevocationVersion`
// under the same row lock a rotation takes. A rotation snapshots the generation
// before queueing for the lock, so a revoke that starts later still dominates:
// the rotation observes a changed generation and refuses rather than resurrecting
// a key an operator just destroyed.

import {
  accessKeyRotationSuperseded,
  bootstrapGrantUnavailable,
  invalidAccessKeyMaterial,
} from "./errors.js";
import type { AccessKeyId, TokenHash, UserId } from "./principal.js";
import {
  err,
  ok,
  type EnvironmentId,
  type OrganizationId,
  type ProjectId,
  type Result,
} from "@platos/kernel";

/** 10 minutes, as in the extraction source's `DEFAULT_ROTATION_OVERLAP_MS`. */
export const DEFAULT_ROTATION_OVERLAP_MS = 10 * 60_000;

/** SHA-256, lower-case hex. The raw key is never stored. */
export const ACCESS_KEY_HASH_PATTERN = /^[a-f0-9]{64}$/u;
/** The public, non-secret discriminator shown in the dashboard. */
export const ACCESS_KEY_PREFIX_PATTERN = /^platos_live_[A-Za-z0-9_-]{1,12}$/u;

export interface AccessKeyRecord {
  readonly accessKeyId: AccessKeyId;
  readonly environmentId: EnvironmentId;
  readonly keyPrefix: string;
  readonly keyHash: TokenHash;
  readonly allowedOrigins: readonly string[];
  /** `null` marks THE active key; a future instant marks one inside its overlap. */
  readonly validUntil: Date | null;
  readonly replacedById: AccessKeyId | null;
  readonly revokedAt: Date | null;
  readonly lastUsedAt: Date | null;
}

export interface AccessKeyRotationPlan {
  readonly nextKey: AccessKeyRecord;
  /** The outgoing key, still honoured until its overlap closes. */
  readonly retiringKey: AccessKeyRecord | null;
  readonly overlapEndsAt: Date;
}

export function isActive(key: AccessKeyRecord): boolean {
  return key.revokedAt === null && key.validUntil === null;
}

export function isRetiring(key: AccessKeyRecord, now: Date): boolean {
  return (
    key.revokedAt === null && key.validUntil !== null && key.validUntil.getTime() > now.getTime()
  );
}

/** The one predicate an inbound request is judged by. */
export function acceptsRequestAt(key: AccessKeyRecord, now: Date): boolean {
  return isActive(key) || isRetiring(key, now);
}

/**
 * Browser-origin allow-list. An empty list allows nothing, not everything:
 * an unconfigured key must not become a wildcard by omission.
 */
export function isOriginAllowed(key: AccessKeyRecord, origin: string): boolean {
  return key.allowedOrigins.includes(origin);
}

export function validateRotationMaterial(input: {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly overlapMs: number;
}): Result<{ readonly keyHash: TokenHash; readonly keyPrefix: string; readonly overlapMs: number }> {
  if (!ACCESS_KEY_HASH_PATTERN.test(input.keyHash)) return err(invalidAccessKeyMaterial("keyHash"));
  if (!ACCESS_KEY_PREFIX_PATTERN.test(input.keyPrefix)) {
    return err(invalidAccessKeyMaterial("keyPrefix"));
  }
  if (!Number.isSafeInteger(input.overlapMs) || input.overlapMs <= 0) {
    return err(invalidAccessKeyMaterial("overlapMs"));
  }
  return ok({ keyHash: input.keyHash as TokenHash, keyPrefix: input.keyPrefix, overlapMs: input.overlapMs });
}

/** The rotation is refused when a revoke has moved the generation under it. */
export function assertGenerationUnchanged(observed: number, current: number): Result<number> {
  if (observed !== current) return err(accessKeyRotationSuperseded());
  return ok(current);
}

/**
 * Compute the two rows a rotation writes.
 *
 * With no active key this is a first install and there is nothing to retire.
 * With one, the outgoing key is given a closing instant and a forward pointer to
 * its replacement, so an operator can see what superseded what.
 */
export function planRotation(input: {
  readonly active: AccessKeyRecord | null;
  readonly nextKeyId: AccessKeyId;
  readonly environmentId: EnvironmentId;
  readonly keyHash: TokenHash;
  readonly keyPrefix: string;
  readonly overlapMs: number;
  readonly now: Date;
}): AccessKeyRotationPlan {
  const overlapEndsAt = new Date(input.now.getTime() + input.overlapMs);
  const nextKey: AccessKeyRecord = {
    accessKeyId: input.nextKeyId,
    environmentId: input.environmentId,
    keyPrefix: input.keyPrefix,
    keyHash: input.keyHash,
    allowedOrigins: input.active?.allowedOrigins ?? [],
    validUntil: null,
    replacedById: null,
    revokedAt: null,
    lastUsedAt: null,
  };
  if (input.active === null) return { nextKey, retiringKey: null, overlapEndsAt };
  return {
    nextKey,
    retiringKey: { ...input.active, validUntil: overlapEndsAt, replacedById: input.nextKeyId },
    overlapEndsAt,
  };
}

/**
 * Re-presenting the same key material must not rotate again.
 *
 * A retried request whose response was lost would otherwise retire the key it
 * just installed and hand back a third one, walking the environment down a chain
 * of rotations it never asked for.
 */
export function isRotationReplay(active: AccessKeyRecord | null, keyHash: TokenHash): boolean {
  return active !== null && active.keyHash === keyHash;
}

// ---------------------------------------------------------------------------
// AccessKeyBootstrapGrant — the one-use first-install credential.
//
// A fresh install has zero AccessKeys and must mint the FIRST one over the
// trusted direct-header channel. Rather than let the broad server-only internal
// token stand in as the first-operator credential, an operator may set a narrow
// one-time install secret that authorizes exactly one key per environment.
//
// THE ROW IS THE CONSUME RECORD. `environmentId` is UNIQUE, so the first writer
// wins and every concurrent or later writer collides. That is a single-winner
// guarantee that does not depend on a check-then-set race — which is why the
// rule below is a classification of observed state and not a lock.
//
// Only the FINGERPRINT of the presented secret is kept, never the secret, so a
// forensic correlation is possible and a store compromise yields nothing usable.
// ---------------------------------------------------------------------------

export interface AccessKeyBootstrapGrantRecord {
  readonly environmentId: EnvironmentId;
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly actorUserId: UserId | null;
  /** SHA-256 of the presented install secret. Never the secret. */
  readonly tokenFingerprint: TokenHash;
  readonly source: string | null;
  readonly consumedAt: Date;
}

export type BootstrapVerdict = "permitted" | "already-provisioned" | "already-consumed";

/**
 * Whether a first-install mint may proceed.
 *
 * An existing active key is checked FIRST: once an environment has a key the
 * path self-disables regardless of the grant, so a grant left lying around after
 * a normal provisioning cannot be spent as a second front door.
 */
export function classifyBootstrap(input: {
  readonly activeKey: AccessKeyRecord | null;
  readonly existingGrant: AccessKeyBootstrapGrantRecord | null;
}): BootstrapVerdict {
  if (input.activeKey !== null) return "already-provisioned";
  if (input.existingGrant !== null) return "already-consumed";
  return "permitted";
}

export function assertBootstrapPermitted(input: {
  readonly activeKey: AccessKeyRecord | null;
  readonly existingGrant: AccessKeyBootstrapGrantRecord | null;
}): Result<BootstrapVerdict> {
  const verdict = classifyBootstrap(input);
  if (verdict !== "permitted") return err(bootstrapGrantUnavailable());
  return ok(verdict);
}

export function revokedKey(key: AccessKeyRecord, now: Date): AccessKeyRecord {
  return { ...key, revokedAt: now };
}

export function withAllowedOrigins(
  key: AccessKeyRecord,
  origins: readonly string[],
): AccessKeyRecord {
  return { ...key, allowedOrigins: [...origins] };
}
