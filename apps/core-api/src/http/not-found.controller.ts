// THE TERMINAL HANDLER: no route matched, and the caller is told so in the
// envelope like every other refusal.
//
// WHY A CONTROLLER AND NOT A BRANCH IN THE FILTER. The alternative was to catch
// the framework's own `NotFoundException` and recognise it — by class, or worse
// by sniffing its `Cannot GET /x` message. Both are guesses about a framework
// internal, and a guess that stops being true on a minor upgrade turns every
// mistyped path into a body no client can parse. A route registered LAST is not
// a guess: Express matches in registration order, so reaching this handler IS
// the definition of "nothing else matched", expressed in the same mechanism
// every other route uses. `http.module.ts` names it last in `controllers` and a
// case in `rest-chassis.test.ts` pins that the real routes still win.
//
// IT ANSWERS EVERY METHOD. `@All` rather than a list, because a 404 for `GET`
// and a Nest-shaped 404 for `PROPFIND` would be two contracts, and the second
// one is the one nobody tests.
//
// IT DOES NOT ECHO THE PATH. See the banner in `transports/rest/transport-errors.ts`:
// this is the one handler in the process that answers ANY string a caller can
// put in a URL, so it is the one handler where quoting the input hands over a
// log-forging primitive. The method is a closed set the framework parsed; the
// path is not, and does not appear.

import { All, Controller, Req, VERSION_NEUTRAL } from "@nestjs/common";

import { raise } from "../transports/rest/fault.js";
import { routeNotFound } from "../transports/rest/transport-errors.js";

/** Only the field this controller reads. */
interface InboundRequest {
  readonly method?: string;
}

/**
 * The path this controller answers, written ONCE.
 *
 * The decorator below is written from it and `runtime/lifecycle.ts` excludes it
 * from the global prefix by the same constant, so the route and the exclusion
 * cannot drift into a state where the terminal handler is mounted under `/api`
 * and half the process's paths answer with Nest's own 404 body instead of the
 * envelope.
 */
export const NOT_FOUND_ROUTE = "{*path}";

/**
 * `"{*path}"` is Express 5 / path-to-regexp 8 for "any remaining segments,
 * including none". `"*"` was the Express 4 spelling and is a hard error under
 * the version `@nestjs/platform-express@11` actually resolves.
 */
// WIN-267 T4 — `VERSION_NEUTRAL`, AND IT IS LOAD-BEARING RATHER THAN TIDY.
//
// `runtime/lifecycle.ts` installs URI versioning with the prefix `api/v`, so a
// controller that says nothing answers at `/api/v1/...`. This one would then be
// terminal for `/api/v1/{*path}` and NOTHING ELSE: `GET /nope` would reach
// Nest's own 404 and the caller would get a body the envelope contract does not
// describe. "Nothing matched" has to be ONE contract for every path this process
// can be sent, which is exactly what version-neutral, prefix-free mounting is.
//
// It still comes LAST in `http.module.ts`'s `controllers`, so a real route wins
// the match; being mounted at the root does not change the order Express tries
// them in. It is spelled on `@Controller` and not as `@Version(...)` above the
// class because `@Version` is a METHOD decorator: applied to a class it is
// handed one argument where it expects three, which is a compile error and not
// a silently version-ed route. `rest-chassis.test.ts` pins a path outside the prefix still reaching
// the envelope, which is the case that fails if this decorator is dropped.
@Controller({ version: VERSION_NEUTRAL })
export class NotFoundController {
  @All(NOT_FOUND_ROUTE)
  unmatched(@Req() request: InboundRequest): never {
    raise(routeNotFound(request.method ?? "this"));
  }
}
