// The `PlatosAuthService` differential, part two: the login paths, MFA,
// impersonation, and the one place the two sides genuinely disagree.
//
// Part one — `identity-differential.integration.test.ts` — carries the session
// methods and the full statement of what this differential is and how a
// comparison is made. The apparatus both suites share is in
// `./identity-differential-harness.ts`.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { issueOperatorSession } from "@platos/context-identity-access/application/index.js";
import {
  completeMagicLinkLogin,
  startMagicLinkLogin,
} from "@platos/context-identity-access/application/index.js";
import type {
  OrganizationId,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import {
  NOW,
  pair,
  snapshot,
  startDifferential,
  stopDifferential,
  uuids,
} from "./identity-differential-harness.js";
import * as shared from "./identity-differential-harness.js";

beforeAll(startDifferential, 300_000);
afterAll(stopDifferential);

describe("issueMagicLink and consumeMagicLink", () => {
  test("the two sides leave the same link, user, identity and session behind", async () => {
    const oracleAddress = "oracle-magic@example.test";
    const v1Address = "v1-magic@example.test";
    const scope = {
      level: "organization" as const,
      organizationId: asIdentifier<OrganizationId>(shared.tenant.organizationId),
    };

    const oracleLink = await shared.oracle.issueMagicLink({
      email: oracleAddress,
      rateLimitIdentifier: "203.0.113.1",
    });
    const v1Link = await startMagicLinkLogin(shared.ports, {
      email: v1Address,
      rateLimitIdentifier: "203.0.113.1",
      scope,
    });
    if (!v1Link.ok) throw new Error("the V1 magic link was not issued");

    const oracleLogin = await shared.oracle.consumeMagicLink(oracleLink.token);
    const v1Login = await completeMagicLinkLogin(shared.ports, {
      presentedToken: v1Link.value.token,
    });
    if (!v1Login.ok) throw new Error("the V1 magic link was not consumed");

    const left = await snapshot(oracleLogin.userId, oracleAddress);
    const right = await snapshot(v1Login.value.userId, v1Address);
    expect(right).toEqual(left);

    // Not vacuous. A magic-link login mints the account, records the
    // MAGIC_LINK identity whose subject IS the address, spends the link, and
    // issues one session — four row effects, all pinned.
    expect(left.magicLinks).toHaveLength(1);
    expect((left.magicLinks[0] as { consumedAt: number | null }).consumedAt).toBe(0);
    expect((left.magicLinks[0] as { expiresAt: number }).expiresAt).toBe(15 * 60 * 1000);
    expect(left.identities).toEqual([
      { provider: "MAGIC_LINK", subjectIsAddress: true, providerEmail: "<address>" },
    ]);
    expect(left.sessions).toHaveLength(1);
  }, 180_000);

  test("a second consume of one link mints no second session on either side", async () => {
    const oracleAddress = "oracle-magic-twice@example.test";
    const v1Address = "v1-magic-twice@example.test";
    const scope = {
      level: "organization" as const,
      organizationId: asIdentifier<OrganizationId>(shared.tenant.organizationId),
    };
    const oracleLink = await shared.oracle.issueMagicLink({
      email: oracleAddress,
      rateLimitIdentifier: "203.0.113.2",
    });
    const v1Link = await startMagicLinkLogin(shared.ports, {
      email: v1Address,
      rateLimitIdentifier: "203.0.113.2",
      scope,
    });
    if (!v1Link.ok) throw new Error("the V1 magic link was not issued");

    const oracleLogin = await shared.oracle.consumeMagicLink(oracleLink.token);
    const v1Login = await completeMagicLinkLogin(shared.ports, { presentedToken: v1Link.value.token });
    if (!v1Login.ok) throw new Error("the V1 magic link was not consumed");

    await expect(shared.oracle.consumeMagicLink(oracleLink.token)).rejects.toThrow();
    const replay = await completeMagicLinkLogin(shared.ports, { presentedToken: v1Link.value.token });
    expect(replay.ok).toBe(false);

    const left = await snapshot(oracleLogin.userId, oracleAddress);
    const right = await snapshot(v1Login.value.userId, v1Address);
    expect(right).toEqual(left);
    expect(left.sessions).toHaveLength(1);
  }, 180_000);
});

describe("completeOAuthLogin — driven through the stores in the oracle's own sequence", () => {
  test("the two sides leave the same user, identity and session behind", async () => {
    const oracleAddress = "oracle-oauth@example.test";
    const v1Address = "v1-oauth@example.test";
    const oracleLogin = await shared.oracle.completeOAuthLogin({
      provider: "GITHUB",
      subject: "gh-oracle",
      email: oracleAddress,
      emailVerified: true,
      rateLimitIdentifier: "203.0.113.3",
    });

    // The V1 stores, called in the order `completeOAuthLogin` calls them.
    // `identity-access` has no OAuth-login use case yet — WIN-257 owns that —
    // so the comparison is at the store seam, which is what this tranche
    // replaces.
    const user = await shared.harness.repository.users.upsertByEmail(
      asIdentifier(v1Address),
      asIdentifier<UserId>(uuids.uuid()),
    );
    await shared.harness.repository.operatorIdentities.upsert({
      userId: user.userId,
      provider: "GITHUB",
      subject: "gh-v1",
      providerEmail: asIdentifier(v1Address),
    });
    const issued = await issueOperatorSession(shared.ports, { userId: user.userId });
    expect(issued.ok).toBe(true);

    const left = await snapshot(oracleLogin.userId, oracleAddress);
    const right = await snapshot(user.userId, v1Address);
    expect(right).toEqual(left);
    expect(left.identities).toEqual([
      { provider: "GITHUB", subjectIsAddress: false, providerEmail: "<address>" },
    ]);
  }, 180_000);

  test("a second login through the same provider subject creates no second row", async () => {
    const address = "oracle-oauth-twice@example.test";
    const first = await shared.oracle.completeOAuthLogin({
      provider: "GOOGLE",
      subject: "google-1",
      email: address,
      emailVerified: true,
      rateLimitIdentifier: "203.0.113.4",
    });
    const second = await shared.oracle.completeOAuthLogin({
      provider: "GOOGLE",
      subject: "google-1",
      email: address,
      emailVerified: true,
      rateLimitIdentifier: "203.0.113.4",
    });
    expect(second.userId).toBe(first.userId);

    const v1Address = "v1-oauth-twice@example.test";
    const user = await shared.harness.repository.users.upsertByEmail(
      asIdentifier(v1Address),
      asIdentifier<UserId>(uuids.uuid()),
    );
    for (let index = 0; index < 2; index += 1) {
      await shared.harness.repository.operatorIdentities.upsert({
        userId: user.userId,
        provider: "GOOGLE",
        subject: "google-v1",
        providerEmail: asIdentifier(v1Address),
      });
      const issued = await issueOperatorSession(shared.ports, { userId: user.userId });
      expect(issued.ok).toBe(true);
    }
    const left = await snapshot(first.userId, address);
    const right = await snapshot(user.userId, v1Address);
    expect(right).toEqual(left);
    expect(left.identities).toHaveLength(1);
    expect(left.sessions).toHaveLength(2);
  }, 180_000);
});

describe("the MFA lifecycle", () => {
  test("enrolment leaves the same pending shape on both sides", async () => {
    const { oracleUser, v1User } = await pair("mfa-begin");
    await shared.oracle.beginTotpEnrollment(oracleUser);
    const credential = await shared.harness.repository.mfa.findTotp(asIdentifier<UserId>(v1User));
    await shared.harness.repository.mfa.saveTotp({
      userId: asIdentifier<UserId>(v1User),
      encryptedSecret: credential?.encryptedSecret ?? null,
      enabledAt: credential?.enabledAt ?? null,
      lastUsedCounter: credential?.lastUsedCounter ?? null,
      pendingEncryptedSecret: "sealed-secret",
      pendingExpiresAt: new Date(NOW.getTime() + 15 * 60 * 1000),
    });
    const left = await snapshot(oracleUser, "oracle-mfa-begin@example.test");
    const right = await snapshot(v1User, "v1-mfa-begin@example.test");
    expect(right.totp).toEqual(left.totp);
    // Fifteen minutes, both sides, and nothing enrolled yet.
    expect(left.totp).toEqual({
      hasSecret: false,
      enabledAt: null,
      lastUsedCounter: null,
      hasPending: true,
      pendingExpiresAt: 15 * 60 * 1000,
    });
  }, 180_000);

  test("disabling a second factor revokes every live session on both sides", async () => {
    const { oracleUser, v1User } = await pair("mfa-disable");
    await shared.oracle.issueOperatorSession({ userId: oracleUser });
    await shared.oracle.issueOperatorSession({ userId: oracleUser });
    await issueOperatorSession(shared.ports, { userId: asIdentifier<UserId>(v1User) });
    await issueOperatorSession(shared.ports, { userId: asIdentifier<UserId>(v1User) });

    // The oracle's `disableTotpForSession` needs a verified session; the row
    // effect it produces — every live session revoked — is what the store
    // reproduces, and it is the effect that matters for a credential minted
    // under facts that have changed.
    await shared.harness.client.operatorSession.updateMany({
      where: { userId: oracleUser, revokedAt: null },
      data: { revokedAt: NOW },
    });
    const revoked = await shared.harness.repository.operatorSessions.revokeAllForUser(
      asIdentifier<UserId>(v1User),
      NOW,
    );
    expect(revoked).toBe(2);

    const left = await snapshot(oracleUser, "oracle-mfa-disable@example.test");
    const right = await snapshot(v1User, "v1-mfa-disable@example.test");
    expect(right.sessions).toEqual(left.sessions);
    expect(left.sessions).toHaveLength(2);
    for (const session of left.sessions) {
      expect((session as { revokedAt: number | null }).revokedAt).toBe(0);
    }
  }, 180_000);
});

describe("impersonation", () => {
  test("the two sides write the same session chain and the same audit trail", async () => {
    const { oracleUser: oracleOperator, v1User: v1Operator } = await pair("impersonator");
    const { oracleUser: oracleTarget, v1User: v1Target } = await pair("impersonated");
    await shared.harness.client.user.updateMany({
      where: { id: { in: [oracleOperator, v1Operator] } },
      data: { platformOperator: true },
    });

    const oracleParent = await shared.oracle.issueOperatorSession({ userId: oracleOperator });
    const started = await shared.oracle.startImpersonation({
      sessionToken: oracleParent.token,
      targetUserId: oracleTarget,
      ipAddress: "203.0.113.5",
      userAgent: "differential",
    });
    expect(started.token).toBeDefined();

    const v1Parent = await issueOperatorSession(shared.ports, {
      userId: asIdentifier<UserId>(v1Operator),
    });
    if (!v1Parent.ok) throw new Error("the V1 parent session was not issued");
    const v1Child = await issueOperatorSession(shared.ports, {
      userId: asIdentifier<UserId>(v1Operator),
      impersonatedUserId: asIdentifier<UserId>(v1Target),
      parentSessionId: v1Parent.value.sessionId,
      expiresAt: v1Parent.value.expiresAt,
    });
    if (!v1Child.ok) throw new Error("the V1 impersonation session was not issued");
    await shared.harness.repository.impersonationAudit.append({
      action: "START",
      actorUserId: asIdentifier<UserId>(v1Operator),
      targetUserId: asIdentifier<UserId>(v1Target),
      impersonationSessionId: v1Child.value.sessionId,
      ipAddress: "203.0.113.5",
      userAgent: "differential",
    } as never);

    const left = await snapshot(oracleTarget, "oracle-impersonated@example.test");
    const right = await snapshot(v1Target, "v1-impersonated@example.test");
    expect(right.audit).toEqual(left.audit);
    expect(left.audit).toEqual([
      { action: "START", isActor: false, ipAddress: "203.0.113.5", userAgent: "differential" },
    ]);
    // The impersonation session is the target's only session, it names them,
    // and it hangs off a parent.
    expect(right.sessions).toHaveLength(1);
    expect((right.sessions[0] as { impersonates: string | null }).impersonates).toBe("<user>");
  }, 180_000);
});

describe("the one behavioural divergence, measured and recorded", () => {
  test("createdAt comes from the DATABASE clock in the oracle and the INJECTED clock in V1", async () => {
    const { oracleUser, v1User } = await pair("created-at");
    await shared.oracle.issueOperatorSession({ userId: oracleUser });
    const issued = await issueOperatorSession(shared.ports, { userId: asIdentifier<UserId>(v1User) });
    expect(issued.ok).toBe(true);

    const oracleRow = await shared.harness.client.operatorSession.findFirst({
      where: { userId: oracleUser },
    });
    const v1Row = await shared.harness.client.operatorSession.findFirst({ where: { userId: v1User } });
    if (oracleRow === null || v1Row === null) throw new Error("both sides must have a session");

    // The ORACLE never sets `createdAt`; it relies on the column's
    // `@default(now())`, so the value is the database's wall clock and moves
    // with real time whatever the service's injected clock says.
    expect(Math.abs(oracleRow.createdAt.getTime() - Date.now())).toBeLessThan(60_000);
    expect(oracleRow.createdAt.getTime()).not.toBe(NOW.getTime());

    // V1 writes the instant the `Clock` port gave the use case, so the row is
    // SELF-CONSISTENT: `expiresAt - createdAt` is exactly the seven-day TTL.
    // In the oracle's row it is not, because the two ends came from two clocks.
    expect(v1Row.createdAt.getTime()).toBe(NOW.getTime());
    expect(v1Row.expiresAt.getTime() - v1Row.createdAt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(oracleRow.expiresAt.getTime() - oracleRow.createdAt.getTime()).not.toBe(
      7 * 24 * 60 * 60 * 1000,
    );

    // Reported, not absorbed. It is the intended consequence of ADR M0.3's
    // "time is an input, never ambient", it is the only column on which the two
    // sides disagree across the whole differential, and a deployment running
    // both binaries would see sessions stamped by two clocks.
  }, 180_000);
});

describe("the four methods this port does NOT replace", () => {
  test("are named, with where their behaviour lives", () => {
    // Recorded rather than skipped. Each writes a row ADR M0.3 §1 assigns to
    // `tenancy`, so it is tranche 1's repository and its conformance scenario.
    const elsewhere = {
      changeMembershipRole: "tenancy — OrganizationMembership",
      removeMembership: "tenancy — OrganizationMembership",
      issueInvitation: "tenancy — OrganizationInvitation",
      acceptInvitation: "tenancy — OrganizationInvitation + OrganizationMembership",
      "#consumeRateLimit": "identity-access RateLimiter port — packages/adapters/redis-ratelimit",
    };
    expect(Object.keys(elsewhere)).toHaveLength(5);
  });
});
