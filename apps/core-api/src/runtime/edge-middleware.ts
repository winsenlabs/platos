// THE FIRST THING EVERY REQUEST TOUCHES.
//
// It was an anonymous callback inside `startCoreApi`. It is a named function
// here for two reasons, and neither is tidiness. The first is that a suite that
// wants the REAL edge — correlation decided the way production decides it,
// admission closed the way production closes it — could otherwise only get it by
// starting the whole process, which is why `rest-chassis.test.ts` can mount a
// probe controller behind the same middleware chain instead of re-implementing
// it and then proving something about the copy. The second is that the refusal
// it writes is now an M0.4 §2 envelope, and an envelope is not something to
// assemble inline.
//
// TWO THINGS HAPPEN HERE AND THE ORDER IS LOAD-BEARING. Correlation is decided
// and stamped BEFORE the in-flight register is touched, so the register's own
// log lines — and everything the request goes on to do — already carry the
// identifier. A request refused by admission still gets an id, still gets it on
// the response header, and still puts it in `traceRef`: an operator asked to
// explain a 503 needs the same handle for the refused request as for the served
// one.
//
// THE REFUSAL CHANGED SHAPE AT WIN-267 (M4.1), AND THE OLD SHAPE WAS THE POINT
// OF THE CHANGE. It used to be `{ error: { code: "core-api.shutdown.work_refused" } }`
// — a bare object with a dotted lower-case string where M0.4 §2 fixes a
// SCREAMING_SNAKE code, no `errorId`, no `traceRef`, no `version`. It was the
// SECOND non-envelope REST error path in the process, beside the framework's own
// 404, and "REST errors map consistently" (WIN-260 (c)) cannot be true while a
// shutdown answers in a private shape. `WORK_REFUSED_SHUTTING_DOWN` survives as
// what it always was underneath — the register's internal reason, counted and
// logged — and `TRANSPORT_SHUTTING_DOWN` is the canonical code on the wire.

import { resolveCorrelation, withCorrelation } from "./correlation.js";
import type { InFlightRegister } from "./in-flight.js";
import { mintErrorId, writeFailure, type FailureResponse } from "../http/failure.js";
import { CONTRACT_BUILD_ID, CONTRACT_VERSION_HEADER } from "../transports/rest/envelope.js";
import { shuttingDown } from "../transports/rest/transport-errors.js";

/** Only the parts of an inbound request this middleware reads. */
export interface EdgeRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly url?: string;
}

/** Only the parts of an outbound response this middleware touches. */
export interface EdgeResponse extends FailureResponse {
  on(event: string, listener: () => void): unknown;
}

export interface EdgeMiddlewareDependencies {
  /** The header the correlation identifier is adopted from and stamped onto. */
  readonly requestIdHeader: string;
  readonly inFlight: InFlightRegister;
}

export type EdgeMiddleware = (
  request: EdgeRequest,
  response: EdgeResponse,
  next: () => void,
) => void;

export function createEdgeMiddleware(dependencies: EdgeMiddlewareDependencies): EdgeMiddleware {
  const { requestIdHeader, inFlight } = dependencies;
  return function edgeMiddleware(request, response, next): void {
    const correlation = resolveCorrelation(request.headers[requestIdHeader]);
    response.setHeader(requestIdHeader, correlation.requestId);
    // THE BUILD STAMP, ON EVERY RESPONSE, BEFORE ANYTHING IS ROUTED. M0.4 §2
    // emits it "in the REST response header `X-Platos-Contract-Version`", and
    // stamping it here rather than per route is what makes that true of the 404,
    // the refusal below and the 500 as well as of the handlers — the responses a
    // client is most likely to be holding when it needs to know which build
    // answered. See `transports/rest/envelope.ts` for why `X-Total-Count` is the
    // opposite case and stays a route's business.
    response.setHeader(CONTRACT_VERSION_HEADER, CONTRACT_BUILD_ID);
    withCorrelation(correlation, () => {
      const registration = inFlight.begin(`${request.method ?? "?"} ${request.url ?? "?"}`);
      if (!registration.admitted) {
        // REFUSED, NOT DROPPED. Admission closed while this connection was still
        // open — a keep-alive socket an upstream proxy holds for minutes can
        // deliver a request after the drain has counted zero, and a few lines
        // later shutdown destroys every remaining socket. Without this the
        // client sees a reset in the middle of a write it cannot safely repeat.
        // A 503 carrying `Retry-After` is the same event told truthfully, and it
        // is retriable.
        //
        // `Connection: close` is set here rather than being derivable from the
        // envelope: `Retry-After` tells the CLIENT when to come back, and this
        // tells the connection not to be reused when they do.
        response.setHeader("Connection", "close");
        writeFailure(response, shuttingDown(), {
          errorId: mintErrorId(),
          requestId: correlation.requestId,
        });
        return;
      }
      // Both events fire in practice — `finish` on a normal response, `close` on
      // an aborted one, and sometimes both. `settle` is idempotent for exactly
      // this reason; see in-flight.ts.
      response.on("finish", registration.settle);
      response.on("close", registration.settle);
      next();
    });
  };
}
