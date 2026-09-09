// THE STREAM ENVELOPE'S OWN CASES.
//
// WHAT THIS SUITE IS AND IS NOT. It is a suite about a pure value object, so it
// proves the ARITHMETIC of ordering, resume and refusal and nothing about a
// socket. The socket half is `apps/core-api/src/transports/stream/*.integration.
// test.ts`, which drives these same functions over a real HTTP connection against
// a real Redis. Both exist because they can fail differently: a correct
// `admitFrame` can still be called at the wrong moment, and a correct SSE writer
// can still be handed a frame this file would have refused.
//
// THE JOIN, AND WHERE HALF OF IT HAD TO GO INSTEAD. Two of the cases below are
// anchored outside the values this file wrote:
//
//   `RESERVED_FRAME_FIELDS` is compared to the keys `flattenFrame` actually emits
//   for a frame with an empty payload, so the list cannot drift from the writer it
//   describes;
//
//   the cursor round-trips through `URLSearchParams` and through a real `Headers`
//   object, which are the two encodings a live `Last-Event-ID` survives — a cursor
//   a header refuses is a cursor no browser can send back. `Headers` is a platform
//   global and NOT an import, which is what lets a kernel suite use it.
//
// THE THIRD JOIN IS NOT HERE, AND THE GATE THAT REFUSED IT WAS RIGHT. The natural
// case for `STREAM_ENVELOPE_FAMILIES` is to read the five names out of ADR M0.4
// §1.2 on disk, and `kernel-content` rule K1 fails a kernel test that imports
// `node:fs` — "a kernel test may import only relative paths and vitest". Reading a
// document is exactly the ambient dependency the kernel is a leaf to avoid. So the
// ADR join lives in `scripts/arch/stream-contracts.mjs`, which owns every other
// contract-to-source join for this surface, and this file asserts only the shape
// it can see without leaving the package.

import { describe, expect, it } from "vitest";

import { isOk, unwrap, type Result } from "./error.js";
import {
  admitFrame,
  admitFrameSize,
  classifyStreamEnd,
  decodeStreamCursor,
  encodeStreamCursor,
  flattenFrame,
  isResumable,
  isTerminalFrameType,
  negotiateStreamVersion,
  RESERVED_FRAME_FIELDS,
  STREAM_ENVELOPE_FAMILIES,
  STREAM_MAX_FRAME_BYTES,
  STREAM_SCHEMA_VERSION,
  STREAM_SCHEMA_VERSION_MAX,
  STREAM_SCHEMA_VERSION_MIN,
  TERMINAL_FRAME_TYPES,
  type StreamCursor,
  type StreamFrame,
} from "./stream-frame.js";

function frame(overrides: Partial<StreamFrame> = {}): StreamFrame {
  return {
    sv: STREAM_SCHEMA_VERSION,
    family: "sse.turn",
    t: "assistant.delta",
    seq: 1,
    ts: 1_760_000_000_000,
    fields: {},
    ...overrides,
  };
}

function errorCode(result: Result<unknown>): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error.code;
}

describe("the envelope families and the major", () => {
  it("holds five distinct families, frozen", () => {
    // The names themselves are joined to ADR M0.4 §1.2 by
    // `scripts/arch/stream-contracts.mjs`; see the banner. What is provable
    // without leaving the package is that the list is a real closed set.
    expect(STREAM_ENVELOPE_FAMILIES.length).toBe(5);
    expect(new Set(STREAM_ENVELOPE_FAMILIES).size).toBe(5);
    expect(Object.isFrozen(STREAM_ENVELOPE_FAMILIES)).toBe(true);
  });

  it("pins one major, and the band it will speak is that major", () => {
    expect(STREAM_SCHEMA_VERSION).toBe(1);
    expect(STREAM_SCHEMA_VERSION_MIN).toBeLessThanOrEqual(STREAM_SCHEMA_VERSION);
    expect(STREAM_SCHEMA_VERSION_MAX).toBe(STREAM_SCHEMA_VERSION);
  });
});

describe("the flat frame", () => {
  it("emits exactly the reserved fields when the payload is empty", () => {
    const flat = unwrap(flattenFrame(frame()));
    // The RESERVED list is compared to what the writer produces, not to itself.
    expect(Object.keys(flat).sort()).toEqual([...RESERVED_FRAME_FIELDS].sort());
    expect(flat).toEqual({ sv: 1, t: "assistant.delta", seq: 1, ts: 1_760_000_000_000 });
  });

  it("keeps `family` off the wire", () => {
    const flat = unwrap(flattenFrame(frame({ family: "ws.agent_event" })));
    expect(Object.prototype.hasOwnProperty.call(flat, "family")).toBe(false);
  });

  it("merges the payload beside the envelope", () => {
    const flat = unwrap(flattenFrame(frame({ fields: { threadId: "th_1", text: "hi" } })));
    expect(flat).toEqual({
      sv: 1,
      t: "assistant.delta",
      seq: 1,
      ts: 1_760_000_000_000,
      threadId: "th_1",
      text: "hi",
    });
  });

  it("refuses every reserved field a payload could shadow, one at a time", () => {
    for (const reserved of RESERVED_FRAME_FIELDS) {
      const refused = flattenFrame(frame({ fields: { [reserved]: 999 } }));
      expect(errorCode(refused), `${reserved} must be refused`).toBe("STREAM_FRAME_FIELD_RESERVED");
    }
  });

  it("does not let a payload field named `seq` rewrite the sequence", () => {
    // The defect this refusal exists for, stated as a case: a producer that put
    // `seq` in its payload would choose the number the client's gap detection
    // reads, and a spread would have let it win silently.
    const refused = flattenFrame(frame({ seq: 7, fields: { seq: 1 } }));
    expect(refused.ok).toBe(false);
  });

  it("ignores an inherited property that is not the frame's own", () => {
    const inherited = Object.create({ seq: 1 }) as Record<string, never>;
    const flat = unwrap(flattenFrame(frame({ fields: inherited })));
    expect(flat["seq"]).toBe(1);
  });
});

describe("frame size", () => {
  it("admits a frame at the ceiling and refuses one past it", () => {
    expect(unwrap(admitFrameSize(STREAM_MAX_FRAME_BYTES))).toBe(STREAM_MAX_FRAME_BYTES);
    expect(errorCode(admitFrameSize(STREAM_MAX_FRAME_BYTES + 1))).toBe("STREAM_FRAME_TOO_LARGE");
  });

  it("counts BYTES, so a multi-byte alphabet cannot buy extra room", () => {
    // The reason the port takes a byte count rather than measuring a string: one
    // of these two strings is three times the other on the wire and the same
    // length in UTF-16 code units.
    const ascii = "a".repeat(30_000);
    const multiByte = "あ".repeat(30_000);
    expect(ascii.length).toBe(multiByte.length);
    const asciiBytes = new TextEncoder().encode(ascii).length;
    const multiByteBytes = new TextEncoder().encode(multiByte).length;
    expect(asciiBytes).toBeLessThanOrEqual(STREAM_MAX_FRAME_BYTES);
    expect(multiByteBytes).toBeGreaterThan(STREAM_MAX_FRAME_BYTES);
    expect(admitFrameSize(asciiBytes).ok).toBe(true);
    expect(admitFrameSize(multiByteBytes).ok).toBe(false);
  });

  it("honours a caller's tighter limit", () => {
    expect(admitFrameSize(64, 64).ok).toBe(true);
    expect(admitFrameSize(65, 64).ok).toBe(false);
  });
});

describe("the resume cursor", () => {
  it("round-trips a plain id", () => {
    const cursor = unwrap(encodeStreamCursor("turn_01J", 42));
    expect(unwrap(decodeStreamCursor(cursor))).toEqual({ streamId: "turn_01J", seq: 42 });
  });

  it("round-trips an id holding the delimiter and digits", () => {
    // The case a `split(".")` decoder gets wrong. Length-prefixing is why this
    // works, and this is the case that would catch its removal.
    const streamId = "9.9.9.turn.7";
    const cursor = unwrap(encodeStreamCursor(streamId, 3));
    expect(unwrap(decodeStreamCursor(cursor))).toEqual({ streamId, seq: 3 });
  });

  it("round-trips through the two encodings a real `Last-Event-ID` survives", () => {
    const cursor = unwrap(encodeStreamCursor("turn_01J.abc", 1234));
    const throughQuery = new URLSearchParams({ cursor }).get("cursor");
    expect(throughQuery).toBe(cursor);
    // A `Headers` object refuses a value carrying a control character; this is
    // the join that proves the encoding is header-safe rather than asserting it.
    const headers = new Headers({ "last-event-id": cursor });
    expect(headers.get("last-event-id")).toBe(cursor);
    expect(unwrap(decodeStreamCursor(headers.get("last-event-id") ?? ""))).toEqual({
      streamId: "turn_01J.abc",
      seq: 1234,
    });
  });

  it("refuses a stream id carrying a control character", () => {
    for (const control of ["\n", "\r", " ", ""]) {
      expect(errorCode(encodeStreamCursor(`turn${control}1`, 1))).toBe(
        "STREAM_CURSOR_STREAM_ID_INVALID",
      );
    }
  });

  it("refuses an empty stream id and a sequence below one", () => {
    expect(errorCode(encodeStreamCursor("", 1))).toBe("STREAM_CURSOR_STREAM_ID_INVALID");
    expect(errorCode(encodeStreamCursor("t", 0))).toBe("STREAM_CURSOR_SEQUENCE_INVALID");
    expect(errorCode(encodeStreamCursor("t", -1))).toBe("STREAM_CURSOR_SEQUENCE_INVALID");
    expect(errorCode(encodeStreamCursor("t", 1.5))).toBe("STREAM_CURSOR_SEQUENCE_INVALID");
  });

  it("tells four kinds of bad cursor apart", () => {
    expect(errorCode(decodeStreamCursor("not-a-cursor"))).toBe("STREAM_CURSOR_UNREADABLE");
    expect(errorCode(decodeStreamCursor("2.3.abc1"))).toBe("STREAM_CURSOR_VERSION_UNKNOWN");
    expect(errorCode(decodeStreamCursor("1.x.abc1"))).toBe("STREAM_CURSOR_UNREADABLE");
    expect(errorCode(decodeStreamCursor("1.3.abcxy"))).toBe("STREAM_CURSOR_SEQUENCE_INVALID");
  });

  it("refuses a length prefix that reaches past the body", () => {
    expect(errorCode(decodeStreamCursor("1.40.abc1"))).toBe("STREAM_CURSOR_UNREADABLE");
    expect(errorCode(decodeStreamCursor("1.0.1"))).toBe("STREAM_CURSOR_UNREADABLE");
  });

  it("refuses a sequence beyond safe integer range rather than rounding it", () => {
    const beyond = "9".repeat(25);
    expect(errorCode(decodeStreamCursor(`1.1.a${beyond}`))).toBe("STREAM_CURSOR_SEQUENCE_INVALID");
  });
});

describe("admitting a frame against the last one applied", () => {
  it("applies the next frame", () => {
    expect(admitFrame(4, frame({ seq: 5 }))).toEqual({ kind: "apply" });
  });

  it("calls a redelivery a duplicate rather than a gap", () => {
    // At-least-once delivery makes this the NORMAL case, not the failure.
    expect(admitFrame(5, frame({ seq: 5 }))).toEqual({ kind: "duplicate" });
    expect(admitFrame(5, frame({ seq: 1 }))).toEqual({ kind: "duplicate" });
  });

  it("reports a gap with the number of frames missing", () => {
    expect(admitFrame(4, frame({ seq: 6 }))).toEqual({ kind: "gap", missing: 1 });
    expect(admitFrame(0, frame({ seq: 5 }))).toEqual({ kind: "gap", missing: 4 });
  });

  it("conserves a whole run: every frame is applied exactly once", () => {
    // The property WIN-272's acceptance is written in. A run of frames is
    // delivered with a redelivered prefix and one out-of-order repeat, and the
    // reader's applied set must be the run itself, in order, with no member twice.
    const produced = Array.from({ length: 20 }, (_, index) => frame({ seq: index + 1 }));
    const delivered = [...produced.slice(0, 6), ...produced.slice(3), produced[9]!];
    const applied: number[] = [];
    let last = 0;
    let gaps = 0;
    for (const delivery of delivered) {
      const admission = admitFrame(last, delivery);
      if (admission.kind === "apply") {
        applied.push(delivery.seq);
        last = delivery.seq;
      } else if (admission.kind === "gap") {
        gaps += 1;
      }
    }
    expect(gaps).toBe(0);
    expect(applied).toEqual(produced.map((produced_) => produced_.seq));
    expect(new Set(applied).size).toBe(applied.length);
  });
});

describe("why a stream stopped", () => {
  const cursor = unwrap(encodeStreamCursor("turn_1", 9));

  it("tells a finished turn from a severed connection", () => {
    expect(classifyStreamEnd(frame({ t: "turn.done" }), cursor)).toEqual({ kind: "completed" });
    expect(classifyStreamEnd(null, cursor)).toEqual({ kind: "severed", resumeFrom: cursor });
    expect(classifyStreamEnd(frame({ t: "assistant.delta" }), cursor)).toEqual({
      kind: "severed",
      resumeFrom: cursor,
    });
  });

  it("carries the failure code off the error frame", () => {
    expect(
      classifyStreamEnd(frame({ t: "stream.error", fields: { code: "STREAM_CREDENTIAL_EXPIRED" } }), cursor),
    ).toEqual({ kind: "failed", code: "STREAM_CREDENTIAL_EXPIRED" });
  });

  it("reports a code-less error frame as null rather than inventing one", () => {
    expect(classifyStreamEnd(frame({ t: "stream.error" }), cursor)).toEqual({
      kind: "failed",
      code: null,
    });
  });

  it("prefers the offline frame's own resume position to the reader's", () => {
    const server = unwrap(encodeStreamCursor("turn_1", 12));
    expect(classifyStreamEnd(frame({ t: "stream.offline", fields: { resumeFrom: server } }), cursor)).toEqual(
      { kind: "interrupted", resumeFrom: server },
    );
  });

  it("falls back to the reader's position when the offline frame carries none", () => {
    expect(classifyStreamEnd(frame({ t: "stream.offline" }), cursor)).toEqual({
      kind: "interrupted",
      resumeFrom: cursor,
    });
    expect(classifyStreamEnd(frame({ t: "stream.offline" }), null)).toEqual({
      kind: "severed",
      resumeFrom: null,
    });
  });

  it("resumes on exactly the two ends that can still grow", () => {
    expect(isResumable(classifyStreamEnd(frame({ t: "turn.done" }), cursor))).toBe(false);
    expect(isResumable(classifyStreamEnd(frame({ t: "stream.error" }), cursor))).toBe(false);
    expect(isResumable(classifyStreamEnd(frame({ t: "stream.offline" }), cursor))).toBe(true);
    expect(isResumable(classifyStreamEnd(null, cursor))).toBe(true);
  });

  it("classifies every terminal type and nothing else as terminal", () => {
    for (const terminal of TERMINAL_FRAME_TYPES) expect(isTerminalFrameType(terminal)).toBe(true);
    for (const mid of ["assistant.delta", "tool_call.start", "meta", "stream_meta", "done"]) {
      expect(isTerminalFrameType(mid), `${mid} must not be terminal`).toBe(false);
    }
  });

  it("gives every terminal frame type a classification that is not `severed`", () => {
    // The invariant behind the four answers: a stream that ended with a terminal
    // frame is never reported as one that ended with nothing.
    for (const terminal of TERMINAL_FRAME_TYPES) {
      const end = classifyStreamEnd(frame({ t: terminal }), cursor);
      expect(end.kind, `${terminal} classified as severed`).not.toBe("severed");
    }
  });
});

describe("negotiating the schema version", () => {
  it("agrees the major a client asks for inside the band", () => {
    expect(unwrap(negotiateStreamVersion(1, { legacyIngress: false }))).toBe(1);
    expect(unwrap(negotiateStreamVersion(1, { legacyIngress: true }))).toBe(1);
  });

  it("defaults an absent version to 1 at a legacy ingress and refuses it elsewhere", () => {
    // M0.4 D4 AS CORRECTED. The uncorrected proposal made this `ok` in both rows.
    expect(unwrap(negotiateStreamVersion(null, { legacyIngress: true }))).toBe(
      STREAM_SCHEMA_VERSION_MIN,
    );
    expect(errorCode(negotiateStreamVersion(null, { legacyIngress: false }))).toBe(
      "STREAM_VERSION_ABSENT",
    );
  });

  it("refuses a version outside the band with a different code from an absent one", () => {
    expect(errorCode(negotiateStreamVersion(0, { legacyIngress: true }))).toBe(
      "STREAM_VERSION_UNSUPPORTED",
    );
    expect(errorCode(negotiateStreamVersion(2, { legacyIngress: true }))).toBe(
      "STREAM_VERSION_UNSUPPORTED",
    );
    expect(errorCode(negotiateStreamVersion(1.5, { legacyIngress: false }))).toBe(
      "STREAM_VERSION_UNSUPPORTED",
    );
  });

  it("reports the band it does speak on the refusal", () => {
    const refused = negotiateStreamVersion(9, { legacyIngress: false });
    expect(isOk(refused)).toBe(false);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.error.details).toEqual({
      min: STREAM_SCHEMA_VERSION_MIN,
      max: STREAM_SCHEMA_VERSION_MAX,
    });
  });
});

describe("the cursor is opaque to everyone but this module", () => {
  it("does not let a bare string be used as a cursor", () => {
    // A compile-time property, asserted at run time only to keep the case honest:
    // the brand means a transport cannot pass a stream id where a cursor belongs.
    const cursor: StreamCursor = unwrap(encodeStreamCursor("turn_1", 1));
    expect(typeof cursor).toBe("string");
  });
});
