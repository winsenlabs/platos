// The session-cookie exchange contract, through the façade.
//
// SPLIT OUT OF `identity-access-service.test.ts`, not because the file was
// untidy but because it crossed the 500-effective-line budget the moment this
// surface landed in it. The budget was pointing at a real seam: everything in
// the sibling file is a decision made against a STORE — a session row, a
// credential row, a rate-limit bucket — and everything here is a decision made
// against nothing but the clock and the install's transport. The two need
// entirely different arrangements, and now they say so.
//
// WHAT IS BEING PROVEN. Not the rules themselves; `domain/session-cookie.test.ts`
// owns those. What only shows up here is that the FAÇADE does not soften them:
// that the expiry comes from the composed clock rather than the caller, that a
// refusal stays a refusal instead of becoming a directive with a shorter life,
// and that the directive crosses the contract as the value this context minted
// rather than a copy — which is the whole mechanism behind
// `verifySessionCookie`.

import { describe, expect, it } from "vitest";

import { DAY_MS, HOUR_MS, at } from "../domain/testing.js";
import { createIdentityAccessService } from "./identity-access-service.js";
import { testPorts } from "./testing.js";

describe("the session-cookie exchange contract", () => {
  const IN_A_WEEK = at(7 * DAY_MS);

  it("hands a BFF the whole shape, decided here", () => {
    const shape = createIdentityAccessService(testPorts()).describeSessionCookie({ secure: true });
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.value).toEqual({
      name: "__Host-platos_operator_session",
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: true,
      domain: null,
    });
  });

  it("TAKES THE EXPIRY FROM ITS OWN CLOCK, not from the caller", async () => {
    // `maxAgeSeconds` is a function of the clock this context was composed with.
    // A BFF computing it would be a BFF deciding how long the credential lives.
    const ports = testPorts();
    const directive = createIdentityAccessService(ports).issueSessionCookie({
      secure: true,
      token: "plt_os_live",
      sessionExpiresAt: IN_A_WEEK,
    });
    expect(directive.ok).toBe(true);
    if (!directive.ok) return;
    expect(directive.value.maxAgeSeconds).toBe(7 * 24 * 60 * 60);
    expect(directive.value.expiresAt).toEqual(IN_A_WEEK);
  });

  it("REFUSES A COOKIE THAT WOULD OUTLIVE ITS SESSION, through the contract", async () => {
    const refusal = createIdentityAccessService(testPorts()).issueSessionCookie({
      secure: true,
      token: "plt_os_live",
      sessionExpiresAt: at(HOUR_MS),
      expiresAt: at(30 * DAY_MS),
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_SESSION_COOKIE");
  });

  it("REFUSES A ROTATION THAT RE-ISSUES THE SAME TOKEN, through the contract", async () => {
    const identityAccess = createIdentityAccessService(testPorts());
    expect(
      identityAccess.rotateSessionCookie({
        secure: true,
        token: "plt_os_new",
        previousToken: "plt_os_old",
        sessionExpiresAt: IN_A_WEEK,
      }).ok,
    ).toBe(true);
    const refusal = identityAccess.rotateSessionCookie({
      secure: true,
      token: "plt_os_same",
      previousToken: "plt_os_same",
      sessionExpiresAt: IN_A_WEEK,
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_SESSION_COOKIE");
  });

  it("clears under the SAME shape it issued under", () => {
    const identityAccess = createIdentityAccessService(testPorts());
    const issued = identityAccess.issueSessionCookie({
      secure: true,
      token: "plt_os_live",
      sessionExpiresAt: IN_A_WEEK,
    });
    const cleared = identityAccess.clearSessionCookie({ secure: true });
    expect(issued.ok && cleared.ok).toBe(true);
    if (!issued.ok || !cleared.ok) return;
    expect(cleared.value.shape).toEqual(issued.value.shape);
    expect(cleared.value.value).toBe("");
    expect(cleared.value.maxAgeSeconds).toBe(0);
  });

  it("REFUSES A DIRECTIVE A BFF DOWNGRADED ON THE WAY TO THE HEADER", async () => {
    // The seam that makes "the BFF may only set the bytes" checkable. The
    // directive crosses the contract as the value this context minted, so a copy
    // with `secure` flipped off is not the value that was issued.
    const identityAccess = createIdentityAccessService(testPorts());
    const issued = identityAccess.issueSessionCookie({
      secure: true,
      token: "plt_os_live",
      sessionExpiresAt: IN_A_WEEK,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(identityAccess.verifySessionCookie(issued.value).ok).toBe(true);

    const downgraded = { ...issued.value, shape: { ...issued.value.shape, secure: false } };
    const refusal = identityAccess.verifySessionCookie(downgraded);
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe("INVALID_SESSION_COOKIE");
    expect(identityAccess.verifySessionCookie({ ...issued.value }).ok).toBe(false);
  });
});
