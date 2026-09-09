// WHERE `/api/v1` IS DECIDED FOR THIS DEPLOYABLE, AND THE ONE PLACE THE DIGIT
// IS WRITTEN.
//
// ADR M0.4 §1.1: "a version is a property of the CONTRACT, not of the code
// path", and §2's REST row fixes the mechanism — the major is a URL segment
// produced by Nest's own versioning, never a string a controller spells. The
// no-bare-prefix lint in `scripts/arch/contract-map.mjs` refuses any routing
// decorator carrying an `api/v1` literal, so a controller in this tree CANNOT
// name the prefix even if it wanted to. It declares a path and a version, and
// this file decides what those become on the wire.
//
// -----------------------------------------------------------------------------
// WHY THIS IS NOT `setGlobalPrefix("api") + enableVersioning({ prefix: "v" })`
//
// That is the spelling `apps/agent/src/http/api-surface.ts` uses and the one the
// ADR names, and this file reaches the SAME URL by folding the two segments into
// one version prefix. The difference is not taste. It is that core-api serves
// two routes the agent does not, and `setGlobalPrefix`'s `exclude` list cannot
// express them:
//
//   `NotFoundController` answers `@All("{*path}")` at the application ROOT, so
//   that every unrouted request in the process gets the M0.4 §2 failure envelope
//   instead of Express's HTML page. Under a global prefix it would move to
//   `/api/{*path}` and `/does-not-exist` would stop being answered.
//
//   Excluding it does not work either, and the reason is mechanical rather than
//   arguable. `RoutePathFactory.isExcludedFromGlobalPrefix` TRUNCATES the version
//   segment before testing the exclusion, so a business route is offered to the
//   exclusion list as `/identity/session` — and `{*path}` matches that. One
//   exclusion entry wide enough to cover the terminal handler is wide enough to
//   strip the prefix off every route the prefix exists for.
//
// THAT CLAIM IS MEASURED, NOT ASSERTED. `api-surface.test.ts` builds a real Nest
// application with `setGlobalPrefix("api", { exclude: ["/{*path}"] })` and a
// versioned probe route, and reads back where the probe actually mounted. If a
// future Nest changes that behaviour the case fails and this comment is wrong in
// public rather than quietly.
//
// AND THE URL IS JOINED TO THE MANIFEST, WHICH IS THE ASSERTION THAT MATTERS.
// `apps/agent/scripts/generate-control-plane.mjs` computes every core-api route's
// path from the AGENT's surface constants — global prefix `api`, version prefix
// `v`, version `1` — and writes it into `operation-manifest.generated.json`.
// `route-manifest.test.ts` reconstructs the template each controller in this tree
// ACTUALLY mounts, from the decorators' own metadata, and joins it to that
// manifest. So the two spellings are not trusted to agree: a divergence in either
// direction is a red test, and a controller one segment off 404s in a test rather
// than in production.

import { VersioningType, type INestApplication } from "@nestjs/common";

/**
 * The API root segment. Written once, and equal to `API_GLOBAL_PREFIX` in
 * `apps/agent/src/http/api-surface.ts` — the constant the manifest generator
 * reads. The join above is what keeps them equal.
 */
export const API_GLOBAL_PREFIX = "api";

/** Nest's URI-versioning segment prefix; `v` is Nest's own default. */
export const API_VERSION_SEGMENT_PREFIX = "v";

/**
 * The REST major.
 *
 * THE ONLY PLACE THIS DIGIT IS A ROUTE DECISION in `apps/core-api`. Every
 * controller passes this constant to `@Controller({ version })`; none of them
 * writes "1".
 */
export const API_VERSION = "1";

/**
 * What Nest is handed as its URI version prefix: the API root plus the version
 * letter, so the segment it emits is `api/v1` in one piece.
 *
 * It is COMPOSED from the two constants above rather than written out, because a
 * hand-written `"api/v"` would be a third spelling of a decision that already has
 * two, and the whole point of this file is that there is one.
 */
export const API_URI_VERSION_PREFIX = `${API_GLOBAL_PREFIX}/${API_VERSION_SEGMENT_PREFIX}`;

/** The canonical prefix every V1 business route sits under, for tests and docs. */
export const API_VERSION_PREFIX = `/${API_URI_VERSION_PREFIX}${API_VERSION}`;

/**
 * Install the surface on an application.
 *
 * `defaultVersion` is set rather than left undefined so that a controller which
 * declares no version is mounted where the MANIFEST GENERATOR already assumes it
 * is: `controllerDeclaredVersion(...) ?? apiSurface().version` in
 * `generate-control-plane.mjs` reads an undeclared controller as v1. Leaving the
 * default off would mount such a controller unversioned while the manifest said
 * otherwise — the exact drift the join test exists to catch, made possible by an
 * omission here.
 *
 * The process edge opts out with `VERSION_NEUTRAL`: `/livez`, `/healthz`,
 * `/readyz` and the terminal 404 describe the PROCESS, and ADR M0.4 §2 keeps
 * them off the versioned surface because a liveness probe that moved when the
 * API's major moved would fail a fleet on a routine release.
 */
export function applyApiSurface(app: INestApplication): void {
  app.enableVersioning({
    type: VersioningType.URI,
    prefix: API_URI_VERSION_PREFIX,
    defaultVersion: API_VERSION,
  });
}
