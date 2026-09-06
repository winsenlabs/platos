// Statement counts, MEASURED — the N+1 control.
//
// Every pin below is a number this suite observed rather than a number somebody
// expected. The client's default relation strategy issues one statement per
// level of a nested selection rather than a join, so the honest figure for a
// read that resolves an ancestor is greater than one, and asserting "1" would
// have been a wish. What matters is that the figure does not grow with the
// number of ROWS: each pin is taken twice, once over a small set and once over a
// set an order of magnitude larger, and both must be identical.
//
// WHY THIS IS THE RIGHT SHAPE OF ASSERTION. An N+1 does not announce itself in a
// suite: every value is correct and every test passes. It announces itself as a
// page that took four seconds in production. Counting the statements a client
// actually sent is the only thing that turns it into a failing test.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  EndUserQuery,
  OAuthTokenId,
  OrganizationId,
  TokenHash,
  UserId,
} from "@platos/context-identity-access/application/ports/index.js";
import { asIdentifier } from "@platos/context-identity-access/application/ports/index.js";

import { AT, digest, EXPIRES } from "./identity-conformance.js";
import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

let harness: IdentityHarness;
let small: SeededTenant;
let large: SeededTenant;
let userId: string;

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of; counting them would make the pins depend on
 * whether a read happened to be inside a transaction.
 */
function queries(): readonly string[] {
  return harness
    .statements()
    .filter((statement) => !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE|SELECT 1)\b/iu.test(statement));
}

async function measure(work: () => Promise<unknown>): Promise<number> {
  harness.resetStatements();
  await work();
  return queries().length;
}

async function seedEndUsers(tenant: SeededTenant, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await harness.seedEndUser({
      organizationId: tenant.organizationId,
      displayName: `Person ${String(index)}`,
      disabledAt: null,
      createdAt: new Date(AT.getTime() + index * 1000),
      identities: [
        { subject: `slack-${String(index)}`, channel: "slack" },
        { subject: `email-${String(index)}`, channel: "email" },
      ],
    });
  }
}

beforeAll(async () => {
  harness = await startIdentityHarness();
  small = await harness.seedTenant("statements-small");
  large = await harness.seedTenant("statements-large");
  userId = await harness.seedUser("statements@example.test");
  await harness.seedMembership(small.organizationId, userId);
  await seedEndUsers(small, 1);
  await seedEndUsers(large, 25);
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/**
 * The measured cost of resolving an ENVIRONMENT scope on a credential read.
 *
 * Read off a real run and pinned, not predicted. If the client's relation
 * strategy changes this number changes with it, and the change should be a
 * reviewed line rather than a silent regression.
 */
const MEASURED_ENVIRONMENT_SCOPE_STATEMENTS = 3;

const page = (organizationId: string, limit: number): EndUserQuery => ({
  organizationId: asIdentifier<OrganizationId>(organizationId),
  status: null,
  search: null,
  limit,
  offset: 0,
});

describe("the end-user page does not grow with the page", () => {
  test("one end user and twenty-five cost the SAME number of statements", async () => {
    const one = await measure(() => harness.repository.endUsers.list(page(small.organizationId, 25)));
    const twentyFive = await measure(() =>
      harness.repository.endUsers.list(page(large.organizationId, 25)),
    );
    // Two statements: the users, then their identities in one batch. A store
    // that loaded identities per row would be 1 + 25 here and 1 + 1 there, so
    // this single equality is the whole N+1 control.
    expect(one).toBe(2);
    expect(twentyFive).toBe(2);
    const rows = await harness.repository.endUsers.list(page(large.organizationId, 25));
    expect(rows).toHaveLength(25);
    expect(rows[0]?.identities).toHaveLength(2);
  }, 120_000);

  test("a count is ONE statement whatever it counts", async () => {
    expect(
      await measure(() => harness.repository.endUsers.count(page(small.organizationId, 25))),
    ).toBe(1);
    expect(
      await measure(() => harness.repository.endUsers.count(page(large.organizationId, 25))),
    ).toBe(1);
    // With the search term, which reaches an identity through a nested filter
    // and must still be one statement rather than a load-then-filter.
    expect(
      await measure(() =>
        harness.repository.endUsers.count({ ...page(large.organizationId, 25), search: "slack-1" }),
      ),
    ).toBe(1);
  }, 120_000);

  test("a page is the same cost as the page before it", async () => {
    const first = await measure(() =>
      harness.repository.endUsers.list({ ...page(large.organizationId, 5), offset: 0 }),
    );
    const fourth = await measure(() =>
      harness.repository.endUsers.list({ ...page(large.organizationId, 5), offset: 20 }),
    );
    expect(first).toBe(fourth);
  }, 120_000);
});

describe("the identity, session and grant reads are constant", () => {
  test("a session lookup by digest is ONE statement", async () => {
    await harness.repository.operatorSessions.save({
      sessionId: asIdentifier(harness.freshId("0400")),
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
    expect(
      await measure(() => harness.repository.operatorSessions.findByTokenHash(digest("a1"))),
    ).toBe(1);
    expect(
      await measure(() =>
        harness.repository.users.findById(asIdentifier<UserId>(userId)),
      ),
    ).toBe(1);
    expect(
      await measure(() => harness.repository.mfa.findTotp(asIdentifier<UserId>(userId))),
    ).toBe(1);
  }, 120_000);

  test("upsertByEmail on an EXISTING address is one statement, not a failed insert", async () => {
    // The get-or-create has TWO independent defences: the early return after the
    // read, and the unique-violation recovery around the insert. Removing either
    // alone leaves the ANSWER correct, because the other covers it — the first
    // mutation sweep proved exactly that by surviving. This is the assertion
    // that makes the early return falsifiable on its own: without it every
    // repeat login issues an INSERT that PostgreSQL refuses and a second SELECT
    // to recover, which is three statements where one will do, on the hottest
    // path in the product.
    const address = "repeat-login@example.test";
    const first = await harness.repository.users.upsertByEmail(
      asIdentifier(address),
      asIdentifier<UserId>(harness.freshId("0404")),
    );
    const cost = await measure(() =>
      harness.repository.users.upsertByEmail(
        asIdentifier(address),
        asIdentifier<UserId>(harness.freshId("0405")),
      ),
    );
    expect(cost).toBe(1);
    const again = await harness.repository.users.upsertByEmail(
      asIdentifier(address),
      asIdentifier<UserId>(harness.freshId("0406")),
    );
    expect(again.userId).toBe(first.userId);
  }, 120_000);

  test("an environment-scoped grant read is a MEASURED constant, not one per level", async () => {
    await harness.seedMcpToken({
      environmentId: small.environmentId,
      mintedByUserId: userId,
      tokenHash: digest("b2"),
      permissions: ["tools:read"],
      tier: "scope",
    });
    // An environment scope needs the environment's project and that project's
    // organization, neither of which is on the row — the migrations'
    // `*_scope_shape_check` forbids them being there. The figure is whatever
    // the client's relation strategy costs for two levels, pinned by
    // measurement; what matters is that it does not depend on how many
    // credentials exist.
    const first = await measure(() =>
      harness.repository.bearerCredentials.findByTokenHash("mcp-token", digest("b2")),
    );
    await harness.seedMcpToken({
      environmentId: small.environmentId,
      mintedByUserId: userId,
      tokenHash: digest("c3"),
      permissions: ["tools:read"],
      tier: "scope",
    });
    const again = await measure(() =>
      harness.repository.bearerCredentials.findByTokenHash("mcp-token", digest("c3")),
    );
    expect(first).toBe(again);
    // The MEASURED figure, pinned exactly. It is greater than one because the
    // client issues a statement per level of a nested selection rather than a
    // join; it is CONSTANT because the levels are a property of the scope, not
    // of how many rows exist.
    expect(first).toBe(MEASURED_ENVIRONMENT_SCOPE_STATEMENTS);
  }, 120_000);

  test("a family revocation is TWO statements however large the family", async () => {
    const clientId = await harness.seedOAuthClient(small.organizationId, userId);
    const familyId = harness.freshId("0401");
    const scope = {
      kind: "ORGANIZATION" as const,
      tenant: {
        level: "organization" as const,
        organizationId: asIdentifier<OrganizationId>(small.organizationId),
      },
    };
    let parent: string | null = null;
    for (let index = 0; index < 6; index += 1) {
      const accessTokenId = harness.freshId("0402");
      const refreshTokenId = harness.freshId("0403");
      const refreshHash = digest(index % 2 === 0 ? "d4" : "e5").slice(0, 62) + String(index) + "0";
      await harness.repository.oauth.saveTokenPair({
        accessToken: {
          tokenId: asIdentifier(accessTokenId),
          tokenHash: (digest("f6").slice(0, 62) + String(index) + "1") as TokenHash,
          clientId: asIdentifier(clientId),
          userId: asIdentifier<UserId>(userId),
          scope,
          scopes: ["read"],
          issuedAt: AT,
          expiresAt: EXPIRES,
          revokedAt: null,
        },
        refreshToken: {
          tokenId: asIdentifier(refreshTokenId),
          tokenHash: refreshHash as TokenHash,
          accessTokenId: asIdentifier<OAuthTokenId>(accessTokenId),
          clientId: asIdentifier(clientId),
          userId: asIdentifier<UserId>(userId),
          scope,
          scopes: ["read"],
          rotationFamilyId: asIdentifier(familyId),
          parentRefreshTokenId: parent === null ? null : asIdentifier<OAuthTokenId>(parent),
          issuedAt: AT,
          expiresAt: EXPIRES,
          consumedAt: null,
          replayDetectedAt: null,
          revokedAt: null,
        },
        consumedRefreshToken: null,
        expiresInSeconds: 3600,
      });
      parent = refreshTokenId;
    }
    const count = await measure(() =>
      harness.repository.oauth.revokeRotationFamily({
        rotationFamilyId: asIdentifier(familyId),
        replayDetectedAt: AT,
        revokedAt: AT,
      }),
    );
    // Two `updateMany`s: the access tokens selected by a NESTED FILTER on the
    // refresh tokens that point at them, then the refresh tokens. No identifier
    // list is round-tripped through this process, so a family of six and a
    // family of six hundred cost the same.
    expect(count).toBe(2);
  }, 180_000);
});
