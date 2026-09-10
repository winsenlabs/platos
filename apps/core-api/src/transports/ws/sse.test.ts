// THE STREAM LANE'S MECHANICS, AGAINST DOUBLES — AND WHAT A DOUBLE IS THE RIGHT
// TOOL FOR HERE.
//
// The real-socket half is `composition/stream-lane.integration.test.ts`: a Nest
// application on a real port, a real PostgreSQL, a real Redis, and a hand-rolled SSE
// reader. It is in `composition/` and not beside this file because rule (C8) refuses
// a `transports/**` file that reads `app.adapters`, and that suite is the PRODUCER.
//
// ONE THING A SOCKET CANNOT SHOW, AND IT IS IN THIS FILE. `writeWithBackpressure`
// gives up when a full socket never drains. Filling a real operating-system send
// buffer takes megabytes and minutes, so a suite that tried to reach that branch
// over a connection would either take minutes or — far worse — silently never
// enter it and go green. A response double whose `write` returns false and which
// never emits `drain` is in exactly the state a wedged socket is in, in one line.
//
// THIS FILE WAS SPLIT IN THREE, AND THE BUDGET IS WHY. It reached 495 effective
// lines against ADR M0.3 §6's warn-at-400 / fail-at-500 band, so it was split on
// the two seams it already had: `stream-errors.test.ts` holds the six refusals and
// their taxonomy join, `stream-pump.test.ts` holds the read loop and the
// credential fence, and what is left here is the BYTES — the headers, the frame
// encoding, the keep-alive, the socket's flow control and the journal key. No
// warning row was added to the gate's pinned list, which is the difference between
// splitting a file and naming a number.

import { describe, expect, it } from "vitest";

import {
  admitFrame,
  decodeStreamCursor,
  encodeStreamCursor,
  STREAM_SCHEMA_VERSION,
  unwrap,
  type StreamCursor,
  type StreamFrame,
} from "@platos/kernel";

import {
  DEFAULT_SSE_OPTIONS,
  encodeHeartbeat,
  encodeSseEvent,
  encodeSseFrame,
  encodeStreamMeta,
  openEventStream,
  presentedResumeId,
  watchForDisconnect,
  writeWithBackpressure,
  type StreamResponse,
} from "./sse.js";
import { journalStreamId, terminalErrorFrame } from "./streams.controller.js";

const STREAM = "env-1/turn-1";

function frame(seq: number, overrides: Partial<StreamFrame> = {}): StreamFrame {
  return {
    sv: STREAM_SCHEMA_VERSION,
    family: "sse.turn",
    t: "assistant.delta",
    seq,
    ts: 1_760_000_000_000 + seq,
    fields: { text: `chunk-${seq}` },
    ...overrides,
  };
}

function cursor(seq: number, stream = STREAM): StreamCursor {
  return unwrap(encodeStreamCursor(stream, seq));
}

/** A response that records what was written and can be told to stop draining. */
function recordingResponse(options: { readonly wedged?: boolean } = {}): StreamResponse & {
  readonly chunks: string[];
  readonly headers: Map<string, string>;
  ended: boolean;
} {
  const chunks: string[] = [];
  const headers = new Map<string, string>();
  const listeners = new Map<string, (() => void)[]>();
  const response = {
    chunks,
    headers,
    ended: false,
    writableEnded: false,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return undefined;
    },
    flushHeaders() {
      headers.set("__flushed", "yes");
    },
    write(chunk: string) {
      chunks.push(chunk);
      // WEDGED MEANS `false` AND NO `drain`, EVER — which is the state a full
      // socket is in and the only way to reach the deadline branch.
      return options.wedged !== true;
    },
    end() {
      response.ended = true;
      (response as { writableEnded: boolean }).writableEnded = true;
      return undefined;
    },
    once(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return undefined;
    },
    off(event: string, listener: () => void) {
      listeners.set(event, (listeners.get(event) ?? []).filter((held) => held !== listener));
      return undefined;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  return response as unknown as StreamResponse & {
    readonly chunks: string[];
    readonly headers: Map<string, string>;
    ended: boolean;
  };
}

describe("the event-stream headers", () => {
  it("declares the media type, refuses caching AND transforming, and flushes", () => {
    const response = recordingResponse();
    openEventStream(response);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    // `no-transform` MATTERS AS MUCH AS `no-cache`: a proxy that gzipped this
    // would buffer it, and a buffered event stream arrives all at once at the end.
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("__flushed")).toBe("yes");
  });
});

describe("the wire bytes", () => {
  it("writes `id:` as the CURSOR, so a resume survives a process restart", () => {
    const encoded = encodeSseFrame(frame(7), cursor(7), DEFAULT_SSE_OPTIONS.maxFrameBytes);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const [idLine] = encoded.bytes.split("\n");
    expect(idLine).toBe(`id: ${cursor(7)}`);
    // AND IT DECODES BACK TO THIS STREAM AND THIS POSITION. A bare `id: 7` would
    // name nothing a second process could continue from, which is the defect M0.4
    // §2's drift-check column records against the live lane.
    expect(unwrap(decodeStreamCursor(idLine!.slice("id: ".length)))).toEqual({
      streamId: STREAM,
      seq: 7,
    });
  });

  it("puts the flat envelope on the `data:` line and nothing else", () => {
    const encoded = encodeSseFrame(frame(1), cursor(1), DEFAULT_SSE_OPTIONS.maxFrameBytes);
    if (!encoded.ok) throw new Error("expected bytes");
    const data = encoded.bytes.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data!.slice("data: ".length))).toEqual({
      sv: 1,
      t: "assistant.delta",
      seq: 1,
      ts: 1_760_000_000_001,
      text: "chunk-1",
    });
  });

  it("refuses a frame past the ceiling rather than truncating it", () => {
    const huge = frame(1, { fields: { text: "x".repeat(200) } });
    expect(encodeSseFrame(huge, cursor(1), 64)).toEqual({ ok: false, seq: 1 });
  });

  it("refuses a frame whose payload shadows a reserved field", () => {
    const shadowed = frame(1, { fields: { seq: 99 } });
    expect(encodeSseFrame(shadowed, cursor(1), DEFAULT_SSE_OPTIONS.maxFrameBytes).ok).toBe(false);
  });

  it("writes a transport-minted frame with NO `id:` line", () => {
    // The absent id is what keeps `Last-Event-ID` naming the last frame the
    // JOURNAL holds. An id here would be a cursor the journal has never held.
    const encoded = encodeSseEvent(terminalErrorFrame(9, 1, "STREAM_CREDENTIAL_EXPIRED"), 4096);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.bytes.startsWith("data: ")).toBe(true);
    expect(encoded.bytes).not.toContain("id:");
  });

  it("writes the LEADING `stream_meta` on SSE's own `event:` channel", () => {
    // M0.4 §2's SSE row asks for it, and the ONE design decision in it is asserted
    // here: it rides on `event:` rather than on the default type, so it never
    // enters the sequence a client's `admitFrame` tracks. There is no honest `seq`
    // for a statement ABOUT a stream.
    const meta = encodeStreamMeta(STREAM_SCHEMA_VERSION, cursor(41));
    expect(meta.startsWith("event: stream_meta\n")).toBe(true);
    expect(meta).not.toContain("id:");
    const data = meta.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data!.slice("data: ".length))).toEqual({ sv: 1, replayFrom: cursor(41) });
  });

  it("says `replayFrom: null` when the reader asked for the whole stream", () => {
    const meta = encodeStreamMeta(STREAM_SCHEMA_VERSION, null);
    const data = meta.split("\n").find((line) => line.startsWith("data: "));
    expect(JSON.parse(data!.slice("data: ".length))).toEqual({ sv: 1, replayFrom: null });
  });

  it("makes a heartbeat an SSE COMMENT, with no id and no data", () => {
    const beat = encodeHeartbeat();
    expect(beat.startsWith(":")).toBe(true);
    expect(beat).not.toContain("data:");
    expect(beat).not.toContain("id:");
    // AND A CLIENT'S SEQUENCE TRACKING IS UNTOUCHED BY IT, which is the property
    // the comment form exists for: a keep-alive that consumed a `seq` would make
    // a client compute a gap out of a keep-alive it missed.
    expect(admitFrame(4, frame(5))).toEqual({ kind: "apply" });
  });
});

describe("backpressure", () => {
  it("writes straight through when the socket is not full", async () => {
    const response = recordingResponse();
    expect(await writeWithBackpressure(response, "x", 50)).toBe(true);
    expect(response.chunks).toEqual(["x"]);
  });

  it("waits for `drain` and then reports success", async () => {
    const response = recordingResponse({ wedged: true });
    const writing = writeWithBackpressure(response, "x", 5_000);
    (response as unknown as { emit(event: string): void }).emit("drain");
    expect(await writing).toBe(true);
  });

  it("GIVES UP on a socket that never drains, rather than waiting forever", async () => {
    // THE BRANCH A REAL SOCKET CANNOT REACH IN A TEST. See the banner.
    const response = recordingResponse({ wedged: true });
    const started = Date.now();
    expect(await writeWithBackpressure(response, "x", 120)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("refuses to write to a response that has already ended", async () => {
    const response = recordingResponse();
    response.end();
    expect(await writeWithBackpressure(response, "x", 50)).toBe(false);
    expect(response.chunks).toEqual([]);
  });
});

describe("disconnect", () => {
  it("notices a close on the REQUEST and on the RESPONSE", () => {
    for (const source of ["request", "response"] as const) {
      const handlers: (() => void)[] = [];
      const request = {
        headers: {},
        on(_event: string, listener: () => void) {
          if (source === "request") handlers.push(listener);
        },
      };
      const response = recordingResponse();
      const original = response.once.bind(response);
      const gone = watchForDisconnect(request, {
        ...response,
        once(event: string, listener: () => void) {
          if (source === "response" && event === "close") handlers.push(listener);
          return original(event, listener);
        },
      } as StreamResponse);
      expect(gone()).toBe(false);
      for (const handler of handlers) handler();
      expect(gone(), `${source} close was not observed`).toBe(true);
    }
  });
});

describe("the resume header", () => {
  it("reads a single value and ignores a repeated one", () => {
    expect(presentedResumeId({ headers: { "last-event-id": cursor(3) }, on() {} })).toBe(cursor(3));
    expect(presentedResumeId({ headers: {}, on() {} })).toBeNull();
    expect(presentedResumeId({ headers: { "last-event-id": "" }, on() {} })).toBeNull();
    // A repeated header arrives as an ARRAY, and treating it as present would let
    // a caller choose which of two positions this lane resumed from.
    expect(presentedResumeId({ headers: { "last-event-id": [cursor(1), cursor(9)] }, on() {} })).toBeNull();
  });
});

describe("the journal key is the tenancy boundary", () => {
  it("puts the environment inside the key rather than beside it", () => {
    expect(journalStreamId("env-a", "turn-1")).toBe("env-a/turn-1");
    // TWO ENVIRONMENTS NAMING THE SAME STREAM ID REACH DIFFERENT KEYS, which is
    // what makes a forged scope a 404 instead of another tenant's frames.
    expect(journalStreamId("env-a", "turn-1")).not.toBe(journalStreamId("env-b", "turn-1"));
    // AND THE KEY ROUND-TRIPS THROUGH THE CURSOR, separator and all, because the
    // encoding is length-prefixed.
    expect(unwrap(decodeStreamCursor(cursor(2, journalStreamId("env-a", "turn-1")))).streamId).toBe(
      "env-a/turn-1",
    );
  });
});
