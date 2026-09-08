// THE FILTER THAT MAKES THE TAXONOMY REACHABLE. WIN-260 (c).
//
// M2.5 built the whole failure machine and wired none of it to a socket.
// `docs/error-taxonomy.json` holds 419 canonical codes; `transports/error-status.ts`
// resolves a status for every one of them; `http/failure.ts` writes M0.4 §2's
// envelope. And until this file existed there was NO `useGlobalFilters`, no
// `ExceptionFilter` and no `@Catch` anywhere in the tree, so `writeFailure` had
// exactly one production caller — `idempotency-middleware.ts:154` — and the only
// codes a REST caller could ever be shown were the seven that middleware mints.
// SEVEN OF 419. The other 412 were a table joined to a source tree, proven by a
// unit suite, and unreachable over HTTP by construction.
//
// That is why WIN-260 (c) — "REST/MCP/stream/workflow errors map consistently" —
// has been open since M2.5. Nothing served the table. This class is what serves
// it: every refusal any of the seventeen contexts can express now leaves through
// the same envelope, at the status the committed taxonomy records, and
// `rest-chassis.test.ts` proves it by throwing EVERY code in that file at a real
// socket and reading every answer back.
//
// FOUR ARMS, AND THE THIRD IS THE ONE PEOPLE GET WRONG.
//
//  1. The exception carries a `DomainError` -> the envelope, at the taxonomy's
//     status. This is the arm the closure rests on.
//  2. The response has already begun -> nothing. A filter cannot un-send bytes,
//     and calling `setHeader` after `end` throws a SECOND error inside the
//     handler for the first one. Logged, because a handler that threw after
//     writing is a defect somebody must see.
//  3. The exception is an `HttpException` -> rendered EXACTLY as Nest renders
//     it, unchanged. It is tempting to force it into the envelope, and it would
//     be wrong: the only production thrower of one in this process is
//     `health.controller.ts`, whose 503 body is the readiness document a load
//     balancer parses, and M0.4 §2's envelope is the BUSINESS transport's
//     contract — `/livez`, `/healthz` and `/readyz` are deliberately outside it,
//     unversioned and unprefixed, for the reason that controller states. The
//     rule this implies for every future REST handler is the one this chassis
//     exists to make easy: a handler REFUSES by raising a `DomainFault`, never
//     by throwing an `HttpException`.
//  4. Anything else -> `TRANSPORT_UNHANDLED_FAULT`, 500, with the thrown value's
//     own text going to the LOG and never to the wire. A defect is not a domain
//     outcome and must not be dressed as one.
//
// IT RENDERS THE `HttpException` ITSELF RATHER THAN EXTENDING `BaseExceptionFilter`.
// Two reasons, and neither is taste. Extending it requires an `HttpAdapterHost`
// injected through the container, which is the reflection-driven wiring
// `http.module.ts` says this application does not do; and `super.catch` reaches
// for a static adapter host when it has no injected one, which is process-global
// state shared by every application a test file starts — the exact cross-wiring
// the constructor comment in `http.module.ts` exists to prevent. Fifteen lines of
// explicit rendering, matching what Nest's own handler does with a string body
// and with an object body, costs less than either.

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";

import type { DomainError, Logger } from "@platos/kernel";

import { domainErrorOf } from "../transports/rest/fault.js";
import { unhandledFault } from "../transports/rest/transport-errors.js";
import { currentCorrelation } from "../runtime/correlation.js";
import { mintErrorId, writeFailure, type FailureResponse } from "./failure.js";

/** Only what this filter touches. Structural, like every other edge type here. */
interface FilterResponse extends FailureResponse {
  readonly headersSent: boolean;
  getHeader(name: string): number | string | string[] | undefined;
}

export interface DomainExceptionFilterDependencies {
  readonly logger: Logger;
  /** The header `runtime/correlation.ts` stamped the id onto. Configurable. */
  readonly requestIdHeader: string;
}

/** A one-line, non-leaking description of a thrown value, for the log only. */
function describe(thrown: unknown): string {
  if (thrown instanceof Error) return `${thrown.name}: ${thrown.message}`;
  if (typeof thrown === "string") return thrown;
  return Object.prototype.toString.call(thrown);
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(private readonly dependencies: DomainExceptionFilterDependencies) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FilterResponse>();

    if (response.headersSent) {
      this.dependencies.logger.log("error", "http.fault_after_response", {
        detail: describe(exception),
      });
      return;
    }

    const domain = domainErrorOf(exception);
    if (domain === null && exception instanceof HttpException) {
      this.renderHttpException(exception, response);
      return;
    }

    this.renderDomainError(domain ?? unhandledFault(), domain === null ? exception : null, response);
  }

  /**
   * The correlation identifier, from the two places it can be.
   *
   * The async-local frame is asked FIRST because it is the value
   * `runtime/correlation.ts` decided and the one an adapter reads through the
   * kernel `CorrelationSource` port — so `traceRef` on the wire, the id in every
   * log line, and the id PostgreSQL records for the transaction are one string
   * rather than three that usually agree. The response header is the fallback
   * for a frame that was lost across a boundary the edge does not control.
   */
  private traceRef(response: FilterResponse): string {
    const ambient = currentCorrelation();
    if (ambient !== null) return ambient.requestId;
    const stamped = response.getHeader(this.dependencies.requestIdHeader);
    return typeof stamped === "string" ? stamped : "";
  }

  private renderDomainError(
    error: DomainError,
    fault: unknown,
    response: FilterResponse,
  ): void {
    const errorId = mintErrorId();
    const requestId = this.traceRef(response);
    const status = writeFailure(response, error, { errorId, requestId });
    this.dependencies.logger.log(status >= 500 ? "error" : "warn", "http.request_failed", {
      code: error.code,
      category: error.category,
      status,
      errorId,
      requestId,
      // `details` is the kernel's "structured, already-redacted context for logs,
      // never returned to a client", and this is the log. `toWireError` is what
      // keeps it off the response; it is not kept off the operator's screen.
      details: error.details,
      // Present only on arm 4. The thrown value's own text can carry a row, a
      // connection string or another tenant's data, so it is joined to the
      // caller's `errorId` here and nowhere else.
      ...(fault === null ? {} : { fault: describe(fault) }),
    });
  }

  /**
   * Nest's own rendering, reproduced: a string body becomes
   * `{ statusCode, message }`, an object body is written as it stands.
   */
  private renderHttpException(exception: HttpException, response: FilterResponse): void {
    const status = exception.getStatus();
    const body = exception.getResponse();
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(typeof body === "string" ? { statusCode: status, message: body } : body));
  }
}
