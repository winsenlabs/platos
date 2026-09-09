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
 * `"{*path}"` is Express 5 / path-to-regexp 8 for "any remaining segments,
 * including none". `"*"` was the Express 4 spelling and is a hard error under
 * the version `@nestjs/platform-express@11` actually resolves.
 */
/**
 * `VERSION_NEUTRAL` (WIN-267 R1). The terminal handler answers EVERY unrouted
 * request in the process, including one addressed at no version at all, so it
 * cannot sit under a version segment. Under `applyApiSurface`'s `defaultVersion`
 * it would have moved to `/api/v1/{*path}` and `/does-not-exist` would have got
 * Express's HTML page instead of the M0.4 §2 envelope.
 */
@Controller({ version: VERSION_NEUTRAL })
export class NotFoundController {
  @All("{*path}")
  unmatched(@Req() request: InboundRequest): never {
    raise(routeNotFound(request.method ?? "this"));
  }
}
