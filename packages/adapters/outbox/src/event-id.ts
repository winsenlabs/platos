// The event identifier, and why it is a UUIDv7 rather than a UUIDv4.
//
// THE ORDERING PROBLEM THIS SOLVES. A drain reads the outbox oldest-first, and
// the only ordering column the frozen `Event` row has is `createdAt`, declared
// `TIMESTAMP(3)` by the initial migration. Millisecond resolution is coarser
// than an append loop: two events written inside one millisecond carry the SAME
// createdAt, so `ORDER BY "createdAt"` alone leaves their relative order to
// whatever the planner does, and a random UUIDv4 primary key cannot break the
// tie in append order either. Both halves of a settlement can then reach a drain
// reversed, which is exactly the kind of defect that reads as "impossible" in a
// suite of ten events and shows up under load.
//
// A UUIDv7 fixes it without a schema change. Its first 48 bits are the Unix
// millisecond, big-endian, and the 12 bits after the version nibble are free —
// this module uses them as a within-millisecond counter. PostgreSQL compares
// `uuid` values byte by byte, so `ORDER BY "createdAt", "id"` is append order
// for every pair of rows this process wrote, and the column type does not move:
// a v7 uuid is still 128 bits and still fits `UUID`.
//
// A BACKWARDS CLOCK IS CLAMPED, AND THE CLAMPED INSTANT IS WHAT THE ROW GETS.
// `mint` returns the instant it actually used, and the adapter stamps
// `Event.createdAt` from that rather than from the raw reading. Without the
// clamp the identifier would be monotonic and the timestamp would not, and
// `ORDER BY "createdAt", "id"` compares the timestamp FIRST — so an ordering
// property held only by the identifier would be thrown away by the ordering the
// drain actually uses. The cost is that a row's timestamp can sit a few
// milliseconds ahead of a clock that jumped back; the alternative is a drain
// reading two events in the wrong order, which is worse.
//
// WHAT THIS DOES NOT CLAIM. The counter is per PROCESS. Two writers appending
// inside the same millisecond order by their random tails. Total cross-writer
// order needs a database sequence, which the frozen row does not have; this is
// the strongest guarantee the baseline schema allows, and the integration suite
// pins exactly it — order within one writer, preserved.

/** Bytes drawn for the random tail. Injectable so a suite can pin them. */
export type RandomBytes = (length: number) => Uint8Array;

/** The largest value the 12 counter bits hold. */
export const COUNTER_LIMIT = 0x1000;

/** A minted identifier and the instant it was actually minted from. */
export interface MintedEventId {
  readonly eventId: string;
  readonly at: Date;
}

export interface EventIdMinter {
  /** A UUIDv7 for `at`, monotonic within and across milliseconds. */
  mint(at: Date): MintedEventId;
}

function hex(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
}

/**
 * A minter with its own counter.
 *
 * ONE PER PROCESS, held by the adapter. A second minter would start its counter
 * at zero again, and the ordering property between the two would be gone —
 * which is the whole thing being bought here.
 */
export function createEventIdMinter(randomBytes: RandomBytes): EventIdMinter {
  let lastMilliseconds = -1;
  let counter = 0;

  return {
    mint(at: Date): MintedEventId {
      const milliseconds = at.getTime();
      if (!Number.isFinite(milliseconds)) {
        throw new RangeError("an event identifier needs a real instant to be minted from");
      }
      if (milliseconds > lastMilliseconds) {
        counter = 0;
        lastMilliseconds = milliseconds;
      } else {
        // The same millisecond, or a clock that stepped BACKWARDS. Both keep the
        // counter running rather than resetting it, so the next event this
        // process writes still sorts after the one before it.
        counter += 1;
        // A full millisecond of counter is 4096 events. Refusing is better than
        // wrapping: a wrapped counter mints a SMALLER identifier than the one
        // before it, which silently reverses two events in the drain — the one
        // failure this module exists to make impossible.
        if (counter >= COUNTER_LIMIT) {
          throw new RangeError(
            `more than ${String(COUNTER_LIMIT)} events were appended in one millisecond;` +
              " the ordering counter cannot carry them",
          );
        }
      }

      const bytes = new Uint8Array(16);
      const time = BigInt(lastMilliseconds);
      for (let index = 0; index < 6; index += 1) {
        bytes[index] = Number((time >> BigInt(8 * (5 - index))) & 0xffn);
      }
      bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
      bytes[7] = counter & 0xff;
      const tail = randomBytes(8);
      for (let index = 0; index < 8; index += 1) bytes[8 + index] = tail[index] ?? 0;
      // The RFC 9562 variant bits, written over the first byte of the tail.
      bytes[8] = ((tail[0] ?? 0) & 0x3f) | 0x80;

      const text = hex(bytes);
      const eventId = [
        text.slice(0, 8),
        text.slice(8, 12),
        text.slice(12, 16),
        text.slice(16, 20),
        text.slice(20),
      ].join("-");
      return { eventId, at: new Date(lastMilliseconds) };
    },
  };
}
