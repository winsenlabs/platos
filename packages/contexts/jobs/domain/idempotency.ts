// Deciding what a repeated request id means.
//
// The live service reserves a key, and on a lost race reads the existing record
// and branches four ways. The BRANCHING is a rule; the reservation is I/O. This
// module owns the rule, so "a retry with a different body is a conflict" is
// provable without a store.
//
// FAIL-CLOSED IS THE DEFAULT AND IT IS DELIBERATE. An unreadable record, a record
// whose digest does not match, and a record in an unrecognised state all refuse.
// The alternative — treating an unreadable reservation as absent and running the
// job — turns a store hiccup into a duplicate side effect, which for a job that
// moves money or sends mail is the one outcome that cannot be undone.
//
// A FAILED RECORD IS REPLAYED, NOT RE-RUN. This surprises people, so: the live
// service caches the failure and returns it to a retry of the SAME body. That is
// correct for this surface, because the caller's `requestId` is its assertion
// that this is one execution; a caller that wants a fresh one mints a fresh id.

import { err, ok, type JsonValue, type Result } from "@platos/kernel";

import { idempotencyConflict, idempotencyInProgress, idempotencyUnavailable } from "./errors.js";
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

/** What the caller should be told when a reservation already existed. */
export type ReplayDecision =
  | { readonly kind: "replay-success"; readonly result: JsonValue | null }
  | { readonly kind: "replay-failure"; readonly code: JobExecutionErrorCode };

/**
 * Decide the fate of a request whose reservation was already held.
 *
 * `existing` is `null` when the record could not be read or had expired between
 * the failed reservation and the read. That is NOT treated as "free to run": the
 * live code refuses it as a conflict, because something held the key a moment ago
 * and this process cannot prove what it did.
 */
export function decideReplay(
  existing: Reservation | null,
  digest: RequestDigest,
): Result<ReplayDecision> {
  if (existing === null) return err(idempotencyConflict());
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
 * A store failure, expressed as the live fail-closed refusal. Present as a named
 * function so every call site that must fail closed reads the same way and none
 * has to remember which of the two 503 codes applies.
 */
export function reservationUnavailable(reason: string): ReturnType<typeof idempotencyUnavailable> {
  return idempotencyUnavailable(reason);
}
