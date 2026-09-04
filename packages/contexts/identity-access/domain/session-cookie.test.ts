import { describe, expect, it } from "vitest";

import {
  HOST_OPERATOR_SESSION_COOKIE_NAME,
  OPERATOR_SESSION_COOKIE_NAME,
  checkSessionCookieShape,
  clearSessionCookie,
  describeSessionCookie,
  isSessionCookieDirective,
  issueSessionCookie,
  rotateSessionCookie,
  type SessionCookieShape,
} from "./session-cookie.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const IN_A_WEEK = new Date("2026-01-08T00:00:00.000Z");
const TOKEN = "plt_os_a-session-token";

const secure = describeSessionCookie({ secure: true });
const insecure = describeSessionCookie({ secure: false });

function issue(overrides: Record<string, unknown> = {}) {
  return issueSessionCookie({
    shape: secure,
    token: TOKEN,
    sessionExpiresAt: IN_A_WEEK,
    now: NOW,
    ...overrides,
  });
}

/**
 * A shape a transport assembled itself, which is what the check is for.
 *
 * The overrides are `unknown`-typed because the point of several cases is a
 * value the TYPE forbids — `SameSite=None`, a `Domain`, `HttpOnly: false`. The
 * type stops an honest caller; the check has to stop a transport that reached
 * this with `any`, a JSON parse, or a `createCookie` call of its own.
 */
function forged(overrides: Record<string, unknown>): SessionCookieShape {
  return { ...secure, ...overrides } as unknown as SessionCookieShape;
}

describe("describeSessionCookie", () => {
  it("reproduces the production shape the deployed gate already pins", () => {
    // `tests/persisted-state-gate/operator-session-cookie.test.mjs` serialises
    // through `createCookie("__Host-platos_operator_session", { httpOnly: true,
    // path: "/", sameSite: "lax", secure: true })`. Core now decides that, and
    // this is the assertion that the decision did not drift while moving.
    expect(secure).toEqual({
      name: "__Host-platos_operator_session",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
      domain: null,
    });
    expect(secure.name).toBe(HOST_OPERATOR_SESSION_COOKIE_NAME);
  });

  it("DROPS THE __Host- PREFIX where there is no TLS, because a browser would drop the cookie", () => {
    expect(insecure.name).toBe(OPERATOR_SESSION_COOKIE_NAME);
    expect(insecure.name.startsWith("__Host-")).toBe(false);
    expect(insecure.secure).toBe(false);
  });

  it("never carries a Domain, and is frozen", () => {
    expect(secure.domain).toBeNull();
    expect(insecure.domain).toBeNull();
    expect(Object.isFrozen(secure)).toBe(true);
  });
});

describe("checkSessionCookieShape — the RFC 6265bis §4.1.3.2 rules", () => {
  it("accepts both shapes this context mints", () => {
    expect(checkSessionCookieShape(secure).ok).toBe(true);
    expect(checkSessionCookieShape(insecure).ok).toBe(true);
  });

  it("REFUSES the __Host- prefix without Secure", async () => {
    const refusal = checkSessionCookieShape(forged({ secure: false }));
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_SESSION_COOKIE");
    expect(refusal.error.message).toContain("__Host-");
  });

  it("REFUSES a secure install that dropped the prefix — that is session fixation", () => {
    // Without the prefix a sibling subdomain can write this cookie, and the
    // victim's browser will send it here.
    const refusal = checkSessionCookieShape(forged({ name: OPERATOR_SESSION_COOKIE_NAME }));
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.message).toContain("__Host-");
  });

  it("REFUSES a Path that is not /", () => {
    expect(checkSessionCookieShape(forged({ path: "/app" })).ok).toBe(false);
  });

  it("REFUSES a Domain attribute", () => {
    expect(checkSessionCookieShape(forged({ domain: ".example.com" })).ok).toBe(false);
  });

  it("REFUSES a cookie readable by script", () => {
    expect(checkSessionCookieShape(forged({ httpOnly: false })).ok).toBe(false);
  });

  it("REFUSES SameSite=None, which would send the session cross-site", () => {
    expect(checkSessionCookieShape(forged({ sameSite: "none" })).ok).toBe(false);
    expect(checkSessionCookieShape(forged({ sameSite: "strict" })).ok).toBe(true);
  });
});

describe("issueSessionCookie", () => {
  it("carries the raw token and the session's own expiry", () => {
    const directive = issue();
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.value).toBe(TOKEN);
    expect(directive.value.expiresAt).toEqual(IN_A_WEEK);
    expect(directive.value.shape).toEqual(secure);
  });

  it("derives Max-Age from the clock, in whole seconds", () => {
    const directive = issue();
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.maxAgeSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("accepts a SHORTER browser lifetime than the session", () => {
    const shorter = new Date("2026-01-02T00:00:00.000Z");
    const directive = issue({ expiresAt: shorter });
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.expiresAt).toEqual(shorter);
    expect(directive.value.maxAgeSeconds).toBe(24 * 60 * 60);
  });

  it("REFUSES A COOKIE THAT WOULD OUTLIVE ITS SESSION", async () => {
    // The browser would keep sending a credential the store has already expired,
    // producing a failure the user cannot act on and an operator cannot tell
    // apart from a revocation.
    const refusal = issue({ expiresAt: new Date("2026-02-01T00:00:00.000Z") });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.message).toContain("outlive");
  });

  it("REFUSES to put an ALREADY EXPIRED session in a browser", () => {
    const refusal = issue({ sessionExpiresAt: new Date("2025-12-31T00:00:00.000Z") });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.message).toContain("already expired");
  });

  it("REFUSES a session expiring exactly now, AND says which guard refused it", () => {
    // Asserting only `ok === false` here was a vacuous test, and a mutation
    // proved it: relaxing this boundary from `<=` to `<` left the case GREEN,
    // because a session expiring exactly now also has a cookie expiry of exactly
    // now, and the NEXT guard refuses that with the same error code. Two guards
    // sharing a code cannot be told apart, so the reason is asserted — it is the
    // only thing that distinguishes them.
    const refusal = issue({ sessionExpiresAt: NOW });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({ reason: "the session has already expired" });
    expect(issue({ sessionExpiresAt: new Date(NOW.getTime() + 1000) }).ok).toBe(true);
  });

  it("REFUSES A REQUESTED EXPIRY IN THE PAST on a live session, under its OWN reason", () => {
    // A caller may ask for a shorter browser lifetime; asking for one that has
    // already passed would emit a cookie the browser deletes on arrival, so the
    // operator would be logged straight back out with nothing to see.
    //
    // This is the case that gives the SECOND expiry guard a reason of its own. A
    // mutation making it mint the first guard's reason has to be red somewhere,
    // and this is where.
    const refusal = issue({ expiresAt: new Date("2025-12-31T00:00:00.000Z") });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.details).toEqual({
      reason: "a session cookie must expire in the future",
    });
  });

  it("REFUSES an empty token, which is what a clear directive is for", () => {
    const refusal = issue({ token: "" });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.message).toContain("clear directive");
  });

  it("REFUSES A BAD SHAPE before it reaches a browser", () => {
    expect(issue({ shape: forged({ secure: false }) }).ok).toBe(false);
    expect(issue({ shape: forged({ httpOnly: false }) }).ok).toBe(false);
  });
});

describe("clearSessionCookie", () => {
  it("empties the value and expires it three different ways", () => {
    // Max-Age for a browser that honours it, Expires for one that does not, and
    // an empty value for anything that honours neither.
    const directive = clearSessionCookie(secure);
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.value).toBe("");
    expect(directive.value.maxAgeSeconds).toBe(0);
    expect(directive.value.expiresAt).toEqual(new Date(0));
  });

  it("KEEPS THE SAME SHAPE, or it would not overwrite the cookie it is clearing", () => {
    // A browser keys a cookie by name, domain and path. A logout emitted under a
    // different name leaves the session sitting in the browser.
    const directive = clearSessionCookie(secure);
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.shape).toEqual(secure);
  });

  it("REFUSES to clear through an invalid shape", () => {
    expect(clearSessionCookie(forged({ secure: false })).ok).toBe(false);
  });
});

describe("rotateSessionCookie", () => {
  it("issues the new token", () => {
    const directive = rotateSessionCookie({
      shape: secure,
      token: "plt_os_new",
      previousToken: TOKEN,
      sessionExpiresAt: IN_A_WEEK,
      now: NOW,
    });
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.value).toBe("plt_os_new");
  });

  it("REFUSES A ROTATION THAT RE-ISSUES THE SAME TOKEN", async () => {
    // MFA verification and impersonation both mint a NEW session. Re-issuing the
    // old token under a new expiry looks exactly like a rotation, passes any
    // test that only checks a cookie was set, and leaves the escalated session
    // reachable with the credential that existed before the escalation.
    const refusal = rotateSessionCookie({
      shape: secure,
      token: TOKEN,
      previousToken: TOKEN,
      sessionExpiresAt: IN_A_WEEK,
      now: NOW,
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.message).toContain("different token");
  });

  it("still applies every issue rule", () => {
    expect(
      rotateSessionCookie({
        shape: secure,
        token: "plt_os_new",
        previousToken: TOKEN,
        sessionExpiresAt: IN_A_WEEK,
        expiresAt: new Date("2026-03-01T00:00:00.000Z"),
        now: NOW,
      }).ok,
    ).toBe(false);
  });
});

describe("isSessionCookieDirective", () => {
  it("recognises what this module minted", () => {
    const directive = issue();
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(isSessionCookieDirective(directive.value)).toBe(true);
    expect(Object.isFrozen(directive.value)).toBe(true);
  });

  it("REFUSES A DIRECTIVE WHOSE SECURE FLAG WAS TURNED OFF ON THE WAY OUT", async () => {
    // The whole point of the brand. A BFF cannot be stopped from writing its own
    // header, but a directive it modified cannot be handed back and accepted.
    const directive = issue();
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    const downgraded = { ...directive.value, shape: { ...directive.value.shape, secure: false } };
    expect(isSessionCookieDirective(downgraded)).toBe(false);
  });

  it("REFUSES a field-by-field copy, and a hand-built object", () => {
    const directive = issue();
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(isSessionCookieDirective({ ...directive.value })).toBe(false);
    expect(
      isSessionCookieDirective({
        shape: secure,
        value: TOKEN,
        expiresAt: IN_A_WEEK,
        maxAgeSeconds: 604800,
      }),
    ).toBe(false);
    expect(isSessionCookieDirective(null)).toBe(false);
    expect(isSessionCookieDirective("__Host-platos_operator_session=x")).toBe(false);
  });
});
