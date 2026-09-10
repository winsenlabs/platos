// THE SSE LANE: the bytes, the heartbeat, the backpressure and the four ways a
// stream ends.
//
// WHY THIS IS IN `transports/ws/` AND NOT A SEVENTH TRANSPORT DIRECTORY. M0.4 §1.2
// puts WS and SSE on ONE row — "`sv = 1` per envelope family" — and gives them one
// version axis between them; §2 then describes two lanes over that one axis. A
// seventh directory would have implied a seventh axis, which is the one thing this
// tranche exists to deny: the whole claim of WIN-272 is that the browser socket
// and the HTTP fallback carry the SAME envelope. The generated seam file beside
// this one still says "ws"; what it names is the streaming transport, both lanes.
//
// WHAT THE KERNEL OWNS AND WHAT THIS FILE OWNS. `vo/stream-frame.ts` decides what a
// frame IS, when a stream has ENDED, whether a client may RESUME and whether the
// frame it just received is the next one. This file owns only the encoding of that
// into `id:`/`data:` lines, the keep-alive, and the socket's own flow control.
// Nothing here re-decides anything the kernel decided; if it did, the SSE lane and
// the socket lane would have two answers.
//
// -----------------------------------------------------------------------------
// THE HEARTBEAT IS A COMMENT LINE AND CONSUMES NO SEQUENCE
//
// SSE's `: text` line is a comment: it keeps proxies and load balancers from
// closing an idle connection and is invisible to `EventSource`. That is the only
// correct shape for a keep-alive here, and the reason is the gap detection. A
// heartbeat delivered as a FRAME would need a `seq`, and every `seq` a client
// applies moves its `lastApplied` — so a client that missed one keep-alive would
// compute a gap out of nothing, and one that received a keep-alive after a
// reconnect would resume from a position that names a keep-alive rather than
// content. `apps/agent/src/agent-runtime/agent.controller.ts` wraps its generator
// in `withHeartbeat`, which yields heartbeats INTO the event stream; the frames
// there carry no `seq` at all, so nothing there could have noticed.
//
// -----------------------------------------------------------------------------
// BACKPRESSURE IS THE SOCKET'S OWN, AND THE ONLY HONEST FAILURE IS TO CLOSE
//
// `res.write()` returns false when the kernel's send buffer is full — the consumer
// is slower than the producer. Ignoring it is how a Node process converts a slow
// browser into unbounded heap: every unwritten frame is retained until the socket
// drains, and a producer that never pauses will outrun any consumer eventually.
//
// So this writer AWAITS `drain`, and it awaits it with a DEADLINE. When the
// deadline passes, the honest thing is the one thing that looks least tidy: END
// THE RESPONSE. It cannot write a `stream.offline` frame explaining itself,
// because the reason it is here is that it cannot write. The client sees a stream
// that stopped with no terminal frame, `classifyStreamEnd` calls that `severed`,
// `isResumable` says yes, and it comes back with its `Last-Event-ID`. That is the
// correct outcome and it is reached by DOING LESS rather than by inventing a
// frame that cannot be delivered.
//
// -----------------------------------------------------------------------------
// AN OVERSIZED FRAME ENDS THE STREAM RATHER THAN BEING SKIPPED
//
// A frame past `STREAM_MAX_FRAME_BYTES` leaves three options and two of them are
// wrong. Delivering it is what the ceiling exists to prevent. SKIPPING it is
// worse: the next frame's `seq` would jump, the client's `admitFrame` would report
// a gap it can do nothing about, and re-reading from the same cursor would hit the
// same frame forever. So the stream ends with a terminal `stream.error` carrying
// `STREAM_FRAME_TOO_LARGE` — loud, once, with a code an operator can chase to the
// producer.

import {
  admitFrameSize,
  flattenFrame,
  isOk,
  STREAM_MAX_FRAME_BYTES,
  type StreamCursor,
  type StreamFrame,
} from "@platos/kernel";

/** The subset of a framework response this lane writes through. Structural. */
export interface StreamResponse {
  setHeader(name: string, value: string): unknown;
  flushHeaders?: () => void;
  write(chunk: string): boolean;
  end(): unknown;
  once(event: string, listener: () => void): unknown;
  off?: (event: string, listener: () => void) => unknown;
  readonly writableEnded?: boolean;
}

/**
 * The subset of an inbound request this lane reads.
 *
 * STRUCTURAL, AND A SUPERSET OF `InboundOperatorRequest` ON PURPOSE. The stream
 * lane authenticates through the ONE seam in `rest/operator.ts`, and that seam
 * takes `{ headers, secure? }`; adding `secure` here means a stream request can be
 * handed to it with no cast, so the cookie-name decision the contract owns is
 * reached the same way on this lane as on every other.
 */
export interface StreamRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly secure?: boolean;
  on(event: string, listener: () => void): unknown;
}

export interface SseWriterOptions {
  /** Milliseconds between keep-alive comments. */
  readonly heartbeatMs: number;
  /** Milliseconds to wait for a full socket to drain before giving up on it. */
  readonly drainDeadlineMs: number;
  /** Bytes one frame may occupy on the wire. */
  readonly maxFrameBytes: number;
}

export const DEFAULT_SSE_OPTIONS: SseWriterOptions = Object.freeze({
  // 15 seconds, matching the one interval this repository already ships
  // (`PLATOS_STREAM_HEARTBEAT_MS` defaults to 15_000 in `apps/agent`). A shared
  // number rather than a second opinion: a client tuned to one lane's keep-alive
  // must not have to be retuned for the other, which is the whole point of one
  // envelope contract.
  heartbeatMs: 15_000,
  // Ten seconds. Long enough that a phone on a slow link is not disconnected for
  // being slow; short enough that a consumer that has stopped reading entirely
  // cannot hold a producer's frames in this process's heap for a whole turn.
  drainDeadlineMs: 10_000,
  maxFrameBytes: STREAM_MAX_FRAME_BYTES,
});

/** The event-stream response headers, written once, before any frame. */
export function openEventStream(response: StreamResponse): void {
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  // `no-transform` as well as `no-cache`: a proxy that gzipped this would buffer
  // it, and a buffered event stream is a stream that arrives all at once at the
  // end. The webapp's own embed proxy already sets both, which is where the pair
  // comes from rather than from a guess here.
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  // The nginx-specific opt-out, kept because every INSTALL of the live surface has
  // needed it and its absence is invisible until a stream is served from behind a
  // proxy nobody remembered.
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();
}

/**
 * One frame as SSE bytes, or a refusal.
 *
 * `id:` CARRIES THE CURSOR AND NOT THE SEQUENCE, which is the difference between
 * a resume that works across a process restart and one that does not. A bare
 * sequence names a position inside a numbering the browser cannot map back to a
 * stream, so a `Last-Event-ID` of `41` tells the next process nothing; the cursor
 * names the stream AND the position, and `decodeStreamCursor` refuses one that
 * belongs to another stream.
 */
export function encodeSseFrame(
  frame: StreamFrame,
  cursor: StreamCursor,
  maxFrameBytes: number,
): { readonly ok: true; readonly bytes: string } | { readonly ok: false; readonly seq: number } {
  const flat = flattenFrame(frame);
  // A payload that collides with a reserved field is a producer defect the kernel
  // already refuses. It cannot be delivered and it cannot be skipped, so it is
  // reported through the same door an oversized frame uses.
  if (!isOk(flat)) return { ok: false, seq: frame.seq };
  const data = JSON.stringify(flat.value);
  // BYTES, MEASURED, not characters counted. `admitFrameSize` documents why: a
  // limit computed from `.length` is a limit an attacker chooses by alphabet.
  const size = admitFrameSize(Buffer.byteLength(data, "utf8"), maxFrameBytes);
  if (!isOk(size)) return { ok: false, seq: frame.seq };
  return { ok: true, bytes: `id: ${cursor}\ndata: ${data}\n\n` };
}

/**
 * A frame with NO `id:` line, for a frame this transport minted rather than read.
 *
 * THE ABSENT ID IS THE POINT. `Last-Event-ID` must keep naming the last frame the
 * JOURNAL holds, because that is the only kind of position `read` can continue
 * from. A transport-minted terminal frame carrying an id would hand the client a
 * cursor the journal has never held, and a resume from it would be refused —
 * turning a clean "your credential expired, come back" into an unreadable cursor.
 */
export function encodeSseEvent(
  frame: StreamFrame,
  maxFrameBytes: number,
): { readonly ok: true; readonly bytes: string } | { readonly ok: false; readonly seq: number } {
  const flat = flattenFrame(frame);
  if (!isOk(flat)) return { ok: false, seq: frame.seq };
  const data = JSON.stringify(flat.value);
  const size = admitFrameSize(Buffer.byteLength(data, "utf8"), maxFrameBytes);
  if (!isOk(size)) return { ok: false, seq: frame.seq };
  return { ok: true, bytes: `data: ${data}\n\n` };
}

/**
 * The LEADING FRAME M0.4 §2 gives the SSE lane, as a NAMED SSE event.
 *
 * The ADR's SSE row asks for "`sv` from `/api/v1/` prefix + leading
 * `stream_meta{sv,replayFrom}` frame; reconnect replay via native
 * `Last-Event-ID`". This is that frame, and the one design decision in it is that
 * it rides on SSE's own `event:` field rather than on the default one.
 *
 * WHY A NAMED EVENT AND NOT A FRAME WITH A `t`. Every frame on the default event
 * type goes through the client's `admitFrame`, which needs a `seq` — and there is
 * no honest sequence for this one. Zero is refused as a duplicate by every correct
 * client; the resumed position is refused for the same reason; and a number above
 * the resumed position would occupy a sequence the JOURNAL will later assign to a
 * real frame. `event: stream_meta` puts it on a channel a client subscribes to
 * separately, so it never enters the sequence at all — which is what it is: a
 * statement ABOUT the stream rather than a member of it.
 *
 * `replayFrom` IS THE POSITION THIS READER ASKED TO CONTINUE FROM, echoed back, and
 * null when it asked for the whole stream. It is not a promise about what the
 * journal holds — that answer is the first page, or the `STREAM_CURSOR_EXPIRED`
 * refusal the reader gets instead of one.
 */
export function encodeStreamMeta(sv: number, replayFrom: StreamCursor | null): string {
  const payload = JSON.stringify({ sv, replayFrom });
  return `event: stream_meta\ndata: ${payload}\n\n`;
}

/** A keep-alive. An SSE comment: no id, no data, no sequence. */
export function encodeHeartbeat(): string {
  return ": keep-alive\n\n";
}

/**
 * Write to a response, waiting for a full socket to drain.
 *
 * RESOLVES `false` RATHER THAN THROWING when the deadline passes, because "the
 * consumer is too slow" is an outcome the caller must record and not an exception:
 * a throw would travel up into the exception filter, which would try to write a
 * JSON error envelope onto a socket whose whole problem is that it cannot be
 * written to.
 */
export async function writeWithBackpressure(
  response: StreamResponse,
  chunk: string,
  drainDeadlineMs: number,
): Promise<boolean> {
  if (response.writableEnded === true) return false;
  if (response.write(chunk)) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off?.("drain", onDrain);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const timer = setTimeout(() => finish(false), drainDeadlineMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    response.once("drain", onDrain);
  });
}

/**
 * Whether the client has gone.
 *
 * `close` ON BOTH THE REQUEST AND THE RESPONSE, because they fire on different
 * events and a lane that watched one would leak on the other: `request` closes
 * when the client aborts, `response` when the socket is destroyed underneath us.
 * The live surface's own SSE handler listens to both for the same reason.
 */
export function watchForDisconnect(request: StreamRequest, response: StreamResponse): () => boolean {
  let gone = false;
  const mark = () => {
    gone = true;
  };
  request.on("close", mark);
  response.once("close", mark);
  return () => gone;
}

/** The `Last-Event-ID` header, or null. A repeated header is treated as absent. */
export function presentedResumeId(request: StreamRequest): string | null {
  const header = request.headers["last-event-id"];
  if (typeof header !== "string" || header.length === 0) return null;
  return header;
}
