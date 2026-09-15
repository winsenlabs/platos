// THE V1 EVENT-STREAM READER: PARSE, ADMIT, RESUME.
//
// WIN-272 (M4.6), "clients resume without missing or double-applying state".
// Before this module the generated SDK's only stream method,
// `environmentStreams.read`, went through `V1Transport.send`, which runs
// `JSON.parse` on the body. Every valid event stream therefore threw
// `SyntaxError: Unexpected token 'e', "event: str"... is not valid JSON`, no
// request ever carried `Last-Event-ID`, and the transport's per-try timeout plus
// its GET retry would have re-read a long stream FROM THE START with no cursor —
// double-applying every frame it had already delivered.
//
// WHAT THIS FILE DECIDES AND WHAT IT DOES NOT.
//
//   The WIRE FACTS are generated, not written here: the media type, the resume
//   header, the meta event name, the `sv` band and the terminal frame types come
//   from `generated/v1.ts`, which `scripts/sdk/v1-contract.mjs` reads off
//   `apps/core-api/src/transports/ws/sse.ts` and the kernel.
//
//   The THREE RULES are the kernel's — `admitFrame`, `classifyStreamEnd` and
//   `isResumable` in `packages/kernel/src/vo/stream-frame.ts`. This package is
//   published and the kernel is private, so they are PORTED rather than imported,
//   line for line, and `tests/v1-stream.test.ts` runs the port and the kernel's own
//   functions over one grid and one fixture so the two cannot drift apart.
//
//   The SSE PARSING is the WHATWG HTML "event stream interpretation" algorithm:
//   CR, LF and CRLF line ends, a leading BOM, `:` comments, `data` lines joined by
//   LF, the `id` buffer persisting across events, and an event the stream ends in
//   the middle of being discarded rather than dispatched.
//
// RESUMING. Each frame the kernel's rule says to APPLY advances the reader's
// position: its `seq`, and the `id:` the server wrote for it (a cursor naming the
// stream and the position). A frame at or behind that position is a DUPLICATE —
// redelivery after a reconnect is normal — and is dropped. A frame AHEAD of it is a
// GAP: frames were lost, so the connection is abandoned and the stream re-read from
// the last applied cursor rather than rendered with a hole in it. A stream that
// stops without a terminal frame is SEVERED and a `stream.offline` frame is
// INTERRUPTED; both reconnect with `Last-Event-ID`, under a budget of reconnects in a
// row that applied nothing — progress restores it.

import { PlatosError, errorFromResponse, isRetryableError, PlatosNetworkError, PlatosRateLimitError } from "./errors.js";
import {
  EVENT_STREAM_MEDIA_TYPE,
  LAST_EVENT_ID_HEADER,
  STREAM_META_EVENT,
  STREAM_SCHEMA_VERSION_MAX,
  STREAM_SCHEMA_VERSION_MIN,
  TERMINAL_FRAME_TYPES,
} from "./generated/v1.js";

/** One frame: the envelope's reserved fields, plus whatever the payload carries. */
export interface V1StreamFrame {
  readonly sv: number;
  readonly t: string;
  readonly seq: number;
  readonly ts: number;
  readonly [field: string]: unknown;
}

/** The leading `stream_meta` event: the `sv` this stream carries and the position it resumed after. */
export interface V1StreamMeta {
  readonly sv: number;
  readonly replayFrom: string | null;
}

/** The kernel's `FrameAdmission`. */
export type V1FrameAdmission =
  | { readonly kind: "apply" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "gap"; readonly missing: number };

/** The kernel's `StreamEnd`, with the cursor as the string it is on the wire. */
export type V1StreamEnd =
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly code: string | null }
  | { readonly kind: "interrupted"; readonly resumeFrom: string }
  | { readonly kind: "severed"; readonly resumeFrom: string | null };

/**
 * PORTED from the kernel's `admitFrame`. Admit, drop or fault one frame against
 * the last sequence applied; `lastApplied` is 0 before the first frame.
 */
export function admitFrame(lastApplied: number, frame: { readonly seq: number }): V1FrameAdmission {
  if (frame.seq <= lastApplied) return { kind: "duplicate" };
  const expected = lastApplied + 1;
  if (frame.seq > expected) return { kind: "gap", missing: frame.seq - expected };
  return { kind: "apply" };
}

/**
 * PORTED from the kernel's `classifyStreamEnd`. `lastFrame` is the last frame
 * RECEIVED; `resumeFrom` the cursor of the last frame applied.
 */
export function classifyStreamEnd(
  lastFrame: { readonly t: string; readonly [field: string]: unknown } | null,
  resumeFrom: string | null,
): V1StreamEnd {
  if (lastFrame === null) return { kind: "severed", resumeFrom };
  if (lastFrame.t === "turn.done") return { kind: "completed" };
  if (lastFrame.t === "stream.error") {
    const code = lastFrame["code"];
    return { kind: "failed", code: typeof code === "string" && code.length > 0 ? code : null };
  }
  if (lastFrame.t === "stream.offline") {
    const cursor = lastFrame["resumeFrom"];
    if (typeof cursor === "string" && cursor.length > 0) return { kind: "interrupted", resumeFrom: cursor };
    if (resumeFrom !== null) return { kind: "interrupted", resumeFrom };
    return { kind: "severed", resumeFrom: null };
  }
  return { kind: "severed", resumeFrom };
}

/** PORTED from the kernel's `isResumable`. */
export function isResumable(end: V1StreamEnd): boolean {
  return end.kind === "interrupted" || end.kind === "severed";
}

/** Whether `t` ends a stream, by the kernel's list as generated. */
export function isTerminalFrameType(t: string): boolean {
  return (TERMINAL_FRAME_TYPES as readonly string[]).includes(t);
}

/** A stream that broke the lane's contract. `violation` names how; `code` stays the server's. */
export class PlatosStreamError extends PlatosError {
  readonly violation: string;
  readonly reason: unknown;
  constructor(status: number, violation: string, message: string, reason?: unknown) {
    super(status, `${violation}: ${message}`);
    this.name = "PlatosStreamError";
    this.violation = violation;
    this.reason = reason;
  }
}

/** U+0000. An `id` field containing it is ignored, per the spec. */
const NULL_CHARACTER = String.fromCharCode(0);

/** One dispatched SSE event. `id` is the last-event-ID buffer at dispatch, as the spec defines it. */
export interface SseEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string;
}

/**
 * The WHATWG event-stream parser, fed decoded text in arbitrary pieces.
 *
 * A PIECE MAY END ANYWHERE — inside a field name, between CR and LF, inside a
 * multi-byte character (the caller decodes with `stream: true`) — and the parser
 * holds what it cannot yet decide. `finish()` discards an unterminated event.
 */
export class SseParser {
  private pending = "";
  private started = false;
  private dataBuffer = "";
  private eventBuffer = "";
  private idBuffer = "";
  /** The last `retry:` field, in milliseconds, or null. */
  retryMs: number | null = null;

  push(text: string): SseEvent[] {
    let input = text;
    if (!this.started) {
      if (input.length === 0) return [];
      if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
      this.started = true;
    }
    this.pending += input;
    const events: SseEvent[] = [];
    for (;;) {
      const cr = this.pending.indexOf("\r");
      const lf = this.pending.indexOf("\n");
      if (cr === -1 && lf === -1) break;
      let end: number;
      let width: number;
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A CR at the very end may be the first half of a CRLF still in flight.
        if (cr === this.pending.length - 1) break;
        end = cr;
        width = this.pending.charCodeAt(cr + 1) === 10 ? 2 : 1;
      } else {
        end = lf;
        width = 1;
      }
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + width);
      const event = this.line(line);
      if (event !== null) events.push(event);
    }
    return events;
  }

  /** The stream ended: any event without its blank line is discarded, per the spec. */
  finish(): void {
    this.pending = "";
    this.dataBuffer = "";
    this.eventBuffer = "";
  }

  private line(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventBuffer = value;
    else if (field === "data") this.dataBuffer += `${value}\n`;
    else if (field === "id") {
      if (!value.includes(NULL_CHARACTER)) this.idBuffer = value;
    } else if (field === "retry") {
      if (/^[0-9]+$/u.test(value)) this.retryMs = Number(value);
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataBuffer === "") {
      this.eventBuffer = "";
      return null;
    }
    const data = this.dataBuffer.endsWith("\n") ? this.dataBuffer.slice(0, -1) : this.dataBuffer;
    const event = { event: this.eventBuffer === "" ? "message" : this.eventBuffer, data, id: this.idBuffer };
    this.dataBuffer = "";
    this.eventBuffer = "";
    return event;
  }
}

export interface V1StreamOptions {
  /**
   * Resume after a position a previous reader reached: the `lastEventId` it
   * reported. Must be given together with `lastSeq`, because the kernel's rule
   * admits a frame against a SEQUENCE and a cursor is opaque to a client.
   */
  readonly lastEventId?: string | null;
  /** The `lastSeq` the same previous reader reported. */
  readonly lastSeq?: number;
  /**
   * Reconnects allowed IN A ROW with no frame applied between them. Default 5.
   *
   * A connection that applies at least one frame restores the whole budget, so a
   * long stream behind a proxy that cuts every connection after a while still
   * finishes, while a server that keeps answering with nothing new is still
   * given up on. `reconnects` counts every reconnect regardless.
   */
  readonly maxReconnects?: number;
  /** Abandon a connection that delivers nothing, heartbeats included, for this long. Default 45s. */
  readonly idleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Every frame received and the kernel's verdict on it, applied or not. For diagnostics. */
  readonly onAdmission?: (frame: V1StreamFrame, admission: V1FrameAdmission) => void;
  /** Every connection that opened: the position it asked to resume after, and the meta the server answered. */
  readonly onConnect?: (connection: { readonly lastEventId: string | null; readonly meta: V1StreamMeta }) => void;
}

/** An event-stream operation's answer: the APPLIED frames, in order, across reconnects. */
export interface V1EventStream extends AsyncIterable<V1StreamFrame> {
  /** The `id:` of the last frame applied — hand it, with `lastSeq`, to a later reader. */
  readonly lastEventId: string | null;
  /** The `seq` of the last frame applied; 0 before the first. */
  readonly lastSeq: number;
  /** How the stream ended, once it has. */
  readonly end: V1StreamEnd | null;
  /** Every reconnect so far, productive or not. The budget counts only the fruitless run. */
  readonly reconnects: number;
}

/** What a transport hands the reader: everything but the parsing and the rules. */
export interface V1StreamConnection {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Merged into every request before the reader's own `method`, `headers` and
   * `signal`: the transport's `fetchOptions` — `credentials`, `mode`, `cache`.
   */
  readonly init?: RequestInit;
  /**
   * Called as a PLAIN FUNCTION, never as a method of this object: a browser's
   * `fetch` throws "Illegal invocation" when `this` is not the global object.
   */
  readonly fetch: typeof globalThis.fetch;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoffMs: (reconnectIndex: number) => number;
}

const DEFAULT_MAX_RECONNECTS = 5;
// Three of the SSE lane's 15-second heartbeats (`DEFAULT_SSE_OPTIONS.heartbeatMs`).
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

type ConnectionOutcome =
  | { readonly kind: "end" }
  | { readonly kind: "reconnect"; readonly cause: unknown; readonly delayMs: number | null };

/** The reader behind `V1Transport.stream`. Nothing is sent until iteration begins. */
export class EventStreamReader implements V1EventStream {
  lastEventId: string | null;
  lastSeq: number;
  end: V1StreamEnd | null = null;
  reconnects = 0;
  private started = false;

  constructor(
    private readonly connection: V1StreamConnection,
    private readonly options: V1StreamOptions = {},
  ) {
    const hasId = options.lastEventId !== undefined && options.lastEventId !== null;
    const hasSeq = options.lastSeq !== undefined;
    if (hasId !== hasSeq) {
      throw new Error("V1 stream: lastEventId and lastSeq resume together; one without the other cannot be admitted");
    }
    if (hasSeq && (!Number.isInteger(options.lastSeq) || (options.lastSeq as number) < 1)) {
      throw new Error("V1 stream: lastSeq must be a whole number of at least 1");
    }
    this.lastEventId = hasId ? (options.lastEventId as string) : null;
    this.lastSeq = options.lastSeq ?? 0;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<V1StreamFrame> {
    if (this.started) throw new Error("V1 stream: a stream is read once; open another to read again");
    this.started = true;
    const maxReconnects = this.options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
    // Plain functions, not methods of the connection object (see `V1StreamConnection.fetch`).
    const { sleep, backoffMs } = this.connection;
    // The position the NEXT request asks to resume after. Normally the last
    // applied cursor; a `stream.offline` frame may name its own.
    let resumeAfter = this.lastEventId;
    // Reconnects in a row since a connection last applied a frame. THE BUDGET
    // BOUNDS THIS RUN, NOT THE STREAM'S LIFETIME: a lifetime budget makes a stream
    // that progresses on every connection fail once it has been cut five times.
    let fruitless = 0;
    for (;;) {
      const appliedBefore = this.lastSeq;
      const outcome = yield* this.connect(resumeAfter);
      if (outcome.kind === "end") return;
      if (this.lastSeq !== appliedBefore) fruitless = 0;
      if (fruitless >= maxReconnects) {
        throw new PlatosStreamError(
          0,
          "STREAM_RECONNECTS_EXHAUSTED",
          `the stream did not finish within ${maxReconnects} consecutive reconnect(s) without progress`,
          outcome.cause,
        );
      }
      fruitless += 1;
      this.reconnects += 1;
      // Backoff grows with the fruitless run, and starts over after progress.
      await sleep(outcome.delayMs ?? backoffMs(fruitless - 1));
      resumeAfter = this.end?.kind === "interrupted" ? this.end.resumeFrom : this.lastEventId;
      this.end = null;
    }
  }

  /**
   * One connection, read to its end, YIELDING each applied frame as it arrives.
   *
   * The position is advanced BEFORE the frame is yielded, so a consumer that stops
   * iterating mid-stream leaves `lastEventId`/`lastSeq` naming exactly the frames
   * it was handed. Stopping runs the `finally`, which cancels the body.
   */
  private async *connect(resumeAfter: string | null): AsyncGenerator<V1StreamFrame, ConnectionOutcome> {
    const controller = new AbortController();
    const external = this.options.signal;
    if (external?.aborted) throw external.reason ?? new Error("aborted");
    const onAbort = () => controller.abort(external?.reason);
    external?.addEventListener("abort", onAbort, { once: true });
    const idleMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idled = false;
    const touch = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idled = true;
        controller.abort(new Error("idle"));
      }, idleMs);
      (idleTimer as unknown as { unref?: () => void }).unref?.();
    };
    const parser = new SseParser();
    let body: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let finished = false;
    try {
      touch();
      let response: Response;
      // UNBOUND. `this.connection.fetch(...)` would call a browser's fetch with
      // `this` set to the connection object, which it refuses as an illegal
      // invocation on every connection; Node's fetch does not check, so no Node
      // run notices.
      const fetchImpl = this.connection.fetch;
      try {
        response = await fetchImpl(this.connection.url, {
          ...(this.connection.init ?? {}),
          method: this.connection.method,
          headers: {
            ...this.connection.headers,
            accept: EVENT_STREAM_MEDIA_TYPE,
            ...(resumeAfter === null || resumeAfter === "" ? {} : { [LAST_EVENT_ID_HEADER]: resumeAfter }),
          },
          signal: controller.signal,
        });
      } catch (cause) {
        if (external?.aborted) throw cause;
        return { kind: "reconnect", cause: new PlatosNetworkError(cause), delayMs: null };
      }

      if (!response.ok) {
        const refusal = await errorFromResponse(response);
        if (!isRetryableError(refusal)) throw refusal;
        const delayMs = refusal instanceof PlatosRateLimitError ? refusal.retryAfterMs ?? null : null;
        return { kind: "reconnect", cause: refusal, delayMs };
      }
      const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (mediaType !== EVENT_STREAM_MEDIA_TYPE) {
        throw new PlatosStreamError(
          response.status,
          "STREAM_MEDIA_TYPE",
          `expected ${EVENT_STREAM_MEDIA_TYPE}, received ${mediaType === "" ? "no content type" : mediaType}`,
        );
      }
      if (response.body === null) return this.severed(null, parser);

      const decoder = new TextDecoder("utf-8");
      body = response.body.getReader();
      let meta: V1StreamMeta | null = null;
      let lastReceived: V1StreamFrame | null = null;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await body.read();
        } catch (cause) {
          if (external?.aborted) throw cause;
          return this.severed(lastReceived, parser, idled ? new Error("idle timeout") : cause);
        }
        if (chunk.done) {
          finished = true;
          parser.push(decoder.decode());
          return this.severed(lastReceived, parser);
        }
        touch();
        for (const event of parser.push(decoder.decode(chunk.value, { stream: true }))) {
          if (event.event === STREAM_META_EVENT) {
            meta = this.readMeta(event.data, resumeAfter, response.status);
            this.options.onConnect?.({ lastEventId: resumeAfter, meta });
            continue;
          }
          // An unknown NAMED event is ignored; only the default event carries frames.
          if (event.event !== "message") continue;
          if (meta === null) {
            throw new PlatosStreamError(response.status, "STREAM_META_MISSING", `a frame arrived before ${STREAM_META_EVENT}`);
          }
          const frame = readFrame(event.data, response.status);
          lastReceived = frame;
          const admission = admitFrame(this.lastSeq, frame);
          this.options.onAdmission?.(frame, admission);
          if (admission.kind === "duplicate") continue;
          // Frames were lost between the producer and this reader. Re-read from the
          // last APPLIED cursor instead of rendering an answer with a hole in it.
          if (admission.kind === "gap") return { kind: "reconnect", cause: admission, delayMs: 0 };
          this.lastSeq = frame.seq;
          if (event.id !== "") this.lastEventId = event.id;
          yield frame;
          if (!isTerminalFrameType(frame.t)) continue;
          const end = classifyStreamEnd(frame, this.lastEventId);
          this.end = end;
          if (!isResumable(end)) return { kind: "end" };
          return { kind: "reconnect", cause: end, delayMs: parser.retryMs };
        }
      }
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      external?.removeEventListener("abort", onAbort);
      if (body !== null && !finished) await body.cancel().catch(() => undefined);
    }
  }

  private severed(lastReceived: V1StreamFrame | null, parser: SseParser, cause?: unknown): ConnectionOutcome {
    parser.finish();
    // The kernel classifies from the last frame RECEIVED. A non-terminal one — or
    // none — is `severed`, and resumable from the last applied cursor.
    const end = classifyStreamEnd(lastReceived, this.lastEventId);
    this.end = end;
    return { kind: "reconnect", cause: cause ?? end, delayMs: parser.retryMs };
  }

  private readMeta(data: string, resumeAfter: string | null, status: number): V1StreamMeta {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (cause) {
      throw new PlatosStreamError(status, "STREAM_META_MALFORMED", `${STREAM_META_EVENT} is not JSON`, cause);
    }
    const record = (parsed ?? {}) as Record<string, unknown>;
    const sv = record["sv"];
    const replayFrom = record["replayFrom"];
    if (typeof sv !== "number" || !Number.isInteger(sv) || (replayFrom !== null && typeof replayFrom !== "string")) {
      throw new PlatosStreamError(status, "STREAM_META_MALFORMED", `${STREAM_META_EVENT} must carry an integer sv and a string or null replayFrom`);
    }
    if (sv < STREAM_SCHEMA_VERSION_MIN || sv > STREAM_SCHEMA_VERSION_MAX) {
      throw new PlatosStreamError(
        status,
        "STREAM_VERSION_UNSUPPORTED",
        `this client reads sv ${STREAM_SCHEMA_VERSION_MIN}..${STREAM_SCHEMA_VERSION_MAX}; the stream carries sv ${sv}`,
      );
    }
    // THE SERVER ECHOES THE POSITION IT RESUMED AFTER. A different one means the
    // frames that follow are numbered from somewhere this reader did not ask for,
    // and admitting them would be admitting a guess.
    if ((replayFrom ?? null) !== (resumeAfter === "" ? null : resumeAfter)) {
      throw new PlatosStreamError(
        status,
        "STREAM_REPLAY_MISMATCH",
        `asked to resume after ${JSON.stringify(resumeAfter)}, the server resumed after ${JSON.stringify(replayFrom)}`,
      );
    }
    return { sv, replayFrom: replayFrom as string | null };
  }
}

function readFrame(data: string, status: number): V1StreamFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (cause) {
    throw new PlatosStreamError(status, "STREAM_FRAME_MALFORMED", "a frame's data is not JSON", cause);
  }
  const record = parsed as Record<string, unknown> | null;
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    typeof record["sv"] !== "number" ||
    typeof record["t"] !== "string" ||
    typeof record["ts"] !== "number" ||
    typeof record["seq"] !== "number" ||
    !Number.isSafeInteger(record["seq"]) ||
    (record["seq"] as number) < 1
  ) {
    throw new PlatosStreamError(status, "STREAM_FRAME_MALFORMED", "a frame must carry sv, t, a whole seq of at least 1, and ts");
  }
  return record as unknown as V1StreamFrame;
}
