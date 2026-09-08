// THE FOUR REFUSALS THE ENVELOPE ITSELF OWNS.
//
// `http/idempotency-errors.ts` opened this seam and states the rule: "the
// request envelope's own failures belong to the edge that owns the envelope. No
// context mints one of these, because no context knows a header exists." These
// four are the rest of that set — the failures that happen when there is no use
// case to fail, so no bounded context can have an opinion:
//
//   ROUTE_NOT_FOUND   nothing matched the path. There is no context to ask.
//   REQUEST_INVALID   the request could not be parsed into what a handler takes.
//                     Carries `fields[]`, which is the whole reason M0.4 §2 put
//                     `fields` in the envelope.
//   UNHANDLED_FAULT   something threw that is not a domain outcome. A DEFECT,
//                     reported as one, with the detail kept off the wire.
//   SHUTTING_DOWN     admission closed under this request. M2.5's in-flight
//                     register decided it; this is the same event with a
//                     canonical code on it.
//
// EVERY ONE OF THEM IS IN `docs/error-taxonomy.json` AND JOINED BY E1/E4. They
// are not a private vocabulary the transport invented and kept to itself: a code
// minted here without a taxonomy entry fails `audit:error-taxonomy` E1, and a
// status here that `error-status.ts` would not resolve fails E4.
//
// NOT ONE OF THEM ECHOES ATTACKER-CONTROLLED TEXT. `message` is rendered into
// logs and onto the wire, and `details` is rendered into logs. A 404 that quoted
// the path it did not match would hand any caller a log-forging primitive
// through the one handler that answers every unrouted request in the process —
// `runtime/correlation.ts` refuses an inbound request id for exactly this
// reason, and it would be a strange gate that validated the header and then
// printed the URL. The method is safe (a closed set the framework parsed); the
// path is not, and is therefore absent.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

/**
 * Nothing matched.
 *
 * `not_found` rather than `invalid_input`: the caller's request was
 * well-formed and named something that does not exist, which is the same answer
 * a context gives for an id it cannot find, and a client's retry logic branches
 * on the category before it branches on the code.
 */
export function routeNotFound(method: string): DomainError {
  return domainError("TRANSPORT_ROUTE_NOT_FOUND", "not_found", "No route matched this request.", {
    fields: [
      {
        field: "path",
        code: "unmatched",
        // The METHOD, never the path. See the banner.
        message: `No ${method} route is served at the requested path.`,
      },
    ],
  });
}

/**
 * The request did not parse.
 *
 * ONE CODE AND MANY FIELDS, which is M0.4 §2's design rather than a shortcut.
 * The envelope carries `fields[]` precisely so that "what was wrong" is
 * structured data a client can render beside the offending input, and minting a
 * code per field would put that structure in the one part of the envelope the
 * ADR freezes as immutable — a new required field would then be a new error code
 * and therefore a breaking change.
 */
export function requestInvalid(fields: readonly FieldViolation[]): DomainError {
  return domainError(
    "TRANSPORT_REQUEST_INVALID",
    "invalid_input",
    "This request could not be read as the operation expects.",
    { fields },
  );
}

/**
 * A defect, reported as a defect.
 *
 * `internal` is the honest category: the transport does not know what happened,
 * and dressing an unknown throw as a domain refusal would tell a caller that
 * retrying will not help when nobody knows whether it will.
 *
 * WHAT THE CALLER IS TOLD IS DELIBERATELY THIN. The thrown value's message can
 * carry a connection string, a row, or another tenant's data — `details` is
 * documented by the kernel as "never returned to a client" and the exception's
 * own text has no such promise attached to it. The filter logs the real thing
 * against this failure's `errorId`; the caller gets the id and nothing else.
 */
export function unhandledFault(): DomainError {
  return domainError(
    "TRANSPORT_UNHANDLED_FAULT",
    "internal",
    "This request failed for a reason the service did not expect. Quote the error id.",
  );
}

/**
 * Admission closed under this request.
 *
 * `retryAfterSeconds` is populated because the kernel populates it "only for
 * `rate_limited` and `unavailable`" and this is the second of those, and it is
 * ONE second because the request is being refused by a process that is going
 * away — the caller's next request should reach a different instance almost
 * immediately, and a long hint would turn a rolling restart into a stall.
 */
export function shuttingDown(): DomainError {
  return domainError(
    "TRANSPORT_SHUTTING_DOWN",
    "unavailable",
    "This instance is shutting down and refused the request rather than dropping it.",
    { retryAfterSeconds: 1 },
  );
}
