// D-COOKIE — THE PROXY HOP AND THE COOKIE POLICY, WITHOUT A SERVER.
//
// What is here is the decision table. The same rules are proven over real sockets
// behind a real TLS-terminating Caddy in the lane evidence; this file pins each
// branch so a mutation to any one of them fails a named case:
//
//   * `reachedOverTls` — no trusted proxy, a peer outside the range, a peer inside
//     it with one `https`, with `http`, with a list, with a repeated header;
//   * `sessionCookieTransport` — no policy, COOKIE_SECURE=false, COOKIE_SECURE=true
//     with and without TLS;
//   * the BFF exchange and sign-out — refused before any store call on a Secure
//     install TLS did not reach, and the contract's `__Host-` Secure cookie when
//     it did, under the configured base name and SameSite mode.

import { describe, expect, it } from "vitest";

import { ok, type Result } from "@platos/kernel";
import type { IdentityAccessContract, OperatorAuthorizationView } from "@platos/context-identity-access";
import { createIdentityAccessService, testPorts } from "@platos/context-identity-access/application/index.js";

import type { AppModule } from "../../app.module.js";
import type { SessionCookiePolicy } from "../../config/security.js";
import { parseTrustedProxy, trustedProxyMatcher } from "../../config/trusted-proxy.js";
import {
  createTransportMiddleware,
  reachedOverTls,
  SESSION_TRANSPORT_PROPERTY,
  type TransportRequest,
} from "../../runtime/trusted-proxy.js";
import { BffSessionController } from "../bff/session.controller.js";
import { domainErrorOf } from "./fault.js";
import { presentedOperatorToken, sessionCookieTransport, type InboundOperatorRequest } from "./operator.js";

const PROXY = "172.18.0.1";

function proxyRange() {
  const range = parseTrustedProxy(PROXY);
  if ("problem" in range) throw new Error(range.problem);
  return range;
}

function request(peer: string, headers: TransportRequest["headers"] = {}): TransportRequest {
  return { headers, socket: { remoteAddress: peer } };
}

describe("did TLS reach this request", () => {
  const isProxy = trustedProxyMatcher(proxyRange());

  it("believes no header at all when no proxy is configured", () => {
    expect(reachedOverTls(null, request(PROXY, { "x-forwarded-proto": "https" }))).toBe(false);
  });

  it("ignores the header from a peer that is not the configured proxy", () => {
    expect(reachedOverTls(isProxy, request("172.18.0.99", { "x-forwarded-proto": "https" }))).toBe(false);
    expect(reachedOverTls(isProxy, request("127.0.0.1", { "x-forwarded-proto": "https" }))).toBe(false);
  });

  it("believes one https value from the configured proxy, and nothing else from it", () => {
    expect(reachedOverTls(isProxy, request(PROXY, { "x-forwarded-proto": "https" }))).toBe(true);
    expect(reachedOverTls(isProxy, request(PROXY, { "x-forwarded-proto": "HTTPS" }))).toBe(true);
    expect(reachedOverTls(isProxy, request(PROXY, { "x-forwarded-proto": "http" }))).toBe(false);
    expect(reachedOverTls(isProxy, request(PROXY))).toBe(false);
    // A chain is more than the one hop this process trusts; its leftmost value
    // is the one a client wrote.
    expect(reachedOverTls(isProxy, request(PROXY, { "x-forwarded-proto": "https, http" }))).toBe(false);
    expect(reachedOverTls(isProxy, request(PROXY, { "x-forwarded-proto": ["https", "https"] }))).toBe(false);
  });

  it("takes an encrypted connection as TLS without any header", () => {
    expect(reachedOverTls(null, { headers: {}, socket: { encrypted: true } })).toBe(true);
  });

  it("stamps the decision and the policy on every request it sees", () => {
    const policy: SessionCookiePolicy = { secure: true, cookieName: "platos_operator_session", sameSite: "lax" };
    const middleware = createTransportMiddleware({ trustedProxy: proxyRange(), sessionCookie: policy });
    const seen = request(PROXY, { "x-forwarded-proto": "https" });
    let continued = false;
    middleware(seen, {}, () => {
      continued = true;
    });
    expect(continued).toBe(true);
    expect(seen[SESSION_TRANSPORT_PROPERTY]).toEqual({ tls: true, policy });
    expect(Object.isFrozen(seen[SESSION_TRANSPORT_PROPERTY])).toBe(true);
  });
});

const SECURE: SessionCookiePolicy = { secure: true, cookieName: "acme_ops", sameSite: "strict" };
const PLAIN: SessionCookiePolicy = { secure: false, cookieName: "acme_ops", sameSite: "strict" };

function stamped(policy: SessionCookiePolicy | null, tls: boolean, headers: InboundOperatorRequest["headers"] = {}) {
  return { headers, [SESSION_TRANSPORT_PROPERTY]: { tls, policy } } satisfies InboundOperatorRequest;
}

describe("what the contract is asked for", () => {
  it("lets the connection decide when the application has no policy", () => {
    expect(sessionCookieTransport(stamped(null, true))).toEqual({ transport: { secure: true }, mayIssue: true });
    expect(sessionCookieTransport(stamped(null, false))).toEqual({ transport: { secure: false }, mayIssue: true });
  });

  it("asks for the plain shape on a COOKIE_SECURE=false install, whatever TLS did", () => {
    for (const tls of [true, false]) {
      expect(sessionCookieTransport(stamped(PLAIN, tls))).toEqual({
        transport: { secure: false, cookieName: "acme_ops", sameSite: "strict" },
        mayIssue: true,
      });
    }
  });

  it("always asks for the __Host- shape on a Secure install, and issues only where TLS arrived", () => {
    expect(sessionCookieTransport(stamped(SECURE, true)).mayIssue).toBe(true);
    expect(sessionCookieTransport(stamped(SECURE, false))).toEqual({
      transport: { secure: true, cookieName: "acme_ops", sameSite: "strict" },
      mayIssue: false,
    });
  });

  it("reads the cookie under the operator's name, never under a name a header chose", () => {
    const identityAccess = createIdentityAccessService(testPorts());
    const cookies = { cookie: "acme_ops=plain; __Host-acme_ops=tls" };
    expect(presentedOperatorToken(identityAccess, stamped(SECURE, false, cookies))).toBe("tls");
    expect(presentedOperatorToken(identityAccess, stamped(SECURE, true, cookies))).toBe("tls");
    expect(presentedOperatorToken(identityAccess, stamped(PLAIN, true, cookies))).toBe("plain");
  });
});

describe("the BFF on a Secure install", () => {
  const EXPIRES = new Date("2027-01-01T00:00:00.000Z");

  function controllerWith(calls: string[]) {
    const real = createIdentityAccessService(testPorts());
    const identityAccess: IdentityAccessContract = {
      ...real,
      authenticateOperator: (): Promise<Result<OperatorAuthorizationView>> => {
        calls.push("authenticateOperator");
        return Promise.resolve(
          ok({
            sessionId: "s",
            actorUserId: "u",
            effectiveUserId: "u",
            email: "o@example.test",
            expiresAt: EXPIRES,
            mfaVerifiedAt: null,
            impersonating: null,
          }),
        );
      },
      revokeOperatorSession: (input) => {
        calls.push("revokeOperatorSession");
        return real.revokeOperatorSession(input);
      },
    };
    return new BffSessionController({ app: { contexts: { identityAccess } } as unknown as AppModule });
  }

  it("refuses the exchange before looking the token up when TLS did not reach the request", async () => {
    const calls: string[] = [];
    const written: string[] = [];
    const thrown = await controllerWith(calls)
      .exchange(stamped(SECURE, false), { setHeader: (_name, value) => written.push(value) }, { token: "t" })
      .catch((error: unknown) => error);
    expect(domainErrorOf(thrown)?.code).toBe("TRANSPORT_SESSION_COOKIE_REQUIRES_TLS");
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it("refuses the sign-out before revoking anything when TLS did not reach the request", async () => {
    const calls: string[] = [];
    const written: string[] = [];
    const thrown = await controllerWith(calls)
      .signOut(stamped(SECURE, false), { setHeader: (_name, value) => written.push(value) })
      .catch((error: unknown) => error);
    expect(domainErrorOf(thrown)?.code).toBe("TRANSPORT_SESSION_COOKIE_REQUIRES_TLS");
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });

  it("writes the __Host- Secure cookie under the configured name and mode when TLS did", async () => {
    const written: string[] = [];
    await controllerWith([]).exchange(
      stamped(SECURE, true),
      { setHeader: (_name, value) => written.push(value) },
      { token: "t" },
    );
    expect(written).toHaveLength(1);
    expect(written[0]?.startsWith("__Host-acme_ops=t;")).toBe(true);
    expect(written[0]).toContain("Secure");
    expect(written[0]).toContain("SameSite=Strict");
  });
});
