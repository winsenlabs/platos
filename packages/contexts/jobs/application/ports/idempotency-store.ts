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
// `settle` IS AN UPDATE-IF-PRESENT. The live call is `SET ... XX`: it must not
// resurrect a reservation that has expired, because a resurrected `completed`
// record would let a request replay long after its window closed.

import type { Result } from "@platos/kernel";

import type { ExecutionRequestId, Reservation } from "../../domain/index.js";

export interface IdempotencyKey {
  readonly environmentId: string;
  readonly requestId: ExecutionRequestId;
}

export type ReservationOutcome =
  | { readonly kind: "reserved" }
  /** Someone else holds the key. `existing` is null when it was unreadable. */
  | { readonly kind: "held"; readonly existing: Reservation | null };

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
