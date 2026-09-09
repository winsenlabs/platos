// WHERE THE MCP PATHS ARE DECIDED FOR THIS DEPLOYABLE, AND THE ONE PLACE THE
// DECISION *NOT* TO VERSION THEM IS WRITTEN.
//
// `http/api-surface.ts` is this file's sibling and its opposite number: there,
// every REST route inherits `/api/v1` from one constant and no controller may
// spell it. Here, every MCP route inherits `VERSION_NEUTRAL` from one constant
// and no controller may spell a version at all — because on this transport,
// putting one in the URL would be the mistake.
//
// -----------------------------------------------------------------------------
// WHY MCP ROUTES ARE VERSION-NEUTRAL, WHICH IS NOT THE SAME AS UNVERSIONED
//
// ADR M0.4 §2's MCP row (WIN-249, ACCEPTED): "Paths stay unversioned; optional
// `?contract=1`" — the major travels in `serverInfo.version` and in
// `_meta["platos.dev/contract"]`, negotiated inside the JSON-RPC handshake.
// `apps/agent/src/http/api-surface.ts` already lists `mcp` among its
// `UNVERSIONED_ROOT_SEGMENTS` for the same reason and cites the same row.
//
// These paths are therefore VERSIONED — thoroughly, on an axis a client can
// negotiate — and simply not versioned in the URL. A `/api/v1/mcp/...` mount
// would create a THIRD axis beside the protocol date and the contract semver,
// and a client pinning it would be pinning something no ADR gives meaning to.
//
// AND THE URL IS NOT A FREE CHOICE. `apps/core-api/src/http/idempotency-policy.ts`
// binds `POST /mcp/platform/tokens` and `POST /mcp/entity/:entityId/tokens` as
// `required` — no `Idempotency-Key`, no execution — and it binds them by
// TEMPLATE, compared as strings against the generated manifest. A route mounted
// one segment away from those templates would be a route the mint gate does not
// cover, which is the failure this tranche exists to close rather than move.
//
// -----------------------------------------------------------------------------
// WHY THE PATHS ARE COMPOSED AND NOT WRITTEN
//
// `mcp/platform` and `mcp/entity` share a root segment, and that root is the
// thing `api-surface.ts` had to be built to stop being written twenty-four
// times. Composing them from `MCP_ROOT_SEGMENT` means a controller cannot
// disagree with the policy table about where the surface lives, and
// `route-manifest.test.ts` reconstructs the mounted templates from the
// decorators' own metadata and joins them to the manifest — so a segment typed
// wrong here fails a named test rather than 404ing in production.

import { VERSION_NEUTRAL } from "@nestjs/common";

/**
 * The root every MCP path hangs off. Written once.
 *
 * Equal to the `mcp` entry in `apps/agent/src/http/api-surface.ts`'s
 * `UNVERSIONED_ROOT_SEGMENTS`, which is the other deployable's statement of the
 * same decision; the generated manifest is where the two are joined.
 */
export const MCP_ROOT_SEGMENT = "mcp";

/**
 * What every MCP controller passes to `@Controller({ version })`.
 *
 * `VERSION_NEUTRAL` AND NOT AN OMISSION. `applyApiSurface` sets
 * `defaultVersion: API_VERSION`, so a controller that declared no version would
 * be mounted at `/api/v1/mcp/...` — the third axis the banner refuses — and the
 * manifest, which reads an undeclared controller as v1, would agree with the
 * router while both were wrong. Opting out has to be explicit for the same
 * reason `HealthController` and `NotFoundController` do it explicitly.
 *
 * The type annotation is not decoration: `VERSION_NEUTRAL` is a unique symbol,
 * and an inferred `symbol` is not assignable to Nest's `VersionValue`. Without
 * it a controller reading this constant does not compile, which is a poor way to
 * discover that the constant lost its identity.
 */
export const MCP_ROUTE_VERSION: typeof VERSION_NEUTRAL = VERSION_NEUTRAL;

/** `POST /mcp/platform/tokens` and its siblings. */
export const MCP_PLATFORM_PATH = `${MCP_ROOT_SEGMENT}/platform`;

/** `POST /mcp/entity/:entityId/tokens` and its siblings. */
export const MCP_ENTITY_PATH = `${MCP_ROOT_SEGMENT}/entity`;

/**
 * The prefix a mounted MCP route must start with, for tests and for the census.
 *
 * Derived rather than typed, so a reader can see that the assertion and the
 * mount are the same decision.
 */
export const MCP_PATH_PREFIX = `/${MCP_ROOT_SEGMENT}/`;
