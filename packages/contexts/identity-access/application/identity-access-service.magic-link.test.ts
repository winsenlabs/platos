// The magic-link pair, THROUGH THE FAÇADE — the two methods D20 put on the
// contract (2026-09-15).
//
// `magic-link-login.test.ts` owns the use cases' rules. What only shows up here is
// what the PUBLISHED surface hands a caller, because that is the thing D20 is a
// statement about: the start answers with no token at all, and the completion
// answers with the session token ONLY inside a directive this context minted and
// will recognise — so a transport can put it in a browser and has no JSON field to
// put it anywhere else.

import { describe, expect, it } from "vitest";

import { email } from "../domain/testing.js";
import { createIdentityAccessService } from "./identity-access-service.js";
import { testPorts } from "./testing.js";

describe("D20 — startMagicLinkLogin on the contract", () => {
  it("answers with the address and the expiry, and the token reaches only the delivery port", async () => {
    const ports = testPorts();
    const started = await createIdentityAccessService(ports).startMagicLinkLogin({
      email: " Operator@Example.COM ",
    });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;
    expect(Object.keys(started.value).sort()).toEqual(["email", "expiresAt"]);
    expect(started.value.email).toBe(email());
    const token = ports.magicLinks.delivered[0]?.token ?? "";
    expect(token.startsWith("plt_ml_")).toBe(true);
    expect(JSON.stringify(started.value)).not.toContain(token);
  });

  it("derives the LOGIN bucket from the address, so two spellings share one budget", async () => {
    const ports = testPorts();
    const service = createIdentityAccessService(ports);
    await service.startMagicLinkLogin({ email: "operator@example.com" });
    await service.startMagicLinkLogin({ email: " OPERATOR@example.COM" });
    expect(ports.rateLimiter.buckets.size).toBe(1);
    expect([...ports.rateLimiter.buckets.values()][0]?.requestCount).toBe(2);
    // AND THE BUCKET IS THE ORACLE'S KEY, digested: `dashboard:<address>`.
    expect([...ports.rateLimiter.buckets.keys()][0]).toBe(
      `LOGIN:${ports.hasher.hash("dashboard:operator@example.com")}`,
    );
  });

  it("D3: refuses with RATE_LIMIT_FAILED_CLOSED when the limiter is down, and delivers nothing", async () => {
    const ports = testPorts();
    ports.rateLimiter.breakLimiter();
    const refused = await createIdentityAccessService(ports).startMagicLinkLogin({
      email: "operator@example.com",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("RATE_LIMIT_FAILED_CLOSED");
    expect(ports.magicLinks.delivered).toHaveLength(0);
    expect(ports.repository.state.magicLinks.size).toBe(0);
  });
});

describe("D20 — completeMagicLinkLogin on the contract", () => {
  it("returns a session whose token exists only inside a directive the contract recognises", async () => {
    const ports = testPorts();
    const service = createIdentityAccessService(ports);
    await service.startMagicLinkLogin({ email: "operator@example.com" });
    const token = ports.magicLinks.delivered[0]?.token ?? "";
    const completed = await service.completeMagicLinkLogin({ presentedToken: token, secure: true });
    expect(completed.ok, JSON.stringify(completed)).toBe(true);
    if (!completed.ok) return;
    expect(Object.keys(completed.value).sort()).toEqual(["cookie", "expiresAt", "sessionId", "userId"]);
    expect(completed.value.cookie.value.startsWith("plt_os_")).toBe(true);
    expect(completed.value.cookie.shape.name).toBe("__Host-platos_operator_session");
    // THE DIRECTIVE IS THE MINTED OBJECT, so `verifySessionCookie` accepts it and
    // refuses a copy — the mechanism that makes "a BFF only sets the bytes" checkable.
    expect(service.verifySessionCookie(completed.value.cookie).ok).toBe(true);
    expect(service.verifySessionCookie({ ...completed.value.cookie }).ok).toBe(false);
    // AND THE SESSION IN IT IS REAL.
    const authenticated = await service.authenticateOperator({
      presentedToken: completed.value.cookie.value,
    });
    expect(authenticated.ok).toBe(true);
    if (!authenticated.ok) return;
    expect(authenticated.value.sessionId).toBe(completed.value.sessionId);
    expect(authenticated.value.actorUserId).toBe(completed.value.userId);
  });

  it("answers an unknown link UNAUTHENTICATED and mints no session", async () => {
    const ports = testPorts();
    const refused = await createIdentityAccessService(ports).completeMagicLinkLogin({
      presentedToken: "plt_ml_invented",
      secure: false,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("UNAUTHENTICATED");
    expect(ports.repository.state.sessions.size).toBe(0);
  });
});
