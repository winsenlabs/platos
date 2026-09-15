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
//   * the cap is 2 MiB, inclusive: a declared length above it is refused;
//   * a body-bearing request that declares NO finite length (chunked) is refused,
//     because a stream whose size is unknown until it has been buffered is what
//     the cap exists to refuse;
//   * GET, HEAD, OPTIONS and DELETE are not inspected;
//   * the refusal is `413` with `{"error":"payload_too_large","limit":<cap>}` —
//     the agent's bytes, so a client that already handles the agent's refusal
//     handles this one. It is deliberately NOT the M0.4 §2 envelope: D21 names the
//     token, and an MCP client migrating between the two deployables must not see
//     two shapes for one refusal;
//   * it runs BEFORE the body parser and therefore before authentication, which in
//     this process happens inside the controllers (`authenticateOperator`) — so an
//     oversized body is never buffered on behalf of a caller nobody has identified.
//
// WHERE IT RUNS. `runtime/lifecycle.ts` installs it with `nest.use` immediately
// after the edge middleware and before `listen()`. Nest registers its own body
// parser inside `init()`, which `listen()` calls, so a middleware registered here
// precedes the parser in Express's stack — the same ordering argument the edge
// middleware's own comment makes. The edge runs first on purpose: a refused
// request still gets its correlation id and still counts against admission.
//
// WHAT IT DOES NOT CHANGE, AND THE GAP THAT LEAVES — MEASURED, NOT ASSUMED.
// Nest's default JSON parser limit (100 KiB) still applies to every route, MCP
// included. Raising it process-wide to 2 MiB would widen what every REST route
// buffers before authentication twentyfold, and a per-prefix parser needs an
// `express`/`body-parser` import this package does not declare; D21 decides the
// MCP cap, not either of those. So a JSON body between 100 KiB and 2 MiB is still
// refused before authentication, but by the PARSER: `startCoreApi` answered
// revoke bodies of about 150 KB and 1.5 MB with `500 TRANSPORT_UNHANDLED_FAULT`
// (fault `PayloadTooLargeError`) on 2026-09-16, because `DomainExceptionFilter`'s
// fourth arm does not recognise the parser's 413. That is a pre-existing defect of
// every route in this process, recorded in the M4 gates report, and it is why the
// accepted MCP body here is 100 KiB until the parser limit is decided.

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

/** Only what this middleware reads. Structural, like the edge middleware's types. */
export interface BodyCapRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/** Only what this middleware writes. */
export interface BodyCapResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body: string): unknown;
}

export interface McpBodyCapOptions {
  /** Defaults to `MCP_BODY_CAP_BYTES`. A test may narrow it; production does not. */
  readonly capBytes?: number;
}

export type McpBodyCap = (request: BodyCapRequest, response: BodyCapResponse, next: () => void) => void;

/** Whether `path` is the MCP root or sits under it, on a segment boundary. */
export function isUnderMcpRoot(path: string): boolean {
  return path === MCP_BODY_CAP_PREFIX || path.startsWith(`${MCP_BODY_CAP_PREFIX}/`);
}

export function createMcpBodyCap(options: McpBodyCapOptions = {}): McpBodyCap {
  const cap = options.capBytes ?? MCP_BODY_CAP_BYTES;
  return function mcpBodyCap(request, response, next): void {
    if (MCP_BODY_CAP_SKIPPED_METHODS.includes(String(request.method))) {
      next();
      return;
    }
    const path = String(request.url ?? "").split("?")[0] ?? "";
    if (!isUnderMcpRoot(path)) {
      next();
      return;
    }
    const declared = Number(request.headers["content-length"]);
    if (!Number.isFinite(declared) || declared > cap) {
      response.statusCode = 413;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: PAYLOAD_TOO_LARGE_ERROR, limit: cap }));
      return;
    }
    next();
  };
}
