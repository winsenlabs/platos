// The kernel's `RequestIdempotency`, over the SAME Redis connection.
//
// ADR M0.3 §15: one vendor client is one adapter DIRECTORY, and a directory may
// satisfy more than one port when the ports sit behind the same client. This is
// the THIRD port on this one, and the argument is the argument `Cache` and
// `IdempotencyStore` already made — reserve-once with a server-enforced TTL is
// what Redis is for, and a fourth directory would have been a second client for
// one server.
//
// IT IS A SEPARATE FILE FROM `idempotency-store.ts` BECAUSE IT IS A SEPARATE
// CONTRACT. That one reserves a job execution: its key is an environment plus an
// `ExecutionRequestId`, and its terminal state carries a `JsonValue` or a
// `JobExecutionErrorCode`. This one reserves an HTTP request: its key is a
// caller-supplied header qualified by the credential that presented it, and its
// terminal state is a response — a status, a content type and the bytes. The two
// keyspaces are disjoint by prefix (`platos:jobs:idem:` and `platos:http:idem:`)
// so neither can read the other's records even by accident.
//
// RESERVE IS ONE COMMAND. `SET key value EX ttl NX` claims the key or reports
// that it did not, atomically, on the server. The loser then READS, and that
// read is a second command with a window in front of it: between the refused SET
// and the GET the key can expire. `absent` is that outcome's own answer, not a
// conflict, because "the reservation vanished under us" and "you sent a
// different body" are different incidents.
//
// RECORD IS `XX`. A settle that recreated an expired key would let a request
// replay long after its window closed — which, on the one-time-secret mints
// M0.4 §2 requires a key for, means handing out a secret to a caller whose
// reservation had already lapsed.
//
// RELEASE IS READ-THEN-DELETE, AND THE READ IS NOT DECORATION. Redis has no
// "delete if the value still says what I wrote", so an unconditional DEL would
// let a request that overran its own reservation delete a TWIN's reservation —
// the twin would then run a second time, which is the one outcome this whole
// port exists to prevent. Reading the digest first shrinks that window to a
// single round trip and makes the wrong-digest case a decision this file takes
// rather than an accident. The window is not zero and is not claimed to be: it
// closes completely only with a server-side compare-and-delete, which needs
// scripting this directory's connection interface deliberately does not expose.

import type {
  RecordedResponse,
  RequestFingerprint,
  RequestIdempotency,
  RequestReservation,
  SettleOutcome,
} from "@platos/kernel";

import type { RedisConnection } from "./client.js";

/**
 * The key one reservation is held under.
 *
 * The SCOPE is in the key rather than beside it. The edge builds it from the
 * operation and a digest of the credential that presented the request, so two
 * callers who happen to choose the same `Idempotency-Key` cannot land on one
 * record — which on a secret mint would mean the second caller replaying the
 * first caller's secret. This is the only string this file builds, and both
 * halves arrive already constrained to unreserved characters by the edge.
 */
export function requestReservationKey(fingerprint: RequestFingerprint): string {
  return `platos:http:idem:${fingerprint.scope}:${fingerprint.key}`;
}

/** What is written under the key. */
interface StoredRecord {
  readonly state: "running" | "settled";
  readonly digest: string;
  readonly response?: RecordedResponse;
}

function encode(record: StoredRecord): string {
  return JSON.stringify(record);
}

/**
 * Turn bytes into a record, or say why they are not one.
 *
 * `null` means the key was gone by the time it was read. Anything present that
 * is not a reservation is malformed — including a `settled` record with no
 * response, which is a record something truncated rather than one a caller may
 * replay.
 */
function decode(raw: string | null): StoredRecord | "absent" | "malformed" {
  if (raw === null) return "absent";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "malformed";
  const record = parsed as Record<string, unknown>;
  const digest = record.digest;
  if (typeof digest !== "string" || digest.length === 0) return "malformed";
  if (record.state === "running") return { state: "running", digest };
  if (record.state !== "settled") return "malformed";
  const response = record.response;
  if (typeof response !== "object" || response === null || Array.isArray(response)) return "malformed";
  const shape = response as Record<string, unknown>;
  if (typeof shape.status !== "number" || !Number.isInteger(shape.status)) return "malformed";
  if (typeof shape.body !== "string") return "malformed";
  const contentType = shape.contentType;
  if (contentType !== null && typeof contentType !== "string") return "malformed";
  return {
    state: "settled",
    digest,
    response: { status: shape.status, body: shape.body, contentType },
  };
}

/** The reason a store failure carries to the edge. The MESSAGE only, never the
 * error object: a driver error carries the connection string, which carries the
 * password, and the reason is rendered into a log line. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "redis command failed";
}

export interface RedisRequestIdempotency extends RequestIdempotency {
  /** The key a given fingerprint is held under. Exposed for operator tooling. */
  keyFor(fingerprint: RequestFingerprint): string;
}

export function createRedisRequestIdempotency(connection: RedisConnection): RedisRequestIdempotency {
  return {
    keyFor: requestReservationKey,

    async reserve(fingerprint, ttlSeconds): Promise<RequestReservation> {
      const name = requestReservationKey(fingerprint);
      let claimed: boolean;
      try {
        claimed = await connection.claim(
          name,
          encode({ state: "running", digest: fingerprint.digest }),
          ttlSeconds,
        );
      } catch (error) {
        // FAIL CLOSED. Treating an unreachable store as "the key is free" turns
        // an outage into a duplicate secret mint, which is the one outcome
        // nobody can undo.
        return { kind: "unavailable", reason: reasonOf(error) };
      }
      if (claimed) return { kind: "reserved" };

      let held: string | null;
      try {
        held = await connection.read(name);
      } catch (error) {
        // The claim was refused and the incumbent cannot be read. This is NOT
        // `absent`: absent is a positive answer from a working store, and this
        // is no answer at all.
        return { kind: "unavailable", reason: reasonOf(error) };
      }
      const record = decode(held);
      if (record === "absent") return { kind: "absent" };
      if (record === "malformed") return { kind: "malformed" };
      // THE DIGEST IS CHECKED BEFORE THE STATE, AND THE ORDER IS THE POINT. A
      // record whose digest differs is a different request under a reused key,
      // whatever state it is in; answering it with the incumbent's response
      // would be the silent wrong answer this field exists to prevent.
      if (record.digest !== fingerprint.digest) return { kind: "mismatch" };
      if (record.state === "running") return { kind: "in-flight" };
      const response = record.response;
      // Unreachable through `decode`, which refuses a settled record with no
      // response as malformed. Kept as a value rather than an assertion so a
      // future decoder change cannot turn it into a thrown TypeError inside an
      // adapter.
      if (response === undefined) return { kind: "malformed" };
      return { kind: "replay", response };
    },

    async record(fingerprint, response, ttlSeconds): Promise<SettleOutcome> {
      try {
        // NEVER `claim` AND NEVER `write`. `claim` is `NX` and would refuse every
        // settle, because the key is always held by the reservation being
        // settled; `write` is unconditional and would resurrect one that had
        // expired. `overwrite` is the only one of the three that is correct.
        const written = await connection.overwrite(
          requestReservationKey(fingerprint),
          encode({ state: "settled", digest: fingerprint.digest, response }),
          ttlSeconds,
        );
        return written ? { kind: "settled" } : { kind: "expired" };
      } catch (error) {
        return { kind: "unavailable", reason: reasonOf(error) };
      }
    },

    async release(fingerprint): Promise<SettleOutcome> {
      const name = requestReservationKey(fingerprint);
      let held: string | null;
      try {
        held = await connection.read(name);
      } catch (error) {
        return { kind: "unavailable", reason: reasonOf(error) };
      }
      const record = decode(held);
      // Nothing of ours to give back. A record that is gone, a record that is
      // rubbish and a record carrying somebody else's digest are all `expired`
      // here rather than three answers, because the caller's only decision is
      // the same in all three: it produced no replayable outcome and must not
      // delete what it does not hold.
      if (record === "absent" || record === "malformed") return { kind: "expired" };
      if (record.digest !== fingerprint.digest) return { kind: "expired" };
      try {
        const removed = await connection.remove([name]);
        return removed > 0 ? { kind: "settled" } : { kind: "expired" };
      } catch (error) {
        return { kind: "unavailable", reason: reasonOf(error) };
      }
    },
  };
}
