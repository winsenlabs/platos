import type { INestApplication } from "@nestjs/common";

/**
 * WIN-267 (M4.1) — THE WIRE HALF OF THE ALIAS CONTRACT.
 *
 * ADR M0.4 §4.1 (WIN-249) makes three demands of every compatibility alias, and
 * before this file the tree satisfied one and a half of them:
 *
 *   1. it must be an EXPLICIT generator row classified `DEPRECATED` with a
 *      non-null replacement — satisfied: `DEPRECATED_RULES` in
 *      `apps/agent/scripts/generate-control-plane.mjs` has carried
 *      `legacy-platos-memory-prefix` since WIN-129;
 *   2. it must DELEGATE 1:1 to the canonical handler, no independent
 *      implementation — satisfied STRUCTURALLY rather than by a test, see below;
 *   3. it must CARRY THE DEPRECATION SIGNAL ON THE WIRE — and nothing in the
 *      repository emitted `Deprecation` or `Sunset` on any response. A grep for
 *      either header name over `apps`, `packages` and `scripts` returned
 *      nothing, so an old client had no way to discover that the path it calls
 *      is scheduled to stop existing. That is what this file fixes.
 *
 * WHY THE SIGNAL IS EMITTED HERE AND NOT IN `apps/core-api`. The V1 lane would
 * be the tidier home, but there is no alias in it: the eleven core-api routes
 * are all canonical, and inventing one so that a V1 interceptor had something to
 * stamp would be building a thing in order to have built it. The fifteen aliases
 * that actually exist are served by `apps/agent`, so the wire signal is emitted
 * by `apps/agent`. The alias is where the old client is.
 *
 * WHY §4.1's FAN-IN IS NOT A TEST HERE, WHICH IS A FINDING AND NOT AN OMISSION.
 * The ADR asks for "a test asserting `aliasHandler === canonicalHandler`". In
 * this tree both paths come from ONE decorator —
 * `@Controller({ path: ["memory", "platos/memory"] })` in
 * `apps/agent/src/memory/memory.controller.ts` — so the two handlers are the
 * same function object BY CONSTRUCTION and no observation can separate them. An
 * assertion that cannot fail is worth less than the fact written down, so the
 * fan-in is instead enforced where a FUTURE alias could break it:
 * `scripts/arch/contract-map.mjs` joins every `DEPRECATED` operation in the
 * generated manifest to the canonical operation its replacement names and
 * refuses a pair whose implementation sets differ. That check fails on an alias
 * implemented as a second controller, which is the case the ADR is guarding.
 *
 * WHAT IS DECLARED HERE IS THE ONE DECLARATION. The generator AST-reads
 * `DEPRECATED_ROUTE_PREFIXES` out of this file — the same way it reads the
 * version out of `api-surface.ts` — and derives the manifest's per-operation
 * `replacement`, its `deprecation` block and the OpenAPI `x-platos-superseded-by`
 * / `x-platos-sunset` extensions from it. So the sunset date a client is told on
 * the wire and the sunset date the published catalogue advertises are the same
 * string, not two strings that have to be kept equal.
 */

/**
 * ADR M0.4 §4.3: "REST route/field: `Sunset` >= 90 days AND removal only in
 * `/api/v2`. An operation cannot vanish inside v1." The floor is written once
 * here and enforced by the generator against every row below.
 */
export const DEPRECATION_MINIMUM_WINDOW_DAYS = 90;

/**
 * The complete set of response headers this module is allowed to add.
 *
 * Declared once and READ BY THE SUITE, which asserts that an alias response
 * differs from its canonical twin in exactly these three names and no others.
 * Written as a literal in both places it would be two spellings of one closed
 * set, and a fourth header could then be added here and go unobserved -- which is
 * the whole failure mode a "preserves old clients" claim has to exclude.
 */
export const DEPRECATION_HEADERS = Object.freeze([
  "Deprecation",
  "Sunset",
  "Link",
] as const);

export type DeprecatedRoutePrefix = {
  /**
   * The generator's own policy-rule id. Equality with the manifest's
   * `policyRule` is what joins this table to the classification, and
   * `scripts/arch/contract-map.mjs` refuses a row that names no rule.
   */
  readonly id: string;
  /** The alias prefix as it appears ON THE WIRE, version segment included. */
  readonly aliasPrefix: string;
  /** The canonical prefix the alias forwards to, on the same terms. */
  readonly canonicalPrefix: string;
  /**
   * When the signal below started being served. NOT when the alias was first
   * classified `DEPRECATED` — that was WIN-129 — because until this file existed
   * no consumer could discover the classification, and a window a client cannot
   * read is not a window.
   */
  readonly announcedOn: string;
  /** RFC 8594 sunset: the date after which the alias may stop answering. */
  readonly sunsetOn: string;
};

/**
 * Every compatibility alias on the V1 REST surface.
 *
 * ONE ROW, and that is the measured truth rather than a starting point: the
 * generated manifest classifies exactly 15 operations `DEPRECATED`, all fifteen
 * under `/api/v1/platos/memory`, and `contract-map.mjs` fails if a sixteenth
 * appears without a row here — or if a row here matches no operation.
 */
export const DEPRECATED_ROUTE_PREFIXES = Object.freeze([
  Object.freeze({
    id: "legacy-platos-memory-prefix",
    aliasPrefix: "/api/v1/platos/memory",
    canonicalPrefix: "/api/v1/memory",
    announcedOn: "2026-09-10",
    sunsetOn: "2027-03-31",
  }),
] as const);

/**
 * Whether `pathname` is under `prefix` as a PATH, not as a string.
 *
 * `startsWith` alone is the defect this exists to avoid: it makes
 * `/api/v1/platos/memoryboard` a deprecated route and stamps a sunset date on a
 * path that has nothing to do with the alias. A match is the prefix exactly, or
 * the prefix followed by a separator.
 */
export function isUnderPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The alias row covering `pathname`, or null when the path is canonical. */
export function matchDeprecatedRoutePrefix(pathname: string): DeprecatedRoutePrefix | null {
  for (const prefix of DEPRECATED_ROUTE_PREFIXES) {
    if (isUnderPathPrefix(pathname, prefix.aliasPrefix)) return prefix;
  }
  return null;
}

/**
 * The canonical path an alias request should move to, computed by swapping the
 * prefix and keeping everything after it.
 *
 * This is deliberately a SECOND computation of a value the manifest also holds
 * (as each `DEPRECATED` row's `replacement`). The manifest gets its answer from
 * the TypeScript AST of the controllers; this one gets it from the two prefixes.
 * `contract-map.mjs` joins them, so a disagreement is a red gate rather than a
 * `Link` header pointing somewhere that does not exist.
 */
export function canonicalPathFor(prefix: DeprecatedRoutePrefix, pathname: string): string {
  return `${prefix.canonicalPrefix}${pathname.slice(prefix.aliasPrefix.length)}`;
}

/**
 * RFC 8594's `Sunset` carries an HTTP-date, which is IMF-fixdate. `Date`'s
 * `toUTCString` is specified to produce exactly that form
 * (`Wed, 31 Mar 2027 00:00:00 GMT`), so the format is the platform's rather than
 * a template assembled here.
 */
export function httpDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`deprecation date must be an ISO calendar date: ${isoDate}`);
  }
  return parsed.toUTCString();
}

/**
 * The headers an alias response carries, or null for a canonical path.
 *
 * `Deprecation: true` is ADR M0.4 §4.2's spelling, not RFC 9745's structured
 * date, and the ADR is what this milestone is measured against; the machine-
 * readable date is in `Sunset`, which is where RFC 8594 puts it. `Link` with
 * `rel="successor-version"` (RFC 5829) is the part that PRESERVES the old
 * client rather than merely warning it: the response says where the operation
 * moved, so a caller can follow it without consulting the catalogue.
 */
export function deprecationHeadersFor(pathname: string): Record<string, string> | null {
  const prefix = matchDeprecatedRoutePrefix(pathname);
  if (prefix === null) return null;
  return {
    Deprecation: "true",
    Sunset: httpDate(prefix.sunsetOn),
    Link: `<${canonicalPathFor(prefix, pathname)}>; rel="successor-version"`,
  };
}

/**
 * Install the signal on an application.
 *
 * Called from `applyApiSurface` so that there is ONE install site and the test
 * that reads these headers back over a real socket is exercising the same call
 * `main.ts` makes. Deleting the install would turn that test red instead of
 * quietly shipping aliases that announce nothing.
 *
 * It only ever ADDS headers: status, body and every other header are untouched,
 * which is the "aliases preserve old clients" half of the acceptance clause and
 * is asserted by comparing an alias response to its canonical twin byte for
 * byte.
 */
type InboundPath = { readonly path?: string; readonly url?: string };
type HeaderSink = { setHeader(name: string, value: string): void };

export function applyDeprecationSignal(app: INestApplication): void {
  app.use((request: InboundPath, response: HeaderSink, next: () => void) => {
    // `req.path` on an Express request is the pathname with the query string
    // already removed. The `url` fallback is for a bare `http.IncomingMessage`,
    // where it is not, hence the split -- `?after=/api/v1/platos/memory` must not
    // make a canonical request look like an alias one.
    const pathname = request.path ?? (request.url ?? "").split("?")[0];
    const headers = deprecationHeadersFor(pathname);
    if (headers === null) return next();
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    return next();
  });
}
