// The WIRE half of `ToolDispatch`: one HTTP POST to an already-resolved callback.
//
// A wire entity opened an inbound connection to Platos and registered a callback
// URL through `/tools/sync`; a call to one of its tools is a POST to that URL
// with the arguments as the body. There is no SDK and no session: the port's own
// header says liveness for a wire entity is something Platos OBSERVES rather
// than tries, so this file's job is to make one request and turn what came back
// into a `DispatchOutcome`.
//
// EVERY BACKEND-SIDE OUTCOME IS A VALUE, NEVER A THROW. The port says so and the
// reason is that the four outcomes are not interchangeable to a caller:
//
//   200-299            `succeeded`, with the parsed body as the result
//   429                `rateLimited`, carrying the backend's own `Retry-After`
//   any other status   `failed`, with the status in the reason
//   abort / socket     `timeout` when the budget expired, `failed` otherwise
//
// `rateLimited` IS NOT A FLAVOUR OF `failed` and the separation is transcribed
// from the legacy executor, which learned it the hard way: a model told "it
// failed" retries immediately and is refused again, and a model told "wait 30
// seconds" waits. The header is honoured verbatim when it is an integer count of
// seconds and falls back to `DEFAULT_RETRY_AFTER_SECONDS` when it is absent or
// is an HTTP-date, which is the same fallback the legacy path takes.
//
// A TIMEOUT IS DISTINGUISHED FROM A FAILURE BY OUR OWN CLOCK, NOT BY THE ERROR
// SHAPE. `AbortController.abort()` surfaces as an `AbortError` in some Node
// versions and as a `TypeError: fetch failed` with a cause in others, so
// branching on the error's name would be branching on a runtime detail. The
// budget is a fact this file owns: if the deadline had passed when the request
// died, the outcome is `timeout`.
//
// -----------------------------------------------------------------------------
// WHAT THIS FILE DELIBERATELY DOES NOT DO, AND WHERE IT BELONGS INSTEAD
//
// IT DOES NOT SCREEN THE DESTINATION. The legacy path calls `validatePublicUrl`
// before every POST because a compromised entity could register
// `http://169.254.169.254/...` through `tool_register` and turn every tool call
// into a metadata-service read. That screen is REAL and it is not this port's:
// `eventing`'s `DestinationScreen` is the declared SSRF boundary in this
// architecture — its contract is DNS resolution plus a socket pinned to the
// address that resolved, and `adapter-bindings.ts` says its adapter is "the sole
// holder of the resolver". A private-address literal check written here would be
// a SECOND, weaker definition of the same rule in a package that owns neither
// the resolver nor the socket, and the two would drift.
//
// It is stated rather than silently omitted because a reader has to be able to
// tell an unwritten screen from a decision. NOTHING IN `apps/core-api` DISPATCHES
// A TOOL TODAY — the composed `tools` contract is reachable from no route in that
// deployable, and `executeTool` is served only by the legacy executor in
// `apps/agent`, which still runs its own screen. So this is a gap in a path with
// no caller, and it must be closed before the first route that calls
// `executeTool` lands.
//
// IT ALSO SENDS NO `X-Platos-*` HEADERS AND NO SIGNATURE. The legacy path signs
// the body and carries the tenant triple in headers; the port hands this file
// `target.headers` already resolved and says outright that "nothing here takes a
// credential" because "resolving them is a domain rule with a fail-closed
// invariant that must run before an adapter is reached". `resolve-transport.ts`
// resolves a wire target's headers to the EMPTY SET today, so a wire backend
// composed through this adapter would receive an unsigned request. That is the
// domain's gap and not this file's: minting a signature here would put the
// signing rule — and the key — inside a transport.
// -----------------------------------------------------------------------------

import { ok, type Result } from "@platos/kernel";

import type { DispatchOutcome, DispatchRequest } from "../application/ports/index.js";

/** What the legacy executor falls back to when `Retry-After` is unusable. */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * The body shape a wire backend has always received.
 *
 * Transcribed rather than invented: the legacy executor POSTs `{ tool, args,
 * callId }` and every entity backend in the field parses that. A new envelope
 * would be a breaking change to third-party code disguised as a refactor.
 */
interface WireCallBody {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly callId: string;
}

export async function dispatchOverWire(
  request: DispatchRequest,
): Promise<Result<DispatchOutcome>> {
  const started = Date.now();
  const deadline = started + request.target.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.target.timeoutMs);

  const body: WireCallBody = {
    tool: request.toolName,
    args: request.arguments,
    callId: request.callId,
  };

  try {
    const response = await fetch(request.target.url as string, {
      method: "POST",
      // `target.headers` LAST would let a resolved header silently replace the
      // content type the body actually has. It is FIRST, so the two facts this
      // file owns — the encoding of the body it just serialised, and nothing
      // else — win over a template.
      headers: { ...request.target.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      // NO REDIRECT FOLLOWING. `fetch`'s default is `follow`, and a followed
      // redirect is the exact hole the destination screen this file does not have
      // would exist to close: a screened URL that 302s to a private address
      // defeats the screen. `manual` makes a 3xx an ordinary non-2xx `failed`,
      // which is the fail-closed reading and is stricter than the legacy path's
      // three-hop `fetchWithValidatedRedirects`.
      redirect: "manual",
    });
    const latencyMs = Date.now() - started;

    if (response.status === 429) {
      return ok({
        kind: "rateLimited",
        retryAfterSeconds: retryAfterSecondsOf(response.headers.get("retry-after")),
        latencyMs,
      });
    }
    if (!response.ok) {
      // The status and NOT the body. A backend's error page can be a megabyte of
      // HTML and this reason reaches an audit row and a log line.
      return ok({ kind: "failed", reason: `http_${String(response.status)}`, latencyMs });
    }
    const text = await response.text();
    return ok({ kind: "succeeded", result: parseJsonOrText(text), latencyMs });
  } catch (cause) {
    const latencyMs = Date.now() - started;
    // THE CLOCK DECIDES, NOT THE ERROR'S NAME. See the header.
    if (Date.now() >= deadline) return ok({ kind: "timeout", latencyMs });
    return ok({ kind: "failed", reason: transportReason(cause), latencyMs });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Retry-After`, honoured only in its delta-seconds form.
 *
 * RFC 9110 §10.2.3 permits an HTTP-date as well, and this returns the fallback
 * for one rather than parsing it. That is deliberate: a date has to be compared
 * against the SERVER'S clock, and a caller whose clock is skewed would compute a
 * negative or enormous wait from a header that was correct. The legacy path draws
 * the same line at the same place.
 */
function retryAfterSecondsOf(header: string | null): number {
  if (header === null) return DEFAULT_RETRY_AFTER_SECONDS;
  if (!/^\d+$/u.test(header.trim())) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number.parseInt(header.trim(), 10);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

/**
 * A successful body, parsed when it is JSON and kept verbatim when it is not.
 *
 * `result` is `unknown` on the port, so a non-JSON 200 is a legitimate answer
 * rather than a failure: several entity backends in the field answer `OK`. A
 * parse error here would turn a successful call into a failed one.
 */
function parseJsonOrText(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A transport-level failure, reduced to something safe to record.
 *
 * NOT the message. A DNS or TLS error message carries the host, the resolved
 * address and sometimes a certificate subject, and this string reaches an audit
 * row that an MCP client may be shown. Node puts the machine-readable part in
 * `cause.code`, which is what travels.
 */
function transportReason(cause: unknown): string {
  const inner = (cause as { cause?: { code?: unknown; errors?: unknown } } | null)?.cause;
  const code = inner?.code;
  if (typeof code === "string" && code !== "") return `transport_${code.toLowerCase()}`;
  // A HOST WITH SEVERAL ADDRESSES FAILS AS AN `AggregateError`, and every branch
  // of it carries its own code. `undici` raises that shape when a name resolves
  // to both an A and an AAAA record and both are refused, which is the ordinary
  // case for `localhost` — so reading only `cause.code` would report the commonest
  // connection failure there is as an unclassified one.
  const branches = inner?.errors;
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      const branchCode = (branch as { code?: unknown } | null)?.code;
      if (typeof branchCode === "string" && branchCode !== "") {
        return `transport_${branchCode.toLowerCase()}`;
      }
    }
  }
  return "transport_error";
}
