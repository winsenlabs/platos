// The identity-access conformance differential: the in-memory fake and this
// adapter, asked the SAME questions against a REAL PostgreSQL, compared
// verbatim.
//
// WHY THE COMPARISON IS THE TEST. A suite written against the adapter alone
// asserts what its author believed; a suite written against the fake alone
// asserts nothing about the database. Running one scenario twice and comparing
// the observation maps makes a divergence a named step with a value on each
// side — and it has already earned that: it is how this tranche found that the
// adapter's `operatorIdentities.upsert` was keyed on the wrong one of the
// table's two unique indexes, and that the fake could not represent an
// `OAuthAccessToken` and therefore understated `revokeRotationFamily`.
//
// Excluded from `vitest run` by vitest.config.ts and run by
// `pnpm test:postgres-tenancy:integration` in its own CI job. It FAILS when
// Docker is absent rather than skipping.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { inMemoryIdentityAccessRepository } from "@platos/context-identity-access/application/index.js";
import type {
  EmailAddress,
  EndUserId,
  EndUserIdentityId,
  IdentityAccessRepository,
  OperatorSessionId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import type { IdentityConformanceIds } from "./identity-conformance.js";
import { AT, digest, EXPIRES, runIdentityConformance } from "./identity-conformance.js";
import type { IdentityHarness } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

let harness: IdentityHarness;

beforeAll(async () => {
  harness = await startIdentityHarness();
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

const EARLIER = new Date("2026-04-01T09:00:00.000Z");

/** The two end users every run seeds, newest first once ordered. */
const END_USERS = [
  { displayName: "Ada Lovelace", disabledAt: null, createdAt: AT, subject: "slack-u1" },
  { displayName: "Grace Hopper", disabledAt: EARLIER, createdAt: EARLIER, subject: "email-u2" },
] as const;

describe("the shared identity-access conformance scenario", () => {
  test("the postgres adapter and the in-memory fake answer it identically", async () => {
    const tenant = await harness.seedTenant("identity-conformance");
    const ids: IdentityConformanceIds = {
      userId: harness.freshId("0100"),
      otherUserId: harness.freshId("0101"),
      sessionId: harness.freshId("0102"),
      secondSessionId: harness.freshId("0103"),
      environmentId: tenant.environmentId,
      organizationId: tenant.organizationId,
      firstKeyId: harness.freshId("0104"),
      secondKeyId: harness.freshId("0105"),
      clientId: "",
      accessTokenId: harness.freshId("0106"),
      refreshTokenId: harness.freshId("0107"),
      nextAccessTokenId: harness.freshId("0108"),
      nextRefreshTokenId: harness.freshId("0109"),
      rotationFamilyId: harness.freshId("0110"),
      mcpTokenHash: digest("ab"),
    };

    // --- the real store -----------------------------------------------------
    const realIds: IdentityConformanceIds = { ...ids };
    const realObserved = await runIdentityConformance({
      repository: harness.repository,
      ids: realIds,
      async seed() {
        // `seed` runs AFTER the user step, so the OAuth client can be
        // registered by the user the scenario just created.
        // The membership is not decoration: `enforce_domain_ancestry` refuses
        // every OAuth and MCP row below whose acting user is not an ACTIVE
        // member of the organization the scope resolves to.
        await harness.seedMembership(tenant.organizationId, ids.userId);
        const clientId = await harness.seedOAuthClient(tenant.organizationId, ids.userId);
        Object.assign(realIds, { clientId });
        await harness.seedAuthorizationCode({
          clientId,
          userId: ids.userId,
          codeHash: digest("33"),
          scopeKind: "PROJECT",
          organizationId: null,
          projectId: tenant.projectId,
          environmentId: null,
          expiresAt: EXPIRES,
        });
        await harness.seedMcpToken({
          environmentId: tenant.environmentId,
          mintedByUserId: ids.userId,
          tokenHash: ids.mcpTokenHash,
          permissions: ["tools:read"],
          // "scope", NOT a PrincipalTier. The column is the MCP permission tier.
          tier: "scope",
        });
        for (const [index, endUser] of END_USERS.entries()) {
          await harness.seedEndUser({
            organizationId: tenant.organizationId,
            displayName: endUser.displayName,
            disabledAt: endUser.disabledAt,
            createdAt: endUser.createdAt,
            identities: [{ subject: endUser.subject, channel: `channel-${String(index)}` }],
          });
        }
      },
    });

    // --- the fake, given the SAME identifiers and the same seeded rows -------
    const fakeIds: IdentityConformanceIds = { ...ids, clientId: realIds.clientId };
    const fake = inMemoryIdentityAccessRepository();
    const fakeObserved = await runIdentityConformance({
      repository: fake,
      ids: fakeIds,
      async seed() {
        fake.state.revocationGenerations.set(
          asIdentifier(tenant.environmentId),
          // The real `Environment` row exists with generation 0. A fake whose
          // map is empty would answer `null` here, which is a different answer
          // to the same question and is exactly what this comparison is for.
          0,
        );
        fake.state.authorizationCodes.set(digest("33"), {
          codeHash: digest("33"),
          clientId: asIdentifier(realIds.clientId),
          userId: asIdentifier<UserId>(ids.userId),
          scope: {
            kind: "PROJECT",
            tenant: {
              level: "project",
              organizationId: asIdentifier(tenant.organizationId),
              projectId: asIdentifier(tenant.projectId),
            },
          },
          scopes: ["read"],
          codeChallenge: "challenge",
          codeChallengeMethod: "S256",
          redirectUri: "https://example.test/cb",
          expiresAt: EXPIRES,
          usedAt: null,
        });
        fake.state.bearerCredentials.set(`mcp-token:${ids.mcpTokenHash}`, {
          credentialId: "<minted>",
          kind: "mcp-token",
          tokenHash: asIdentifier<TokenHash>(ids.mcpTokenHash),
          tier: "OPERATOR",
          principalId: asIdentifier(ids.userId),
          scope: {
            kind: "ENVIRONMENT",
            tenant: {
              level: "environment",
              organizationId: asIdentifier(tenant.organizationId),
              projectId: asIdentifier(tenant.projectId),
              environmentId: asIdentifier(tenant.environmentId),
            },
          },
          permissions: ["tools:read"],
          expiresAt: null,
          revokedAt: null,
          lastUsedAt: null,
        });
        for (const [index, endUser] of END_USERS.entries()) {
          const endUserId = asIdentifier<EndUserId>(`fake-end-user-${String(index)}`);
          fake.state.endUsers.set(endUserId, {
            endUserId,
            organizationId: asIdentifier(tenant.organizationId),
            displayName: endUser.displayName,
            disabledAt: endUser.disabledAt,
            createdAt: endUser.createdAt,
          });
          const identityId = asIdentifier<EndUserIdentityId>(`fake-identity-${String(index)}`);
          fake.state.endUserIdentities.set(identityId, {
            identityId,
            endUserId,
            issuer: "platos",
            channel: `channel-${String(index)}`,
            subject: endUser.subject,
            verifiedAt: null,
            disabledAt: null,
          });
        }
      },
    });

    // The identifiers of rows neither store chose are normalised away, and
    // NOTHING ELSE is: dates, counts, booleans, ordering and null-versus-absent
    // all compare literally.
    expect(normalise(realObserved)).toEqual(normalise(fakeObserved));

    // Non-vacuity. The scenario has to have observed something, and the values
    // this tranche turns on are pinned by value rather than by agreement.
    expect(Object.keys(realObserved).length).toBeGreaterThan(45);
    expect(realObserved.firstConsume).toBe(true);
    expect(realObserved.secondConsume).toBe(false);
    expect(realObserved.advanceFirst).toBe(true);
    expect(realObserved.advanceReplay).toBe(false);
    expect(realObserved.firstRotation).toEqual({ committed: true, generation: 0 });
    expect(realObserved.supersededRotation).toEqual({ committed: false, generation: 1 });
    // Two refresh tokens plus the two access tokens they point at.
    expect(realObserved.familyRevoked).toBe(4);
    expect(realObserved.endUserTotal).toBe(2);
    expect(realObserved.searchBySubject).toBe(1);
    expect(realObserved.otherTenant).toBe(0);
  }, 300_000);
});

/** Replace the identifiers neither store chose with a stable label. */
function normalise(observation: Record<string, unknown>): Record<string, unknown> {
  const seen = JSON.stringify(observation, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  });
  const withoutMinted = seen
    .replace(/"(endUserId|identityId|credentialId)":"[^"]*"/gu, '"$1":"<minted>"')
    .replace(/"userAgent":"conformance"/gu, '"userAgent":"conformance"');
  return JSON.parse(withoutMinted) as Record<string, unknown>;
}

describe("the double is measured, not trusted", () => {
  test("a readable placeholder digest is accepted by the fake and refused by PostgreSQL", async () => {
    // The single most important case in this package. `TokenHash` is a branded
    // STRING, so `"session-token-1"` type-checks and satisfies every unit test
    // in the tree — and `OperatorSession_tokenHash_check` refuses it.
    const fake: IdentityAccessRepository = inMemoryIdentityAccessRepository();
    const userId = asIdentifier<UserId>(await harness.seedUser("placeholder@example.test"));
    const session = {
      sessionId: asIdentifier<OperatorSessionId>(harness.freshId("0111")),
      tokenHash: asIdentifier<TokenHash>("session-token-1"),
      tier: "OPERATOR" as const,
      userId,
      impersonatedUserId: null,
      parentSessionId: null,
      mfaVerifiedAt: null,
      expiresAt: EXPIRES,
      revokedAt: null,
      lastSeenAt: null,
      createdAt: AT,
    };
    await expect(fake.operatorSessions.save(session)).resolves.toBeUndefined();
    await expect(harness.repository.operatorSessions.save(session)).rejects.toThrow(
      /64 lowercase hexadecimal/u,
    );
  }, 120_000);

  test("an un-normalised address is accepted by the fake and refused by the store", async () => {
    const fake: IdentityAccessRepository = inMemoryIdentityAccessRepository();
    const address = asIdentifier<EmailAddress>("Mixed@Example.Test");
    const newId = asIdentifier<UserId>(harness.freshId("0112"));
    await expect(fake.users.upsertByEmail(address, newId)).resolves.toBeDefined();
    await expect(harness.repository.users.upsertByEmail(address, newId)).rejects.toThrow(
      /lower\(btrim/u,
    );
  }, 120_000);
});
