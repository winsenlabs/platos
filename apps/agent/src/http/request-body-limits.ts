import type { NestExpressApplication } from "@nestjs/platform-express";

/**
 * L8 — THE BODY CAP ON THE UNAUTHENTICATED BYPASS SURFACE, AND THE PARSER IT
 * MUST RUN AHEAD OF.
 *
 * WHY THIS IS ITS OWN MODULE. It was an inline `app.use` inside `bootstrap()` in
 * `main.ts`, and the only way to exercise it was to boot the whole agent. So it
 * had no test at all: `git grep` over every test file for `payload_too_large`,
 * `UNAUTH_BODY_CAPS` or `MCP_BODY_CAP_BYTES` found nothing, and the M4 census
 * recorded "auth/isolation/body-limit regression suite passes" as met on the
 * strength of a request-line fix in a different controller. Moving the table and
 * the middleware here, and having `main.ts` call `installRequestBodyLimits`, is
 * what lets `request-body-limits.test.ts` put the SAME installer in front of a
 * real Nest application on a real socket — the surface under test is the surface
 * that boots, not a copy of it.
 *
 * WHY BEFORE THE PARSER, AND WHY BEFORE AUTH. The 15mb parser limit below exists
 * solely for the authenticated catalog-ingest route (POST
 * /api/v1/agent/monitoring/cost/catalog, admin-token gated in ScopeGuard). The
 * public prefixes never need a 15mb buffer, and auth on every one of them runs
 * AFTER the body is parsed — in ScopeGuard, or inside the controller for the
 * self-authenticating MCP and OAuth transports — so without this a big body is
 * buffered before the 401: a memory-amplification DoS vector. The middleware is
 * registered BEFORE `useBodyParser`, and both are `httpAdapter.use()` calls
 * appended in order, so a refusal here fails closed before `express.json` reads a
 * byte. `installRequestBodyLimits` owns that ORDER, which is why the two calls
 * live in one function rather than on two lines of `main.ts` a reader could swap.
 *
 * WHY CONTENT-LENGTH AND NOT A SECOND PARSER. A direct `require("express")` is not
 * resolvable in the pruned production image and `useBodyParser` is app-global,
 * not per-prefix, so a per-prefix `express.json({ limit })` is not available. The
 * declared length is inspected instead, and a body-bearing request on a capped
 * prefix with NO declared length (chunked) is refused too: legitimate callers on
 * these prefixes always send a small, length-framed JSON payload, and a stream
 * whose size is unknown until it has been buffered is exactly what the cap exists
 * to refuse.
 *
 * WHY THE PREFIXES ARE LITERAL WIRE PATHS. `http/api-surface.ts` records this
 * table, with `auth/scope.guard.ts`, as the deliberate exception to "the version
 * is written once": both compare an INBOUND REQUEST PATHNAME against the path a
 * client really sends, and a guard that kept matching the literal it always
 * matched is the independent witness that the router did not move them. The
 * literals below are the ones `main.ts` carried, moved, not new.
 */

/** `/oauth` and `/api/v1/public` are tiny control-plane payloads; 256KB is generous. */
export const PUBLIC_BODY_CAP_BYTES = 256 * 1024;

/**
 * `/mcp` tool calls can legitimately carry document-sized arguments (memory
 * upsert, RAG ingest), so they get a higher-but-still-bounded cap — 7.5x below the
 * old 15mb, closing the amplification vector without 413-ing real tool calls.
 * Founder decision D21 (2026-09-15) fixes this value, and `apps/core-api` mirrors
 * it for its own MCP routes.
 */
export const DEFAULT_MCP_BODY_CAP_BYTES = 2 * 1024 * 1024;

/**
 * Channels inbound webhooks are also an UNAUTHENTICATED bypass surface (auth runs
 * in-controller: webhookSecret + provider signature). A provider event payload is
 * small; 1MB is generous.
 */
export const DEFAULT_CHANNELS_BODY_CAP_BYTES = 1 * 1024 * 1024;

/**
 * Nest's default express.json cap is 100kb, which 413s the litellm price-catalog
 * refresh (`POST /monitoring/cost/catalog` carries the full multi-MB catalog from
 * the platos.cost.refresh_model_prices task). 15mb bounds it without being
 * effectively unlimited.
 */
export const AUTHENTICATED_BODY_PARSER_LIMIT = "15mb";

/** The refusal's error string. The same token `apps/core-api` writes (D21). */
export const PAYLOAD_TOO_LARGE_ERROR = "payload_too_large";

/**
 * Methods the cap never inspects. GET, HEAD and OPTIONS carry no body a client
 * relies on (the WhatsApp `hub.challenge` handshake is a query string on a GET).
 * DELETE is skipped as it always was: every DELETE on a capped prefix is an
 * operator-authenticated management route, not a bypass route.
 */
export const BODY_CAP_SKIPPED_METHODS: readonly string[] = Object.freeze([
  "GET",
  "HEAD",
  "OPTIONS",
  "DELETE",
]);

export interface UnauthBodyCap {
  readonly prefix: string;
  readonly cap: number;
}

/** The two operator overrides, read by `main.ts` and passed in. */
export interface BodyCapEnvironment {
  readonly PLATOS_MCP_BODY_CAP_BYTES?: string;
  readonly PLATOS_CHANNELS_BODY_CAP_BYTES?: string;
}

/**
 * The per-prefix cap table.
 *
 * `Number(x) || default` is the rule `main.ts` always applied: an unset, empty,
 * zero or non-numeric override falls back to the default rather than to "no cap".
 */
export function resolveUnauthBodyCaps(environment: BodyCapEnvironment): readonly UnauthBodyCap[] {
  const mcpCap = Number(environment.PLATOS_MCP_BODY_CAP_BYTES) || DEFAULT_MCP_BODY_CAP_BYTES;
  const channelsCap =
    Number(environment.PLATOS_CHANNELS_BODY_CAP_BYTES) || DEFAULT_CHANNELS_BODY_CAP_BYTES;
  return Object.freeze([
    { prefix: "/mcp", cap: mcpCap },
    { prefix: "/oauth", cap: PUBLIC_BODY_CAP_BYTES },
    { prefix: "/api/v1/public", cap: PUBLIC_BODY_CAP_BYTES },
    // M4 gates — THE ENTRY THE ORIGINAL TABLE MISSED. `POST
    // /api/v1/entities/:entityId/session-tokens` is admitted by ScopeGuard's
    // `isPublicTokenMintRoute` exactly as `/api/v1/public/guest-token` is, and
    // authenticates IN the controller (the entity bearer) after the body is
    // parsed — so it was the one public mint still buffering up to 15mb before
    // its 401. The manifest-joined case in `request-body-limits.test.ts` found it
    // by asking every public body-bearing route for a cap rather than trusting
    // this list. It is the only operation the manifest records under this prefix,
    // and its body is a scope triple plus a claims bag: 256KB is generous.
    { prefix: "/api/v1/entities", cap: PUBLIC_BODY_CAP_BYTES },
    { prefix: "/api/v1/channels/inbound", cap: channelsCap },
    // Connect v3 marketplace-app events (POST /api/v1/channels/apps/:id/events)
    // — same unauthenticated-bypass shape as /channels/inbound (auth is the
    // in-controller Slack signature check, which runs AFTER the body is
    // buffered). Slack event payloads are far under 1MB. The sibling
    // /api/v1/channels/oauth prefix is GET-only, so the method check skips it.
    { prefix: "/api/v1/channels/apps", cap: channelsCap },
    // Connect v3 Phase C hosted account linking (/api/v1/channels/link/*). This
    // is the same unauthenticated-bypass family; the caps list matches by exact
    // prefix, and neither of the entries above covers `/link`. The link routes
    // are GET-only today (the method check skips them), so this is a
    // forward-guard: if a POST link route is ever added, it inherits the same
    // 1MB cap instead of falling back to the effectively-unbounded 15mb parser.
    { prefix: "/api/v1/channels/link", cap: channelsCap },
  ]);
}

interface CapRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface CapResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

/** The first cap whose prefix owns `path`, matched on a segment boundary. */
export function capFor(caps: readonly UnauthBodyCap[], path: string): UnauthBodyCap | undefined {
  return caps.find((c) => path === c.prefix || path.startsWith(c.prefix + "/"));
}

/**
 * The middleware. Refuses with `413 {"error":"payload_too_large","limit":N}` when
 * a body-bearing request on a capped prefix declares more than the cap OR declares
 * no finite length at all.
 */
export function unauthBodyCapMiddleware(
  caps: readonly UnauthBodyCap[],
): (req: CapRequest, res: CapResponse, next: () => void) => void {
  return (req, res, next) => {
    if (BODY_CAP_SKIPPED_METHODS.includes(String(req.method))) return next();
    const path = String(req.url || "").split("?")[0] ?? "";
    const match = capFor(caps, path);
    if (!match) return next();
    const len = Number(req.headers["content-length"]);
    if (!Number.isFinite(len) || len > match.cap) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: PAYLOAD_TOO_LARGE_ERROR, limit: match.cap }));
      return;
    }
    return next();
  };
}

/**
 * Install the cap, THEN the global parsers — in that order, which is the whole of
 * the guarantee. `main.ts` calls this, and so does the real-socket suite.
 *
 * `useBodyParser` is the platform-express API (a direct `require("express")` is
 * NOT resolvable in the pruned production image — it crashed the boot).
 * `rawBody: true` on the application makes these parsers also stash the exact
 * received bytes on `req.rawBody`, which the channels controllers verify
 * signatures over.
 */
export function installRequestBodyLimits(
  app: Pick<NestExpressApplication, "use" | "useBodyParser">,
  caps: readonly UnauthBodyCap[],
): void {
  app.use(unauthBodyCapMiddleware(caps));
  app.useBodyParser("json", { limit: AUTHENTICATED_BODY_PARSER_LIMIT });
  app.useBodyParser("urlencoded", { extended: true, limit: AUTHENTICATED_BODY_PARSER_LIMIT });
}
