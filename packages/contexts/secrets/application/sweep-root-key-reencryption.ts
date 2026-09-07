// Rotation as a JOB, not as a request-time loop.
//
// `re-encrypt-credential.ts` moves ONE envelope onto the active root key and its
// header says why it converges: "an operator sweeping a whole environment must be
// able to run this over every credential and have it converge, and a partial
// sweep must be safe to repeat." This file is that sweep, and it is the shape a
// durable job needs rather than the shape a request can hold.
//
// WHY A REQUEST CANNOT DO THIS. A root key rotation is owed against EVERY
// envelope sealed under the prior version, across every credential in the
// environment. Until the last one moves, `domain/key-ring.ts`'s
// `canRemoveRootKey` is false, the operator cannot destroy the compromised key,
// and the blast radius of its compromise stays open. That is a unit of work
// measured in credentials and minutes, and an HTTP handler that tried to hold it
// would fail three ways at once: the request times out and the caller cannot tell
// how far it got, the transaction — if there were one — holds a row lock on every
// credential it has reached, and a retry starts from zero.
//
// THE FOUR PROPERTIES THAT MAKE IT A JOB.
//
//   BOUNDED. `SWEEP_HARD_LIMIT` clamps a batch, exactly as
//   `PURGE_RETIRED_HARD_LIMIT` clamps a purge. One call can never turn into an
//   unbounded rewrap of an environment.
//
//   RESUMABLE. The report carries a `nextCursor`, and the next call resumes
//   strictly after it. The order is the repository's name order, which is stable,
//   so a sweep interrupted at credential 400 does not re-do the first 399.
//
//   ONE TRANSACTION PER CREDENTIAL, NOT ONE PER SWEEP. Every re-encryption opens
//   its own unit of work through `reEncryptCredential`, so work already done is
//   COMMITTED when a later credential fails. That is what makes a resume cheap
//   rather than a restart. A sweep-wide transaction would be the opposite of
//   durable: the longer it ran the more it had to lose.
//
//   IDEMPOTENT. A credential already on the active key is a SUCCESS that changes
//   nothing — `reEncryptCredential` returns early — so re-running a sweep over
//   ground it has covered costs a metadata read per credential and writes no row.
//
// A FAILING CREDENTIAL DOES NOT STOP THE SWEEP, AND THE SWEEP IS NEVER
// "COMPLETE" WHILE ONE EXISTS. Stopping would let a single permanently broken
// credential — a legacy format-2 envelope, say, which `envelope-operations.ts`
// refuses to open — block the rotation of an entire environment for ever.
// Continuing and calling it done would be worse: the operator would remove a key
// that something still needs. So a failure is recorded, the sweep goes on, and
// `complete` is false while any skip stands. The real fence is elsewhere and
// unaffected either way: `countVersionsByRootKey` still counts the unmoved
// envelope and `canRemoveRootKey` still refuses to let the key go.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not schedule itself. ADR M0.3
// §1 row 3 gives `secrets` the KERNEL ALONE as a dependency — the strictest
// allow-list in the table — so this context may not name `jobs`, may not register
// a `Job`, and may not reach `DurableRuntime`. The seam is at the composition
// root: a job handler calls this use case with a cursor and stores the one it
// gets back. That direction is the only one the DAG permits, and it is also the
// right one — the vault decides what a sweep MEANS and the runtime decides when
// it runs.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireSecretMutation } from "../domain/access-rules.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import { invalidPurgeRequest } from "../domain/errors.js";
import type { CredentialId, RootKeyVersion } from "../domain/ids.js";
import { rootKeyStatus } from "../domain/key-ring.js";
import type { SecretsDependencies } from "./dependencies.js";
import { reEncryptCredential } from "./re-encrypt-credential.js";

/**
 * The most credentials one call will re-encrypt.
 *
 * The same shape and the same reason as `PURGE_RETIRED_HARD_LIMIT`: a limit the
 * caller supplies is CLAMPED rather than honoured, so no argument can turn one
 * invocation into an unbounded rewrap. Fifty and not a hundred because each unit
 * here is an open, a seal and three writes rather than one delete.
 */
export const SWEEP_HARD_LIMIT = 50;

export interface SweepRootKeyReEncryptionCommand {
  readonly authorization: EnvironmentAuthorization;
  /** Clamped to `SWEEP_HARD_LIMIT`. */
  readonly limit?: number;
  /**
   * Resume strictly AFTER this credential, in the repository's name order.
   *
   * A NAME and not an offset. An offset shifts when a credential is created or
   * revoked mid-sweep, so a resume would skip or repeat rows; a name is the key
   * the order is on, so "after this one" stays true whatever else moved.
   */
  readonly afterName?: string | null;
}

/** One credential the sweep could not move, and the code that says why. */
export interface SweepSkip {
  readonly credentialId: CredentialId;
  /** The domain error's code. Never its message, and never the envelope. */
  readonly code: string;
}

export interface RootKeySweepReport {
  readonly activeRootKeyVersion: RootKeyVersion;
  /** Credentials looked at in this batch, whether or not they needed work. */
  readonly examined: number;
  /** Credentials whose envelope moved onto the active root key. */
  readonly reEncrypted: number;
  /** Credentials already on the active key. Idempotence, counted. */
  readonly alreadyActive: number;
  readonly skipped: readonly SweepSkip[];
  /** Where a following call must resume, or null when the batch reached the end. */
  readonly nextCursor: string | null;
  /**
   * True only when the batch reached the end of the environment AND nothing was
   * skipped. A caller that loops until `complete` therefore loops until the
   * environment is genuinely on one key.
   */
  readonly complete: boolean;
}

function clampLimit(limit: number | undefined): Result<number> {
  if (limit === undefined) return ok(SWEEP_HARD_LIMIT);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return err(invalidPurgeRequest("limit_not_a_positive_integer"));
  }
  return ok(Math.min(limit, SWEEP_HARD_LIMIT));
}

/**
 * Re-encrypt up to `limit` of one environment's credentials onto the active root
 * key, and say where to resume.
 *
 * IT NEEDS A MUTATION GRANT AND NOT A READ ONE, and it needs no read grant at
 * all. `requireSecretMutation` is the operator tier; `requireSecretRead` — the
 * runtime tier that `read-secret.ts` demands — is deliberately not consulted,
 * because no plaintext leaves the boundary here. A re-encryption opens an
 * envelope and re-seals it inside `reEncryptCredential`; the material never
 * becomes a value the caller holds. That is what lets an operator rotate a key
 * they are forbidden to read.
 */
export async function sweepRootKeyReEncryption(
  deps: SecretsDependencies,
  command: SweepRootKeyReEncryptionCommand,
): Promise<Result<RootKeySweepReport>> {
  const granted = requireSecretMutation(command.authorization);
  if (!granted.ok) return err(granted.error);
  const limit = clampLimit(command.limit);
  if (!limit.ok) return err(limit.error);

  const authorization = granted.value;
  const ring = await deps.keyRing.state();
  if (!ring.ok) return err(ring.error);

  const rows = await deps.repository.listCredentials(authorization.environmentId);
  if (!rows.ok) return err(rows.error);

  // The cursor is applied to the REPOSITORY's order rather than to a re-sort
  // here. `listCredentials` is documented name-ordered, and a second sort in this
  // file would be a second opinion about the order the cursor is defined against.
  const after = command.afterName ?? null;
  const pending = after === null ? rows.value : rows.value.filter((row) => row.credential.name > after);

  let examined = 0;
  let reEncrypted = 0;
  let alreadyActive = 0;
  const skipped: SweepSkip[] = [];
  let cursor: string | null = null;
  let exhausted = true;

  for (const row of pending) {
    if (examined >= limit.value) {
      // The batch is full and rows remain. `cursor` already holds the last
      // credential this call finished, so the next one resumes strictly after it.
      exhausted = false;
      break;
    }
    examined += 1;
    cursor = row.credential.name;

    const version = row.activeSecretVersion;
    // A revoked credential and one with no envelope are not failures and not
    // work. `reEncryptCredential` would refuse the second with
    // `no_active_secret_version`, and counting that as a SKIP would keep the
    // sweep permanently incomplete over a credential that is behaving correctly.
    if (version === null || row.credential.revokedAt !== null) {
      alreadyActive += 1;
      continue;
    }
    // ACTIVE, and ONLY active, is already-done.
    //
    // THE FIRST DRAFT OF THIS LINE ASKED `needsReEncryption`, WHICH IS TRUE ONLY
    // FOR `prior`, AND THAT WAS A SILENT FAILURE OF EXACTLY THE KIND THIS FILE
    // ARGUES AGAINST. `domain/key-ring.ts` has THREE statuses, not two: a version
    // that has been removed from the ring is `absent`, `needsReEncryption` is
    // false for it, and the sweep counted a credential nothing can ever open
    // again as `alreadyActive` — reported it as done, and reported the
    // environment complete. A stranded credential would have been invisible in
    // the one report an operator reads before destroying a key.
    //
    // So `prior` AND `absent` both go to `reEncryptCredential`. `prior` moves;
    // `absent` fails there with the fail-closed `CREDENTIAL_UNAVAILABLE` that
    // `envelope-operations.ts` produces for a rotated-out key, and lands in
    // `skipped` where an operator can see it.
    if (rootKeyStatus(ring.value, version.rootKeyVersion) === "active") {
      alreadyActive += 1;
      continue;
    }

    const moved = await reEncryptCredential(deps, {
      authorization: command.authorization,
      credentialId: row.credential.id,
    });
    if (moved.ok) {
      reEncrypted += 1;
      continue;
    }
    // The CODE and not the message. `domain/errors.ts` keeps the reason in
    // `details`, which it documents as "never returned to a client", and a report
    // an operator reads through an API is a client.
    skipped.push({ credentialId: row.credential.id, code: moved.error.code });
  }

  return ok(
    Object.freeze({
      activeRootKeyVersion: ring.value.activeVersion,
      examined,
      reEncrypted,
      alreadyActive,
      skipped: Object.freeze([...skipped]),
      nextCursor: exhausted ? null : cursor,
      complete: exhausted && skipped.length === 0,
    }),
  );
}
