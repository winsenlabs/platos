// READING A JSON BODY INTO WHAT A USE CASE TAKES, OR REFUSING WITH `fields[]`.
//
// THE RULE THIS FILE OBEYS IS THE HARD ONE IN THIS TRANCHE: a transport may check
// SHAPE and must not check MEANING. `createProject` refuses an empty name with
// `TENANCY_INVALID_NAME` and a bad slug with `TENANCY_INVALID_SLUG`; if this file
// also rejected them it would be a second, weaker copy of a domain rule, and the
// day the domain's slug grammar changed the transport would refuse requests the
// contract would have accepted. Worse, it could go the other way: a transport
// that trimmed, lower-cased or defaulted a field would hand the contract input
// the caller never sent, and every refusal the contract makes about that field
// would then be about the transport's edit.
//
// So the whole of the rule here is: is it a JSON object, and is the field a
// string. `"  "` and `"Not A Slug"` both reach the use case, and the use case
// decides.
//
// EVERY VIOLATION IS REPORTED, NOT THE FIRST — the same choice `page.ts` makes
// and for the same reason: a client fixing one field per round trip is a client
// this envelope's `fields[]` array exists to spare.

import { err, ok, type FieldViolation, type Result } from "@platos/kernel";

import { requestInvalid } from "./transport-errors.js";

export type JsonBody = Readonly<Record<string, unknown>>;

/** A reader that accumulates violations rather than throwing on the first. */
export class BodyReader {
  private readonly violations: FieldViolation[] = [];

  constructor(private readonly body: JsonBody) {}

  /**
   * A required string field.
   *
   * Returns `""` on a violation so the caller can keep reading the rest of the
   * body and report every problem at once; the empty string never reaches a use
   * case, because `finish()` refuses whenever anything was recorded.
   */
  string(field: string): string {
    const value = this.body[field];
    if (value === undefined || value === null) {
      this.violations.push({ field: `body.${field}`, code: "required", message: `${field} is required.` });
      return "";
    }
    if (typeof value !== "string") {
      this.violations.push({ field: `body.${field}`, code: "not_a_string", message: `${field} must be a string.` });
      return "";
    }
    return value;
  }

  finish<Value>(value: Value): Result<Value> {
    if (this.violations.length > 0) return err(requestInvalid(this.violations));
    return ok(value);
  }
}

/**
 * The body as a JSON object, or a refusal.
 *
 * An ARRAY is refused explicitly. `typeof [] === "object"` and `[] !== null`, so a
 * check written the obvious way accepts `[]` and then reads every field as
 * `undefined` — which would report "name is required" for a request whose real
 * problem is that it is not an object at all.
 */
export function jsonBody(input: unknown): Result<JsonBody> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err(
      requestInvalid([
        { field: "body", code: "malformed", message: "This operation takes a JSON object." },
      ]),
    );
  }
  return ok(input as JsonBody);
}
