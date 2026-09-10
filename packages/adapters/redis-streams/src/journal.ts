// THE kernel `StreamJournal`, over Redis Streams.
//
// WHAT MAKES THIS AN IMPLEMENTATION OF THAT PORT AND NOT A CACHE THAT LOOKS LIKE
// ONE: every one of the port's six facts is a DIFFERENT observation of the
// server, and no two of them can be reached by the same path.
//
//   `appended` needs the server to have accepted a caller-chosen id, which it
//   refuses when the sequence does not strictly increase.
//   `sealed` (on append) needs the seal field to be present in the metadata hash.
//   `already-sealed` (on seal) needs `HSETNX` to have lost.
//   `page` needs an exclusive range read.
//   `unknown` needs the metadata hash to be absent.
//   `expired` needs the oldest RETAINED sequence to be above the one the caller
//   asked to continue from — the one fact this whole port exists for.
//
// TWO KEYS PER STREAM, AND THE SECOND ONE IS NOT BOOKKEEPING. The stream key
// holds frames and is TRIMMED; the metadata key holds the seal and the highest
// sequence ever written and is NOT. Without it, a stream whose frames had all
// aged out would be indistinguishable from a stream that never existed — and
// those are the two answers an operator most needs kept apart, because one is a
// retention window too short for its readers and the other is a bad request.
//
// RETENTION IS TWO BOUNDS AND BOTH ARE NEEDED. `maxLength` bounds a single busy
// stream so one runaway turn cannot evict every other stream's frames from the
// server; `ttlSeconds` bounds an idle one so a stream nobody ever resumed does
// not sit in memory forever. A length bound alone leaks keys; a time bound alone
// lets one producer take the whole instance.
//
// TIME IS A PARAMETER HERE TOO. `seal` takes the instant. This file reads a clock
// exactly once, inside `read`, and only to bound a WAIT — `Date.now()` for a
// deadline is not a domain reading, and the port's `blockMs` is a duration rather
// than an instant precisely so no domain meaning rides on it.

import type {
  StreamAppendOutcome,
  StreamCursor,
  StreamFrame,
  StreamJournal,
  StreamReadOutcome,
  StreamReadRequest,
  StreamSeal,
  StreamSealOutcome,
  TerminalFrameType,
} from "@platos/kernel";
import { encodeStreamCursor, isTerminalFrameType, isOk, decodeStreamCursor } from "@platos/kernel";

import type { RedisStreamConnection } from "./client.js";

/**
 * The namespace, versioned.
 *
 * `v1` IS THE ENCODING'S VERSION AND NOT THE STREAM SCHEMA'S. They are separate
 * axes: the frames inside an entry carry their own `sv`, and this segment moves
 * only if the way an entry is LAID OUT changes — which would make every key
 * written by an older binary unreadable and must therefore be a new namespace
 * rather than a silent reinterpretation of the old one.
 */
export const STREAM_KEY_PREFIX = "platos:stream:v1";

/** The frames. Trimmed. */
export function streamKey(streamId: string): string {
  return `${STREAM_KEY_PREFIX}:${streamId}`;
}

/** The seal and the high-water sequence. NOT trimmed. */
export function streamMetaKey(streamId: string): string {
  return `${STREAM_KEY_PREFIX}:${streamId}:meta`;
}

/** Metadata fields. Two, and each is written by exactly one verb. */
const META_SEAL = "seal";
const META_LAST_SEQ = "lastSeq";

export interface RedisStreamJournalOptions {
  /** Most frames one stream retains. Older frames are trimmed on append. */
  readonly maxLength: number;
  /** How long an untouched stream survives, in seconds. */
  readonly ttlSeconds: number;
  /**
   * How often a blocking read looks again, in milliseconds.
   *
   * THIS IMPLEMENTATION POLLS AND DOES NOT HOLD A BLOCKING `XREAD`, and the
   * reason is a capacity one rather than a simplicity one. A blocking read
   * occupies its connection for the whole window, so N readers waiting 15 seconds
   * each would serialize behind one connection unless the adapter opened N of
   * them — which turns a browser count into a Redis connection count. Polling
   * costs one `XRANGE` per reader per interval and bounds the connection count at
   * one. The trade is latency of at most this interval on a frame that arrives
   * just after a look, and it is stated rather than hidden because a future
   * implementation with a dedicated follow connection would remove it.
   */
  readonly pollIntervalMs: number;
}

export const DEFAULT_JOURNAL_OPTIONS: RedisStreamJournalOptions = Object.freeze({
  // 10,000 frames is roughly a long turn's token stream with room to spare, and
  // it is a CEILING per stream rather than a target: a stream that reaches it is
  // one whose oldest frames a reader can no longer resume from, and the `trimmed`
  // count on every append is how a producer finds that out.
  maxLength: 10_000,
  // Fifteen minutes. Long enough that a browser tab suspended by a phone lock
  // screen can still resume; short enough that an abandoned stream is not a leak.
  ttlSeconds: 900,
  pollIntervalMs: 50,
});

/** Sleep, for the poll loop. Adapters may read a clock; `ambient-time` scopes to contexts. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseSeal(raw: string | null): StreamSeal | null {
  if (raw === null) return null;
  const separator = raw.indexOf(":");
  if (separator < 0) return null;
  const terminal = raw.slice(0, separator);
  const at = Number(raw.slice(separator + 1));
  if (!isTerminalFrameType(terminal) || !Number.isSafeInteger(at)) return null;
  return { terminal, at };
}

function formatSeal(seal: StreamSeal): string {
  return `${seal.terminal}:${seal.at}`;
}

/**
 * The frame inside an entry, or null when the entry is not one of ours.
 *
 * NULL RATHER THAN A THROW, for the reason `sequenceOf` returns null: this
 * directory is not the only thing that can write to a Redis server, and one
 * unreadable entry must not take down every reader of the stream it is in. The
 * caller drops it, and the client's own gap detection is what makes the loss
 * visible rather than silent.
 */
function parseFrame(body: string, seq: number): StreamFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { sv, family, t, ts, fields } = record;
  if (typeof sv !== "number" || typeof family !== "string" || typeof t !== "string") return null;
  if (typeof ts !== "number") return null;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return null;
  return {
    sv,
    family: family as StreamFrame["family"],
    t,
    // THE SEQUENCE COMES FROM THE ENTRY ID, NOT FROM THE BODY. They are written
    // together and the id is the one the SERVER enforced monotonic; trusting the
    // body would let a producer's own bug reorder a stream the server had already
    // ordered correctly.
    seq,
    ts,
    fields: fields as StreamFrame["fields"],
  };
}

function serializeFrame(frame: StreamFrame): string {
  return JSON.stringify({
    sv: frame.sv,
    family: frame.family,
    t: frame.t,
    ts: frame.ts,
    fields: frame.fields,
  });
}

function cursorFor(streamId: string, seq: number): StreamCursor | null {
  const encoded = encodeStreamCursor(streamId, seq);
  return isOk(encoded) ? encoded.value : null;
}

export interface RedisStreamJournal extends StreamJournal {
  readonly journalName: "redis-streams";
}

export function createRedisStreamJournal(
  connection: RedisStreamConnection,
  options: RedisStreamJournalOptions = DEFAULT_JOURNAL_OPTIONS,
): RedisStreamJournal {
  async function readSeal(streamId: string): Promise<StreamSeal | null> {
    return parseSeal(await connection.readMeta(streamMetaKey(streamId), META_SEAL));
  }

  async function onePass(
    streamId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StreamReadOutcome> {
    const meta = await connection.readAllMeta(streamMetaKey(streamId));
    // UNKNOWN IS DECIDED BY THE METADATA KEY AND NEVER BY AN EMPTY STREAM. A
    // stream whose frames have all been trimmed still has metadata, so the two
    // answers stay apart for as long as the window allows them to.
    if (meta === null) return { kind: "unknown" };
    const seal = parseSeal(meta[META_SEAL] ?? null);
    const lastSeqText = meta[META_LAST_SEQ];
    const parsedLastSeq = lastSeqText === undefined ? 0 : Number(lastSeqText);
    // A HIGH-WATER MARK THIS BUILD CANNOT READ IS TREATED AS ZERO, which makes
    // the `expired` branch below unreachable rather than wrong. Refusing a live
    // reader because a metadata field is corrupt would turn one bad key into an
    // outage; under-reporting retention loss only costs the reader a gap its own
    // `admitFrame` will see.
    const lastSeq = Number.isSafeInteger(parsedLastSeq) ? parsedLastSeq : 0;

    if (afterSeq > 0) {
      const oldest = await connection.oldest(streamKey(streamId));
      // THE CONSERVATION REFUSAL, and it is two conditions because a stream can
      // be trimmed to empty. With entries present, the next frame the reader
      // wants is `afterSeq + 1` and it is gone when the oldest retained sequence
      // is above it. With NO entries present, the frames are gone whenever the
      // producer ever wrote past the reader's position.
      if (oldest !== null) {
        if (oldest.seq > afterSeq + 1) {
          return { kind: "expired", earliest: cursorFor(streamId, oldest.seq) };
        }
      } else if (lastSeq > afterSeq) {
        return { kind: "expired", earliest: null };
      }
    }

    const entries = await connection.readAfter(streamKey(streamId), afterSeq, limit);
    const frames: StreamFrame[] = [];
    for (const entry of entries) {
      const frame = parseFrame(entry.body, entry.seq);
      if (frame !== null) frames.push(frame);
    }
    const lastRead = entries.length === 0 ? afterSeq : entries[entries.length - 1]!.seq;
    return {
      kind: "page",
      frames,
      cursor: lastRead > 0 ? cursorFor(streamId, lastRead) : null,
      seal,
    };
  }

  return {
    journalName: "redis-streams",

    async append(streamId, frames): Promise<StreamAppendOutcome> {
      // The position did not move, so there is no position to report. See the
      // port's own note on why this is null rather than a fabricated cursor.
      if (frames.length === 0) return { kind: "appended", cursor: null, trimmed: 0 };
      try {
        // SEAL FIRST, AND THE ORDER MATTERS. A producer that wrote frames and
        // only then noticed the seal would have already put content after a
        // terminal frame — the "trailing invalid frames" the acceptance forbids.
        // The check is not a lock: two writers can still race past it, which is
        // why the SERVER's monotonic id refusal is the second line of defence and
        // this one is the answer a well-behaved producer gets.
        const seal = await readSeal(streamId);
        if (seal !== null) return { kind: "sealed", seal };

        const report = await connection.append(
          streamKey(streamId),
          frames.map((frame) => ({ seq: frame.seq, body: serializeFrame(frame) })),
          options.maxLength,
          options.ttlSeconds,
        );
        if (report === null) {
          return {
            kind: "unavailable",
            reason: "the server refused a frame sequence that did not increase past the last one written",
          };
        }
        await connection.writeMeta(
          streamMetaKey(streamId),
          META_LAST_SEQ,
          String(report.lastSeq),
          options.ttlSeconds,
        );
        const cursor = cursorFor(streamId, report.lastSeq);
        if (cursor === null) {
          return { kind: "unavailable", reason: "this stream id cannot be written into a resume cursor" };
        }
        return { kind: "appended", cursor, trimmed: report.trimmed };
      } catch (error) {
        return { kind: "unavailable", reason: describe(error) };
      }
    },

    async seal(streamId, terminal: TerminalFrameType, at): Promise<StreamSealOutcome> {
      try {
        const proposed: StreamSeal = { terminal, at };
        const won = await connection.claimMeta(
          streamMetaKey(streamId),
          META_SEAL,
          formatSeal(proposed),
          options.ttlSeconds,
        );
        if (won) return { kind: "sealed", seal: proposed };
        const existing = await readSeal(streamId);
        // A LOST CLAIM WITH NO READABLE SEAL IS UNAVAILABLE, NOT A SUCCESS. It
        // means the field is set to something this build cannot parse, and
        // answering `already-sealed` with a fabricated seal would tell the caller
        // an outcome that is not the one recorded.
        if (existing === null) {
          return { kind: "unavailable", reason: "this stream holds a seal this build cannot read" };
        }
        return { kind: "already-sealed", seal: existing };
      } catch (error) {
        return { kind: "unavailable", reason: describe(error) };
      }
    },

    async read(
      streamId,
      after: StreamCursor | null,
      request: StreamReadRequest,
    ): Promise<StreamReadOutcome> {
      let afterSeq = 0;
      if (after !== null) {
        const position = decodeStreamCursor(after);
        // A CURSOR FOR ANOTHER STREAM IS `unknown`, NOT A SILENT READ OF THIS
        // ONE. Answering with this stream's frames would hand a caller a page
        // that does not continue the sequence they hold, which is the exact
        // wrong-answer this port refuses everywhere else.
        if (!isOk(position)) return { kind: "unknown" };
        if (position.value.streamId !== streamId) return { kind: "unknown" };
        afterSeq = position.value.seq;
      }
      try {
        const deadline = Date.now() + Math.max(0, request.blockMs);
        for (;;) {
          const outcome = await onePass(streamId, afterSeq, request.limit);
          if (outcome.kind !== "page") return outcome;
          if (outcome.frames.length > 0) return outcome;
          // A SEALED STREAM NEVER BLOCKS. There is nothing further by definition,
          // and waiting would hold a reader open for its whole window on every
          // read after the end.
          if (outcome.seal !== null) return outcome;
          if (Date.now() >= deadline) return outcome;
          await pause(Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())));
        }
      } catch (error) {
        return { kind: "unavailable", reason: describe(error) };
      }
    },
  };
}

/**
 * A cause, never a connection string.
 *
 * `config/load.ts` promises a startup diagnostic never echoes one, and this text
 * reaches `/readyz` and the operator-facing refusal. A thrown value's `message`
 * from a client library can carry the URL it dialled.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "the stream journal is unreachable";
}
