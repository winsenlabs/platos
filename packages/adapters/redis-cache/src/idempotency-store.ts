// The `jobs` `IdempotencyStore`, over Redis.
//
// `packages/adapters/postgres-tenancy/src/jobs-repository.ts` states in as many
// words why this port is not a canonical store and belongs here: "an atomic
// claim-or-report in one round trip, a TTL the store enforces rather than a
// sweep, and an `XX` update that must not resurrect an expired key". This file
// is those three sentences, in that order.
//
// RESERVE IS ONE ROUND TRIP AND ONE COMMAND. `SET key value EX ttl NX` either
// claims the key or reports that it did not, atomically, on the server. There is
// no `GET` then `SET`: a caller composing those two would have written the race
// this port exists to close, and would close it wrong — two processes can both
// read "absent" and both write.
//
// THE LOSER READS AFTERWARDS, AND THAT READ CAN COME BACK EMPTY. The port's own
// comment says the result carries the holder's record so the caller needs no
// second round trip. It is still a second COMMAND — Redis has no
// "SET NX, and give me the incumbent if you refuse" — so between the refused SET
// and the GET the key can expire. WIN-260 made that outcome its own answer:
// `absent` rather than a shared conflict, because "the reservation vanished
// under us" and "you sent a different body" are different incidents and only one
// of them is the caller's doing.
//
// SETTLE IS `XX`, AND THE `XX` IS THE WHOLE POINT. A settle that recreated an
// expired key would let a request replay long after its window closed — seven
// days later, a caller retrying an id it has forgotten the meaning of would be
// handed a result rather than running the job. `SET ... XX` writes only if the
// key is still there, and a `null` reply means it was not, which the port
// documents as survivable: the caller has already produced a correct outcome.

import type {
  HeldReservation,
  IdempotencyKey,
  IdempotencyStore,
  Reservation,
  ReservationOutcome,
  Result,
} from "@platos/context-jobs/application/ports/index.js";
import {
  err,
  ok,
  readReservation,
  reservationUnavailable,
  unreadableRecord,
} from "@platos/context-jobs/application/ports/index.js";

import type { RedisConnection } from "./client.js";

/**
 * The key an environment's request id is held under.
 *
 * The environment is IN the key rather than beside it, so two environments
 * cannot collide on a request id and no read has to remember to filter by one.
 * ADR M0.3 §4 asks each adapter for "one namespaced keyspace"; this is that
 * namespace, and it is the only string this file builds.
 */
export function reservationKey(key: IdempotencyKey): string {
  return `platos:jobs:idem:${key.environmentId}:${key.requestId}`;
}

/** What is written under the key. Compact, because it is written per request. */
function encode(reservation: Reservation): string {
  return JSON.stringify(reservation);
}

/**
 * Read a stored record, deciding nothing.
 *
 * The classification — absent, malformed, an unpromised failure code — is
 * `readReservation` in the `jobs` DOMAIN, and it is there rather than here for
 * the reason ADR M0.3 §2 gives: which of those three a record is, and what each
 * means for a caller, is a rule. This function's whole job is to turn bytes into
 * a value that rule can judge, and to make a parse failure look like the
 * malformed record it is rather than throwing out of an adapter.
 */
function decode(raw: string | null): HeldReservation {
  if (raw === null) return readReservation(null);
  try {
    return readReservation(JSON.parse(raw) as unknown);
  } catch {
    // Not JSON at all. `readReservation` never sees it, so the reason is chosen
    // here — and it is `malformed` rather than `absent`, because something IS
    // under the key and an operator looking for an eviction would look in the
    // wrong place.
    return unreadableRecord("malformed");
  }
}

/** The reason a store failure carries into `IDEMPOTENCY_UNAVAILABLE`. */
function reasonOf(error: unknown): string {
  // The MESSAGE only, never the error object. `details` is rendered into logs
  // and a driver error carries the connection string, which carries the
  // password.
  return error instanceof Error ? error.message : "redis command failed";
}

export interface RedisIdempotencyStore extends IdempotencyStore {
  /** The key a given reservation is held under. Exposed for operator tooling. */
  keyFor(key: IdempotencyKey): string;
}

export function createRedisIdempotencyStore(connection: RedisConnection): RedisIdempotencyStore {
  return {
    keyFor: reservationKey,

    async reserve(
      key: IdempotencyKey,
      reservation: Reservation,
      ttlSeconds: number,
    ): Promise<Result<ReservationOutcome>> {
      const name = reservationKey(key);
      let claimed: boolean;
      try {
        claimed = await connection.claim(name, encode(reservation), ttlSeconds);
      } catch (error) {
        // FAIL CLOSED. The alternative — treating an unreachable store as "the
        // key is free" — turns an outage into duplicate side effects, and for a
        // job that moves money or sends mail that is the one outcome nobody can
        // undo.
        return err(reservationUnavailable(reasonOf(error)));
      }
      if (claimed) return ok({ kind: "reserved" });

      let held: string | null;
      try {
        held = await connection.read(name);
      } catch (error) {
        // The claim was refused and the incumbent cannot be read. This is NOT
        // `absent`: absent is a positive answer from a store that is working,
        // and this is no answer at all. Reporting it as unavailable is what
        // keeps a caller from being told a conflict it could act on.
        return err(reservationUnavailable(reasonOf(error)));
      }
      return ok({ kind: "held", held: decode(held) });
    },

    async settle(
      key: IdempotencyKey,
      reservation: Reservation,
      ttlSeconds: number,
    ): Promise<Result<boolean>> {
      try {
        // NEVER `claim` HERE, AND NEVER `write`. `claim` is `NX` and would refuse
        // every settle, since the key is always held by the reservation being
        // settled; `write` is unconditional and would resurrect one that had
        // expired. `overwrite` is the only one of the three that is correct, and
        // the three are named rather than spelled so that cannot be a typo.
        const written = await connection.overwrite(reservationKey(key), encode(reservation), ttlSeconds);
        return ok(written);
      } catch (error) {
        // Deliberately survivable, and the port says why: the original running
        // reservation stays fail-closed until it expires, so a caller that
        // cannot settle has still produced a correct outcome. Later retries of
        // the same id are told IDEMPOTENCY_IN_PROGRESS rather than re-running.
        return err(reservationUnavailable(reasonOf(error)));
      }
    },
  };
}
