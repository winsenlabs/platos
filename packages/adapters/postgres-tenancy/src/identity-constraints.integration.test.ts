// What the MIGRATIONS say and `schema.prisma` does not.
//
// Every rule asserted below lives in
// `internal-packages/tenancy-database/prisma/migrations/` and in NO other place
// this code can see: not in the schema file, so not in the generated client's
// types; not in the in-memory double, so not in any unit suite in the tree.
// Tranche 1 found the first of them by having its very first integration run
// refused, and recorded that a readable placeholder digest would have passed
// every unit test that exists. This suite is the systematic version of that
// finding for the twenty-three rows identity-access owns.
//
// EACH TEST NAMES THE CONSTRAINT AND SHOWS IT BITING. A test that merely says
// "the store works" would pass against a database with none of these rules
// installed, which is precisely the database the double is.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  OperatorSessionId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import { digest, AT, EXPIRES, LATER } from "./identity-conformance.js";
import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

let harness: IdentityHarness;
let tenant: SeededTenant;
let userId: string;

beforeAll(async () => {
  harness = await startIdentityHarness();
  tenant = await harness.seedTenant("constraints");
  userId = await harness.seedUser("constraints@example.test");
  await harness.seedMembership(tenant.organizationId, userId);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

const session = (overrides: Record<string, unknown> = {}) => ({
  sessionId: asIdentifier<OperatorSessionId>(harness.freshId("0200")),
  tokenHash: digest("a1"),
  tier: "OPERATOR" as const,
  userId: asIdentifier<UserId>(userId),
  impersonatedUserId: null,
  parentSessionId: null,
  mfaVerifiedAt: null,
  expiresAt: EXPIRES,
  revokedAt: null,
  lastSeenAt: null,
  createdAt: AT,
  ...overrides,
});

describe("the digest CHECKs (five columns, migrations only)", () => {
  test("OperatorSession_tokenHash_check refuses anything but 64 lowercase hex", async () => {
    // The adapter's own guard fires first and names the column. Removing it —
    // mutation M-I01 in mutations.json — leaves PostgreSQL refusing the same
    // input, which is how the two are known to agree rather than to overlap.
    await expect(
      harness.repository.operatorSessions.save(
        session({ tokenHash: asIdentifier<TokenHash>("session-token-1") }),
      ),
    ).rejects.toThrow(/64 lowercase hexadecimal/u);
    await expect(
      harness.client.$executeRawUnsafe(
        `INSERT INTO "OperatorSession" ("id","tokenHash","tier","userId","expiresAt","createdAt") VALUES ($1::uuid,$2,'OPERATOR',$3::uuid,$4::timestamp,$5::timestamp)`,
        harness.freshId("0201"),
        "session-token-1",
        userId,
        EXPIRES,
        AT,
      ),
    ).rejects.toThrow(/OperatorSession_tokenHash_check/u);
  }, 60_000);

  test("MagicLinkToken and OperatorMfaRecoveryCode carry the same CHECK", async () => {
    await expect(
      harness.repository.magicLinks.save({
        tokenHash: asIdentifier<TokenHash>("magic-1"),
        email: asIdentifier("constraints@example.test"),
        expiresAt: EXPIRES,
        consumedAt: null,
        createdAt: AT,
      }),
    ).rejects.toThrow(/64 lowercase hexadecimal/u);
    await expect(
      harness.repository.mfa.replaceRecoveryCodes(asIdentifier<UserId>(userId), [
        asIdentifier<TokenHash>("recovery-1"),
      ]),
    ).rejects.toThrow(/64 lowercase hexadecimal/u);
  }, 60_000);
});

describe("the email normalisation CHECKs (migrations only)", () => {
  test("User_email_normalized_check refuses a mixed-case address", async () => {
    await expect(
      harness.client.$executeRawUnsafe(
        `INSERT INTO "User" ("id","email","createdAt","updatedAt") VALUES ($1::uuid,$2,$3::timestamp,$3::timestamp)`,
        harness.freshId("0202"),
        "Mixed@Example.Test",
        AT,
      ),
    ).rejects.toThrow(/User_email_normalized_check/u);
  }, 60_000);

  test("an un-normalised address is not merely invalid, it is a SECOND account", async () => {
    // `User.email` is UNIQUE, so without the normalisation check
    // `Ada@example.test` and `ada@example.test` would be two rows and two
    // identities for one human. This is the reason the CHECK exists and the
    // reason the adapter refuses before the round trip.
    const lower = await harness.repository.users.upsertByEmail(
      asIdentifier("ada@example.test"),
      asIdentifier<UserId>(harness.freshId("0203")),
    );
    const again = await harness.repository.users.upsertByEmail(
      asIdentifier("ada@example.test"),
      asIdentifier<UserId>(harness.freshId("0204")),
    );
    expect(again.userId).toBe(lower.userId);
  }, 60_000);
});

describe("AccessKey_one_active_per_environment — a PARTIAL unique index", () => {
  test("two active keys for one environment are impossible", async () => {
    const first = harness.freshId("0205");
    await harness.client.$executeRawUnsafe(
      `INSERT INTO "AccessKey" ("id","environmentId","keyPrefix","keyHash","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'platos_live_aaa',$3,$4::timestamp,$4::timestamp)`,
      first,
      tenant.environmentId,
      digest("11"),
      AT,
    );
    await expect(
      harness.client.$executeRawUnsafe(
        `INSERT INTO "AccessKey" ("id","environmentId","keyPrefix","keyHash","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'platos_live_bbb',$3,$4::timestamp,$4::timestamp)`,
        harness.freshId("0206"),
        tenant.environmentId,
        digest("22"),
        AT,
      ),
      // 23505 on `environmentId` ALONE. `AccessKey` has no plain unique index
      // on that column — only `AccessKey_one_active_per_environment`, which is
      // partial — so this error can have come from nowhere else.
    ).rejects.toThrow(/Key \("environmentId"\)/u);
  }, 60_000);

  test("the index is PARTIAL, so a rotation must hide the incoming key first", async () => {
    // The three-statement dance in `identity-access-keys.ts` exists only
    // because of this index. A rotation that inserted the incoming key with a
    // NULL `validUntil` — the obvious two-statement version — is refused here,
    // which is the case that proves the extra statement is load-bearing.
    const environment = (await harness.seedTenant("rotation-index")).environmentId;
    await harness.client.$executeRawUnsafe(
      `INSERT INTO "AccessKey" ("id","environmentId","keyPrefix","keyHash","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'platos_live_aaa',$3,$4::timestamp,$4::timestamp)`,
      harness.freshId("0207"),
      environment,
      digest("33"),
      AT,
    );
    await expect(
      harness.client.$executeRawUnsafe(
        `INSERT INTO "AccessKey" ("id","environmentId","keyPrefix","keyHash","validUntil","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,'platos_live_bbb',$3,$4::timestamp,$5::timestamp,$5::timestamp)`,
        harness.freshId("0208"),
        environment,
        digest("44"),
        LATER,
        AT,
      ),
    ).resolves.toBeDefined();
  }, 60_000);
});

describe("OperatorMfaTotp_active_pending_shape_check", () => {
  test("enrolled with no secret behind it is refused", async () => {
    await expect(
      harness.repository.mfa.saveTotp({
        userId: asIdentifier<UserId>(userId),
        encryptedSecret: null,
        enabledAt: AT,
        lastUsedCounter: null,
        pendingEncryptedSecret: null,
        pendingExpiresAt: null,
      }),
    ).rejects.toThrow(/fully unenrolled or has both/u);
    await expect(
      harness.client.$executeRawUnsafe(
        `INSERT INTO "OperatorMfaTotp" ("id","userId","enabledAt","createdAt","updatedAt") VALUES ($1::uuid,$2::uuid,$3::timestamp,$3::timestamp,$3::timestamp)`,
        harness.freshId("0209"),
        userId,
        AT,
      ),
    ).rejects.toThrow(/OperatorMfaTotp_active_pending_shape_check/u);
  }, 60_000);
});

describe("ImpersonationAudit is append-only IN THE DATABASE", () => {
  test("an update and a delete are both refused by a database-side rule", async () => {
    const sessionId = harness.freshId("0210");
    await harness.repository.operatorSessions.save(
      session({ sessionId: asIdentifier<OperatorSessionId>(sessionId), tokenHash: digest("55") }),
    );
    await harness.repository.impersonationAudit.append({
      action: "START",
      actorUserId: asIdentifier<UserId>(userId),
      targetUserId: asIdentifier<UserId>(userId),
      impersonationSessionId: asIdentifier<OperatorSessionId>(sessionId),
      ipAddress: null,
      userAgent: null,
      recordedAt: AT,
    });
    // Not a convention this store observes: the table REFUSES. A future store
    // that added an `amend` method would fail here rather than quietly editing
    // evidence.
    await expect(
      harness.client.$executeRawUnsafe(
        'UPDATE "ImpersonationAudit" SET "ipAddress" = $1 WHERE "impersonationSessionId" = $2::uuid',
        "203.0.113.9",
        sessionId,
      ),
    ).rejects.toThrow(/ImpersonationAudit is immutable/u);
    await expect(
      harness.client.$executeRawUnsafe(
        'DELETE FROM "ImpersonationAudit" WHERE "impersonationSessionId" = $1::uuid',
        sessionId,
      ),
    ).rejects.toThrow(/ImpersonationAudit is immutable/u);
  }, 60_000);
});

describe("the ancestry rules — the largest class the double cannot carry", () => {
  test("an McpToken minted by a non-member is refused", async () => {
    const stranger = await harness.seedUser("stranger@example.test");
    await expect(
      harness.seedMcpToken({
        environmentId: tenant.environmentId,
        mintedByUserId: stranger,
        tokenHash: digest("66"),
        permissions: [],
        tier: "scope",
      }),
    ).rejects.toThrow(/crosses its canonical owner ancestry/u);
  }, 60_000);

  test("an authorization code whose scope leaves the client's organization is refused", async () => {
    const other = await harness.seedTenant("other-tenant");
    const clientId = await harness.seedOAuthClient(tenant.organizationId, userId);
    await expect(
      harness.seedAuthorizationCode({
        clientId,
        userId,
        codeHash: digest("77"),
        scopeKind: "PROJECT",
        organizationId: null,
        projectId: other.projectId,
        environmentId: null,
        expiresAt: EXPIRES,
      }),
    ).rejects.toThrow(/crosses its canonical owner ancestry/u);
  }, 60_000);

  test("the ancestry rule fires on UPDATE as well as INSERT", async () => {
    // Consequential and worth stating plainly: revoking a rotation family for a
    // user whose membership has since been DEACTIVATED fails, because every
    // UPDATE re-checks the ancestry. That is the database's decision, not this
    // store's, and it is recorded here rather than discovered in production.
    const scoped = await harness.seedTenant("update-ancestry");
    const actor = await harness.seedUser("update-ancestry@example.test");
    await harness.seedMembership(scoped.organizationId, actor);
    const tokenId = harness.freshId("0211");
    await harness.seedMcpToken({
      environmentId: scoped.environmentId,
      mintedByUserId: actor,
      tokenHash: digest("88"),
      permissions: [],
      tier: "scope",
    });
    await harness.client.$executeRawUnsafe(
      `UPDATE "OrganizationMembership" SET "deactivatedAt" = $1::timestamp WHERE "organizationId" = $2::uuid AND "userId" = $3::uuid`,
      LATER,
      scoped.organizationId,
      actor,
    );
    await expect(
      harness.client.$executeRawUnsafe(
        'UPDATE "McpToken" SET "lastUsedAt" = $1::timestamp WHERE "tokenHash" = $2',
        LATER,
        digest("88"),
      ),
    ).rejects.toThrow(/crosses its canonical owner ancestry/u);
    expect(tokenId).toBeDefined();
  }, 60_000);
});

describe("OperatorIdentity carries TWO unique indexes and they mean different things", () => {
  test("a second subject for the same (user, provider) is refused", async () => {
    // The adapter upserts on (provider, subject), which is `completeOAuthLogin`'s
    // key. The consequence is that a second subject for a user who already has
    // a GitHub identity is an INSERT, and
    // `OperatorIdentity_userId_provider_key` refuses it. The double carries
    // neither index and accepts it silently.
    const person = asIdentifier<UserId>(await harness.seedUser("two-subjects@example.test"));
    await harness.repository.operatorIdentities.upsert({
      userId: person,
      provider: "GITHUB",
      subject: "subject-a",
      providerEmail: asIdentifier("two-subjects@example.test"),
    });
    await expect(
      harness.repository.operatorIdentities.upsert({
        userId: person,
        provider: "GITHUB",
        subject: "subject-b",
        providerEmail: asIdentifier("two-subjects@example.test"),
      }),
    ).rejects.toThrow();
  }, 60_000);
});

describe("the store's own refusals, on a real database", () => {
  test("revokeAllForUser reaches a session that IMPERSONATES the user", async () => {
    // Both arms of the filter matter. A privilege change must not leave an
    // operator holding a live session OVER the account whose facts changed, and
    // a filter on `userId` alone would leave exactly that.
    const operator = await harness.seedUser("revoke-operator@example.test");
    const target = await harness.seedUser("revoke-target@example.test");
    await harness.client.user.updateMany({
      where: { id: operator },
      data: { platformOperator: true },
    });
    const parentId = harness.freshId("0215");
    await harness.repository.operatorSessions.save(
      session({
        sessionId: asIdentifier<OperatorSessionId>(parentId),
        tokenHash: digest("cc"),
        userId: asIdentifier<UserId>(operator),
      }),
    );
    await harness.repository.operatorSessions.save(
      session({
        sessionId: asIdentifier<OperatorSessionId>(harness.freshId("0216")),
        tokenHash: digest("dd"),
        userId: asIdentifier<UserId>(operator),
        impersonatedUserId: asIdentifier<UserId>(target),
        parentSessionId: asIdentifier<OperatorSessionId>(parentId),
      }),
    );
    // The TARGET has no session of their own; the only credential naming them is
    // the impersonating one, and revoking for the target must reach it.
    const revoked = await harness.repository.operatorSessions.revokeAllForUser(
      asIdentifier<UserId>(target),
      LATER,
    );
    expect(revoked).toBe(1);
  }, 60_000);

  test("bearerCredentials.save refuses a credential with no row behind it", async () => {
    // `save` UPDATES. Every one of the four tables carries required columns the
    // port cannot supply, so a save that created a row would be minting a
    // credential through a method that cannot mint.
    await expect(
      harness.repository.bearerCredentials.save({
        credentialId: harness.freshId("0217"),
        kind: "mcp-token",
        tokenHash: digest("ee"),
        tier: "OPERATOR",
        principalId: asIdentifier(userId),
        scope: { kind: "GLOBAL" },
        permissions: [],
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: LATER,
      }),
    ).rejects.toThrow(/save updates a credential, it does not mint one/u);
  }, 60_000);
});

describe("the session parent and cascade rules", () => {
  test("a child session may not outlive its parent, and revoking the parent revokes it", async () => {
    const parentId = harness.freshId("0212");
    await harness.repository.operatorSessions.save(
      session({ sessionId: asIdentifier<OperatorSessionId>(parentId), tokenHash: digest("99") }),
    );
    // OperatorSession_parent_active: a child whose expiry is beyond its
    // parent's is refused outright.
    await expect(
      harness.repository.operatorSessions.save(
        session({
          sessionId: asIdentifier<OperatorSessionId>(harness.freshId("0213")),
          tokenHash: digest("aa"),
          parentSessionId: asIdentifier<OperatorSessionId>(parentId),
          impersonatedUserId: asIdentifier<UserId>(userId),
          expiresAt: new Date(EXPIRES.getTime() + 1000),
        }),
      ),
    ).rejects.toThrow(/parent must be active/u);

    const childId = harness.freshId("0214");
    await harness.repository.operatorSessions.save(
      session({
        sessionId: asIdentifier<OperatorSessionId>(childId),
        tokenHash: digest("bb"),
        parentSessionId: asIdentifier<OperatorSessionId>(parentId),
        impersonatedUserId: asIdentifier<UserId>(userId),
      }),
    );
    const parent = await harness.repository.operatorSessions.findById(
      asIdentifier<OperatorSessionId>(parentId),
    );
    if (parent === null) throw new Error("the parent session was not written");
    await harness.repository.operatorSessions.save({ ...parent, revokedAt: LATER });
    // OperatorSession_cascade_revocation: the child is revoked by the database,
    // not by this store. An implementation that forgot to cascade would still
    // pass, which is exactly why this is asserted against the real one.
    const child = await harness.repository.operatorSessions.findById(
      asIdentifier<OperatorSessionId>(childId),
    );
    expect(child?.revokedAt).toEqual(LATER);
  }, 60_000);
});
