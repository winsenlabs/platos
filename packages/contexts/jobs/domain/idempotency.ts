// Deciding what a repeated request id means.
//
// The live service reserves a key, and on a lost race reads the record that
// already exists and branches on it. The BRANCHING is a rule; the reservation is
// I/O. This module owns the rule, so "a retry with a different body is a
// conflict" is provable without a store.
//
// FAIL-CLOSED IS THE DEFAULT AND IT IS DELIBERATE. A record that is gone, a
// record that does not decode, a record whose digest does not match, and a record
// in an unrecognised state all refuse. The alternative — treating an unreadable
// reservation as absent and running the job — turns a store hiccup into a
// duplicate side effect, which for a job that moves money or sends mail is the
// one outcome that cannot be undone.
//
// A FAILED RECORD IS REPLAYED, NOT RE-RUN. This surprises people, so: the live
// service caches the failure and returns it to a retry of the SAME body. That is
// correct for this surface, because the caller's `requestId` is its assertion
// that this is one execution; a caller that wants a fresh one mints a fresh id.
//
// WIN-260: FOUR REFUSALS, FOUR CODES. Until this issue three of those four
// fail-closed paths — a record that was gone, a record that did not decode, and
// a record whose cached failure code this major never promised — all left
// through ONE `idempotencyConflict()`, alongside the genuine "same id, different
// body". Four different incidents arriving under `IDEMPOTENCY_CONFLICT` cannot be
// told apart in a log or by a caller, which is the same defect that hid behind
// one code in `privacy` and in `identity-access`. `decideReplay` now returns a
// distinct code per branch and `scripts/error-taxonomy.mjs` refuses a regression.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import {
  idempotencyConflict,
  idempotencyInProgress,
  idempotencyRecordAbsent,
  idempotencyRecordMalformed,
  idempotencyReplayCodeUnpromised,
  idempotencyUnavailable,
  isJobExecutionErrorCode,
} from "./errors.js";
import type { RequestDigest } from "./identifiers.js";
import type { JobExecutionErrorCode } from "./errors.js";

/** The live reservation TTL: seven days. */
export const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

export type ReservationState = "running" | "completed" | "failed";

/**
 * What is stored under a request id.
 *
 * `digest` is what makes reuse detectable: the id alone says two calls claim to
 * be the same execution, and the digest says whether they actually are.
 */
export type Reservation =
  | { readonly state: "running"; readonly digest: RequestDigest }
  | { readonly state: "completed"; readonly digest: RequestDigest; readonly result: JsonValue | null }
  | { readonly state: "failed"; readonly digest: RequestDigest; readonly code: JobExecutionErrorCode };

export function runningReservation(digest: RequestDigest): Reservation {
  return { state: "running", digest };
}

export function completedReservation(digest: RequestDigest, result: JsonValue | null): Reservation {
  return { state: "completed", digest, result };
}

export function failedReservation(digest: RequestDigest, code: JobExecutionErrorCode): Reservation {
  return { state: "failed", digest, code };
}

/**
 * Why a held key produced no reservation this process may act on.
 *
 * Three facts, not one. `absent` is a store that lost the record between the
 * failed reservation and the read — an expiry, an eviction, a failover.
 * `malformed` is a record that is THERE and is not a reservation.
 * `unpromised-code` is a record that decodes and whose cached failure names a
 * code outside the closed set this major promises. An operator has to tell them
 * apart to know whether to look at the store's memory policy, at what is writing
 * rubbish into the keyspace, or at a peer running a different contract version.
 */
export type UnreadableReason = "absent" | "malformed" | "unpromised-code";

/** What the loser of a reservation race actually found under the key. */
export type HeldReservation =
  | { readonly kind: "readable"; readonly reservation: Reservation }
  | { readonly kind: "unreadable"; readonly reason: UnreadableReason };

export function readableRecord(reservation: Reservation): HeldReservation {
  return { kind: "readable", reservation };
}

export function unreadableRecord(reason: UnreadableReason): HeldReservation {
  return { kind: "unreadable", reason };
}

/** What the caller should be told when a reservation already existed. */
export type ReplayDecision =
  | { readonly kind: "replay-success"; readonly result: JsonValue | null }
  | { readonly kind: "replay-failure"; readonly code: JobExecutionErrorCode };

/**
 * Decide the fate of a request whose reservation was already held.
 *
 * Every branch that refuses names its own code, and no two branches share one.
 * That is not tidiness: `IDEMPOTENCY_CONFLICT` means "you sent a different body
 * under an id you already used", which is a caller defect, and the three
 * unreadable reasons mean "the store cannot say what happened", which is an
 * operator incident. A caller that is right to give up on the first may be right
 * to retry after the others, and with one shared code it could not tell.
 */
export function decideReplay(held: HeldReservation, digest: RequestDigest): Result<ReplayDecision> {
  if (held.kind === "unreadable") {
    switch (held.reason) {
      case "absent":
        return err(idempotencyRecordAbsent());
      case "malformed":
        return err(idempotencyRecordMalformed());
      case "unpromised-code":
        return err(idempotencyReplayCodeUnpromised());
    }
  }
  const existing = held.reservation;
  if (existing.digest !== digest) return err(idempotencyConflict());
  if (existing.state === "completed") {
    return ok({ kind: "replay-success", result: existing.result });
  }
  if (existing.state === "failed") {
    return ok({ kind: "replay-failure", code: existing.code });
  }
  return err(idempotencyInProgress());
}

/**
 * Turn whatever the keyspace returned into a `HeldReservation`.
 *
 * THE READ SIDE OF THE PROMISE `settle` MAKES ON THE WRITE SIDE.
 * `execute-job.ts::settle` refuses to cache a failure whose code is outside the
 * eleven inherited execution codes, so nothing this version writes can carry an
 * unpromised code. That is not enough on its own: a record is read up to seven
 * days after it was written, by a process that may not be the one that wrote it,
 * out of a keyspace anything holding the credential can write. The type says
 * `JobExecutionErrorCode`; the bytes say whatever they say. This is where the two
 * are reconciled, and a code the type system was told to expect but the store did
 * not hold is refused rather than replayed.
 *
 * `null` and `undefined` mean the record was gone by the time it was read, which
 * is `absent`; anything present that is not a reservation is `malformed`.
 */
export function readReservation(raw: unknown): HeldReservation {
  if (raw === null || raw === undefined) return unreadableRecord("absent");
  if (typeof raw !== "object" || Array.isArray(raw)) return unreadableRecord("malformed");

  const record = raw as Record<string, unknown>;
  const digest = record.digest;
  if (typeof digest !== "string" || digest.length === 0) return unreadableRecord("malformed");
  const branded = digest as RequestDigest;

  switch (record.state) {
    case "running":
      return readableRecord(runningReservation(branded));
    case "completed": {
      const result = record.result;
      // A completed reservation with no `result` key at all is not the same fact
      // as one that completed with a null result: the second is a value a caller
      // is entitled to replay, and the first is a record somebody truncated.
      if (result === undefined) return unreadableRecord("malformed");
      return readableRecord(completedReservation(branded, result as JsonValue | null));
    }
    case "failed": {
      const code = record.code;
      if (typeof code !== "string") return unreadableRecord("malformed");
      if (!isJobExecutionErrorCode(code)) return unreadableRecord("unpromised-code");
      return readableRecord(failedReservation(branded, code));
    }
    default:
      return unreadableRecord("malformed");
  }
}

/**
 * A store failure, expressed as the live fail-closed refusal. Present as a named
 * function so every call site that must fail closed reads the same way and none
 * has to remember which of the two 503 codes applies.
 */
export function reservationUnavailable(reason: string): ReturnType<typeof idempotencyUnavailable> {
  return idempotencyUnavailable(reason);
}
