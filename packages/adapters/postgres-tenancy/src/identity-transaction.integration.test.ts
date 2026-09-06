// Transaction boundaries for the identity-access half, proved by FAILURE
// INJECTION against a real database.
//
// Prose does not establish atomicity and a fake cannot: an in-memory unit of
// work has nothing to roll back, so a store that wrote outside its transaction
// would look identical to one that did not. Every case below forces a real
// failure at a chosen point and then asks the database what survived.
//
// THE `cost-monitoring` TRAP IS ASSERTED, NOT DESCRIBED. A use case that returns
// an error `Result` has RETURNED — the callback resolved — so the transaction
// COMMITS. Only a thrown error rolls back. That is the single most expensive
// misunderstanding available here, so it is a passing test with the surviving
// row counted rather than a paragraph.
//
// THE THREE REFUSALS BIND THE IDENTITY-ACCESS WRITES TOO. `transactions.atomic`
// resolves its client through `writer()`, so `replaceRecoveryCodes`,
// `saveTokenPair`, `commitRotation` and `revokeAll` are held to exactly the
// three-code refusal set a tenancy write is held to.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AccessKeyId,
  AuthorizationScope,
  OAuthClientId,
  OAuthRefreshTokenRecord,
  OAuthTokenId,
  OperatorSessionId,
  OrganizationId,
  RotationFamilyId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";
import { domainError, err, runResult } from "@platos/kernel";

import { AT, digest, EXPIRES, LATER } from "./identity-conformance.js";
import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";
import {
  createTenancyTransactions,
  TRANSACTION_NOT_OPEN,
  TRANSACTION_SCOPE_FOREIGN,
  TRANSACTION_SCOPE_UNKNOWN,
  TransactionScopeError,
} from "./transaction.js";

let harness: IdentityHarness;
let tenant: SeededTenant;
let userId: string;

beforeAll(async () => {
  harness = await startIdentityHarness();
  tenant = await harness.seedTenant("identity-txn");
  userId = await harness.seedUser("txn@example.test");
  await harness.seedMembership(tenant.organizationId, userId);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

async function countRecoveryCodes(subject: string): Promise<number> {
  return harness.client.operatorMfaRecoveryCode.count({ where: { userId: subject } });
}

describe("failure injection: neither row survives", () => {
  test("a session write and an audit append inside one UnitOfWork.run roll back together", async () => {
    const sessionId = harness.freshId("0300");
    await expect(
      harness.adapter.unitOfWork.run(async () => {
        await harness.repository.operatorSessions.save({
          sessionId: asIdentifier<OperatorSessionId>(sessionId),
          tokenHash: digest("a1"),
          tier: "OPERATOR",
          userId: asIdentifier<UserId>(userId),
          impersonatedUserId: null,
          parentSessionId: null,
          mfaVerifiedAt: null,
          expiresAt: EXPIRES,
          revokedAt: null,
          lastSeenAt: null,
          createdAt: AT,
        });
        // The SECOND write fails: an audit row pointing at a session that does
        // not exist violates the foreign key. Chosen because it is a failure
        // the database raises rather than one this suite simulates.
        await harness.repository.impersonationAudit.append({
          action: "START",
          actorUserId: asIdentifier<UserId>(userId),
          targetUserId: asIdentifier<UserId>(userId),
          impersonationSessionId: asIdentifier<OperatorSessionId>(harness.freshId("0301")),
          ipAddress: null,
          userAgent: null,
          recordedAt: AT,
        });
      }),
    ).rejects.toThrow();
    // The FIRST write must be gone. Without the ambient frame in
    // `./transaction.ts` it would have run on a pooled connection outside the
    // transaction and would still be here.
    expect(
      await harness.client.operatorSession.count({ where: { id: sessionId } }),
    ).toBe(0);
  }, 120_000);

  test("replaceRecoveryCodes never leaves an operator with no codes at all", async () => {
    const subject = await harness.seedUser("recovery@example.test");
    await harness.repository.mfa.replaceRecoveryCodes(asIdentifier<UserId>(subject), [
      digest("b2"),
      digest("c3"),
    ]);
    expect(await countRecoveryCodes(subject)).toBe(2);
    // The delete happens first and the insert second. A malformed digest in the
    // NEW set is refused by the adapter's guard before either statement runs;
    // this case forces the failure on the INSERT instead, by handing a
    // well-formed duplicate that the (userId, codeHash) unique index refuses.
    await expect(
      harness.repository.mfa.replaceRecoveryCodes(asIdentifier<UserId>(subject), [
        digest("d4"),
        digest("d4"),
      ]),
    ).rejects.toThrow();
    // Still TWO — the original set. The window in which the operator has no
    // recovery codes at all is inside the transaction and never observable.
    expect(await countRecoveryCodes(subject)).toBe(2);
    const survivors = await harness.client.operatorMfaRecoveryCode.findMany({
      where: { userId: subject },
      select: { codeHash: true },
      orderBy: { codeHash: "asc" },
    });
    expect(survivors.map((row) => row.codeHash)).toEqual([digest("b2"), digest("c3")].sort());
  }, 120_000);

  test("saveTokenPair rolls the new pair back when the presented token was consumed concurrently", async () => {
    const clientId = await harness.seedOAuthClient(tenant.organizationId, userId);
    const familyId = harness.freshId("0302");
    const scope: AuthorizationScope = {
      kind: "ORGANIZATION",
      tenant: {
        level: "organization",
        organizationId: asIdentifier<OrganizationId>(tenant.organizationId),
      },
    };
    const first: OAuthRefreshTokenRecord = {
      tokenId: asIdentifier<OAuthTokenId>(harness.freshId("0303")),
      tokenHash: digest("e5"),
      accessTokenId: null,
      clientId: asIdentifier<OAuthClientId>(clientId),
      userId: asIdentifier<UserId>(userId),
      scope,
      scopes: ["read"],
      rotationFamilyId: asIdentifier<RotationFamilyId>(familyId),
      parentRefreshTokenId: null,
      issuedAt: AT,
      expiresAt: EXPIRES,
      consumedAt: null,
      replayDetectedAt: null,
      revokedAt: null,
    };
    await harness.repository.oauth.saveTokenPair({
      accessToken: {
        tokenId: asIdentifier<OAuthTokenId>(harness.freshId("0304")),
        tokenHash: digest("f6"),
        clientId: asIdentifier<OAuthClientId>(clientId),
        userId: asIdentifier<UserId>(userId),
        scope,
        scopes: ["read"],
        issuedAt: AT,
        expiresAt: EXPIRES,
        revokedAt: null,
      },
      refreshToken: first,
      consumedRefreshToken: null,
      expiresInSeconds: 3600,
    });
    // Somebody else exchanges it first.
    await harness.client.oAuthRefreshToken.updateMany({
      where: { tokenHash: digest("e5") },
      data: { consumedAt: LATER },
    });
    await expect(
      harness.repository.oauth.saveTokenPair({
        accessToken: {
          tokenId: asIdentifier<OAuthTokenId>(harness.freshId("0305")),
          tokenHash: digest("07"),
          clientId: asIdentifier<OAuthClientId>(clientId),
          userId: asIdentifier<UserId>(userId),
          scope,
          scopes: ["read"],
          issuedAt: LATER,
          expiresAt: EXPIRES,
          revokedAt: null,
        },
        refreshToken: {
          ...first,
          tokenId: asIdentifier<OAuthTokenId>(harness.freshId("0306")),
          tokenHash: digest("11"),
          parentRefreshTokenId: first.tokenId,
          issuedAt: LATER,
        },
        consumedRefreshToken: { ...first, consumedAt: LATER },
        expiresInSeconds: 3600,
      }),
    ).rejects.toThrow(/consumed concurrently/u);
    // NEITHER half of the new pair survives. A double-mint of one refresh token
    // is the failure rotation exists to make impossible, and an implementation
    // that marked the presented token unconditionally would have produced two
    // live pairs here.
    expect(await harness.client.oAuthAccessToken.count({ where: { tokenHash: digest("07") } })).toBe(0);
    expect(
      await harness.client.oAuthRefreshToken.count({ where: { tokenHash: digest("11") } }),
    ).toBe(0);
  }, 120_000);

  test("a RETURNED error Result ROLLS BACK — the cost-monitoring trap, closed", async () => {
    const sessionId = harness.freshId("0307");
    const result = await runResult(harness.adapter.unitOfWork, async () => {
      await harness.repository.operatorSessions.save({
        sessionId: asIdentifier<OperatorSessionId>(sessionId),
        tokenHash: digest("22"),
        tier: "OPERATOR",
        userId: asIdentifier<UserId>(userId),
        impersonatedUserId: null,
        parentSessionId: null,
        mfaVerifiedAt: null,
        expiresAt: EXPIRES,
        revokedAt: null,
        lastSeenAt: null,
        createdAt: AT,
      });
      // A use case that decided the request was unauthorized and RETURNED. This
      // case used to assert that the callback RESOLVED, so the transaction
      // committed and the session row was left live — a session written for a
      // request that was refused. WIN-260 (M2.5) made the shape unwritable:
      // `run` no longer takes a `Result`-valued callback, and `runResult` aborts
      // on `err`. Counted over the client, after the transaction, the row is
      // gone.
      return err(domainError("UNAUTHENTICATED", "unauthenticated", "the request was not authenticated"));
    });
    expect(result.ok).toBe(false);
    expect(await harness.client.operatorSession.count({ where: { id: sessionId } })).toBe(0);
  }, 120_000);

  test("a rotation that fails after its first write leaves no orphan key", async () => {
    const environment = (await harness.seedTenant("rotation-rollback")).environmentId;
    const nextKeyId = harness.freshId("0308");
    await expect(
      harness.repository.accessKeys.commitRotation({
        environmentId: asIdentifier(environment),
        plan: {
          nextKey: {
            accessKeyId: asIdentifier<AccessKeyId>(nextKeyId),
            environmentId: asIdentifier(environment),
            keyPrefix: "platos_live_aaa",
            keyHash: digest("33"),
            allowedOrigins: [],
            validUntil: null,
            replacedById: null,
            revokedAt: null,
            lastUsedAt: null,
          },
          // A retiring key that is not there. The UPDATE between the two writes
          // fails, and the key inserted first must not survive it.
          retiringKey: {
            accessKeyId: asIdentifier<AccessKeyId>(harness.freshId("0309")),
            environmentId: asIdentifier(environment),
            keyPrefix: "platos_live_zzz",
            keyHash: digest("44"),
            allowedOrigins: [],
            validUntil: LATER,
            replacedById: null,
            revokedAt: null,
            lastUsedAt: null,
          },
          overlapEndsAt: LATER,
        },
        observedGeneration: 0,
      }),
    ).rejects.toThrow();
    expect(await harness.client.accessKey.count({ where: { id: nextKeyId } })).toBe(0);
  }, 120_000);
});

describe("a read joins the open transaction rather than answering from the pool", () => {
  test("a read between two writes of one transaction sees the first write", async () => {
    const sessionId = harness.freshId("0310");
    const seen = await harness.adapter.unitOfWork.run(async () => {
      await harness.repository.operatorSessions.save({
        sessionId: asIdentifier<OperatorSessionId>(sessionId),
        tokenHash: digest("55"),
        tier: "OPERATOR",
        userId: asIdentifier<UserId>(userId),
        impersonatedUserId: null,
        parentSessionId: null,
        mfaVerifiedAt: null,
        expiresAt: EXPIRES,
        revokedAt: null,
        lastSeenAt: null,
        createdAt: AT,
      });
      // The port gives a READ no transaction parameter at all. Without the
      // ambient frame this would run on a pooled connection and answer `null`,
      // and every test that only checked the final state would still be green.
      return harness.repository.operatorSessions.findById(
        asIdentifier<OperatorSessionId>(sessionId),
      );
    });
    expect(seen?.sessionId).toBe(sessionId);
  }, 120_000);

  test("an identity-access write and a tenancy write inside one run are ONE transaction", async () => {
    // The property ADR M0.3 §15 buys. Two adapter packages would have meant two
    // pools and two transactions, and a window in which one half is committed.
    const organizationId = harness.freshId("0311");
    const subject = harness.freshId("0312");
    await expect(
      harness.adapter.unitOfWork.run(async (transaction) => {
        await harness.adapter.saveOrganization(
          {
            id: asIdentifier(organizationId),
            slug: asIdentifier(`atomic-${organizationId.slice(0, 8)}`),
            name: "Atomic",
            archivedAt: null,
            createdAt: AT,
            updatedAt: AT,
          },
          transaction,
        );
        await harness.repository.users.upsertByEmail(
          asIdentifier("atomic@example.test"),
          asIdentifier<UserId>(subject),
        );
        throw new Error("injected");
      }),
    ).rejects.toThrow("injected");
    expect(await harness.client.organization.count({ where: { id: organizationId } })).toBe(0);
    expect(await harness.client.user.count({ where: { id: subject } })).toBe(0);
  }, 120_000);
});

describe("the three refusals, three codes, still bind after atomic() joined them", () => {
  // `transactions.atomic` — added by this tranche so an identity-access
  // multi-statement write can be atomic without a `TransactionScope` in its
  // signature — resolves its client through `writer()`. So every guard below is
  // on the path `replaceRecoveryCodes`, `saveTokenPair`, `commitRotation` and
  // `revokeAll` take, and these three cases are the regression control on that.
  function codeOf(error: unknown): string {
    return error instanceof TransactionScopeError ? error.code : `unexpected: ${String(error)}`;
  }

  test("a write with no open transaction is refused as not_open", async () => {
    const transactions = createTenancyTransactions(harness.client);
    let refusal: unknown;
    try {
      transactions.writer({ transactionId: asIdentifier("pg-txn-absent") } as never);
    } catch (error) {
      refusal = error;
    }
    expect(codeOf(refusal)).toBe(TRANSACTION_NOT_OPEN);
  }, 60_000);

  test("a token whose transaction has finished is refused as scope_unknown", async () => {
    const transactions = createTenancyTransactions(harness.client);
    let stale: { transactionId: string } | undefined;
    await transactions.unitOfWork.run(async (transaction) => {
      stale = transaction;
    });
    let refusal: unknown;
    await transactions.unitOfWork.run(async () => {
      try {
        transactions.writer(stale as never);
      } catch (error) {
        refusal = error;
      }
    });
    expect(codeOf(refusal)).toBe(TRANSACTION_SCOPE_UNKNOWN);
  }, 60_000);

  test("another live transaction's token is refused as scope_foreign", async () => {
    // A second transaction opened OUTSIDE any ambient frame — genuinely
    // concurrent rather than the nested JOIN `unitOfWork.run` performs by
    // design — and held open on a gate. Its token IS in the registry, so
    // `scope_unknown` cannot explain this refusal and only the identity check
    // can. That is the distinction the two separate codes exist to preserve.
    const transactions = createTenancyTransactions(harness.client);
    let release = (): void => undefined;
    const gate = new Promise<void>((settle) => {
      release = settle;
    });
    let concurrent: { transactionId: string } | undefined;
    const held = new Promise<void>((ready) => {
      void transactions.unitOfWork.run(async (transaction) => {
        concurrent = transaction;
        ready();
        await gate;
      });
    });
    await held;

    let refusal: unknown;
    await transactions.unitOfWork.run(async () => {
      try {
        transactions.writer(concurrent as never);
      } catch (error) {
        refusal = error;
      }
    });
    release();
    expect(codeOf(refusal)).toBe(TRANSACTION_SCOPE_FOREIGN);
  }, 60_000);

  test("the three codes are distinct", () => {
    expect(
      new Set([TRANSACTION_NOT_OPEN, TRANSACTION_SCOPE_UNKNOWN, TRANSACTION_SCOPE_FOREIGN]).size,
    ).toBe(3);
  });
});
