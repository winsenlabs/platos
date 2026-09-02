// The erased-subject register — the write barrier that keeps an erasure erased.
//
// THE DEFECT THIS EXISTS TO FIX
//
// A sweep deletes rows and returns. Nothing else in the runtime knows an erasure
// happened, so the next write recreates the person: an identity chokepoint
// resolves the tuple, finds none, and mints a fresh subject under a NEW id the
// finished receipt cannot see. A browser tab still holding a valid session, or
// an inbound channel message, rebuilds the subject on its next turn.
//
// A receipt that says "completed" while the next request restores the subject is
// a false legal statement. So erasure leaves something behind: a tombstone per
// ALIAS, consulted before any identity may be resolved or minted.
//
// FOUR PROPERTIES, EACH LOAD-BEARING
//
// 1. EVERY ALIAS, NOT THE REQUESTED ONE. Sealed from the subject's whole alias
//    set, including handles already disabled — the sweep deletes those rows too.
//    See `domain/alias.ts`.
//
// 2. CONTENT-FREE. A register of raw handles would recreate, in a new table,
//    exactly the personal data the operation destroyed. A row holds only the
//    salted, organization-scoped digest, so the register is no more reversible
//    than the receipt.
//
// 3. FAIL CLOSED. If the lookup cannot run, the write is REFUSED, not allowed. A
//    barrier that opens under load is not a barrier; a failed turn is
//    recoverable, a resurrected subject is not. That rule lives at the use case
//    (`application/guard-subject-write.ts`) because it is about a failed port
//    call, but it is stated here because it is a property of the register.
//
// 4. BOUNDED. A tombstone lives for `PrivacyBarrierPolicy.tombstoneTtlDays` from
//    the moment the subject was sealed, and EXPIRY IS APPLIED AT READ TIME — the
//    rule holds whether or not anything sweeps. `purgeExpired` is therefore an
//    optimisation, never a correctness dependency.
//
// SEALING RUNS BEFORE THE TARGETS, NOT AFTER. Sealing first closes the mid-sweep
// window — a turn landing while a target is still working is refused rather than
// writing rows the later targets will never look for — and it is the only point
// at which the identity rows enumerating the aliases still exist. The
// consequence is deliberate: if the pass then fails, the subject stays sealed
// while the operation awaits retry. Refusing writes for someone whose erasure is
// half-finished is the direction that cannot produce an unrecoverable outcome.

import type { OrganizationId } from "@platos/kernel";

import type { AliasHash, ErasureOperationId, ErasureTombstoneId } from "./identifiers.js";

/** One row of `ErasureTombstone`. */
export interface ErasureTombstone {
  readonly tombstoneId: ErasureTombstoneId;
  readonly organizationId: OrganizationId;
  /** Salted, organization-scoped digest of one alias. Never a raw handle. */
  readonly aliasHash: AliasHash;
  /** The operation that sealed it, so a barrier can be traced to its cause. */
  readonly operationId: ErasureOperationId;
  readonly policyVersion: string;
  readonly sealedAt: Date;
  readonly expiresAt: Date;
}

/** Everything a tombstone needs except its own id, which the use case mints. */
export interface TombstoneDraft {
  readonly organizationId: OrganizationId;
  readonly aliasHash: AliasHash;
  readonly operationId: ErasureOperationId;
  readonly policyVersion: string;
  readonly sealedAt: Date;
  readonly expiresAt: Date;
}

/** When a tombstone sealed at `sealedAt` stops refusing writes. */
export function tombstoneExpiry(sealedAt: Date, ttlMs: number): Date {
  return new Date(sealedAt.getTime() + ttlMs);
}

/**
 * Whether a tombstone still refuses writes.
 *
 * STRICTLY greater than `now`: a row whose expiry is exactly the current instant
 * has elapsed. `hasElapsed` is its exact complement, and `purgeExpired` deletes
 * precisely the rows `hasElapsed` reports — so the read rule and the sweep rule
 * cannot disagree about the boundary instant.
 */
export function isActive(tombstone: Pick<ErasureTombstone, "expiresAt">, now: Date): boolean {
  return tombstone.expiresAt.getTime() > now.getTime();
}

export function hasElapsed(tombstone: Pick<ErasureTombstone, "expiresAt">, now: Date): boolean {
  return !isActive(tombstone, now);
}

/** The subset of a register that still refuses writes, in input order. */
export function activeTombstones(
  tombstones: readonly ErasureTombstone[],
  now: Date,
): readonly ErasureTombstone[] {
  return tombstones.filter((tombstone) => isActive(tombstone, now));
}

/**
 * Compose the rows for one seal.
 *
 * Callers pass already-digested aliases: this module never sees a handle. The
 * drafts come back in the order the hashes arrived, which `normalizeAliases`
 * has already made stable, so a re-seal on retry produces an identical set.
 */
export function draftTombstones(args: {
  readonly organizationId: OrganizationId;
  readonly operationId: ErasureOperationId;
  readonly policyVersion: string;
  readonly aliasHashes: readonly AliasHash[];
  readonly sealedAt: Date;
  readonly ttlMs: number;
}): readonly TombstoneDraft[] {
  const expiresAt = tombstoneExpiry(args.sealedAt, args.ttlMs);
  const seen = new Set<string>();
  const drafts: TombstoneDraft[] = [];
  for (const aliasHash of args.aliasHashes) {
    if (seen.has(aliasHash)) continue;
    seen.add(aliasHash);
    drafts.push({
      organizationId: args.organizationId,
      aliasHash,
      operationId: args.operationId,
      policyVersion: args.policyVersion,
      sealedAt: args.sealedAt,
      expiresAt,
    });
  }
  return drafts;
}

/**
 * The outcome of one seal.
 *
 * `sealed` counts rows that did not exist; `extended` counts rows that did and
 * had their expiry pushed out. The two are reported separately because a re-seal
 * on retry legitimately creates nothing, and a seal that reports `sealed: 0`
 * with `extended: 0` means the alias set was empty — which is a different fact
 * worth failing on.
 */
export interface SealOutcome {
  readonly aliases: number;
  readonly sealed: number;
  readonly extended: number;
  readonly purged: number;
}
