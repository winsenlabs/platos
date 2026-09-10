// THE JOURNAL, AGAINST A REAL REDIS.
//
// WHY NOTHING SMALLER WOULD DO. WIN-272's acceptance is four claims and every one
// of them is a claim about a SERVER:
//
//   "event ordering and conservation is proven under reconnect" — a reconnect is a
//   second connection, and a single in-process fake has one command queue, so the
//   interleaving that could break ordering does not exist in it;
//
//   "and multi-instance" — two producers or two readers are two clients whose
//   commands the server orders, which a double cannot exhibit at all;
//
//   "clients resume without missing or double-applying state" — resume is a read
//   addressed by a position the server assigned, so a fake that handed back its own
//   array indices would be proving that an array is ordered;
//
//   "load tests cover slow consumers" — a slow consumer matters because the journal
//   TRIMS, and trimming is a Redis behaviour with its own exact and approximate
//   forms. A fake would trim however this file told it to.
//
// IT FAILS WHEN DOCKER IS ABSENT RATHER THAN SKIPPING. A skipped integration suite
// and a passing one look identical in a CI summary.
//
// THE SEQUENCE THE SERVER ENFORCES IS THE ONE JOIN THIS SUITE CANNOT FAKE. Redis
// refuses an `XADD` whose id is not above the last, so the "a producer cannot
// repeat a sequence" case is decided by the server's own rule and not by a check
// written here — which is the difference between proving a property and proving
// that this file remembered to check for it.

import { createConnection, createServer, type Server, type Socket } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { encodeStreamCursor, unwrap, type StreamCursor, type StreamFrame } from "@platos/kernel";

import type { RedisStreamConnection } from "./client.js";
import { createRedisStreamConnection } from "./client.js";
import { startRedisStreamsHarness, type RedisStreamsHarness } from "./harness.js";
import { createRedisStreamJournal, DEFAULT_JOURNAL_OPTIONS, type RedisStreamJournal } from "./journal.js";

const TTL = 60;

function frame(seq: number, overrides: Partial<StreamFrame> = {}): StreamFrame {
  return {
    sv: 1,
    family: "sse.turn",
    t: "assistant.delta",
    seq,
    ts: 1_760_000_000_000 + seq,
    fields: { text: `chunk-${seq}` },
    ...overrides,
  };
}

function cursor(streamId: string, seq: number): StreamCursor {
  return unwrap(encodeStreamCursor(streamId, seq));
}

let harness: RedisStreamsHarness;
let connection: RedisStreamConnection;
let journal: RedisStreamJournal;
let streamCounter = 0;

/** A fresh stream id per case, so no case can inherit another's frames. */
function nextStream(): string {
  streamCounter += 1;
  return `turn_${streamCounter}`;
}

beforeAll(async () => {
  harness = await startRedisStreamsHarness();
  connection = harness.connect();
  journal = createRedisStreamJournal(connection, { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

beforeEach(async () => {
  await harness.reset();
});

describe("a stream nobody wrote", () => {
  it("is unknown, and that is not the same answer as empty", () => {
    // The distinction the metadata key exists for. `unknown` sends an operator to
    // the caller; `expired` would send them to the retention window.
    return expect(journal.read(nextStream(), null, { limit: 10, blockMs: 0 })).resolves.toEqual({
      kind: "unknown",
    });
  });
});

describe("append and read back", () => {
  it("returns the frames in the order they were written, with the producer's sequences", async () => {
    const stream = nextStream();
    const written = [frame(1), frame(2), frame(3)];
    const appended = await journal.append(stream, written);
    expect(appended.kind).toBe("appended");
    expect(appended.kind === "appended" && appended.cursor).toBe(cursor(stream, 3));

    const page = await journal.read(stream, null, { limit: 10, blockMs: 0 });
    expect(page.kind).toBe("page");
    if (page.kind !== "page") return;
    expect(page.frames.map((read) => read.seq)).toEqual([1, 2, 3]);
    expect(page.frames.map((read) => read.fields["text"])).toEqual(["chunk-1", "chunk-2", "chunk-3"]);
    expect(page.cursor).toBe(cursor(stream, 3));
    expect(page.seal).toBeNull();
  });

  it("preserves every envelope field through the server", async () => {
    const stream = nextStream();
    const written = frame(1, {
      family: "ws.agent_event",
      t: "tool_call.result",
      ts: 1_700_000_000_123,
      fields: { status: "ok", ms: 42, nested: { kind: "dispatch" }, absent: null },
    });
    await journal.append(stream, [written]);
    const page = await journal.read(stream, null, { limit: 10, blockMs: 0 });
    expect(page.kind === "page" && page.frames[0]).toEqual(written);
  });

  it("reads STRICTLY after a cursor, so a resuming client never sees its own last frame", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1), frame(2), frame(3)]);
    const page = await journal.read(stream, cursor(stream, 2), { limit: 10, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([3]);
  });

  it("honours the page limit and lets a caller walk the whole stream", async () => {
    const stream = nextStream();
    await journal.append(stream, Array.from({ length: 10 }, (_, index) => frame(index + 1)));
    const seen: number[] = [];
    let position: StreamCursor | null = null;
    for (let round = 0; round < 10; round += 1) {
      const page: Awaited<ReturnType<RedisStreamJournal["read"]>> = await journal.read(stream, position, {
        limit: 3,
        blockMs: 0,
      });
      if (page.kind !== "page" || page.frames.length === 0) break;
      expect(page.frames.length).toBeLessThanOrEqual(3);
      for (const read of page.frames) seen.push(read.seq);
      position = page.cursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("refuses a cursor that names a different stream rather than reading this one", async () => {
    const mine = nextStream();
    const other = nextStream();
    await journal.append(mine, [frame(1)]);
    await expect(journal.read(mine, cursor(other, 1), { limit: 10, blockMs: 0 })).resolves.toEqual({
      kind: "unknown",
    });
  });
});

describe("the server refuses a sequence that does not increase", () => {
  it("reports a repeated sequence as unavailable rather than writing it twice", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1), frame(2)]);
    const repeated = await journal.append(stream, [frame(2)]);
    // THE SERVER DECIDED THIS, NOT THIS FILE. Redis's own `XADD` rule is what
    // makes the refusal real: there is no check in the adapter that could be
    // deleted to make this case pass.
    expect(repeated.kind).toBe("unavailable");
    const page = await journal.read(stream, null, { limit: 10, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([1, 2]);
  });

  it("reports a sequence that goes backwards the same way", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(5)]);
    expect((await journal.append(stream, [frame(3)])).kind).toBe("unavailable");
  });

  it("writes the prefix of a batch that was legal before refusing the rest", async () => {
    // HONEST ABOUT PARTIAL FAILURE. `XADD` is per-entry, so a batch whose third
    // frame repeats a sequence has already written the first two. Pretending
    // otherwise would let a producer retry the whole batch and be refused on
    // frames the journal accepted.
    const stream = nextStream();
    await journal.append(stream, [frame(1)]);
    const mixed = await journal.append(stream, [frame(2), frame(3), frame(3)]);
    expect(mixed.kind).toBe("unavailable");
    const page = await journal.read(stream, null, { limit: 10, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([1, 2, 3]);
  });
});

describe("sealing", () => {
  it("tells a reader the producer finished, and the first seal wins", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1), frame(2, { t: "turn.done" })]);
    const sealed = await journal.seal(stream, "turn.done", 1_760_000_000_500);
    expect(sealed).toEqual({ kind: "sealed", seal: { terminal: "turn.done", at: 1_760_000_000_500 } });

    const second = await journal.seal(stream, "stream.error", 1_760_000_009_999);
    // A RETRY MUST NOT TURN A COMPLETED TURN INTO A FAILED ONE.
    expect(second).toEqual({
      kind: "already-sealed",
      seal: { terminal: "turn.done", at: 1_760_000_000_500 },
    });
  });

  it("refuses an append after the seal", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1)]);
    await journal.seal(stream, "turn.done", 1_760_000_000_500);
    const late = await journal.append(stream, [frame(2)]);
    // The "no trailing frames after a terminal frame" half of the acceptance.
    expect(late.kind).toBe("sealed");
    const page = await journal.read(stream, null, { limit: 10, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([1]);
  });

  it("surfaces the seal on every page, including one a reader has already caught up past", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1)]);
    await journal.seal(stream, "turn.done", 1_760_000_000_500);
    const caughtUp = await journal.read(stream, cursor(stream, 1), { limit: 10, blockMs: 0 });
    expect(caughtUp.kind).toBe("page");
    expect(caughtUp.kind === "page" && caughtUp.frames).toEqual([]);
    expect(caughtUp.kind === "page" && caughtUp.seal).toEqual({
      terminal: "turn.done",
      at: 1_760_000_000_500,
    });
  });

  it("does not block on a sealed stream", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1)]);
    await journal.seal(stream, "turn.done", 1);
    const started = Date.now();
    await journal.read(stream, cursor(stream, 1), { limit: 10, blockMs: 3_000 });
    // A reader at the end of a finished stream must return at once. Waiting would
    // hold every completed stream's reader open for its whole window.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("backpressure: a consumer slower than the producer", () => {
  it("REFUSES a trimmed cursor rather than answering with a gap that looks complete", async () => {
    // THE CONSERVATION CASE. A reader holds position 2; the producer writes past
    // the retention bound; positions 3..N are gone. Answering with a page starting
    // at the oldest retained frame would hand the reader a sequence that looks
    // continuous from its own next read onward, and the state it renders would be
    // silently missing everything in between.
    const stream = nextStream();
    const tight = createRedisStreamJournal(connection, {
      ...DEFAULT_JOURNAL_OPTIONS,
      maxLength: 5,
      ttlSeconds: TTL,
    });
    await tight.append(stream, [frame(1), frame(2), frame(3)]);
    const held = cursor(stream, 2);

    const flood = await tight.append(
      stream,
      Array.from({ length: 12 }, (_, index) => frame(index + 4)),
    );
    expect(flood.kind).toBe("appended");
    // THE PRODUCER LEARNS IT HAPPENED. This is the only moment backpressure is
    // observable to a writer, which is why the port reports it.
    expect(flood.kind === "appended" && flood.trimmed).toBeGreaterThan(0);
    expect(await connection.length(`platos:stream:v1:${stream}`)).toBe(5);

    const resumed = await tight.read(stream, held, { limit: 50, blockMs: 0 });
    expect(resumed.kind).toBe("expired");
    expect(resumed.kind === "expired" && resumed.earliest).toBe(cursor(stream, 11));
  });

  it("still serves a cursor inside the retained window", async () => {
    const stream = nextStream();
    const tight = createRedisStreamJournal(connection, {
      ...DEFAULT_JOURNAL_OPTIONS,
      maxLength: 5,
      ttlSeconds: TTL,
    });
    await tight.append(
      stream,
      Array.from({ length: 10 }, (_, index) => frame(index + 1)),
    );
    // Retained: 6..10. A reader holding 7 asks for 8..10 and gets exactly them.
    const page = await tight.read(stream, cursor(stream, 7), { limit: 50, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([8, 9, 10]);
  });

  it("serves the boundary cursor — the oldest frame still held minus one", async () => {
    // THE OFF-BY-ONE THIS REFUSAL LIVES OR DIES ON. With 6..10 retained, a reader
    // at position 5 has lost nothing: the next frame it wants is 6 and 6 is there.
    // Refusing here would disconnect every reader that was exactly caught up.
    const stream = nextStream();
    const tight = createRedisStreamJournal(connection, {
      ...DEFAULT_JOURNAL_OPTIONS,
      maxLength: 5,
      ttlSeconds: TTL,
    });
    await tight.append(
      stream,
      Array.from({ length: 10 }, (_, index) => frame(index + 1)),
    );
    const boundary = await tight.read(stream, cursor(stream, 5), { limit: 50, blockMs: 0 });
    expect(boundary.kind === "page" && boundary.frames.map((read) => read.seq)).toEqual([6, 7, 8, 9, 10]);
    const past = await tight.read(stream, cursor(stream, 4), { limit: 50, blockMs: 0 });
    expect(past.kind).toBe("expired");
  });

  it("reads from the beginning without claiming continuity, and the client sees the gap", async () => {
    // `after: null` is "whatever you have", NOT a claim to have missed nothing —
    // so it is a page and not `expired`. The loss is still visible, because the
    // first frame's sequence is not 1 and the client's own `admitFrame(0, ...)`
    // reports the gap. Two mechanisms, one answer.
    const stream = nextStream();
    const tight = createRedisStreamJournal(connection, {
      ...DEFAULT_JOURNAL_OPTIONS,
      maxLength: 3,
      ttlSeconds: TTL,
    });
    await tight.append(
      stream,
      Array.from({ length: 8 }, (_, index) => frame(index + 1)),
    );
    const page = await tight.read(stream, null, { limit: 50, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([6, 7, 8]);
  });
});

describe("following the live end", () => {
  it("returns as soon as a frame arrives rather than after the whole window", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1)]);
    const started = Date.now();
    const following = journal.read(stream, cursor(stream, 1), { limit: 10, blockMs: 5_000 });
    setTimeout(() => {
      void journal.append(stream, [frame(2)]);
    }, 200);
    const page = await following;
    const waited = Date.now() - started;
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([2]);
    expect(waited).toBeGreaterThanOrEqual(150);
    expect(waited).toBeLessThan(4_000);
  });

  it("returns an empty page when the window closes with nothing written", async () => {
    const stream = nextStream();
    await journal.append(stream, [frame(1)]);
    const started = Date.now();
    const page = await journal.read(stream, cursor(stream, 1), { limit: 10, blockMs: 400 });
    expect(page.kind).toBe("page");
    expect(page.kind === "page" && page.frames).toEqual([]);
    // AN EMPTY PAGE IS NOT AN ERROR: it is how a reader learns the producer has
    // not finished AND has nothing new, which is the state a heartbeat exists for.
    expect(page.kind === "page" && page.seal).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
  });
});

describe("two clients, one server", () => {
  it("gives two readers on separate connections the identical ordering", async () => {
    // MULTI-INSTANCE, LITERALLY. Two connections the server interleaves, not two
    // objects sharing one socket.
    const stream = nextStream();
    const writer = createRedisStreamJournal(harness.connect(), {
      ...DEFAULT_JOURNAL_OPTIONS,
      ttlSeconds: TTL,
    });
    const readerA = createRedisStreamJournal(harness.connect(), {
      ...DEFAULT_JOURNAL_OPTIONS,
      ttlSeconds: TTL,
    });
    const readerB = createRedisStreamJournal(harness.connect(), {
      ...DEFAULT_JOURNAL_OPTIONS,
      ttlSeconds: TTL,
    });
    await writer.append(
      stream,
      Array.from({ length: 40 }, (_, index) => frame(index + 1)),
    );
    const [pageA, pageB] = await Promise.all([
      readerA.read(stream, null, { limit: 100, blockMs: 0 }),
      readerB.read(stream, null, { limit: 100, blockMs: 0 }),
    ]);
    const seqsA = pageA.kind === "page" ? pageA.frames.map((read) => read.seq) : [];
    const seqsB = pageB.kind === "page" ? pageB.frames.map((read) => read.seq) : [];
    expect(seqsA).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(seqsB).toEqual(seqsA);
  });

  it("lets only one of two racing producers write each sequence", async () => {
    // The server's monotonic-id rule under real contention: two producers both
    // holding `seq: 1` cannot both land it, and the loser is TOLD.
    const stream = nextStream();
    const one = createRedisStreamJournal(harness.connect(), { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
    const two = createRedisStreamJournal(harness.connect(), { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
    const [first, second] = await Promise.all([
      one.append(stream, [frame(1, { fields: { text: "one" } })]),
      two.append(stream, [frame(1, { fields: { text: "two" } })]),
    ]);
    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(["appended", "unavailable"]);
    const page = await journal.read(stream, null, { limit: 10, blockMs: 0 });
    expect(page.kind === "page" && page.frames.length).toBe(1);
  });

  it("lets only one of two racing seals win, and both learn the same outcome", async () => {
    const stream = nextStream();
    const one = createRedisStreamJournal(harness.connect(), { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
    const two = createRedisStreamJournal(harness.connect(), { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
    await journal.append(stream, [frame(1)]);
    const [first, second] = await Promise.all([
      one.seal(stream, "turn.done", 111),
      two.seal(stream, "stream.error", 222),
    ]);
    const kinds = [first.kind, second.kind].sort();
    expect(kinds).toEqual(["already-sealed", "sealed"]);
    // BOTH PARTIES END UP HOLDING THE SAME SEAL. Two callers left believing
    // different outcomes would be worse than either outcome.
    expect(first.kind !== "unavailable" && second.kind !== "unavailable").toBe(true);
    if (first.kind === "unavailable" || second.kind === "unavailable") return;
    expect(first.seal).toEqual(second.seal);
  });
});

describe("a reconnect", () => {
  it("resumes on a NEW connection from a cursor the old one was holding", async () => {
    // The reconnect the acceptance names. The second journal shares nothing with
    // the first but the server: no in-process state carries the position across.
    const stream = nextStream();
    await journal.append(stream, [frame(1), frame(2), frame(3)]);
    const held = cursor(stream, 2);

    const reconnected = createRedisStreamJournal(harness.connect(), {
      ...DEFAULT_JOURNAL_OPTIONS,
      ttlSeconds: TTL,
    });
    await journal.append(stream, [frame(4), frame(5)]);
    const page = await reconnected.read(stream, held, { limit: 50, blockMs: 0 });
    expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([3, 4, 5]);
  });

  it("conserves every frame across a reconnect in the middle of a run", async () => {
    // THE WHOLE PROPERTY, END TO END: 200 frames, a reader that drops after 37 and
    // returns on a new connection, and an applied set that must be the run itself
    // with nothing missing and nothing twice.
    const stream = nextStream();
    const total = 200;
    await journal.append(
      stream,
      Array.from({ length: total }, (_, index) => frame(index + 1)),
    );

    const applied: number[] = [];
    let position: StreamCursor | null = null;
    let reader = createRedisStreamJournal(harness.connect(), { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
    for (let round = 0; round < 40; round += 1) {
      const page: Awaited<ReturnType<RedisStreamJournal["read"]>> = await reader.read(stream, position, {
        limit: 17,
        blockMs: 0,
      });
      if (page.kind !== "page" || page.frames.length === 0) break;
      for (const read of page.frames) applied.push(read.seq);
      position = page.cursor;
      // The drop, mid-run: a brand-new client with nothing but the cursor.
      if (applied.length >= 37 && round === 2) {
        reader = createRedisStreamJournal(harness.connect(), {
          ...DEFAULT_JOURNAL_OPTIONS,
          ttlSeconds: TTL,
        });
      }
    }
    expect(applied).toEqual(Array.from({ length: total }, (_, index) => index + 1));
    expect(new Set(applied).size).toBe(total);
  });
});

describe("a server that is not there yet", () => {
  /**
   * A TCP forwarder this suite starts and stops, so the "server" behind a port can
   * appear AFTER a client has already failed to reach it.
   *
   * WHY THIS IS WORTH A SERVER OF ITS OWN. The defect it proves absent is not
   * hypothetical: the FIRST run of this suite against a cold container reported
   * `unavailable` on twenty-three of twenty-four cases while the server was
   * healthy. The handshake promise was built ONCE at construction and rejected on
   * the first `error`, so every command for the life of that connection failed on
   * a settled rejection. Nothing else in this file could catch it, because every
   * other case reaches a server that is already up — which is precisely why a
   * cold-start defect survives a green suite.
   */
  function forward(port: number, upstream: URL): Server {
    const server = createServer((inbound: Socket) => {
      const outbound = createConnection({ port: Number(upstream.port), host: upstream.hostname });
      inbound.pipe(outbound);
      outbound.pipe(inbound);
      const drop = () => {
        inbound.destroy();
        outbound.destroy();
      };
      inbound.on("error", drop);
      outbound.on("error", drop);
    });
    server.listen(port, "127.0.0.1");
    return server;
  }

  /** A port nothing is listening on: claimed, read, and released. */
  async function freePort(): Promise<number> {
    const probe = createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it("recovers once the server appears, rather than failing forever on one early error", async () => {
    const upstream = new URL(harness.url);
    const port = await freePort();

    const connection = createRedisStreamConnection({
      url: `redis://127.0.0.1:${port}`,
      readyTimeoutMs: 2_000,
    });
    let serving: Server | null = null;
    try {
      const cold = createRedisStreamJournal(connection, { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
      // The first command FAILS rather than hanging — the fail-closed half.
      expect((await cold.read("cold_start", null, { limit: 1, blockMs: 0 })).kind).toBe("unavailable");

      serving = forward(port, upstream);
      await new Promise<void>((resolve) => {
        serving?.once("listening", () => resolve());
        if (serving?.listening === true) resolve();
      });

      // THE ASSERTION THE ONE-SHOT SHAPE COULD NOT PASS. Same connection object,
      // same client; only the server changed.
      const warm = createRedisStreamJournal(connection, { ...DEFAULT_JOURNAL_OPTIONS, ttlSeconds: TTL });
      const stream = nextStream();
      const appended = await warm.append(stream, [frame(1)]);
      expect(appended.kind).toBe("appended");
      const page = await warm.read(stream, null, { limit: 10, blockMs: 0 });
      expect(page.kind === "page" && page.frames.map((read) => read.seq)).toEqual([1]);
    } finally {
      await connection.close();
      if (serving !== null) await new Promise<void>((resolve) => serving?.close(() => resolve()));
    }
  }, 60_000);
});
