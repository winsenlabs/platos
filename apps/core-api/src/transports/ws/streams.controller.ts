// GET /api/v1/environments/:environmentId/streams/:streamId — THE RESUMABLE
// STREAM, AND THE ROUTE THAT MUST NOT OUTLIVE THE CREDENTIAL THAT OPENED IT.
//
// -----------------------------------------------------------------------------
// WHY THE ENVIRONMENT IS IN THE PATH, AND WHY THAT IS A SECURITY DECISION
//
// A stream id on its own is a BEARER CAPABILITY: anyone who can guess or observe
// one reads the turn behind it. The kernel's `StreamJournal` has no scope in its
// signature and should not — a journal is an ordered log — so the scope has to be
// enforced by the party that has one, and that is this transport.
//
// The key handed to the port is built from `authorization.scope`, which is the
// environment scope `tenancy` RE-DERIVED while deciding the four-gate question,
// and never from the path segment. `environment-end-users.controller.ts` states
// the rule this follows — "THE SCOPE IS THE AUTHORIZATION'S, NOT THE PATH'S" —
// and here it is what makes a forged scope answer 404 instead of another
// tenant's frames: a caller who names an environment they hold and a stream
// created under one they do not reaches a key that does not exist.
//
// AND THE FORGED-SCOPE ANSWER IS 404 AND NOT 403, deliberately. 403 would confirm
// the stream exists, which is the one bit a prober is trying to obtain.
//
// -----------------------------------------------------------------------------
// THE CREDENTIAL EXPIRY FENCE, WHICH IS THE DEFECT THIS ROUTE IS BUILT AGAINST
//
// The live SSE lane authenticates ONCE at admission and then streams without
// bound: `apps/agent/src/agent-runtime/agent.controller.ts`'s `agentChatStream`
// takes its scope from the guard, wraps the generator in a 15-second heartbeat and
// awaits it. Nothing re-reads the credential. A public guest token with five
// seconds left therefore holds a stream open for as long as the turn runs — the
// default guest window is 1800 seconds and the stream is bounded by NEITHER.
//
// `OperatorAuthorizationView` carries `expiresAt`, so the fence is available and
// costs one comparison: the read loop's deadline is
// `min(credential expiry, request deadline)`, and reaching it writes a terminal
// `stream.error` carrying `STREAM_CREDENTIAL_EXPIRED` and closes. That code is
// distinct from `SESSION_EXPIRED` for the reason `stream-errors.ts` gives: one is
// an answer to a REQUEST, the other is an event about a STREAM, and a client that
// conflated them would refresh its token and not know whether to resume.
//
// A REVOCATION MID-STREAM IS NOT COVERED BY THIS FENCE AND IS NOT CLAIMED TO BE.
// The fence is arithmetic over an expiry this route already holds. A session
// REVOKED after admission would need the credential re-authenticated on a timer,
// which is a database round trip per interval per open stream; that is a real
// decision with a real cost and it is not taken here. What is here bounds the
// window at the credential's own lifetime, which is what makes the unbounded case
// impossible.
//
// -----------------------------------------------------------------------------
// WHAT THIS ROUTE DOES NOT DO
//
// It does not START a turn. The turn engine cannot be composed in this deployable,
// so a route that claimed to run one would be a controller with nothing behind it.
//
// WIN-302 CORRECTS WHY. This said `conversations` is on
// `UNIMPORTABLE_CONTEXT_FACTORIES`, and it is not — its root barrel re-exports
// `createConversationsContract`, so the factory was always nameable and the list
// named it by mistake. What stops the context is its BUNDLE: eleven peers, of
// which `files` and `jobs` are genuinely unimportable and `agents` and `skills`
// are each short driven ports that have no adapter directory. This is the READ half of the lane: something else appends
// frames through `StreamJournal` and seals when it reaches an outcome, and this
// serves them in order, from a position, to a browser. The producer half is the
// port, and `apps/core-api/src/composition/stream-lane.integration.test.ts` is the
// producer in the suite — standing in for the turn engine exactly as far as the
// port's contract goes and no further.

import { Controller, Get, Inject, Param, Req, Res } from "@nestjs/common";

import {
  decodeStreamCursor,
  encodeStreamCursor,
  isOk,
  STREAM_SCHEMA_VERSION,
  type StreamCursor,
  type StreamFrame,
  type DomainError,
  type StreamJournal,
  type StreamReadOutcome,
} from "@platos/kernel";

import type { AppModule } from "../../app.module.js";
import { API_VERSION } from "../../http/api-surface.js";
import { REST_APPLICATION, type RestApplication } from "../rest/dependencies.js";
import { raise } from "../rest/fault.js";
import { authenticateOperator, authorizeEnvironment } from "../rest/operator.js";
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
  type StreamRequest,
  type StreamResponse,
  type SseWriterOptions,
} from "./sse.js";
import {
  streamCredentialExpired,
  streamCursorExpired,
  streamCursorUnreadable,
  streamFrameTooLarge,
  streamJournalUnavailable,
  streamUnknown,
} from "./stream-errors.js";

/** The envelope family this lane serves. One lane, one family, per M0.4 §1.2. */
export const STREAM_FAMILY = "sse.turn" as const;

/**
 * The journal key for one stream inside one environment.
 *
 * THE ENVIRONMENT IS PART OF THE KEY AND NOT A CHECK BESIDE IT, which is the
 * difference between a tenancy rule and a tenancy hope. A check can be forgotten
 * on the next route; a key cannot be read past. `/` is the separator because the
 * kernel's own `resolvePath` uses it for exactly this purpose and the journal's
 * cursor encoding is LENGTH-PREFIXED, so a separator inside an id is not a
 * parsing hazard.
 */
export function journalStreamId(environmentId: string, streamId: string): string {
  return `${environmentId}/${streamId}`;
}

/** Everything the loop needs, so the loop itself holds no framework and no policy. */
export interface StreamPumpInput {
  readonly journal: StreamJournal;
  readonly streamId: string;
  readonly response: StreamResponse;
  readonly after: StreamCursor | null;
  /** Epoch milliseconds past which this reader is let go. */
  readonly deadlineMs: number;
  readonly hasDisconnected: () => boolean;
  readonly now: () => number;
  readonly options: SseWriterOptions;
  /** Most frames one read returns. */
  readonly pageLimit: number;
}

/** Why the pump stopped. The caller turns each into bytes or into nothing. */
export type StreamPumpKind =
  | "sealed"
  | "credential-expired"
  | "disconnected"
  | "consumer-too-slow"
  | "frame-too-large"
  | "journal-unavailable"
  | "cursor-expired";

export interface StreamPumpOutcome {
  readonly kind: StreamPumpKind;
  /**
   * The highest journal sequence this reader was handed, or 0.
   *
   * IT IS WHAT A TRANSPORT-MINTED TERMINAL FRAME IS NUMBERED FROM, and getting it
   * wrong is the difference between a client applying that frame and DROPPING it:
   * `admitFrame` calls any sequence at or below the last applied one a DUPLICATE,
   * so a terminal frame numbered 0 would be silently discarded by every correct
   * client. It is numbered `lastSeq + 1` instead.
   */
  readonly lastSeq: number;
}

/**
 * Yield to the event loop.
 *
 * A MACROTASK AND NOT A MICROTASK. `await Promise.resolve()` drains to the microtask
 * queue and never lets a timer fire, which is exactly the starvation this exists to
 * prevent; `setTimeout(…, 0)` is the shortest wait that gives the loop a turn.
 */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** A terminal `stream.error` frame. Its `code` is what `classifyStreamEnd` reads. */
export function terminalErrorFrame(seq: number, at: number, code: string): StreamFrame {
  return {
    sv: STREAM_SCHEMA_VERSION,
    family: STREAM_FAMILY,
    t: "stream.error",
    seq,
    ts: at,
    fields: { code },
  };
}

/**
 * Read frames and write them, until the stream ends or this reader is let go.
 *
 * IT TAKES A CLOCK AS A PARAMETER. The credential fence is arithmetic over an
 * instant, and a unit case that had to WAIT for a real expiry would be a case
 * nobody runs. The integration suite passes the real clock and a real two-second
 * session, so both halves are proven.
 *
 * IT NEVER WRITES A FRAME IT HAS NOT ALREADY BEEN ABLE TO ENCODE. The order inside
 * the loop is encode, then write, then advance — so a frame the encoder refuses
 * stops the stream at the position BEFORE it, and a resuming client is handed the
 * same frame rather than the one after it. Advancing first would turn one bad
 * frame into a silent gap.
 */
export async function pumpStream(input: StreamPumpInput): Promise<StreamPumpOutcome> {
  let position = input.after;
  let lastSeq = startingSequence(input.after);
  let lastHeartbeat = input.now();
  const stop = (kind: StreamPumpKind): StreamPumpOutcome => ({ kind, lastSeq });
  for (;;) {
    if (input.hasDisconnected()) return stop("disconnected");
    const remaining = input.deadlineMs - input.now();
    if (remaining <= 0) return stop("credential-expired");
    // THE BLOCK IS BOUNDED BY BOTH THE FENCE AND THE HEARTBEAT. Waiting past the
    // credential's expiry would hold a stream open on a dead credential for one
    // whole window; waiting past the heartbeat interval would let a proxy close a
    // healthy idle stream. The smaller of the two is the only correct wait.
    const blockMs = Math.max(1, Math.min(remaining, input.options.heartbeatMs));
    const page: StreamReadOutcome = await input.journal.read(input.streamId, position, {
      limit: input.pageLimit,
      blockMs,
    });
    if (page.kind === "unavailable") return stop("journal-unavailable");
    if (page.kind === "expired") return stop("cursor-expired");
    // A STREAM THAT VANISHED MID-READ IS `sealed`, NOT `unknown`. Admission already
    // proved it existed; a metadata key whose window closed under a reader that is
    // caught up is the end of the stream, and a 404 at this point would be an
    // envelope written onto an open event stream.
    if (page.kind === "unknown") return stop("sealed");

    for (const frame of page.frames) {
      if (input.hasDisconnected()) return stop("disconnected");
      const cursorForFrame = frameCursor(input.streamId, frame);
      if (cursorForFrame === null) return stop("frame-too-large");
      const encoded = encodeSseFrame(frame, cursorForFrame, input.options.maxFrameBytes);
      if (!encoded.ok) return stop("frame-too-large");
      const wrote = await writeWithBackpressure(
        input.response,
        encoded.bytes,
        input.options.drainDeadlineMs,
      );
      if (!wrote) return stop(input.hasDisconnected() ? "disconnected" : "consumer-too-slow");
      position = cursorForFrame;
      lastSeq = frame.seq;
      lastHeartbeat = input.now();
    }

    if (page.frames.length === 0) {
      if (page.seal !== null) return stop("sealed");
      if (input.now() - lastHeartbeat >= input.options.heartbeatMs) {
        const wrote = await writeWithBackpressure(
          input.response,
          encodeHeartbeat(),
          input.options.drainDeadlineMs,
        );
        if (!wrote) return stop(input.hasDisconnected() ? "disconnected" : "consumer-too-slow");
        lastHeartbeat = input.now();
      }
      // THE LOOP PACES ITSELF AND DOES NOT TRUST THE JOURNAL TO PACE IT, and this
      // one line is the difference between a bounded wait and a spinning process.
      //
      // A CONFORMING JOURNAL COSTS NOTHING FOR IT. `StreamReadRequest.blockMs` is
      // "how long to wait for a frame that does not exist yet", so a conforming
      // implementation has already waited most of a heartbeat before it answers with
      // an empty page — and an empty page arrives at most once per window.
      //
      // A JOURNAL THAT ANSWERS INSTANTLY MADE THIS LOOP SPIN, and a mutation found
      // it: with the credential fence pushed forward, the pump read a scripted
      // journal that returns immediately, never reached a macrotask, and starved the
      // event loop so completely that the test runner's own timeout could not fire.
      // The process sat at 99% CPU. A transport whose liveness depends on a port
      // behaving well is a transport that hangs when the port does not.
      await pause(0);
      continue;
    }
    // FRAMES WERE WRITTEN, so the seal is only acted on once the reader has caught
    // up — a sealed stream with a full page still has frames to deliver, and
    // returning here would drop them.
    if (page.seal !== null && page.frames.length < input.pageLimit) return stop("sealed");
  }
}

/**
 * The sequence a resuming reader starts from.
 *
 * READ OUT OF THE CURSOR RATHER THAN ASSUMED ZERO. A reader that resumed at 400 and
 * was then let go by the credential fence before receiving anything would otherwise
 * be handed a terminal frame numbered 1 — which its own `admitFrame` would call a
 * duplicate and drop, leaving it with no explanation for a stream that stopped.
 */
export function startingSequence(after: StreamCursor | null): number {
  if (after === null) return 0;
  const position = decodeStreamCursor(after);
  return isOk(position) ? position.value.seq : 0;
}

/**
 * The cursor for one frame, or null when it cannot be encoded.
 *
 * A stream id the cursor encoding refuses is not a frame this lane can deliver: it
 * would have to write an `id:` the client cannot send back, and a client that
 * resumed from it would be refused. That is reported through the same door an
 * oversized frame uses rather than being written without an id, because a frame
 * with no `id:` silently resets `Last-Event-ID` to the previous one — which is the
 * RIGHT behaviour for a transport-minted terminal frame and the wrong one for
 * content.
 */
function frameCursor(streamId: string, frame: StreamFrame): StreamCursor | null {
  const encoded = encodeStreamCursor(streamId, frame.seq);
  return isOk(encoded) ? encoded.value : null;
}

/**
 * WHY THIS ROUTE TAKES NO `?sv=` PARAMETER, WHICH IT DID FOR ONE COMMIT.
 *
 * M0.4 §2's SSE row derives this lane's `sv` from the `/api/v1/` prefix and reports
 * it in the leading `stream_meta` frame. It asks for nothing else, and the extra
 * parameter — a floor assertion for a client that cannot set a header — was mine
 * rather than the ADR's.
 *
 * IT COST MORE THAN IT WAS WORTH, AND THE OPENAPI RATCHET IS WHAT PRICED IT.
 * `rest-schema-derivation.mjs` refuses a `@Query` typed `string | undefined`, and it
 * refuses a POST-PARSE DTO too: `StreamQuery { sv: number }` declares a number the
 * caller never sends and omits the string it does, so publishing it "would describe
 * a query string this route does not accept". The register's own note names the
 * remedy — "a declared wire-query DTO that the validator itself consumes" — and
 * says it "is a change to `apps/core-api/src/transports/rest`, it is not this
 * tranche's". It is not this one's either. The alternatives were a second entry in
 * `UNDERIVABLE_QUERY_HANDLERS`, which documents a gap rather than closing one, or
 * inventing a repository-wide wire-DTO convention for another tranche's generator.
 *
 * So the parameter is gone and the route has no query string at all.
 * `negotiateStreamVersion` is still the one place a version is agreed and is still
 * proven by cases; what no surface in this deployable does yet is carry `sv` ON THE
 * WIRE, because the lane that would — the WebSocket handshake — is in `apps/agent`,
 * which imports no V1 package at all.
 */

/** The composed journal, or a 503 naming what is missing. */
export function requireStreamJournal(app: AppModule): StreamJournal {
  const journal = app.streamJournal;
  // `contextUnavailable` names a CONTEXT and this is a kernel port, so the refusal
  // is the journal's own rather than that one — an operator sent to look for a
  // missing context when the answer is `PLATOS_STORE_REDIS_URL` would be sent to
  // the wrong system. `/readyz` reports the binding.
  if (journal === null || journal === undefined) raise(streamJournalUnavailable());
  return journal;
}

@Controller({ path: "environments", version: API_VERSION })
export class EnvironmentStreamsController {
  constructor(@Inject(REST_APPLICATION) private readonly application: RestApplication) {}

  @Get(":environmentId/streams/:streamId")
  async read(
    @Req() request: StreamRequest,
    @Res() response: StreamResponse,
    @Param("environmentId") environmentId: string,
    @Param("streamId") streamId: string,
  ): Promise<void> {
    const app = this.application.app;
    const options = DEFAULT_SSE_OPTIONS;
    // THE MAJOR THIS LANE CARRIES. The URL prefix is where M0.4 §2 puts it for the
    // SSE lane, so it is the build's constant rather than a negotiated value — and
    // the leading `stream_meta` frame is where a client is told which one it got.
    const sv = STREAM_SCHEMA_VERSION;
    // EVERY REFUSAL BEFORE THE FIRST BYTE IS A JSON ENVELOPE, and every one after
    // it is a terminal FRAME. That split is the whole reason admission happens
    // before `openEventStream`: a 401 cannot be sent once a 200 has gone out, so a
    // lane that opened the stream first would have to report authentication
    // failures inside the event body — which is where the live surface's
    // `{type:"error"}` frame came from and why a browser cannot tell it from a
    // model failure.
    const operator = await authenticateOperator(app, request);
    const authorization = await authorizeEnvironment(app, operator, environmentId);
    const journal = requireStreamJournal(app);
    const key = journalStreamId(authorization.scope.environmentId, streamId);

    const presented = presentedResumeId(request);
    let after: StreamCursor | null = null;
    if (presented !== null) {
      const position = decodeStreamCursor(presented);
      if (!isOk(position)) raise(streamCursorUnreadable());
      // A CURSOR FOR ANOTHER STREAM IS REFUSED HERE AND NOT PASSED DOWN. The port
      // would answer `unknown`, which this lane turns into 404 — and a 404 for a
      // stream that exists, because the client sent the wrong cursor, would send an
      // operator looking for a missing stream. The refusal names the header.
      if (position.value.streamId !== key) raise(streamCursorUnreadable());
      after = presented as StreamCursor;
    }

    // THE FIRST READ HAPPENS BEFORE THE HEADERS, so `unknown` and `expired` can
    // still be answered with a real status and a canonical code. A lane that opened
    // the stream first would have to answer both inside the body.
    const first = await journal.read(key, after, { limit: 1, blockMs: 0 });
    if (first.kind === "unavailable") raise(streamJournalUnavailable());
    if (first.kind === "unknown") raise(streamUnknown());
    if (first.kind === "expired") raise(streamCursorExpired());

    const deadlineMs = operator.expiresAt.getTime();
    if (deadlineMs <= Date.now()) raise(streamCredentialExpired());

    openEventStream(response);
    // THE LEADING FRAME, BEFORE ANY CONTENT. A client that receives frames before
    // it has been told the `sv` and the position it is resuming from would have to
    // infer both, and inferring a version is how a reader ends up applying a frame
    // it does not understand.
    await writeWithBackpressure(response, encodeStreamMeta(sv, after), options.drainDeadlineMs);
    const hasDisconnected = watchForDisconnect(request, response);
    const outcome = await pumpStream({
      journal,
      streamId: key,
      response,
      after,
      deadlineMs,
      hasDisconnected,
      now: () => Date.now(),
      options,
      pageLimit: 64,
    });
    await this.close(response, outcome, options, hasDisconnected);
  }

  /**
   * End the stream the way its outcome demands.
   *
   * THE TERMINAL FRAME IS WRITTEN HERE AND NOWHERE ELSE, so "at most one terminal
   * frame per stream" is a property of one function rather than of every branch.
   * `disconnected` and `consumer-too-slow` write NOTHING — the first because there
   * is no client and the second because the inability to write is the reason we are
   * here — and both leave the client with no terminal frame, which
   * `classifyStreamEnd` reports as `severed` and `isResumable` says to resume.
   *
   * `sealed` WRITES NOTHING EITHER, and that is not an omission. The producer's own
   * terminal frame — `turn.done`, or its own `stream.error` — is already in the
   * journal and was already delivered by the pump. Writing a second one here would
   * be the "duplicate terminal frame" the acceptance forbids, and it is exactly
   * what the live SSE lane does today: `streaming.service.ts` writes an `error`
   * frame AND a `done` frame on its failure path.
   */
  private async close(
    response: StreamResponse,
    outcome: StreamPumpOutcome,
    options: SseWriterOptions,
    hasDisconnected: () => boolean,
  ): Promise<void> {
    const fault = TERMINAL_FAULTS[outcome.kind];
    if (fault !== undefined && !hasDisconnected()) {
      // NUMBERED `lastSeq + 1` AND WRITTEN WITH NO `id:` LINE, and both halves
      // matter. The number is what stops a correct client dropping it as a
      // duplicate; the absent id is what stops the client resuming FROM it — a
      // transport-minted frame is not a journal position, and a `Last-Event-ID` of
      // one would be a cursor the journal has never held.
      const frame = terminalErrorFrame(outcome.lastSeq + 1, Date.now(), fault().code);
      const encoded = encodeSseEvent(frame, options.maxFrameBytes);
      // A TERMINAL FRAME THAT CANNOT BE ENCODED IS NOT RETRIED WITH A SMALLER ONE.
      // It carries a code and a sequence and nothing else, so the only way it can
      // fail is a defect here — and inventing a second shape for the end of a
      // stream would put two spellings of it on the wire.
      if (encoded.ok) await writeWithBackpressure(response, encoded.bytes, options.drainDeadlineMs);
    }
    if (response.writableEnded !== true) response.end();
  }
}

/**
 * The FAULT each mid-stream ending carries — the constructor, not the string.
 *
 * A TABLE OF THE SAME FUNCTIONS THE PRE-STREAM REFUSALS USE, so a code cannot be
 * spelled twice. The obvious shape is a map of `kind` to a code STRING, and it
 * would have created exactly the drift this programme keeps paying for: the code
 * on a 409 envelope and the code inside a terminal frame would be two literals
 * that agree today. Reading `.code` off the minted `DomainError` means one mint
 * site, one taxonomy entry, and one value on both sides of the first byte.
 *
 * `sealed`, `disconnected` and `consumer-too-slow` are ABSENT, and that is the
 * rule rather than an omission. `sealed` means the producer's own terminal frame
 * has already been delivered, and a second one here is the DUPLICATE TERMINAL
 * FRAME the acceptance forbids — which is what `streaming.service.ts` writes
 * today, an `error` frame followed by a `done` frame. The other two mean there is
 * nothing that can be written to.
 */
export const TERMINAL_FAULTS: Readonly<Partial<Record<StreamPumpKind, () => DomainError>>> =
  Object.freeze({
    "credential-expired": streamCredentialExpired,
    "frame-too-large": streamFrameTooLarge,
    "journal-unavailable": streamJournalUnavailable,
    "cursor-expired": streamCursorExpired,
  });
