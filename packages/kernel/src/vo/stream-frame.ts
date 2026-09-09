// THE ONE STREAM ENVELOPE. WebSocket, SSE, webhook ingest, public guest and
// embed all carry THIS frame, and `sv` is written down HERE once.
//
// WHY IT IS A KERNEL VALUE OBJECT AND NOT FIVE HELPERS AT FIVE EDGES.
//
// M0.4 §1.2 pins the stream major to "a monotonic int per envelope family" and
// names the five families. M0.4 §2 then says the same three things about each
// lane in five different rows: a flat frame carrying `sv`/`t`/`seq`/`ts`, a
// terminal event, and replay from a cursor. The V1 tree implements that FIVE
// TIMES and no two the same way:
//
//   `apps/agent/src/streaming/streaming.service.ts` stamps `_seq` INSIDE the
//   JSON body and writes `id: {seq}` on the SSE line, with no `sv` anywhere and
//   no family. Its terminal frame is `{type:"done"}` — and on the failure path it
//   writes an `error` frame AND a `done` frame, so a reader counting terminal
//   frames sees two.
//
//   `apps/agent/src/connections/connections.gateway.ts` emits socket events with
//   no `seq` at all, so a browser that missed one has no way to learn that it
//   did. Its approval frame carries `durableToken` and the HTTP path's does not,
//   which M0.4 §2 records as "one schema, not an accident".
//
//   The public guest and embed lanes are the SSE lane through a same-origin
//   proxy (`apps/webapp/app/routes/api.v1.public.agents.$agentId.chat.stream.ts`),
//   which copies the body through untouched. Whatever the SSE lane's contract is,
//   theirs is the same one — including its gaps.
//
// A shared vocabulary written five times is not a contract; it is five
// conventions that agree today. So the vocabulary is ONE module, in the one
// package every lane may import, and it holds the four decisions no lane may
// make privately: what a frame IS, when a stream has ENDED, whether the client
// may RESUME, and whether the frame it just received is the next one.
//
// TIME IS A PARAMETER, NEVER A READING, and `ts` is a NUMBER. ADR M0.3 §5.3 (rule
// K4) fails this package on `Date.now` and on `new Date(...)` alike, and it is
// right to: a kernel that can build an instant is one call from building the
// current one. The caller holds a `Clock`.
//
// NOTHING HERE SERIALIZES TO A WIRE. `flattenFrame` produces the flat JSON object
// M0.4 §2 specifies and stops there. SSE's `id:`/`data:` framing, WebSocket's
// handshake and the heartbeat are TRANSPORT, and they live at the transport —
// which is also why a heartbeat is not a frame type below. A heartbeat carries no
// state and must not consume a `seq`, or a client that missed one would compute a
// gap out of a keep-alive.

import { domainError, err, ok, type DomainError, type Result } from "./error.js";
import type { JsonValue } from "./domain-event.js";

/**
 * M0.4 §1.2's stream MAJOR. ONE const, for the reason the REST prefix is one
 * constant and `PLATOS_MCP_CONTRACT` is one const: the ADR's own enforcement
 * clause is "a drift-check reads the STRUCTURE, so two code paths cannot
 * privately disagree on the version".
 */
export const STREAM_SCHEMA_VERSION = 1;

/** The lowest `sv` this build will still speak. */
export const STREAM_SCHEMA_VERSION_MIN = 1;

/** The highest `sv` this build will speak. Equal to the major it emits. */
export const STREAM_SCHEMA_VERSION_MAX = 1;

/**
 * The five envelope families M0.4 §1.2 pins one `sv` axis to, in its own order.
 *
 * A FAMILY IS PART OF THE FRAME'S IDENTITY, not decoration. The ADR gives each
 * family its own `sv` axis, so `sv:1` on `sse.turn` and `sv:1` on
 * `webhook.ingest` are two independent promises. A frame that did not say which
 * family it belonged to would make the version meaningless: a reader could not
 * tell which of the five majors it had just been handed.
 */
export const STREAM_ENVELOPE_FAMILIES = Object.freeze([
  "ws.agent_event",
  "sse.turn",
  "webhook.ingest",
  "internal.callback",
  "trigger.payload",
] as const);

export type StreamEnvelopeFamily = (typeof STREAM_ENVELOPE_FAMILIES)[number];

/**
 * The field names the envelope owns. A payload may not use one.
 *
 * THIS IS THE RULE THAT MAKES A FLAT FRAME SAFE. M0.4 §2 specifies the wire shape
 * as flat — <code>{sv, t, seq, ts, ...existingFields}</code> — because that is
 * what the live gateway already emits and nesting it would be the breaking
 * restructure the ADR forbids. Flat means a payload field spelled `seq` would
 * overwrite the sequence number ON THE WIRE, and the client would compute its gap
 * detection from a value the producer chose. `flattenFrame` refuses instead.
 */
export const RESERVED_FRAME_FIELDS = Object.freeze(["sv", "t", "seq", "ts"] as const);

/**
 * One frame, before it becomes bytes.
 *
 * THE FOUR RESERVED FIELDS ARE SEPARATE FROM `fields` IN MEMORY AND MERGED ON THE
 * WIRE. Keeping them apart here is what lets `flattenFrame` see a collision at
 * all; a single flat record would have already lost the distinction by the time
 * anything could check it.
 */
export interface StreamFrame {
  readonly sv: number;
  readonly family: StreamEnvelopeFamily;
  /**
   * The event type. M0.4 §2's `t`, and an OPEN enum: "readers must ignore unknown
   * `t`". Adding one is additive and does not move `sv`.
   */
  readonly t: string;
  /** 1-based, monotonic within one stream, gap-free. Never re-used. */
  readonly seq: number;
  /** Epoch milliseconds, supplied by the caller's `Clock`. */
  readonly ts: number;
  /** Every other field of the flat frame. M0.4 §2's `...existingFields`. */
  readonly fields: Readonly<Record<string, JsonValue>>;
}

/**
 * The frame types that END a stream. Every other `t` is mid-stream.
 *
 * THREE, AND THE THREE ARE NOT INTERCHANGEABLE — which is the whole point of
 * this module. `turn.done` and `stream.error` both mean the PRODUCER reached an
 * outcome, so a client that resumed would be asking for frames that will never
 * exist. `stream.offline` means the SERVER let go of a stream whose producer had
 * not finished, and it is the only terminal frame that carries a resume cursor.
 */
export const TERMINAL_FRAME_TYPES = Object.freeze([
  "turn.done",
  "stream.error",
  "stream.offline",
] as const);

export type TerminalFrameType = (typeof TERMINAL_FRAME_TYPES)[number];

/** Whether `t` ends a stream. */
export function isTerminalFrameType(t: string): t is TerminalFrameType {
  return (TERMINAL_FRAME_TYPES as readonly string[]).includes(t);
}

/**
 * WHY A STREAM STOPPED, AS FOUR ANSWERS RATHER THAN ONE.
 *
 * "The stream ended" is the single most useless thing a streaming client can be
 * told, and the V1 SSE lane tells it: `{type:"done"}` is written when the work
 * finished AND after an error, and when the socket dies nothing is written at
 * all. A browser therefore cannot tell "your answer is complete" from "the
 * process holding your answer went away", and the two demand opposite behaviour —
 * render it, or reconnect.
 *
 * `completed` and `failed` are OUTCOMES: the producer is finished, there is
 * nothing further, and reconnecting would be a wasted round trip that returns the
 * same terminal frame forever.
 *
 * `interrupted` is the server saying so ON PURPOSE: the producer had not
 * finished, this reader is being let go (shutdown, credential expiry, a slow
 * consumer), and here is where to pick up. It carries the cursor because the whole
 * value of saying it is that the client does not have to guess.
 *
 * `severed` is the absence of any of the three. Nothing terminal arrived, so the
 * client knows only what it received; it resumes from the last frame it applied.
 * Distinguishing this from `interrupted` matters to an OPERATOR, not to the
 * retry: a stream that severs is one nobody got to write a frame on, which is a
 * crash or a network partition rather than a policy decision.
 */
export type StreamEnd =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly code: string | null }
  | { readonly kind: "interrupted"; readonly resumeFrom: StreamCursor }
  | { readonly kind: "severed"; readonly resumeFrom: StreamCursor | null };

/**
 * Classify how a stream stopped from the last frame the client saw.
 *
 * `lastFrame` is the LAST frame RECEIVED, which is not the same as the last frame
 * SENT — that difference is exactly what `severed` records. `resumeFrom` is the
 * cursor for the last frame received, computed by the caller, because the caller
 * is the only party that knows the stream id.
 *
 * A `stream.error` frame's `code` is read out of its `fields`. It is a string on
 * the wire and this returns it as one: the taxonomy that gives it meaning lives at
 * the transport, and a kernel that validated the code against a list would need to
 * hold that list.
 */
export function classifyStreamEnd(
  lastFrame: StreamFrame | null,
  resumeFrom: StreamCursor | null,
): StreamEnd {
  if (lastFrame === null) return { kind: "severed", resumeFrom };
  if (lastFrame.t === "turn.done") return { kind: "completed" };
  if (lastFrame.t === "stream.error") {
    const code = lastFrame.fields["code"];
    // NULL RATHER THAN AN INVENTED CODE. A `stream.error` frame that carries no
    // code is a producer defect, and answering it with a placeholder string would
    // put a code in a client's branch that no taxonomy entry explains.
    return { kind: "failed", code: typeof code === "string" && code.length > 0 ? code : null };
  }
  if (lastFrame.t === "stream.offline") {
    const cursor = lastFrame.fields["resumeFrom"];
    // The frame's OWN cursor wins over the caller's. A server that writes
    // `stream.offline` is stating where to pick up, and it may know about frames
    // it wrote after the last one this reader managed to consume.
    if (typeof cursor === "string" && cursor.length > 0) {
      return { kind: "interrupted", resumeFrom: cursor as StreamCursor };
    }
    if (resumeFrom !== null) return { kind: "interrupted", resumeFrom };
    return { kind: "severed", resumeFrom: null };
  }
  return { kind: "severed", resumeFrom };
}

/**
 * Whether a client should reconnect.
 *
 * ONE FUNCTION SO THE ANSWER CANNOT DIFFER BY LANE. A browser, the SDK and the
 * embed script each deciding for themselves is how one of them ends up polling a
 * finished stream forever and another one drops half an answer.
 */
export function isResumable(end: StreamEnd): boolean {
  return end.kind === "interrupted" || end.kind === "severed";
}

/**
 * An opaque resume position. `Last-Event-ID` carries one.
 *
 * BRANDED SO IT CANNOT BE CONFUSED WITH A STREAM ID OR A SEQUENCE. Both of those
 * are also strings/numbers at the edges, and a transport that passed the wrong one
 * to `read` would resume from a position that happened to parse.
 */
export type StreamCursor = string & { readonly __streamCursor: unique symbol };

/** A cursor refused because its stream id is empty or holds the delimiter. */
export const STREAM_CURSOR_STREAM_ID_INVALID = "STREAM_CURSOR_STREAM_ID_INVALID";

/** A cursor refused because its sequence is not a whole number above zero. */
export const STREAM_CURSOR_SEQUENCE_INVALID = "STREAM_CURSOR_SEQUENCE_INVALID";

/** A cursor refused because it is not this encoding at all. */
export const STREAM_CURSOR_UNREADABLE = "STREAM_CURSOR_UNREADABLE";

/** A cursor refused because the version prefix is one this build does not know. */
export const STREAM_CURSOR_VERSION_UNKNOWN = "STREAM_CURSOR_VERSION_UNKNOWN";

/**
 * The delimiter. A single character, and the reason the id is LENGTH-PREFIXED.
 *
 * A stream id may hold anything a caller's id generator produces, delimiter
 * included, and a naive `split` would then parse a cursor into the wrong pieces
 * and resume at the wrong place. Length-prefixing removes the question: the
 * decoder is told how many characters the id occupies and never looks for a
 * boundary inside it.
 */
const CURSOR_DELIMITER = ".";

/** The encoding's own version, so a future shape is a refusal and not a misread. */
const CURSOR_ENCODING = "1";

/**
 * Any C0 control character, plus DEL.
 *
 * NAMED RATHER THAN INLINE because it is the security half of this encoding and a
 * range written inside a condition is a range nobody re-reads. A literal newline
 * or carriage return inside a stream id would let the id's owner inject a second
 * SSE field into every reader's byte stream; DEL is here because it is the one
 * other character an HTTP header field-value may not carry.
 */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/u;

/**
 * Encode a resume position.
 *
 * `v1.<idLength>.<streamId><seq>` — the id's length, then the id, then the
 * sequence, with no delimiter between the last two because the length already
 * says where one ends.
 *
 * NO NEWLINE CAN REACH THE OUTPUT, and that is a security property rather than
 * tidiness: this value is written onto an SSE `id:` line and echoed back in a
 * `Last-Event-ID` header. A newline inside it would let a caller inject a second
 * SSE field — a frame of their own choosing — into every other reader's stream.
 * The length prefix plus the refusal below make it impossible: a stream id
 * carrying a control character is refused at the encode.
 */
export function encodeStreamCursor(streamId: string, seq: number): Result<StreamCursor> {
  if (streamId.length === 0 || /[ -]/u.test(streamId)) {
    return err(
      domainError(
        STREAM_CURSOR_STREAM_ID_INVALID,
        "invalid_input",
        "a stream id must be non-empty and free of control characters",
        {
          fields: [
            {
              field: "streamId",
              code: STREAM_CURSOR_STREAM_ID_INVALID,
              message: "must be non-empty and hold no control character",
            },
          ],
        },
      ),
    );
  }
  if (!Number.isInteger(seq) || seq < 1) {
    return err(
      domainError(
        STREAM_CURSOR_SEQUENCE_INVALID,
        "invalid_input",
        "a stream cursor's sequence must be a whole number of at least 1",
        {
          fields: [
            {
              field: "seq",
              code: STREAM_CURSOR_SEQUENCE_INVALID,
              message: "must be a whole number of at least 1",
            },
          ],
        },
      ),
    );
  }
  const encoded = `${CURSOR_ENCODING}${CURSOR_DELIMITER}${streamId.length}${CURSOR_DELIMITER}${streamId}${seq}`;
  return ok(encoded as StreamCursor);
}

/** What a cursor points at. */
export interface StreamPosition {
  readonly streamId: string;
  readonly seq: number;
}

/**
 * Decode a resume position, or refuse.
 *
 * FOUR REFUSALS, NOT ONE. `Last-Event-ID` is attacker-controlled on every public
 * lane, so this is a parser on the security boundary, and "the cursor was bad" is
 * the answer that tells an operator nothing. An unknown ENCODING is a client from
 * a future build and is survivable by starting over; a malformed one is a client
 * that is broken or probing; a bad sequence and a bad id are two different
 * malformations. The transport turns each into its own code.
 */
export function decodeStreamCursor(raw: string): Result<StreamPosition> {
  const firstBreak = raw.indexOf(CURSOR_DELIMITER);
  if (firstBreak < 0) return err(unreadableCursor());
  const encoding = raw.slice(0, firstBreak);
  if (encoding !== CURSOR_ENCODING) {
    return err(
      domainError(
        STREAM_CURSOR_VERSION_UNKNOWN,
        "invalid_input",
        "this resume position was written by a build whose cursor encoding this one does not know",
      ),
    );
  }
  const secondBreak = raw.indexOf(CURSOR_DELIMITER, firstBreak + 1);
  if (secondBreak < 0) return err(unreadableCursor());
  const lengthText = raw.slice(firstBreak + 1, secondBreak);
  if (!/^[0-9]+$/u.test(lengthText)) return err(unreadableCursor());
  const idLength = Number(lengthText);
  const body = raw.slice(secondBreak + 1);
  if (idLength === 0 || idLength >= body.length) return err(unreadableCursor());
  const streamId = body.slice(0, idLength);
  const seqText = body.slice(idLength);
  if (!/^[0-9]+$/u.test(seqText)) {
    return err(
      domainError(
        STREAM_CURSOR_SEQUENCE_INVALID,
        "invalid_input",
        "a stream cursor's sequence must be a whole number of at least 1",
      ),
    );
  }
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq < 1) {
    return err(
      domainError(
        STREAM_CURSOR_SEQUENCE_INVALID,
        "invalid_input",
        "a stream cursor's sequence must be a whole number of at least 1",
      ),
    );
  }
  if (/[ -]/u.test(streamId)) {
    return err(
      domainError(
        STREAM_CURSOR_STREAM_ID_INVALID,
        "invalid_input",
        "a stream id must be non-empty and free of control characters",
      ),
    );
  }
  return ok(Object.freeze({ streamId, seq }));
}

function unreadableCursor(): DomainError {
  return domainError(
    STREAM_CURSOR_UNREADABLE,
    "invalid_input",
    "this resume position is not a stream cursor",
  );
}

/**
 * WHAT A CLIENT SHOULD DO WITH THE FRAME IT JUST RECEIVED.
 *
 * WIN-272's acceptance is "clients resume without missing or double-applying
 * state", and that is one function, not a convention. At-least-once delivery
 * means a redelivered frame is NORMAL — the kernel's own `EventBus` says so — and
 * a client that applied it twice would double a token, a cost or a tool result.
 *
 * `gap` is the third answer and the reason this is not a boolean. A frame whose
 * `seq` skips ahead means frames were LOST between the producer and this reader,
 * and applying it would leave the client silently wrong: it would render a partial
 * answer it believes is whole. Reporting the gap lets the client re-read from its
 * own last position instead — and lets a test assert conservation, which a boolean
 * could never do because "not a duplicate" and "the next one" are different claims.
 */
export type FrameAdmission =
  | { readonly kind: "apply" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "gap"; readonly missing: number };

/**
 * Admit, drop or fault one frame against the last sequence applied.
 *
 * `lastApplied` is 0 before the first frame, so a stream that starts at `seq:1`
 * is `apply` and one that starts at `seq:5` is a gap of four. That is deliberate:
 * a reader that joined a live stream WITHOUT a cursor has genuinely missed the
 * first four frames, and telling it so is more useful than pretending it started
 * at the beginning.
 */
export function admitFrame(lastApplied: number, frame: StreamFrame): FrameAdmission {
  if (frame.seq <= lastApplied) return { kind: "duplicate" };
  const expected = lastApplied + 1;
  if (frame.seq > expected) return { kind: "gap", missing: frame.seq - expected };
  return { kind: "apply" };
}

/** A negotiation refused because a new surface presented no `sv` at all. */
export const STREAM_VERSION_ABSENT = "STREAM_VERSION_ABSENT";

/** A negotiation refused because the asked-for `sv` is outside this build's band. */
export const STREAM_VERSION_UNSUPPORTED = "STREAM_VERSION_UNSUPPORTED";

/**
 * Agree an `sv` with a client, or refuse.
 *
 * `legacyIngress` IS M0.4 DECISION D4 AS CORRECTED, AND THE CORRECTION IS THE
 * WHOLE REASON THIS PARAMETER EXISTS. The original proposal said absent ⇒ 1
 * everywhere. §7 corrects it: "a missing stream version maps to V1 only at
 * IDENTIFIED LEGACY INGRESS POINTS, not as a blanket default everywhere. New
 * surfaces must carry an explicit `sv`."
 *
 * A blanket default is not a small convenience. It makes the version field
 * OPTIONAL, and an optional version cannot be relied on by the drift-check that
 * gives it meaning: every future client would be free never to send one, so the
 * day a `sv:2` exists there would be no way to tell a v1 client from one that
 * simply omitted the field. Pinning the default to the enumerated old lanes keeps
 * every NEW lane's version load-bearing while breaking no live reader.
 */
export function negotiateStreamVersion(
  requested: number | null,
  options: { readonly legacyIngress: boolean },
): Result<number> {
  if (requested === null) {
    if (options.legacyIngress) return ok(STREAM_SCHEMA_VERSION_MIN);
    return err(
      domainError(
        STREAM_VERSION_ABSENT,
        "invalid_input",
        "this stream surface requires an explicit schema version",
        {
          fields: [
            {
              field: "sv",
              code: STREAM_VERSION_ABSENT,
              message: `must be a whole number in [${STREAM_SCHEMA_VERSION_MIN}, ${STREAM_SCHEMA_VERSION_MAX}]`,
            },
          ],
        },
      ),
    );
  }
  if (
    !Number.isInteger(requested) ||
    requested < STREAM_SCHEMA_VERSION_MIN ||
    requested > STREAM_SCHEMA_VERSION_MAX
  ) {
    return err(
      domainError(
        STREAM_VERSION_UNSUPPORTED,
        "invalid_input",
        "this build speaks no stream schema version the caller asked for",
        {
          details: { min: STREAM_SCHEMA_VERSION_MIN, max: STREAM_SCHEMA_VERSION_MAX },
          fields: [
            {
              field: "sv",
              code: STREAM_VERSION_UNSUPPORTED,
              message: `must be a whole number in [${STREAM_SCHEMA_VERSION_MIN}, ${STREAM_SCHEMA_VERSION_MAX}]`,
            },
          ],
        },
      ),
    );
  }
  return ok(requested);
}

/** A frame refused because a payload field collides with a reserved one. */
export const STREAM_FRAME_FIELD_RESERVED = "STREAM_FRAME_FIELD_RESERVED";

/**
 * The flat JSON object M0.4 §2 puts on the wire, or a refusal.
 *
 * `family` IS NOT ON THE WIRE. It scopes the `sv` on the SERVER side — which of
 * the five majors this frame's `1` refers to — and each lane serves exactly one
 * family, so a reader already knows which one it is connected to. Emitting it
 * would add a required field to five live envelopes, which M0.4 §1.3 classifies as
 * breaking.
 *
 * THE COLLISION IS A REFUSAL AND NOT AN OVERWRITE, in either direction. A spread
 * that let the payload win would let a producer choose the client's gap
 * detection; one that let the envelope win would silently discard a field the
 * producer believes it sent. Both are wrong answers, so there is no answer.
 */
export function flattenFrame(frame: StreamFrame): Result<Readonly<Record<string, JsonValue>>> {
  for (const reserved of RESERVED_FRAME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(frame.fields, reserved)) {
      return err(
        domainError(
          STREAM_FRAME_FIELD_RESERVED,
          "invalid_input",
          "a stream frame's payload may not use a field the envelope owns",
          {
            fields: [
              {
                field: reserved,
                code: STREAM_FRAME_FIELD_RESERVED,
                message: `${reserved} belongs to the stream envelope`,
              },
            ],
          },
        ),
      );
    }
  }
  return ok(
    Object.freeze({
      sv: frame.sv,
      t: frame.t,
      seq: frame.seq,
      ts: frame.ts,
      ...frame.fields,
    }),
  );
}

/**
 * The largest one frame may be, in bytes of its flat JSON.
 *
 * 64 KiB, and the number is here rather than at five edges for the reason the
 * version is. It is a CEILING on one frame and not on a stream: a turn emits
 * thousands of frames and the limit that matters per frame is the one that stops a
 * single tool result from becoming a memory incident in every connected browser.
 */
export const STREAM_MAX_FRAME_BYTES = 65_536;

/** A frame refused because its flat form exceeds the per-frame ceiling. */
export const STREAM_FRAME_TOO_LARGE = "STREAM_FRAME_TOO_LARGE";

/**
 * Whether a frame of `byteLength` bytes may be sent.
 *
 * BYTES, MEASURED BY THE CALLER, NOT CHARACTERS COUNTED HERE. A string's `.length`
 * is UTF-16 code units, which under-counts every non-Latin character by up to a
 * factor of three — so a limit computed from it would be a limit an attacker
 * chooses by picking an alphabet. Rule K4 forbids this package from holding a
 * `Buffer` or a `TextEncoder`, and that is the right side of the line: the caller
 * that already has the encoded bytes passes their count.
 */
export function admitFrameSize(byteLength: number, limit: number = STREAM_MAX_FRAME_BYTES): Result<number> {
  if (byteLength <= limit) return ok(byteLength);
  return err(
    domainError(
      STREAM_FRAME_TOO_LARGE,
      "invalid_input",
      "this stream frame is larger than one frame may be",
      { details: { limit, byteLength } },
    ),
  );
}
