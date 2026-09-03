// The three kernel ports with no adapter, implemented at the process edge.
//
// WHY THEY LIVE HERE AND NOT UNDER packages/adapters/.
// ADR M0.3 §4 defines an adapter as the sole holder of ONE vendor SDK. `Clock`,
// `IdGenerator` and `Logger` have no vendor: they are the platform's own
// primitives over `Date`, `crypto` and a byte stream. Manufacturing three
// adapter packages to hold no SDK would inflate the 32-project graph to satisfy
// a definition that does not describe them. ADR M0.3 §5.3 rules out the other
// candidate — the kernel declares these ports and may not implement them, since
// it may hold no clock, no randomness and no I/O.
//
// That leaves the composition root, which is also where they are correct: a
// process's clock, its identity source and its log stream are process
// properties. This is the seam WIN-297 exists to create.
//
// Nothing here is a business rule, and nothing here is reachable from a context
// except by being handed over as a port at composition time.

import { randomUUID } from "node:crypto";

import {
  asIdentifier,
  type Clock,
  type IdGenerator,
  type JsonValue,
  type LogFields,
  type LogLevel,
  type Logger,
  type Ulid,
  type Uuid,
} from "@platos/kernel";

import { currentCorrelation } from "./correlation.js";

export function systemClock(): Clock {
  return { now: () => new Date() };
}

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID: 48 bits of millisecond timestamp then 80 bits of randomness, both
 * Crockford base-32.
 *
 * Monotonicity within a millisecond is the point of the format, so a counter is
 * carried: two ids minted in the same millisecond must still sort in creation
 * order, or a "sortable" identifier silently is not one under load — which is
 * exactly when ordering starts to matter.
 */
export function ulidGenerator(clock: Clock = systemClock()): IdGenerator {
  let lastMillisecond = -1;
  let lastRandom: number[] = [];

  const encodeTime = (millisecond: number): string => {
    let remaining = millisecond;
    let out = "";
    for (let index = 0; index < 10; index += 1) {
      out = `${CROCKFORD32[remaining % 32] ?? "0"}${out}`;
      remaining = Math.floor(remaining / 32);
    }
    return out;
  };

  const freshRandom = (): number[] => {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte % 32);
  };

  const incrementRandom = (values: number[]): number[] => {
    const next = [...values];
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const value = (next[index] ?? 0) + 1;
      next[index] = value % 32;
      if (value < 32) return next;
    }
    // Overflowed all 80 bits inside one millisecond. Astronomically unlikely,
    // and re-randomising is still ordered against the NEXT millisecond, which is
    // the property callers actually depend on.
    return freshRandom();
  };

  return {
    uuid: (): Uuid => asIdentifier<Uuid>(randomUUID()),
    ulid: (): Ulid => {
      const millisecond = clock.now().getTime();
      if (millisecond === lastMillisecond) lastRandom = incrementRandom(lastRandom);
      else {
        lastMillisecond = millisecond;
        lastRandom = freshRandom();
      }
      const random = lastRandom.map((value) => CROCKFORD32[value] ?? "0").join("");
      return asIdentifier<Ulid>(`${encodeTime(millisecond)}${random}`);
    },
  };
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface ProcessLoggerOptions {
  readonly minimumLevel: LogLevel;
  readonly write: (line: string) => void;
  readonly clock?: Clock;
  readonly base?: LogFields;
}

/**
 * One JSON object per line.
 *
 * The kernel `Logger` port has no `log(string)` overload on purpose, and this
 * implementation keeps that promise: `message` is a constant the code chose and
 * `fields` are structured, so nothing here interpolates caller data into a
 * sentence that could not later be redacted, indexed or correlated.
 *
 * The correlation id is stamped from the ambient request rather than passed by
 * every caller. A caller that must remember to attach it is a caller that will
 * eventually forget, and one unattributed line breaks a trace.
 */
export function createProcessLogger(options: ProcessLoggerOptions): Logger {
  const clock = options.clock ?? systemClock();
  const build = (base: LogFields): Logger => ({
    log(level: LogLevel, message: string, fields?: LogFields): void {
      if (LEVEL_ORDER[level] < LEVEL_ORDER[options.minimumLevel]) return;
      const correlation = currentCorrelation();
      const payload: Record<string, JsonValue> = {
        at: clock.now().toISOString(),
        level,
        message,
        ...base,
        ...(fields ?? {}),
      };
      if (correlation !== null) payload["requestId"] = correlation.requestId;
      options.write(`${JSON.stringify(payload)}\n`);
    },
    child(fields: LogFields): Logger {
      return build({ ...base, ...fields });
    },
  });
  return build(options.base ?? {});
}
