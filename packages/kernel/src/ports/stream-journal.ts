// ADR M0.3 §4 kernel port: StreamJournal.
//
// M0.4 §2 makes one promise about the SSE lane that the V1 tree cannot keep, and
// states the reason in its own drift-check column: "per-turn event log keyed
// (turnId, seq) required so `Last-Event-ID` survives a process restart (else
// replay is best-effort)". There is no such log. `streaming.service.ts` counts
// `seq` in a local variable and writes it onto the wire, so the numbering exists
// only inside the one request that produced it: the instant the socket drops,
// every frame already sent is unrecoverable and the `id:` the browser is holding
// names nothing. `Last-Event-ID` is a header this system reads from nowhere.
//
// That is also why WIN-272's acceptance cannot be met by a better writer. "Event
// ordering and conservation is proven under reconnect and multi-instance pub/sub"
// and "clients resume without missing or double-applying state" are both claims
// about frames that OUTLIVE the connection that carried them, and a connection
// cannot hold them. So the frames go somewhere, and this is the port they go to.
//
// WHY IT IS KERNEL-HOSTED, ON THE SAME TEST `CorrelationSource` AND
// `RequestIdempotency` PASS AND NO WEAKER ONE. It belongs to NO context. Five
// lanes carry the same frames — WebSocket, SSE, webhook ingest, public guest and
// embed — and M0.4 §2 gives all five one envelope family axis; none of the
// seventeen contexts decides anything with a resume cursor; and the two ends that
// must agree are the transport that writes frames and the transport that replays
// them, which are the same layer and never a context. Hanging it on
// `conversations` would make every other lane depend on the turn engine to be
// resumable, and the webhook and callback families have no turn at all.
//
// IT IS NOT `EventBus`, AND THE DIFFERENCE IS THE WHOLE REASON IT EXISTS.
// `EventBus` is documented as "the transient fan-out seam ... never unacknowledged
// canonical truth", and its `subscribe` takes an event name and a handler and
// hands back an unsubscribe. There is no position in it, so there is nothing to
// resume FROM; a subscriber that reconnects joins wherever the bus happens to be.
// This port is ordered and addressable: every frame has a cursor, and a reader
// that presents one gets the frames after it or is TOLD that they are gone. The
// two share an implementation — ADR M0.3 §15 permits one vendor client to satisfy
// several ports — and they do not share a contract.
//
// NO `Result`, FOR THE REASON `RequestIdempotency` HAS NONE. Every failure in this
// system is a `DomainError` carrying a code, and a code must be minted where the
// error taxonomy can see it. A kernel port that minted `STREAM_CURSOR_EXPIRED`
// would put the transport's wire vocabulary in the kernel and hide the mint from
// the transport that answers with it. So the port reports FACTS — appended,
// sealed, a page, an unknown stream, an expired cursor, unavailable — and the edge
// decides which code each fact deserves.
//
// RETENTION IS THE POINT OF `expired`, NOT AN OVERSIGHT. A journal that kept every
// frame forever would be a canonical store, which the charter's data rule reserves
// for the database; a journal that silently dropped the oldest would make
// "conservation" unfalsifiable, because a reader resuming into a trimmed range
// would receive a page that looks complete and is not. Bounded retention plus an
// explicit `expired` is the only arrangement in which a client can be WRONG
// loudly rather than quietly.

import type { StreamCursor, StreamFrame, TerminalFrameType } from "../vo/stream-frame.js";

/**
 * Why a stream stopped, recorded ONCE by the producer.
 *
 * THIS IS THE SERVER-SIDE HALF OF `classifyStreamEnd`. A client can tell a
 * completed stream from a severed one only if the two look different, and the only
 * party that knows which happened is the producer. A stream that reaches an
 * outcome is SEALED with the terminal frame type it reached; a stream whose
 * producer died is never sealed, and a reader that catches up to the end of an
 * UNSEALED stream knows to keep waiting rather than to render.
 */
export interface StreamSeal {
  readonly terminal: TerminalFrameType;
  /** Epoch milliseconds, from the producer's `Clock`. */
  readonly at: number;
}

/**
 * What appending frames did.
 *
 * `sealed` is a REFUSAL and not a no-op. A producer writing after the seal has a
 * defect — two producers on one stream, or a retry of work that already finished —
 * and accepting the frames would put content after a terminal frame, which is
 * exactly the "trailing invalid frames" WIN-272's acceptance forbids. The port
 * refuses and the caller learns why.
 *
 * `trimmed` is how many frames fell out of retention as a consequence of this
 * append. It is reported rather than hidden because it is the ONLY moment a
 * producer can observe backpressure: a stream whose readers are slower than its
 * writer trims, and a producer that never learns this cannot slow down, warn, or
 * record that a resume window closed.
 */
export type StreamAppendOutcome =
  | {
      readonly kind: "appended";
      /** The position of the LAST frame in the batch. */
      readonly cursor: StreamCursor;
      readonly trimmed: number;
    }
  | { readonly kind: "sealed"; readonly seal: StreamSeal }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * What sealing a stream did.
 *
 * `already-sealed` carries the EXISTING seal rather than replacing it. A second
 * seal is a redelivery — the kernel's own delivery contract is at-least-once — and
 * the first outcome a stream reached is the true one. Overwriting would let a
 * retry turn a completed turn into a failed one.
 */
export type StreamSealOutcome =
  | { readonly kind: "sealed"; readonly seal: StreamSeal }
  | { readonly kind: "already-sealed"; readonly seal: StreamSeal }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * What reading did.
 *
 * `page` may be EMPTY and that is not an error: a reader blocking at the live end
 * of an unsealed stream gets an empty page when nothing arrived in its window, and
 * loops. `seal` non-null with an empty page is the reader learning the producer
 * finished.
 *
 * `expired` IS THE CONSERVATION REFUSAL. The cursor is well-formed and names a
 * position this journal no longer holds, so the frames between it and `earliest`
 * are gone. Returning a page from `earliest` instead would hand the client a gap
 * dressed as a sequence — the client's own `admitFrame` would see a jump it could
 * not explain, or worse, would not see one because the page started where the
 * journal did. The refusal is what makes "no missing state" a property rather than
 * a hope.
 *
 * `unknown` and `expired` are SEPARATE because the operator response differs
 * completely: a stream that never existed is a bad request or a typo, and a stream
 * that has been trimmed past is a retention window too short for its readers.
 */
export type StreamReadOutcome =
  | {
      readonly kind: "page";
      readonly frames: readonly StreamFrame[];
      /** The position of the LAST frame in `frames`, or the caller's `after`. */
      readonly cursor: StreamCursor | null;
      /** Non-null once the producer sealed. Null while the stream may still grow. */
      readonly seal: StreamSeal | null;
    }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "expired";
      /** The oldest position this journal still holds, or null when it holds none. */
      readonly earliest: StreamCursor | null;
    }
  | { readonly kind: "unavailable"; readonly reason: string };

/** What a reader asks for. */
export interface StreamReadRequest {
  /** Most frames to return. A journal may return fewer; never more. */
  readonly limit: number;
  /**
   * How long to wait for a frame that does not exist yet, in milliseconds. `0`
   * returns immediately.
   *
   * ONE METHOD FOR REPLAY AND FOR THE LIVE TAIL, DELIBERATELY. An SSE handler
   * resuming a stream reads history and then follows, and those are the same loop
   * with the same cursor — a separate `follow` would have made them two, with two
   * chances to disagree about where history ended and the tail began. That seam is
   * where a duplicate or a dropped frame lives.
   */
  readonly blockMs: number;
}

export interface StreamJournal {
  /**
   * Append frames to one stream, in order, and report the position of the last.
   *
   * THE JOURNAL ASSIGNS NOTHING. `seq` is the producer's, because the producer is
   * the only party that can guarantee it is gap-free across a batch boundary — and
   * because a journal that renumbered would break the promise that a cursor a
   * client is holding still names the same frame after a redelivery.
   */
  append(streamId: string, frames: readonly StreamFrame[]): Promise<StreamAppendOutcome>;

  /**
   * Record that this stream reached an outcome. Idempotent: the first seal wins.
   *
   * SEALING IS SEPARATE FROM WRITING THE TERMINAL FRAME because the two can fail
   * apart. A producer appends `turn.done` and then dies before sealing, and a
   * reader must still be able to tell that the last frame it holds IS terminal —
   * which `classifyStreamEnd` does from the frame. The seal is what a reader that
   * has NOT yet caught up needs: it says "there is an end, and you have not
   * reached it", which no individual frame can say.
   */
  seal(streamId: string, terminal: TerminalFrameType, at: number): Promise<StreamSealOutcome>;

  /** Read the frames after `after`, or from the beginning when it is null. */
  read(
    streamId: string,
    after: StreamCursor | null,
    request: StreamReadRequest,
  ): Promise<StreamReadOutcome>;
}
