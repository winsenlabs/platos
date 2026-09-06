// THE SEVEN CODES M0.4 §2's `Idempotency-Key` CONTRACT CAN ANSWER WITH.
//
// `IDEMPOTENCY_KEY_REQUIRED` IS THE ONE THE ADR NAMES, and it is named with its
// status attached: "one-time-secret mints ... **require** it → `400
// IDEMPOTENCY_KEY_REQUIRED`". Until this file the code existed in exactly one
// place in the repository — a string in a kernel unit test proving
// `domainError` accepts SCREAMING_SNAKE — which is a code with no minting site,
// and a code with no minting site fails this dimension's own E2 rule.
//
// WHY SEVEN AND NOT ONE. "Two guards returning the same error code cannot be
// told apart" is the defect this dimension found in `privacy`, in
// `identity-access` and in `jobs`' own `decideReplay`, where four facts left
// through one `IDEMPOTENCY_CONFLICT`. The gate in front of a mint can refuse for
// seven different reasons and an operator's next move differs for every one of
// them:
//
//   KEY_REQUIRED      the caller sent no key. Fix the client.
//   KEY_MALFORMED     the caller sent something that is not a key. Fix the
//                     client, but somewhere else — a truncating proxy, a
//                     template that interpolated nothing, a header split.
//   REQUEST_IN_FLIGHT a twin is running right now. Wait and retry the same key.
//   REQUEST_MISMATCH  the key is spoken for by a DIFFERENT request. Retrying
//                     will never help; mint a new key.
//   RECORD_ABSENT     the reservation vanished between the refused claim and the
//                     read. Look at the store's eviction and memory policy.
//   RECORD_MALFORMED  something is writing non-reservations into the keyspace.
//                     Look at who else holds the credential.
//   STORE_UNAVAILABLE the store could not answer. Look at the store.
//
// The three refusals in the middle share a STATUS — 409 — and that is correct
// and is not the same thing as sharing a code. They are one instruction to a
// dumb client ("this is a conflict on your key") and four different instructions
// to a human, and M0.4 §2 makes `error.code` immutable within a major precisely
// so the human's instruction survives.
//
// THIS IS A TRANSPORT FILE AND THE CODES ARE TRANSPORT VOCABULARY. ADR M0.3 §2
// keeps HTTP out of the domain, and the mirror of that rule is that the request
// envelope's own failures belong to the edge that owns the envelope. No context
// mints one of these, because no context knows a header exists.

import { domainError, type DomainError } from "@platos/kernel";

/** The header M0.4 §2 names. Spelled once, so a rename cannot half-happen. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * The header a replay is marked with.
 *
 * M0.4 §2 writes it `Idempotency-Replayed:true`. It is a HEADER rather than a
 * body field because the body is the first response byte for byte — that is what
 * "returns same secret" means — and adding a field to it would make the replay
 * differ from the thing it is replaying.
 */
export const IDEMPOTENCY_REPLAYED_HEADER = "Idempotency-Replayed";

/** The one field violation these refusals attach, so a client can point at it. */
function keyViolation(code: string, message: string): DomainError["fields"] {
  return [{ field: "headers.idempotency-key", code, message }];
}

export function idempotencyKeyRequired(operation: string): DomainError {
  return domainError(
    "IDEMPOTENCY_KEY_REQUIRED",
    "invalid_input",
    "This operation mints a one-time secret and requires an Idempotency-Key header.",
    {
      fields: keyViolation("missing", "Send a unique Idempotency-Key with this request."),
      // The OPERATION, never the key: there is no key to report, and the
      // operation is what tells an operator which client is misconfigured.
      details: { operation },
    },
  );
}

export function idempotencyKeyMalformed(operation: string): DomainError {
  return domainError(
    "IDEMPOTENCY_KEY_MALFORMED",
    "invalid_input",
    "The Idempotency-Key header is not a usable key.",
    {
      fields: keyViolation(
        "malformed",
        "An Idempotency-Key is 1 to 255 characters of A-Z a-z 0-9 and _ . : - and is sent once.",
      ),
      // NOT the key itself. It is attacker-controlled, it is why this refusal
      // fired, and `details` is rendered into log lines — a 200KB value or one
      // carrying CRLF would be a log-forging primitive handed over by the guard
      // that rejected it.
      details: { operation },
    },
  );
}

export function idempotencyRequestInFlight(operation: string): DomainError {
  return domainError(
    "IDEMPOTENCY_REQUEST_IN_FLIGHT",
    "conflict",
    "An identical request with this Idempotency-Key is still running.",
    { details: { operation } },
  );
}

export function idempotencyRequestMismatch(operation: string): DomainError {
  return domainError(
    "IDEMPOTENCY_REQUEST_MISMATCH",
    "conflict",
    "This Idempotency-Key was already used for a different request.",
    { details: { operation } },
  );
}

export function idempotencyRecordAbsent(operation: string): DomainError {
  return domainError(
    "IDEMPOTENCY_RECORD_ABSENT",
    "conflict",
    "The reservation for this Idempotency-Key could not be read back after the claim was refused.",
    { details: { operation } },
  );
}

export function idempotencyRecordMalformed(operation: string): DomainError {
  return domainError(
    "IDEMPOTENCY_RECORD_MALFORMED",
    "conflict",
    "The record held under this Idempotency-Key is not a reservation.",
    { details: { operation } },
  );
}

/**
 * The fail-closed refusal.
 *
 * `retryAfterSeconds` is populated because the kernel says it is populated "only
 * for `rate_limited` and `unavailable`", and this is the second of those. One
 * second, not sixty: the caller is holding a request open and the store is
 * usually a failover away, so a long hint would turn a two-second blip into a
 * minute of refused mints.
 */
export function idempotencyStoreUnavailable(operation: string, reason: string): DomainError {
  return domainError(
    "IDEMPOTENCY_STORE_UNAVAILABLE",
    "unavailable",
    "The idempotency store could not be reached, so this request was refused rather than risked twice.",
    { retryAfterSeconds: 1, details: { operation, reason } },
  );
}
