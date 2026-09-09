// THE PIPE M0.4 §2's `fields[]` EXISTS FOR.
//
// A `ValidationPipe` in the Nest sense usually means `class-validator` reading
// decorators off a DTO class. This one does not, and the reason is not
// preference: `class-validator` and `class-transformer` are not dependencies of
// this deployable, they carry a decorator-metadata reflection model that
// `http.module.ts` explicitly refuses ("no `@Injectable()` scanning, no
// auto-wiring and no metadata-driven resolution"), and the rule they would
// express — "this query has a limit between 1 and 100" — is already expressible
// as a function returning the kernel's own `Result`.
//
// SO A VALIDATOR IS A FUNCTION AND THE PIPE IS THE ADAPTER. `parsePageQuery` is
// a pure rule with no framework in it, exercisable in a unit test with no
// server; this class is the ten lines that turn its `err` into something the
// framework will route to `DomainExceptionFilter`. Every branch of the rule is
// therefore testable without HTTP, and the HTTP suite proves one path end to end
// rather than re-proving the rule through a socket.
//
// IT THROWS `DomainFault` AND NOT `BadRequestException`. That is the whole
// point of the chassis: a refusal that left as a `BadRequestException` would be
// rendered by arm 3 of the filter in Nest's shape — `{statusCode,message,error}`
// — and a caller would receive a 400 with no `error.code`, no `errorId`, no
// `traceRef` and no `fields[]`. The envelope is not something a handler opts
// into.

import type { PipeTransform } from "@nestjs/common";

import type { Result } from "@platos/kernel";

import { DomainFault } from "../transports/rest/fault.js";
import { parsePageQuery, refuseUnpagedQuery, type PageRequest } from "../transports/rest/page.js";
import { requestInvalid } from "../transports/rest/transport-errors.js";

/** A rule: unparsed input in, a domain refusal or a decided value out. */
export type Validator<Value> = (input: unknown) => Result<Value>;

export class DomainValidationPipe<Value> implements PipeTransform<unknown, Value> {
  constructor(private readonly validate: Validator<Value>) {}

  transform(value: unknown): Value {
    const outcome = this.validate(value);
    if (outcome.ok) return outcome.value;
    throw new DomainFault(outcome.error);
  }
}

/**
 * `?limit=&cursor=` for any collection route.
 *
 * The non-object guard is not defensive noise: Express hands `@Query()` an
 * object, and the day something hands this a string instead, refusing is the
 * only answer that does not read properties off a primitive and quietly page
 * with defaults.
 */
export const pageQueryValidator: Validator<PageRequest> = (input) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      error: requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    };
  }
  return parsePageQuery(input as Readonly<Record<string, unknown>>);
};

/**
 * ONE INSTANCE, SHARED. The pipe holds no per-request state — it is a function
 * and a `throw` — so a `new DomainValidationPipe(...)` per route decorator would
 * allocate one object per route for no difference in behaviour.
 */
export const PAGE_QUERY_PIPE = new DomainValidationPipe(pageQueryValidator);

/**
 * The query rule for a collection the contract does not page.
 *
 * Written as a validator and a pipe for the same reason `pageQueryValidator` is:
 * the RULE is exercisable with no server, and the pipe is the only thing that
 * turns its refusal into something the framework routes.
 */
export const unpagedQueryValidator: Validator<null> = (input) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      error: requestInvalid([
        { field: "query", code: "malformed", message: "The query string could not be read." },
      ]),
    };
  }
  return refuseUnpagedQuery(input as Readonly<Record<string, unknown>>);
};

export const UNPAGED_QUERY_PIPE = new DomainValidationPipe(unpagedQueryValidator);
