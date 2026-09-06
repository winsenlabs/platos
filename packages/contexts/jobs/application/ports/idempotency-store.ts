// The `IdempotencyStore` port — reserve-once semantics, without naming a store.
//
// The live implementation is Redis `SET key value EX ttl NX` and this port is
// that operation's meaning rather than its spelling: `reserve` either wins the
// key or reports that someone else holds it. There is no `get`-then-`set` pair,
// because a caller composing those two would have written a race.
//
// `reserve` RETURNS THE LOSER'S VIEW. On a lost race the caller needs the record
// that already exists to decide between replay and conflict, and fetching it
// separately would be a second round trip and a second chance for the key to
// expire in between. So the result carries it.
//
// WIN-260: THE LOSER'S VIEW IS NOT `Reservation | null`. It was, and `null`
// carried three different facts at once — the record had gone, the record was
// there and was rubbish, and the record was a reservation whose cached failure
// code this major never promised. An adapter had no way to say which, and the
// domain had no way to report which, so all three arrived as
// `IDEMPOTENCY_CONFLICT` alongside the genuine "same id, different body". The
// port now carries `HeldReservation`, and `readReservation` in the domain is the
// decoder every adapter runs to produce one, so the three reasons are decided in
// one place rather than three.
//
// `settle` IS AN UPDATE-IF-PRESENT. The live call is `SET ... XX`: it must not
// resurrect a reservation that has expired, because a resurrected `completed`
// record would let a request replay long after its window closed.

import type { Result } from "@platos/kernel";

import type { ExecutionRequestId, HeldReservation, Reservation } from "../../domain/index.js";

export interface IdempotencyKey {
  readonly environmentId: string;
  readonly requestId: ExecutionRequestId;
}

export type ReservationOutcome =
  | { readonly kind: "reserved" }
  /** Someone else holds the key; `held` says what was found under it. */
  | { readonly kind: "held"; readonly held: HeldReservation };

export interface IdempotencyStore {
  /** Atomically claim `key` for `reservation`, or report the holder. */
  reserve(
    key: IdempotencyKey,
    reservation: Reservation,
    ttlSeconds: number,
  ): Promise<Result<ReservationOutcome>>;

  /**
   * Overwrite an EXISTING reservation with its terminal state.
   *
   * A failure here is deliberately survivable: the live code comments that "the
   * original running reservation remains fail-closed until expiry", so a caller
   * that cannot settle has still produced a correct outcome — later retries of
   * the same id will be told `IDEMPOTENCY_IN_PROGRESS` rather than re-running.
   */
  settle(key: IdempotencyKey, reservation: Reservation, ttlSeconds: number): Promise<Result<boolean>>;
}
