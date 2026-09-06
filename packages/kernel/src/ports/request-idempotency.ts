// ADR M0.3 §4 kernel port: RequestIdempotency.
//
// M0.4 §2 makes three promises about the request envelope, and all three are
// about the SAME reservation: `Idempotency-Key` is accepted on every
// side-effecting `POST/PATCH/DELETE`, it is REQUIRED on the one-time-secret
// mints, and a replay "returns same secret + `Idempotency-Replayed:true`". A
// promise about what a REPEATED request gets back is a promise about a record
// that outlives the first request, so the edge needs a store — and the edge is
// the one place in V1 with no context to ask for one.
//
// WHY IT IS KERNEL-HOSTED, ON THE SAME TEST `CorrelationSource` PASSES. It
// belongs to NO context. Every side-effecting operation in all seventeen is
// covered by the rule, none of them decides anything with the key, and the two
// ends that must agree — the transport that reads the header and the store that
// holds the reservation — are on opposite sides of the whole system. Hanging it
// on one context would make the other sixteen depend on that context to be
// idempotent.
//
// IT IS NOT `jobs`' `IdempotencyStore`, AND THE DIFFERENCE IS NOT COSMETIC.
// That port reserves a job EXECUTION: its key is an `ExecutionRequestId` inside
// an environment, and its terminal states carry a `JsonValue` result or a
// `JobExecutionErrorCode`. This one reserves an HTTP REQUEST: its key is a
// caller-supplied header, its scope is the operation plus the credential that
// asked for it, and its terminal state is a response — a status and the bytes.
// Reusing the job port here would have put `jobs` vocabulary in the transport
// and HTTP vocabulary in `jobs`. They share a STORE, which ADR M0.3 §15 already
// permits, and they do not share a contract.
//
// NO `Result`, AND THAT IS DELIBERATE. Every other failure in this system is a
// `DomainError` carrying a code, and a code has to be MINTED somewhere the error
// taxonomy can see it. A kernel port that minted `IDEMPOTENCY_STORE_UNAVAILABLE`
// would put the transport's vocabulary in the kernel and hide the mint from the
// transport that answers with it. So the port reports FACTS — reserved, replay,
// in-flight, mismatch, absent, malformed, unavailable — and the edge, which owns
// the wire contract, decides which code each fact deserves. Seven facts, seven
// codes, and no two guards refusing identically.

/**
 * What identifies one reservation.
 *
 * THREE FIELDS, AND EACH CLOSES A HOLE THE OTHER TWO LEAVE OPEN.
 *
 * `key` is the caller's `Idempotency-Key`, already validated at the edge. It is
 * attacker-controlled and unqualified: two unrelated callers may pick the same
 * string, and nothing stops them.
 *
 * `scope` is what the key is qualified BY — the operation, and the credential
 * that presented it. Without it, one caller's `Idempotency-Key: 1` would collide
 * with another's, and on a one-time-secret mint the collision would hand the
 * second caller the first caller's secret. That is why the scope is part of the
 * identity rather than a convenience: a reservation is per (credential,
 * operation, key), never per key.
 *
 * `digest` is what the caller actually sent. Two requests sharing a key and a
 * scope but differing in body are NOT the same request, and answering the second
 * with the first's response would be a silent wrong answer. A store that holds
 * the digest can refuse instead.
 */
export interface RequestFingerprint {
  readonly scope: string;
  readonly key: string;
  readonly digest: string;
}

/** The response a settled reservation replays. Exactly what went on the wire. */
export interface RecordedResponse {
  readonly status: number;
  readonly body: string;
  /** The `Content-Type` the first answer carried, or null when it carried none. */
  readonly contentType: string | null;
}

/**
 * What a reservation attempt found.
 *
 * `reserved` is the ONLY outcome that admits a caller to the handler. Every
 * other one is a fact about a twin, and the edge turns each into its own code —
 * `absent` and `malformed` separately, for the reason `jobs` learned the hard
 * way: a record that vanished under a lost race is a store-policy incident, a
 * record that is there and is rubbish is a different incident, and one shared
 * code makes them one alert.
 */
export type RequestReservation =
  | { readonly kind: "reserved" }
  | { readonly kind: "replay"; readonly response: RecordedResponse }
  | { readonly kind: "in-flight" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * What settling a reservation did.
 *
 * `expired` is not a failure. The reservation's window closed while the handler
 * was running, so there is nothing to update — and RE-CREATING the key would let
 * a request replay long after the window it was promised. The caller has already
 * produced a correct answer; the only thing lost is the replay.
 */
export type SettleOutcome =
  | { readonly kind: "settled" }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RequestIdempotency {
  /**
   * Claim `fingerprint` for this request, or report who holds it.
   *
   * ONE ROUND TRIP AND AN ATOMIC CLAIM, not a read followed by a write: a caller
   * composing those two would have written the race this port exists to close,
   * and would close it wrong, because two processes can both read "absent".
   */
  reserve(fingerprint: RequestFingerprint, ttlSeconds: number): Promise<RequestReservation>;

  /**
   * Settle a reservation this process holds with the answer it produced.
   *
   * UPDATE-IF-PRESENT, never create. A settle that recreated an expired key would
   * hand a replay to a caller whose window had closed.
   */
  record(
    fingerprint: RequestFingerprint,
    response: RecordedResponse,
    ttlSeconds: number,
  ): Promise<SettleOutcome>;

  /**
   * Give a reservation back without settling it.
   *
   * FOR THE ANSWER THAT IS NOT AN ANSWER. A 5xx means the system does not know
   * what happened, and recording it would turn "try again" into "you already
   * did", for as long as the reservation lives. Releasing lets the retry run —
   * which is the whole reason the caller sent a key.
   */
  release(fingerprint: RequestFingerprint): Promise<SettleOutcome>;
}
