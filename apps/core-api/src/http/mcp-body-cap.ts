// THE MCP BODY CAP, FOR THE MCP ROUTES THIS DEPLOYABLE SERVES. FOUNDER DECISION D21.
//
// D21 (2026-09-15): "MCP body cap in core-api. Mirror apps/agent: 2 MB,
// `413 payload_too_large`, enforced before authentication." Before this file the
// MCP token and policy routes here relied on nothing but Nest's implicit parser
// default, with no explicit cap and no test — the census row for WIN-268's
// "auth/isolation/body-limit regression suite" said exactly that.
//
// WHAT "MIRROR" MEANS, CLAUSE BY CLAUSE, against
// `apps/agent/src/http/request-body-limits.ts`:
//
//   * the prefix is the MCP root (`/mcp`, and every path under it), composed from
//     `MCP_ROOT_SEGMENT` rather than typed, for the reason `mcp-surface.ts` gives;
//   * the cap is 2 MiB, inclusive: a body of exactly 2 MiB is ADMITTED and parsed,
//     and a declared length above it is refused;
//   * a body-bearing request that declares NO finite length (chunked) is refused,
//     because a stream whose size is unknown until it has been buffered is what
//     the cap exists to refuse;
//   * GET, HEAD, OPTIONS and DELETE are not inspected;
//   * the refusal is `413` with `{"error":"payload_too_large","limit":<cap>}` —
//     the agent's bytes, so a client that already handles the agent's refusal
//     handles this one. It is deliberately NOT the M0.4 §2 envelope: D21 names the
//     token, and an MCP client migrating between the two deployables must not see
//     two shapes for one refusal;
//   * it runs BEFORE any body parser and therefore before authentication, which in
//     this process happens inside the controllers (`authenticateOperator`) — so an
//     oversized body is never buffered on behalf of a caller nobody has identified.
//
// THE ROUTER DECIDES WHICH REQUESTS THE CAP SEES. `installMcpBodyLimits` mounts it
// with Express's own `use("/mcp", ...)`, so it sees exactly what the router would
// hand to an MCP route: Express matches case-insensitively and reads the pathname
// out of an absolute-form request target. The first version compared the raw
// `req.url` with `/mcp`, and `POST /MCP/...` or `POST http://host/mcp/...` reached
// the MCP controllers with no cap at all.
//
// THE PARSER THE CAP ADMITS INTO. Nest's default JSON parser stops at 100 KiB, and
// it used to be the only parser here. So a 2 MiB cap was not a mirror: every MCP
// body between 100 KiB and 2 MiB got `500 TRANSPORT_UNHANDLED_FAULT` (fault
// `PayloadTooLargeError`), measured against `startCoreApi` on 2026-09-16, where the
// agent admits it. The MCP root therefore gets its OWN JSON and urlencoded parsers,
// mounted after the cap and ahead of Nest's defaults, with the cap as their limit.
// Every other route keeps Nest's defaults unchanged: widening them process-wide
// would multiply what every REST route buffers before authentication by twenty.
//
//   * WHERE THE PARSERS COME FROM. `ExpressAdapter.useBodyParser` is the framework's
//     own construction: Nest's `rawBody` handling (the exact bytes kept on
//     `request.rawBody`, which the idempotency fingerprint is taken over; the
//     process creates its application with `rawBody: true`) and the `express`
//     instance the adapter itself loads. It REGISTERS what it builds on the whole
//     application, though, and takes no path. So it is called with a collector in
//     place of the adapter, and the collected parser is mounted on `/mcp` instead.
//     That relies on the method handing its parser to `this.use`, which is how
//     `@nestjs/platform-express@11` is written; if a release changes it,
//     `installMcpBodyLimits` throws at start-up rather than serving MCP without a
//     parser, and the suite's process case goes red.
//   * WHY THE WRAPPERS HAVE THEIR OWN NAMES. Nest skips a default parser when the
//     Express stack already holds a function named `jsonParser` (or
//     `urlencodedParser`). A mounted parser under that name would switch the JSON
//     parser off for every other route in the process.
//   * WHAT A PARSER MAY STILL REFUSE. The cap reads the declared length, which is
//     the ENCODED length. A compressed body that inflates past the cap is refused by
//     the parser as it reads, and the wrapper answers that with the same 413 rather
//     than letting it reach the filter as an unhandled fault.

import { ExpressAdapter } from "@nestjs/platform-express";

import { MCP_ROOT_SEGMENT } from "../transports/mcp/mcp-surface.js";

/** D21. The same figure `apps/agent` uses for its `/mcp` prefix. */
export const MCP_BODY_CAP_BYTES = 2 * 1024 * 1024;

/** D21. The refusal token, byte-identical to `apps/agent`'s. */
export const PAYLOAD_TOO_LARGE_ERROR = "payload_too_large";

/** Methods never inspected, as in `apps/agent`. */
export const MCP_BODY_CAP_SKIPPED_METHODS: readonly string[] = Object.freeze([
  "GET",
  "HEAD",
  "OPTIONS",
  "DELETE",
]);

/** `/mcp`, from the one constant that names the MCP root. */
export const MCP_BODY_CAP_PREFIX = `/${MCP_ROOT_SEGMENT}`;

/** The names the mounted handlers carry on the Express stack, in mount order. */
export const MCP_BODY_LIMIT_HANDLERS: readonly string[] = Object.freeze([
  "mcpBodyCap",
  "mcpJsonParser",
  "mcpUrlencodedParser",
]);

/** Only what the cap reads. Structural, like the edge middleware's types. */
export interface BodyCapRequest {
  readonly method?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** Only what the cap writes. */
export interface BodyCapResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

export interface McpBodyCapOptions {
  /** Defaults to `MCP_BODY_CAP_BYTES`. A test may narrow it; production does not. */
  readonly capBytes?: number;
}

type Next = (error?: unknown) => void;
type Middleware = (request: never, response: never, next: Next) => void;

/** What `installMcpBodyLimits` needs: Nest's `use`, which mounts on a path. */
export interface MountingApplication {
  use(path: string, handler: Middleware): unknown;
}

function refuse(response: BodyCapResponse, cap: number): void {
  response.statusCode = 413;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ error: PAYLOAD_TOO_LARGE_ERROR, limit: cap }));
}

/**
 * The cap. It never reads the path: it refuses every body-bearing request it is
 * shown that declares more than the cap or no finite length, so it is only ever
 * mounted on the MCP root, which is what `installMcpBodyLimits` does.
 */
export function createMcpBodyCap(options: McpBodyCapOptions = {}) {
  const cap = options.capBytes ?? MCP_BODY_CAP_BYTES;
  return function mcpBodyCap(request: BodyCapRequest, response: BodyCapResponse, next: () => void): void {
    if (MCP_BODY_CAP_SKIPPED_METHODS.includes(String(request.method))) {
      next();
      return;
    }
    const declared = Number(request.headers["content-length"]);
    if (!Number.isFinite(declared) || declared > cap) {
      refuse(response, cap);
      return;
    }
    next();
  };
}

/** The framework's own parser, built by `ExpressAdapter.useBodyParser` and collected rather than registered. */
function frameworkParser(type: "json" | "urlencoded", limit: number): Middleware {
  let collected: unknown;
  const collector = { use: (parser: unknown) => void (collected = parser) };
  const options = type === "json" ? { limit } : { limit, extended: true };
  ExpressAdapter.prototype.useBodyParser.call(collector as unknown as ExpressAdapter, type, true, options);
  if (typeof collected !== "function") {
    throw new Error(`ExpressAdapter.useBodyParser("${type}") no longer hands its parser to this.use`);
  }
  return collected as Middleware;
}

/** Hand the parser's own "too large" to the D21 refusal; pass anything else on unchanged. */
function answeringTooLarge(response: never, cap: number, next: Next): Next {
  return (error) => {
    if (typeof error === "object" && error !== null && (error as { type?: unknown }).type === "entity.too.large") {
      refuse(response, cap);
    } else if (error === undefined) {
      next();
    } else {
      next(error);
    }
  };
}

/**
 * Mount the cap, then the MCP root's own parsers, on `/mcp`. Call it after the edge
 * middleware and before `listen()`, which is when Nest registers its default
 * parsers, behind these.
 */
export function installMcpBodyLimits(app: MountingApplication, options: McpBodyCapOptions = {}): void {
  const cap = options.capBytes ?? MCP_BODY_CAP_BYTES;
  const json = frameworkParser("json", cap);
  const urlencoded = frameworkParser("urlencoded", cap);
  app.use(MCP_BODY_CAP_PREFIX, createMcpBodyCap({ capBytes: cap }));
  app.use(MCP_BODY_CAP_PREFIX, function mcpJsonParser(request, response, next) {
    json(request, response, answeringTooLarge(response, cap, next));
  });
  app.use(MCP_BODY_CAP_PREFIX, function mcpUrlencodedParser(request, response, next) {
    urlencoded(request, response, answeringTooLarge(response, cap, next));
  });
}
