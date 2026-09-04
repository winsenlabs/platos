// The write barrier — the read side of the erased-subject register.
//
// This is the hot path. Every identity chokepoint in the system calls it before
// resolving or minting a subject, because an erasure that nothing consults is
// undone by the next request: the chokepoint finds no row, mints a fresh one,
// and the person the receipt says was destroyed exists again under a new id the
// receipt cannot see.
//
// Called at the identity chokepoints rather than at every table, because every
// subject-keyed row hangs off an id one of those chokepoints produced. Refusing
// there refuses the rows downstream of it too.
//
// FAIL CLOSED, ON BOTH FAILURES
//
// A matched tombstone is `PRIVACY_SUBJECT_ERASED`. A register that could not be
// consulted is `PRIVACY_ERASURE_REGISTER_UNAVAILABLE`. They mean opposite things
// about the subject and are reported separately so an operator can tell "we
// blocked a resurrection" from "we lost the ability to tell" — but they are
// identical in effect, because both REFUSE the write. A barrier that opens under
// load is not a barrier: a failed turn is recoverable, a resurrected subject is
// not.
//
// AN EMPTY ALIAS SET IS ALLOWED THROUGH, and that is not a hole. It means the
// caller presented nothing that could identify anyone — there is no subject to
// have erased. The dangerous version of this is an alias set that normalizes
// away to nothing, which `aliasHashes` drops rather than digesting; a blank
// handle must not be sealable in the first place, which is why the rule lives in
// `normalizeAlias` rather than here.

import { err, ok, type Result } from "@platos/kernel";

import {
  activeTombstones,
  erasureRegisterUnavailable,
  subjectErased,
  type AliasHash,
} from "../domain/index.js";
import type { PrivacyDependencies } from "./dependencies.js";
import { aliasHashes } from "./subject-digests.js";
import type { SubjectWriteCheck } from "../contracts/index.js";

async function lookup(
  dependencies: PrivacyDependencies,
  check: SubjectWriteCheck,
): Promise<Result<readonly AliasHash[]>> {
  const hashes = aliasHashes(dependencies.hasher, check.organizationId, check.aliases);
  if (hashes.length === 0) return ok([]);

  const now = dependencies.clock.now();
  const found = await dependencies.repository.findActiveTombstones(check.organizationId, hashes, now);
  if (!found.ok) return err(erasureRegisterUnavailable(found.error.code));

  // Expiry is applied here as well as in the repository. The retention rule has
  // to hold whether or not anything sweeps AND whether or not an implementation
  // remembered to filter — a barrier that trusted its store to have done it
  // would refuse writes for a subject whose tombstone lapsed a month ago.
  return ok(activeTombstones(found.value, now).map((tombstone) => tombstone.aliasHash));
}

/**
 * Refuse the write if any presented alias belongs to an erased subject.
 *
 * Fails on ANY failure, including a failure to ask.
 */
export async function assertSubjectNotErased(
  dependencies: PrivacyDependencies,
  check: SubjectWriteCheck,
): Promise<Result<void>> {
  const matched = await lookup(dependencies, check);
  if (!matched.ok) return err(matched.error);
  if (matched.value.length > 0) return err(subjectErased(check.organizationId));
  return ok(undefined);
}

/**
 * Which of these aliases belong to an erased subject.
 *
 * The batch form, for the one caller that has to decide row by row rather than
 * refuse a single write: the outbox drain, which holds a full batch of queued
 * projections and must drop the erased subjects' rows while delivering everyone
 * else's. Asking per row would be one query per queued turn.
 *
 * Returns the ERASED subset as digests, which are content-free — the caller
 * digests its own aliases and looks its rows up in the result. Nothing
 * reversible crosses this boundary in either direction.
 *
 * Fails when the register cannot be consulted, for the same reason
 * `assertSubjectNotErased` does: "we lost the ability to tell" must never read
 * as "nobody here is erased", and a caller handed an empty set would deliver
 * every row in the batch.
 */
export async function erasedAliases(
  dependencies: PrivacyDependencies,
  check: SubjectWriteCheck,
): Promise<Result<readonly AliasHash[]>> {
  return lookup(dependencies, check);
}
