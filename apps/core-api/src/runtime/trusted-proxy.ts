// WHETHER TLS REACHED THIS PROCESS, DECIDED ONCE PER REQUEST (D-COOKIE).
//
// core-api serves plain HTTP. When an operator puts it behind a TLS-terminating
// proxy, the only evidence that the browser used TLS is the proxy's
// `X-Forwarded-Proto` — a header any other caller can also send. So the header is
// believed from exactly ONE hop, and only when the operator named that hop:
//
//   * no `PLATOS_CORE_API_TRUSTED_PROXY`   -> the header is never read;
//   * the TCP peer is outside that range    -> the header is ignored, however it
//                                              is spelled, so a client that can
//                                              reach the listener directly cannot
//                                              claim TLS;
//   * the peer is the proxy                 -> TLS only if the header carries ONE
//                                              value and it is `https`. A list is
//                                              a chain of hops, and this process
//                                              trusts one; a repeated header is
//                                              joined into a list by Node and is
//                                              refused the same way.
//
// WHY NOT THE FRAMEWORK'S `trust proxy`. Express's `req.protocol` believes the
// LEFTMOST `X-Forwarded-Proto` value once the peer is trusted, and the leftmost
// value in an appended chain is the one the client wrote. Deciding here keeps
// every reading of "did TLS reach us" in one function a test can drive, and the
// framework's own setting stays at its default: trust nobody.
//
// THE DECISION TRAVELS ON THE REQUEST, beside the cookie policy the process was
// started with, so `transports/rest/operator.ts` reads one stamped value instead
// of every controller being handed configuration it would only pass along.

import type { SessionCookiePolicy } from "../config/security.js";
import type { TrustedProxyRange } from "../config/schema.js";
import { trustedProxyMatcher } from "../config/trusted-proxy.js";

/** The request property the decision is stamped onto. */
export const SESSION_TRANSPORT_PROPERTY = "platosSessionTransport";

export interface SessionTransportDecision {
  /** TLS reached this process: on the connection itself, or through the one trusted hop. */
  readonly tls: boolean;
  /**
   * How the operator session cookie is shaped on this install. Null when the
   * application was started without the process configuration — a suite that
   * composes directly — and the connection alone then decides, as it always did.
   */
  readonly policy: SessionCookiePolicy | null;
}

/** Only what the decision reads off a Node request. */
export interface TransportRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket?: { readonly remoteAddress?: string | undefined; readonly encrypted?: boolean };
  [SESSION_TRANSPORT_PROPERTY]?: SessionTransportDecision;
}

export interface TransportMiddlewareDependencies {
  readonly trustedProxy: TrustedProxyRange | null;
  readonly sessionCookie: SessionCookiePolicy | null;
}

/** Did TLS reach this process? Pure over the peer predicate and the request. */
export function reachedOverTls(
  isTrustedProxy: ((peer: string | undefined) => boolean) | null,
  request: TransportRequest,
): boolean {
  if (request.socket?.encrypted === true) return true;
  if (isTrustedProxy === null || !isTrustedProxy(request.socket?.remoteAddress)) return false;
  const header = request.headers["x-forwarded-proto"];
  if (typeof header !== "string") return false;
  const values = header.split(",").map((value) => value.trim());
  return values.length === 1 && values[0]?.toLowerCase() === "https";
}

export function createTransportMiddleware(
  dependencies: TransportMiddlewareDependencies,
): (request: TransportRequest, response: unknown, next: () => void) => void {
  const isTrustedProxy = dependencies.trustedProxy === null ? null : trustedProxyMatcher(dependencies.trustedProxy);
  return function transportMiddleware(request, _response, next): void {
    request[SESSION_TRANSPORT_PROPERTY] = Object.freeze({
      tls: reachedOverTls(isTrustedProxy, request),
      policy: dependencies.sessionCookie,
    });
    next();
  };
}
