// THE GATE, ON A SOCKET.
//
// `idempotency.ts` decides; this executes. The split is ADR M0.3 §6's transport
// budget applied honestly: every branch of the contract is reachable in
// `decideIdempotency` without a server, and what is left here is the three
// things only a real response can do — write the refusal, replay the recorded
// bytes, and capture what the handler produced so the NEXT twin has something to
// replay.
//
// CAPTURING THE RESPONSE IS A WRAP, AND THE WRAP IS BOUNDED. `write` and `end`
// are replaced with functions that copy the chunk and then call the original, so
// the caller's bytes are untouched and the capture cannot change what goes on
// the wire. It stops copying at `MAX_REPLAYABLE_BODY_BYTES` and then RELEASES
// the reservation rather than recording a truncated body, because a replay that
// returned half a secret is worse than a replay that never happens.
//
// SETTLEMENT IS FIRE-AND-FORGET, AND IT HAS TO BE. `finish` is not an async
// hook: the response has already gone. So the record or release is started there
// and its failure is LOGGED rather than swallowed — a reservation that cannot be
// settled stays `running` until its TTL, which means later twins are told
// IDEMPOTENCY_REQUEST_IN_FLIGHT rather than being run twice. Fail-closed again,
// and the log line is how an operator sees it happening.

import type { Logger, RecordedResponse, RequestFingerprint, RequestIdempotency } from "@platos/kernel";

import { mintErrorId, writeFailure, type FailureResponse } from "./failure.js";
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_REPLAYED_HEADER } from "./idempotency-errors.js";
import {
  decideIdempotency,
  settlementFor,
  REQUEST_IDEMPOTENCY_TTL_SECONDS,
  MAX_REPLAYABLE_BODY_BYTES,
  type RequestFacts,
} from "./idempotency.js";

/** Only the parts of an inbound request this middleware reads. */
export interface GatedRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly originalUrl?: string;
  readonly url?: string;
  readonly rawBody?: Uint8Array;
}

/** Only the parts of an outbound response this middleware touches. */
export interface GatedResponse extends FailureResponse {
  write(chunk: unknown, ...rest: unknown[]): boolean;
  end(chunk?: unknown, ...rest: unknown[]): unknown;
  getHeader(name: string): number | string | string[] | undefined;
  on(event: string, listener: () => void): unknown;
}

/** A single-valued header, or null. A repeated one is handed on as the array it
 * is, so `readIdempotencyKey` can refuse it rather than this file picking one. */
function header(request: GatedRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

export function factsOf(request: GatedRequest): RequestFacts {
  return {
    method: request.method ?? "GET",
    // `originalUrl` before `url`: Express rewrites `url` to the path RELATIVE to
    // the mount point for middleware, so a gate reading it would classify every
    // request as "/" and bind nothing.
    originalUrl: request.originalUrl ?? request.url ?? "/",
    idempotencyKey: request.headers[IDEMPOTENCY_KEY_HEADER],
    authorization: header(request, "authorization"),
    contentType: header(request, "content-type"),
    contentLength: header(request, "content-length"),
    rawBody: request.rawBody ?? null,
  };
}

/** Send a recorded response back, byte for byte, marked as a replay. */
function replay(response: GatedResponse, recorded: RecordedResponse): void {
  response.statusCode = recorded.status;
  if (recorded.contentType !== null) response.setHeader("Content-Type", recorded.contentType);
  // M0.4 §2 spells it `Idempotency-Replayed:true`. It is a header and not a body
  // field because the body is the first answer byte for byte — which is what
  // "returns same secret" means — and editing it would make the replay differ
  // from the thing being replayed.
  response.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");
  response.end(recorded.body);
}

interface Capture {
  readonly chunks: string[];
  bytes: number;
  overflowed: boolean;
}

/** Replace `write`/`end` with copies that record and then delegate. */
function captureBody(response: GatedResponse): Capture {
  const capture: Capture = { chunks: [], bytes: 0, overflowed: false };
  const originalWrite = response.write.bind(response);
  const originalEnd = response.end.bind(response);
  const copy = (chunk: unknown): void => {
    if (chunk === undefined || chunk === null || typeof chunk === "function") return;
    const text =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : null;
    if (text === null) {
      // A stream or a typed array this file cannot faithfully re-send. Marked as
      // an overflow rather than guessed at, so settlement releases instead of
      // recording something a replay would get wrong.
      capture.overflowed = true;
      return;
    }
    capture.bytes += Buffer.byteLength(text, "utf8");
    if (capture.bytes > MAX_REPLAYABLE_BODY_BYTES) {
      capture.overflowed = true;
      return;
    }
    capture.chunks.push(text);
  };
  response.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    copy(chunk);
    return originalWrite(chunk, ...rest);
  };
  response.end = (chunk?: unknown, ...rest: unknown[]): unknown => {
    copy(chunk);
    return originalEnd(chunk, ...rest);
  };
  return capture;
}

export interface GateDependencies {
  readonly store: RequestIdempotency | null;
  readonly logger: Logger;
}

export type NextFunction = (error?: unknown) => void;

/**
 * The middleware M0.4 §2 asks for.
 *
 * Registered over `*` by `http.module.ts`, so it also sees a request whose route
 * does not exist yet — which is the state of every one of the eight mints in
 * this table until WIN-267 lands them. That is deliberate: the envelope contract
 * is not the routes, and a gate that waited for the routes would be a gate every
 * route has to remember to ask for.
 */
export function createIdempotencyGate(dependencies: GateDependencies) {
  return function idempotencyGate(
    request: GatedRequest,
    response: GatedResponse,
    next: NextFunction,
  ): void {
    const facts = factsOf(request);
    void decideIdempotency(facts, dependencies.store)
      .then((decision) => {
        if (decision.kind === "refuse") {
          const errorId = mintErrorId();
          const status = writeFailure(response, decision.error, {
            errorId,
            requestId: String(response.getHeader("x-request-id") ?? ""),
          });
          dependencies.logger.log("warn", "http.idempotency_refused", {
            code: decision.error.code,
            status,
            errorId,
            operation: facts.method,
          });
          return;
        }
        if (decision.kind === "replay") {
          dependencies.logger.log("info", "http.idempotency_replayed", {
            status: decision.response.status,
          });
          replay(response, decision.response);
          return;
        }
        const held = decision.held;
        if (held === null) {
          next();
          return;
        }
        settleWhenFinished(response, dependencies, held);
        next();
      })
      .catch((error: unknown) => {
        // The gate itself threw. It is not a domain refusal and must not be
        // dressed as one, so it goes to the framework's error path with the
        // request UNSERVED — a gate that swallowed its own fault would let the
        // handler run unguarded, which is the duplicate side effect again.
        next(error);
      });
  };
}

function settleWhenFinished(
  response: GatedResponse,
  dependencies: GateDependencies,
  held: RequestFingerprint,
): void {
  const capture = captureBody(response);
  const store = dependencies.store;
  if (store === null) return;
  let settled = false;
  response.on("finish", () => {
    // `finish` and `close` both fire in practice, sometimes both for one
    // response, exactly as `runtime/lifecycle.ts` documents for the in-flight
    // register. Settling twice would overwrite a record with itself, which is
    // harmless, and releasing after recording would not be — so this latches.
    if (settled) return;
    settled = true;
    const bytes = capture.overflowed ? MAX_REPLAYABLE_BODY_BYTES + 1 : capture.bytes;
    const action = settlementFor(response.statusCode, bytes);
    const contentTypeHeader = response.getHeader("content-type");
    const promise =
      action === "release"
        ? store.release(held)
        : store.record(
            held,
            {
              status: response.statusCode,
              body: capture.chunks.join(""),
              contentType: typeof contentTypeHeader === "string" ? contentTypeHeader : null,
            },
            REQUEST_IDEMPOTENCY_TTL_SECONDS,
          );
    void promise
      .then((outcome) => {
        if (outcome.kind === "settled") return;
        dependencies.logger.log("warn", "http.idempotency_unsettled", {
          action,
          outcome: outcome.kind,
        });
      })
      .catch((error: unknown) => {
        dependencies.logger.log("error", "http.idempotency_settle_failed", {
          action,
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  });
}
