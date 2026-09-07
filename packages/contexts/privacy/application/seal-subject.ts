// Sealing a subject — the write side of the erased-subject register.
//
// RUNS BEFORE THE TARGETS, NOT AFTER, and in its OWN transaction.
//
// Before, because sealing first closes the mid-sweep window: a turn landing
// while a target is still working is refused, rather than writing rows the later
// targets will never look for. And because it is the only point at which the
// identity rows enumerating the aliases still exist — the targets are about to
// delete them.
//
// In its own transaction, because the barrier must survive a destructive pass
// that rolls back. If sealing shared the destruction transaction, a rejected
// target would un-seal the subject at exactly the moment the operation is left
// half-finished and most in need of the barrier.
//
// The consequence is deliberate: if the pass then fails, the subject stays
// sealed while the operation awaits retry. Refusing writes for someone whose
// erasure is half-finished is the direction that cannot produce an
// unrecoverable outcome. The tombstone's TTL bounds how long that can last even
// if nobody ever retries.

import { asIdentifier, err, ok, runResult, type OrganizationId, type Result } from "@platos/kernel";

import {
  draftTombstones,
  operationStoreUnavailable,
  tombstoneTtlMs,
  type AliasHash,
  type ErasureOperationId,
  type ErasureTombstoneId,
  type SealOutcome,
  type SubjectAlias,
} from "../domain/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { aliasHashes } from "./subject-digests.js";

export interface SealSubjectCommand {
  readonly organizationId: OrganizationId;
  readonly operationId: ErasureOperationId;
  readonly aliases: readonly SubjectAlias[];
}

/**
 * Record a tombstone for every alias the subject can be reached by.
 *
 * Insert-then-extend, never delete-then-insert: a re-seal on retry must not
 * leave the barrier momentarily open. The repository owns that ordering; this
 * use case owns which aliases and for how long.
 *
 * Purging elapsed rows opportunistically keeps the table trimmed without
 * depending on a scheduler, and cannot affect correctness — the read side
 * already ignores elapsed rows.
 */
export async function sealSubject(
  dependencies: PrivacyDependencies,
  command: SealSubjectCommand,
): Promise<Result<SealOutcome>> {
  const hashes: readonly AliasHash[] = aliasHashes(
    dependencies.hasher,
    command.organizationId,
    command.aliases,
  );
  const now = dependencies.clock.now();
  if (hashes.length === 0) {
    return ok({ aliases: 0, sealed: 0, extended: 0, purged: 0 });
  }

  const drafts = draftTombstones({
    organizationId: command.organizationId,
    operationId: command.operationId,
    policyVersion: dependencies.policy.version,
    aliasHashes: hashes,
    sealedAt: now,
    ttlMs: tombstoneTtlMs(dependencies.policy),
  });
  const ids = drafts.map(() => asIdentifier<ErasureTombstoneId>(dependencies.ids.uuid()));

  return runResult(dependencies.unitOfWork, async (transaction) => {
    const sealed = await dependencies.repository.sealTombstones(drafts, ids, transaction);
    if (!sealed.ok) return err(operationStoreUnavailable(sealed.error.code));
    const purged = await dependencies.repository.purgeExpiredTombstones(now, transaction);
    return ok({
      aliases: drafts.length,
      sealed: sealed.value.sealed,
      extended: sealed.value.extended,
      // A purge that failed is not a sealing failure: the seal is committed and
      // the register is correct either way. Report zero rather than losing the
      // seal to a housekeeping error.
      purged: purged.ok ? purged.value : 0,
    });
  });
}

/**
 * Drop tombstones past their retention window, on demand.
 *
 * Published separately because an installation may want it on a schedule rather
 * than only when something is sealed. It is never load-bearing: the read side
 * ignores elapsed rows, so this only stops the table growing.
 */
export async function purgeExpiredTombstones(
  dependencies: PrivacyDependencies,
): Promise<Result<number>> {
  const now = dependencies.clock.now();
  return runResult(dependencies.unitOfWork, async (transaction) => {
    const purged = await dependencies.repository.purgeExpiredTombstones(now, transaction);
    if (!purged.ok) return err(operationStoreUnavailable(purged.error.code));
    return ok(purged.value);
  });
}
