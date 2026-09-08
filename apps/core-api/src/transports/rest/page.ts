// READING `?limit=&cursor=` INTO A PAGE REQUEST, OR REFUSING WITH `fields[]`.
//
// This is the first validator the chassis carries, and it is a real one rather
// than a demonstration: M0.4 §2 pins the collection envelope's pagination to the
// BFF's own numbers ("matches BFF `defaultPageSize:25`/`maxPageSize:100`"), and
// WIN-236's contract says outright that "malformed pagination and filter values
// now return HTTP 400 instead of being silently coerced". Silent coercion is the
// failure mode being closed: `Number("20; DROP")` is `NaN`, `Number("")` is 0,
// and a transport that fell back to a default on either would serve a page the
// caller did not ask for and never say so.
//
// EVERY VIOLATION IS REPORTED, NOT THE FIRST. `config/load.ts` "reports every
// bad variable in one run" for the same reason: a caller fixing one field at a
// time round-trips once per mistake, and the envelope has a `fields[]` array
// rather than a `field` precisely so it does not have to.
//
// THE FIELD PATHS ARE `query.limit` AND `query.cursor`. The kernel calls
// `FieldViolation.field` "a dotted path into the input", and for a REST request
// the input has parts — query, headers, body — that a client renders in
// different places. `limit` alone would be ambiguous the first time a body
// carries one too.

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";

import { decodeCursor } from "./envelope.js";
import { requestInvalid } from "./transport-errors.js";

/** M0.4 §2, from the BFF. Named so the two numbers appear once each. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  /** The opaque cursor the caller sent, or null for the first page. */
  readonly cursor: string | null;
  readonly limit: number;
}

/** What Express hands a `@Query()` parameter: absent, one value, or repeated. */
export type QueryValue = string | readonly string[] | undefined;
export type QueryInput = Readonly<Record<string, unknown>>;

function violation(field: string, code: string, message: string): FieldViolation {
  return { field, code, message };
}

/**
 * A repeated parameter is refused rather than resolved.
 *
 * `?limit=10&limit=100` is two instructions, and every rule for picking one —
 * first, last, smallest — is a rule the caller did not agree to. It is also the
 * exact shape `runtime/correlation.ts` refuses an inbound request id for: "two
 * upstream opinions about the identity of one request is itself untrustworthy".
 */
function single(
  value: unknown,
  field: string,
  violations: FieldViolation[],
): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    violations.push(
      violation(field, "repeated", "Send this parameter once; it was sent more than once."),
    );
    return null;
  }
  if (typeof value !== "string") {
    violations.push(violation(field, "malformed", "This parameter must be a single value."));
    return null;
  }
  return value;
}

/** `"25"` -> 25, and nothing else. Not `" 25 "`, not `"25.0"`, not `"2e1"`. */
const INTEGER = /^(?:0|[1-9][0-9]{0,4})$/u;

function readLimit(raw: string, violations: FieldViolation[]): number | null {
  if (!INTEGER.test(raw)) {
    violations.push(
      violation("query.limit", "not_an_integer", "limit must be a whole number of rows."),
    );
    return null;
  }
  const limit = Number(raw);
  if (limit < 1) {
    violations.push(violation("query.limit", "below_minimum", "limit must be at least 1."));
    return null;
  }
  if (limit > MAX_PAGE_SIZE) {
    violations.push(
      violation(
        "query.limit",
        "above_maximum",
        `limit must be at most ${String(MAX_PAGE_SIZE)} rows.`,
      ),
    );
    return null;
  }
  return limit;
}

/**
 * The page request, or `TRANSPORT_REQUEST_INVALID` carrying every violation.
 *
 * A `Result` rather than a throw, so the rule is exercisable without a server
 * and so the SAME function serves the pipe and any caller that has a query
 * object already. `http/validation.pipe.ts` is the thing that turns the `err`
 * into an exception the framework can route, and it is the only thing that does.
 */
export function parsePageQuery(query: QueryInput): Result<PageRequest> {
  const violations: FieldViolation[] = [];

  const rawLimit = single(query["limit"], "query.limit", violations);
  const rawCursor = single(query["cursor"], "query.cursor", violations);

  const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : rawLimit === null ? null : readLimit(rawLimit, violations);

  let cursor: string | null = null;
  if (typeof rawCursor === "string") {
    if (rawCursor === "" || decodeCursor(rawCursor) === null) {
      violations.push(
        violation(
          "query.cursor",
          "malformed",
          "cursor is opaque: send back a nextCursor this service issued.",
        ),
      );
    } else {
      cursor = rawCursor;
    }
  }

  if (violations.length > 0 || limit === null) return err(requestInvalid(violations));
  return ok({ cursor, limit });
}
