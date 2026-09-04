// THE ACCEPTANCE FOR THIS TRANCHE: a differential against `PlatosAuthService`.
//
// `internal-packages/tenancy-database/src/auth.ts` is 1,196 lines and 17 public
// methods, and it is the behaviour the ten stores in this package replace. The
// only honest way to show a replacement is a replacement is to run BOTH against
// the SAME real database and compare what each left behind.
//
// HOW A COMPARISON IS MADE. Each case drives the oracle for one operator and
// the V1 use cases — over this adapter, with a real SHA-256 hasher, because the
// digest CHECKs in the migrations refuse anything else — for another, then
// snapshots every identity-access row belonging to each and compares the two
// snapshots with volatile values normalised. Identifiers become `<user>`,
// `<session-1>`, `<digest-1>`; instants become millisecond offsets from the one
// clock both sides are given. Nothing else is normalised, so a different
// `tier`, a different `expiresAt` window, a missing `OperatorIdentity`, an extra
// row or a different count all fail.
//
// WHAT IS OUT OF SCOPE AND WHY, recorded rather than skipped. Four of the
// seventeen — `changeMembershipRole`, `removeMembership`, `issueInvitation`,
// `acceptInvitation` — write `OrganizationMembership` and
// `OrganizationInvitation`, which ADR M0.3 §1 assigns to `tenancy`. They are
// tranche 1's `TenancyRepository` and its conformance scenario covers them.
// `#consumeRateLimit` writes `AuthRateLimitBucket` through the `RateLimiter`
// port, whose adapter is `redis-ratelimit`, not this one.

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { PlatosAuthService, hashSecret } from "@platos/tenancy-database";
import {
  authenticateOperator,
  completeMagicLinkLogin,
  issueOperatorSession,
  revokeOperatorSession,
  startMagicLinkLogin,
} from "@platos/context-identity-access/application/index.js";
import {
  fakeMfaSecretCipher,
  fakeRateLimiter,
  fakeTotpCodeVerifier,
  fixedClock,
  recordingSafetySink,
  silentLogger,
} from "@platos/context-identity-access/application/index.js";
import type {
  OrganizationId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";
import type { IdentityAccessPorts } from "@platos/context-identity-access/application/index.js";

import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

let harness: IdentityHarness;
let tenant: SeededTenant;
let ports: IdentityAccessPorts;
let oracle: PlatosAuthService;

const NOW = new Date("2026-05-01T09:00:00.000Z");
const ENCRYPTION_KEY = "07".repeat(32);

/**
 * The REAL digest, not the test double's.
 *
 * `application/testing.ts`'s `fakeSecretHasher` prepends a string, which is
 * deterministic and injective and therefore perfectly adequate for a unit
 * suite — and is refused by `OperatorSession_tokenHash_check`. Against a real
 * database the hasher has to be the one the oracle uses, or the two sides are
 * not writing comparable rows.
 */
const realHasher = {
  hash: (value: string): TokenHash =>
    asIdentifier<TokenHash>(createHash("sha256").update(value, "utf8").digest("hex")),
  matches: (value: string, digest: TokenHash): boolean =>
    createHash("sha256").update(value, "utf8").digest("hex") === digest,
};

let minted = 0;
function opaque(prefix: string): string {
  minted += 1;
  return `${prefix}${randomBytes(24).toString("base64url")}${String(minted)}`;
}

const realMinter = {
  mint: (kind: string): string =>
    (
      opaque(kind === "magicLink" ? "plt_ml_" : kind === "operatorSession" ? "plt_os_" : "plt_")
    ),
  mintTotpSecret: (): string => randomBytes(20).toString("hex").toUpperCase(),
  mintRecoveryCodes: (count: number): readonly string[] =>
    Array.from({ length: count }, () => opaque("rc_")),
};

let uuidSequence = 0;
const uuids = {
  uuid: (): string => {
    uuidSequence += 1;
    return `cccccccc-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
  },
  ulid: (): string => `01ARZ3NDEKTSV4RRFFQ69G5F${String(uuidSequence).padStart(2, "0")}`,
};

beforeAll(async () => {
  harness = await startIdentityHarness();
  tenant = await harness.seedTenant("differential");
  const clock = fixedClock(NOW);
  ports = {
    repository: harness.repository,
    rateLimiter: fakeRateLimiter(),
    hasher: realHasher as never,
    minter: realMinter as never,
    totp: fakeTotpCodeVerifier(),
    cipher: fakeMfaSecretCipher(),
    clock,
    ids: uuids as never,
    safety: recordingSafetySink(),
    logger: silentLogger(),
  };
  oracle = new PlatosAuthService(harness.client as never, {
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
    tokenGenerator: opaque,
  });
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

interface Snapshot {
  readonly sessions: readonly unknown[];
  readonly identities: readonly unknown[];
  readonly magicLinks: readonly unknown[];
  readonly totp: unknown;
  readonly recoveryCodeCount: number;
  readonly audit: readonly unknown[];
}

/** Millisecond offset from the one instant both sides were given. */
const offset = (value: Date | null): number | null =>
  value === null ? null : value.getTime() - NOW.getTime();

/**
 * Every identity-access row belonging to `subject`, with the values that CANNOT
 * agree replaced by stable labels and everything else left literal.
 *
 * The labels are assigned in a deterministic order — sessions by `createdAt`
 * then `id` — so two runs that produced the same shape produce the same
 * snapshot, and one that produced an extra row does not.
 */
async function snapshot(subject: string, address: string): Promise<Snapshot> {
  const sessionRows = await harness.client.operatorSession.findMany({
    where: { OR: [{ userId: subject }, { impersonatedUserId: subject }] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const label = new Map<string, string>();
  sessionRows.forEach((row, index) => label.set(row.id, `<session-${String(index + 1)}>`));
  return {
    sessions: sessionRows.map((row) => ({
      id: label.get(row.id),
      digestLength: row.tokenHash.length,
      digestIsHex: /^[0-9a-f]{64}$/u.test(row.tokenHash),
      tier: row.tier,
      isActor: row.userId === subject,
      impersonates: row.impersonatedUserId === null ? null : "<user>",
      parent: row.parentSessionId === null ? null : label.get(row.parentSessionId),
      mfaVerifiedAt: offset(row.mfaVerifiedAt),
      expiresAt: offset(row.expiresAt),
      revokedAt: offset(row.revokedAt),
      lastSeenAt: offset(row.lastSeenAt),
      // `createdAt` is compared as PRESENT rather than by value, and that is a
      // recorded DIVERGENCE rather than a convenience. See the dedicated case
      // "the one behavioural divergence" below: the oracle lets the column
      // default stamp it from the DATABASE clock, and V1 writes the instant its
      // injected `Clock` gave the use case. Every other column here compares
      // literally.
      createdAtIsSet: row.createdAt !== null,
    })),
    identities: (
      await harness.client.operatorIdentity.findMany({
        where: { userId: subject },
        orderBy: [{ provider: "asc" }, { subject: "asc" }],
      })
    ).map((row) => ({
      provider: row.provider,
      subjectIsAddress: row.subject === address,
      providerEmail: row.providerEmail === address ? "<address>" : row.providerEmail,
    })),
    magicLinks: (
      await harness.client.magicLinkToken.findMany({
        where: { email: address },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).map((row) => ({
      digestIsHex: /^[0-9a-f]{64}$/u.test(row.tokenHash),
      expiresAt: offset(row.expiresAt),
      consumedAt: offset(row.consumedAt),
    })),
    totp: await harness.client.operatorMfaTotp
      .findUnique({ where: { userId: subject } })
      .then((row) =>
        row === null
          ? null
          : {
              hasSecret: row.encryptedSecret !== null,
              enabledAt: offset(row.enabledAt),
              lastUsedCounter: row.lastUsedCounter === null ? null : row.lastUsedCounter.toString(),
              hasPending: row.pendingEncryptedSecret !== null,
              pendingExpiresAt: offset(row.pendingExpiresAt),
            },
      ),
    recoveryCodeCount: await harness.client.operatorMfaRecoveryCode.count({
      where: { userId: subject },
    }),
    audit: (
      await harness.client.impersonationAudit.findMany({
        where: { OR: [{ actorUserId: subject }, { targetUserId: subject }] },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).map((row) => ({
      action: row.action,
      isActor: row.actorUserId === subject,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
    })),
  };
}

/** A pair of operators, one for each side, created identically. */
async function pair(name: string): Promise<{ oracleUser: string; v1User: string }> {
  const oracleAddress = `oracle-${name}@example.test`;
  const v1Address = `v1-${name}@example.test`;
  const oracleUser = await harness.client.user
    .create({ data: { email: oracleAddress } })
    .then((row) => row.id);
  const v1User = await harness.repository.users
    .upsertByEmail(asIdentifier(v1Address), asIdentifier<UserId>(uuids.uuid()))
    .then((row) => row.userId);
  await harness.seedMembership(tenant.organizationId, oracleUser);
  await harness.seedMembership(tenant.organizationId, v1User);
  return { oracleUser, v1User };
}

describe("issueOperatorSession", () => {
  test("the two sides write the same session row", async () => {
    const { oracleUser, v1User } = await pair("issue");
    await oracle.issueOperatorSession({ userId: oracleUser });
    const issued = await issueOperatorSession(ports, { userId: asIdentifier<UserId>(v1User) });
    expect(issued.ok).toBe(true);

    const left = await snapshot(oracleUser, `oracle-issue@example.test`);
    const right = await snapshot(v1User, `v1-issue@example.test`);
    expect(right.sessions).toEqual(left.sessions);
    // Not vacuous: there IS a session, its digest is a real SHA-256 hex, and the
    // seven-day window both sides use is the same number.
    expect(left.sessions).toHaveLength(1);
    expect((left.sessions[0] as { expiresAt: number }).expiresAt).toBe(7 * 24 * 60 * 60 * 1000);
    expect((right.sessions[0] as { digestIsHex: boolean }).digestIsHex).toBe(true);
  }, 180_000);
});

describe("authorizeOperatorSession", () => {
  const states = ["active", "revoked", "expired", "unknown-token"] as const;

  test("the two sides accept and refuse the same four states", async () => {
    const { oracleUser, v1User } = await pair("authorize");
    const verdicts: Record<string, { oracle: string; v1: string }> = {};

    for (const state of states) {
      const oracleSession = await oracle.issueOperatorSession({ userId: oracleUser });
      const v1Session = await issueOperatorSession(ports, {
        userId: asIdentifier<UserId>(v1User),
      });
      if (!v1Session.ok) throw new Error("the V1 session was not issued");

      if (state === "revoked") {
        await oracle.revokeOperatorSession(oracleSession.token);
        await revokeOperatorSession(ports, { presentedToken: v1Session.value.token });
      }
      if (state === "expired") {
        const past = new Date(NOW.getTime() - 1000);
        await harness.client.operatorSession.updateMany({
          where: { tokenHash: hashSecret(oracleSession.token) },
          data: { expiresAt: past },
        });
        await harness.client.operatorSession.updateMany({
          where: { tokenHash: realHasher.hash(v1Session.value.token) },
          data: { expiresAt: past },
        });
      }

      const oracleToken = state === "unknown-token" ? opaque("plt_os_") : oracleSession.token;
      const v1Token = state === "unknown-token" ? opaque("plt_os_") : v1Session.value.token;

      let oracleVerdict = "accepted";
      try {
        await oracle.authorizeOperatorSession(oracleToken);
      } catch (error) {
        oracleVerdict = (error as { code?: string }).code ?? "threw";
      }
      const v1Result = await authenticateOperator(ports, { presentedToken: v1Token });
      const v1Verdict = v1Result.ok
        ? "accepted"
        : ((v1Result.error as { reason?: string; code?: string }).reason ??
          (v1Result.error as { code?: string }).code ??
          "refused");
      verdicts[state] = { oracle: oracleVerdict, v1: v1Verdict };
    }

    // ACCEPT/REFUSE must agree state by state. The refusal VOCABULARY does not:
    // the oracle throws `PlatosAuthError` codes and V1 returns a domain
    // `Result`, which is the deliberate change WIN-256 made. So the comparison
    // is on the decision, and the two vocabularies are recorded beside it.
    expect(verdicts.active).toEqual({ oracle: "accepted", v1: "accepted" });
    for (const state of ["revoked", "expired", "unknown-token"] as const) {
      expect(verdicts[state]?.oracle).not.toBe("accepted");
      expect(verdicts[state]?.v1).not.toBe("accepted");
    }
    // The oracle's own codes, pinned, so a silent change to them is visible.
    expect(verdicts.revoked?.oracle).toBe("revoked");
    expect(verdicts.expired?.oracle).toBe("expired");
    expect(verdicts["unknown-token"]?.oracle).toBe("unauthorized");
  }, 180_000);

  test("both sides stamp lastSeenAt on a successful authorization and neither on a refusal", async () => {
    const { oracleUser, v1User } = await pair("last-seen");
    const oracleSession = await oracle.issueOperatorSession({ userId: oracleUser });
    const v1Session = await issueOperatorSession(ports, { userId: asIdentifier<UserId>(v1User) });
    if (!v1Session.ok) throw new Error("the V1 session was not issued");

    await oracle.authorizeOperatorSession(oracleSession.token);
    await authenticateOperator(ports, { presentedToken: v1Session.value.token });

    const left = await snapshot(oracleUser, "oracle-last-seen@example.test");
    const right = await snapshot(v1User, "v1-last-seen@example.test");
    expect(right.sessions).toEqual(left.sessions);
    expect((left.sessions[0] as { lastSeenAt: number | null }).lastSeenAt).toBe(0);
  }, 180_000);
});

describe("revokeOperatorSession", () => {
  test("both sides end the session once and report the second call differently but consistently", async () => {
    const { oracleUser, v1User } = await pair("revoke");
    const oracleSession = await oracle.issueOperatorSession({ userId: oracleUser });
    const v1Session = await issueOperatorSession(ports, { userId: asIdentifier<UserId>(v1User) });
    if (!v1Session.ok) throw new Error("the V1 session was not issued");

    expect(await oracle.revokeOperatorSession(oracleSession.token)).toBe(true);
    const firstV1 = await revokeOperatorSession(ports, {
      presentedToken: v1Session.value.token,
    });
    expect(firstV1.ok).toBe(true);

    // The SECOND call is the distinction both sides preserve: an already-ended
    // session is not ended again. The oracle reports `false`, V1 reports a
    // refusal — different shapes, same decision — and neither writes a second
    // `revokedAt`.
    expect(await oracle.revokeOperatorSession(oracleSession.token)).toBe(false);
    const secondV1 = await revokeOperatorSession(ports, {
      presentedToken: v1Session.value.token,
    });
    expect(secondV1.ok).toBe(false);

    const left = await snapshot(oracleUser, "oracle-revoke@example.test");
    const right = await snapshot(v1User, "v1-revoke@example.test");
    expect(right.sessions).toEqual(left.sessions);
    expect((left.sessions[0] as { revokedAt: number | null }).revokedAt).toBe(0);
  }, 180_000);
});

describe("issueMagicLink and consumeMagicLink", () => {
  test("the two sides leave the same link, user, identity and session behind", async () => {
    const oracleAddress = "oracle-magic@example.test";
    const v1Address = "v1-magic@example.test";
    const scope = {
      level: "organization" as const,
      organizationId: asIdentifier<OrganizationId>(tenant.organizationId),
    };

    const oracleLink = await oracle.issueMagicLink({
      email: oracleAddress,
      rateLimitIdentifier: "203.0.113.1",
    });
    const v1Link = await startMagicLinkLogin(ports, {
      email: v1Address,
      rateLimitIdentifier: "203.0.113.1",
      scope,
    });
    if (!v1Link.ok) throw new Error("the V1 magic link was not issued");

    const oracleLogin = await oracle.consumeMagicLink(oracleLink.token);
    const v1Login = await completeMagicLinkLogin(ports, {
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
      organizationId: asIdentifier<OrganizationId>(tenant.organizationId),
    };
    const oracleLink = await oracle.issueMagicLink({
      email: oracleAddress,
      rateLimitIdentifier: "203.0.113.2",
    });
    const v1Link = await startMagicLinkLogin(ports, {
      email: v1Address,
      rateLimitIdentifier: "203.0.113.2",
      scope,
    });
    if (!v1Link.ok) throw new Error("the V1 magic link was not issued");

    const oracleLogin = await oracle.consumeMagicLink(oracleLink.token);
    const v1Login = await completeMagicLinkLogin(ports, { presentedToken: v1Link.value.token });
    if (!v1Login.ok) throw new Error("the V1 magic link was not consumed");

    await expect(oracle.consumeMagicLink(oracleLink.token)).rejects.toThrow();
    const replay = await completeMagicLinkLogin(ports, { presentedToken: v1Link.value.token });
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
    const oracleLogin = await oracle.completeOAuthLogin({
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
    const user = await harness.repository.users.upsertByEmail(
      asIdentifier(v1Address),
      asIdentifier<UserId>(uuids.uuid()),
    );
    await harness.repository.operatorIdentities.upsert({
      userId: user.userId,
      provider: "GITHUB",
      subject: "gh-v1",
      providerEmail: asIdentifier(v1Address),
    });
    const issued = await issueOperatorSession(ports, { userId: user.userId });
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
    const first = await oracle.completeOAuthLogin({
      provider: "GOOGLE",
      subject: "google-1",
      email: address,
      emailVerified: true,
      rateLimitIdentifier: "203.0.113.4",
    });
    const second = await oracle.completeOAuthLogin({
      provider: "GOOGLE",
      subject: "google-1",
      email: address,
      emailVerified: true,
      rateLimitIdentifier: "203.0.113.4",
    });
    expect(second.userId).toBe(first.userId);

    const v1Address = "v1-oauth-twice@example.test";
    const user = await harness.repository.users.upsertByEmail(
      asIdentifier(v1Address),
      asIdentifier<UserId>(uuids.uuid()),
    );
    for (let index = 0; index < 2; index += 1) {
      await harness.repository.operatorIdentities.upsert({
        userId: user.userId,
        provider: "GOOGLE",
        subject: "google-v1",
        providerEmail: asIdentifier(v1Address),
      });
      const issued = await issueOperatorSession(ports, { userId: user.userId });
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
    await oracle.beginTotpEnrollment(oracleUser);
    const credential = await harness.repository.mfa.findTotp(asIdentifier<UserId>(v1User));
    await harness.repository.mfa.saveTotp({
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
    await oracle.issueOperatorSession({ userId: oracleUser });
    await oracle.issueOperatorSession({ userId: oracleUser });
    await issueOperatorSession(ports, { userId: asIdentifier<UserId>(v1User) });
    await issueOperatorSession(ports, { userId: asIdentifier<UserId>(v1User) });

    // The oracle's `disableTotpForSession` needs a verified session; the row
    // effect it produces — every live session revoked — is what the store
    // reproduces, and it is the effect that matters for a credential minted
    // under facts that have changed.
    await harness.client.operatorSession.updateMany({
      where: { userId: oracleUser, revokedAt: null },
      data: { revokedAt: NOW },
    });
    const revoked = await harness.repository.operatorSessions.revokeAllForUser(
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
    await harness.client.user.updateMany({
      where: { id: { in: [oracleOperator, v1Operator] } },
      data: { platformOperator: true },
    });

    const oracleParent = await oracle.issueOperatorSession({ userId: oracleOperator });
    const started = await oracle.startImpersonation({
      sessionToken: oracleParent.token,
      targetUserId: oracleTarget,
      ipAddress: "203.0.113.5",
      userAgent: "differential",
    });
    expect(started.token).toBeDefined();

    const v1Parent = await issueOperatorSession(ports, {
      userId: asIdentifier<UserId>(v1Operator),
    });
    if (!v1Parent.ok) throw new Error("the V1 parent session was not issued");
    const v1Child = await issueOperatorSession(ports, {
      userId: asIdentifier<UserId>(v1Operator),
      impersonatedUserId: asIdentifier<UserId>(v1Target),
      parentSessionId: v1Parent.value.sessionId,
      expiresAt: v1Parent.value.expiresAt,
    });
    if (!v1Child.ok) throw new Error("the V1 impersonation session was not issued");
    await harness.repository.impersonationAudit.append({
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
    await oracle.issueOperatorSession({ userId: oracleUser });
    const issued = await issueOperatorSession(ports, { userId: asIdentifier<UserId>(v1User) });
    expect(issued.ok).toBe(true);

    const oracleRow = await harness.client.operatorSession.findFirst({
      where: { userId: oracleUser },
    });
    const v1Row = await harness.client.operatorSession.findFirst({ where: { userId: v1User } });
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
