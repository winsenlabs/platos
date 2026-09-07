import { VersioningType, type INestApplication } from "@nestjs/common";

/**
 * WIN-267 (M4.1) T1 — the ONE expression of the REST version.
 *
 * ADR M0.4 §1.2 / §2 (WIN-249): "A version is a property of the CONTRACT, not
 * of the code path… REST major = URL segment via Nest `@Version`, not a
 * per-controller literal." Before this file the version was a per-controller
 * literal: 24 `api/v1` strings on 23 source lines across 20 controller files,
 * identical on the frozen `origin/main` oracle and on `v1`, so the shape was
 * the real one and not drift. `scripts/arch/contract-map.mjs` measures that
 * number from the tree and `api-surface.test.ts` pins it at ZERO — the
 * "no-bare-prefix lint (fail on any literal `api/v1`)" the ADR's REST row asks
 * for.
 *
 * WHAT IS DECLARED HERE, AND WHY IT IS ALL DECLARED HERE. The wire prefix
 * `/api/v1` is composed by Nest out of three independent parts, and every one
 * of them is a version decision:
 *
 *   `/api`  ← `API_GLOBAL_PREFIX`, applied by `setGlobalPrefix`
 *   `/v1`   ← `API_VERSION_PREFIX` + `API_VERSION`, inserted by URI versioning
 *   rest    ← the controller's own path, which no longer spells either
 *
 * Split across 20 files those three parts could privately disagree; here they
 * cannot, because there is one string of each and `applyApiSurface` is the only
 * caller that assembles them.
 *
 * WHAT IS DELIBERATELY *NOT* MOVED HERE. `auth/scope.guard.ts` and the
 * `UNAUTH_BODY_CAPS` table in `main.ts` compare an INBOUND REQUEST PATHNAME
 * against `/api/v1/...` string constants. Those are wire facts, not route
 * declarations: the whole claim of this change is that the wire paths do not
 * move, so a guard that keeps matching the literal it always matched is the
 * independent witness that they did not. Rewriting them to derive from
 * `API_VERSION` would make the guard agree with the router BY CONSTRUCTION and
 * destroy exactly the falsifiability this milestone is being judged on.
 */

/** The global prefix, applied by `setGlobalPrefix` to every non-excluded route. */
export const API_GLOBAL_PREFIX = "api";

/** Nest's URI-versioning segment prefix. `v` is Nest's default; named so the
 *  generator and the runtime read the same character. */
export const API_VERSION_PREFIX = "v";

/** The REST major. The ONLY place this digit is written as a route decision. */
export const API_VERSION = "1";

/**
 * The wire prefix the 24 literals used to spell by hand, assembled from its
 * parts rather than written out. Nothing in a routing decorator may contain it.
 */
export const API_V1_PREFIX = `/${API_GLOBAL_PREFIX}/${API_VERSION_PREFIX}${API_VERSION}`;

/**
 * Root path segments that are NOT part of the versioned REST contract and must
 * therefore keep their bare, unprefixed, unversioned URLs.
 *
 * Each of these is a surface whose URL is fixed by something outside this repo,
 * which is why none of them may be swept under `/api/v1`:
 *
 *   `.well-known` — RFC 8414 / RFC 9728 discovery; the path IS the standard.
 *   `internal`    — HMAC-signed callbacks; ADR M0.4 §2 "Workflow" row pins
 *                   `/internal/*` and freezes the contract across majors.
 *   `mcp`         — ADR M0.4 §2 "MCP" row: "Paths stay unversioned"; the major
 *                   travels in `serverInfo.version`, never in the URL.
 *   `metrics`     — the Prometheus scrape path, configured in the scraper.
 *   `oauth`       — RFC 6749/7591/7009 endpoints advertised in the metadata
 *                   document; moving them breaks issued client registrations.
 *   `openapi`     — the human-facing document alias (the versioned machine
 *                   document lives at `/api/v1/agent/openapi.json`).
 *   `test`        — PLATOS_TEST_MODE-only, never mounted in production.
 *
 * `api/health` is NOT here: the process health probe keeps its `/api/health`
 * URL by taking the global prefix like everything else and declaring only
 * `health`, which is the same simplification this change makes everywhere.
 */
export const UNVERSIONED_ROOT_SEGMENTS = Object.freeze([
  ".well-known",
  "internal",
  "mcp",
  "metrics",
  "oauth",
  "openapi",
  "test",
] as const);

/**
 * `setGlobalPrefix`'s `exclude` list, DERIVED from the segment list above so the
 * two cannot drift.
 *
 * `{/*rest}` is path-to-regexp v8 optional-group syntax: `/mcp{/*rest}` matches
 * `/mcp` AND `/mcp/entity/:entityId/tokens`, which a bare `/mcp/*rest` would
 * not (it requires at least one trailing segment, and `DocsMcpController`
 * really does serve `GET /mcp`). Nest compiles these with
 * `pathToRegexp(addLeadingSlash(path)).regexp` and tests them against the
 * route path with the version prefix already truncated
 * (`RoutePathFactory.isExcludedFromGlobalPrefix`), which is why the patterns
 * are written unversioned.
 */
export const GLOBAL_PREFIX_EXCLUDE: readonly string[] = Object.freeze(
  UNVERSIONED_ROOT_SEGMENTS.map((segment) => `/${segment}{/*rest}`),
);

/**
 * Install the version expression on a Nest application.
 *
 * `main.ts` calls this, and so does the route-identity test — so the surface
 * under test is the surface that boots, not a second copy of it.
 *
 * `defaultVersion` makes v1 the FLOOR: a controller that says nothing is
 * versioned. Controllers on the unversioned roots above say
 * `@Version(VERSION_NEUTRAL)` explicitly, which is the only way to opt out and
 * is therefore visible in review.
 */
export function applyApiSurface(app: INestApplication): void {
  app.setGlobalPrefix(API_GLOBAL_PREFIX, { exclude: [...GLOBAL_PREFIX_EXCLUDE] });
  app.enableVersioning({
    type: VersioningType.URI,
    prefix: API_VERSION_PREFIX,
    defaultVersion: API_VERSION,
  });
}
