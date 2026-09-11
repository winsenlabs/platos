// THE MCP CREDENTIAL LIFECYCLE, THROUGH THE CONTRACT, AGAINST A REAL POSTGRESQL.
//
// WIN-268 (M4.2). The four MCP token lifecycle routes reach exactly two new
// contract methods — `listBearerCredentials` and `revokeBearerCredential` — and
// this suite exercises them the way those routes do: through
// `createIdentityAccessService`, over the PostgreSQL repository, with only the
// clock, the id generator and the token minter faked.
//
// THE HASHER IS NOT FAKED, AND THAT IS THE FIRST THING THIS SUITE FOUND.
// `application/testing.ts`'s `fakeSecretHasher` prepends a string, which is fine
// for a Map and is REFUSED by this store: the migrations carry
// `^[0-9a-f]{64}$` checks on both `tokenHash` columns and `requireDigest` applies
// them before the insert. So the digest here is a real SHA-256 — the same
// algorithm both legacy services use — and every row below is one PostgreSQL
// accepted rather than one a double tolerated.
//
// WHAT ONLY A REAL DATABASE CAN SETTLE:
//
//   * A REVOKED TOKEN STOPS AUTHENTICATING, proved by presenting the SAME raw
//     secret to `authenticateBearer` before and after, with the ROW read back to
//     show it is ENDED rather than merely absent from a cache. That is the bar
//     `revokeOperatorSession` was held to for server-side sign-out.
//   * REVOKED, EXPIRED AND NEVER-EXISTED ARE THREE DIFFERENT CODES, from the one
//     lifecycle rule, over rows the database wrote.
//   * SIXTEEN CONCURRENT REVOKES PRODUCE ONE WINNER and do not rewrite its
//     instant. The precondition is `WHERE revokedAt IS NULL`; a store that updated
//     unconditionally would report sixteen winners and no unit test over a Map
//     could tell the difference.
//   * ONE ENTITY'S LISTING EXCLUDES A SIBLING ENTITY'S CREDENTIALS in the SAME
//     environment — the coherent-scope case a two-tenant test passes either way.
//   * `enforce_domain_ancestry` is in the migrations and in neither
//     `schema.prisma` nor the double, so every mint below also proves the acting
//     user really is a member of the organization the scope resolves to.

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  IdentityAccessContract,
  MintedBearerCredentialView,
} from "@platos/context-identity-access";
import {
  createIdentityAccessService,
  testPorts,
  type SecretHasher,
} from "@platos/context-identity-access/application/index.js";
import type { IdGenerator } from "@platos/kernel";
import type { PrincipalId, TenantScope } from "@platos/kernel";
import { asIdentifier, environmentScope } from "@platos/kernel";

import type { IdentityHarness, SeededTenant } from "./identity-harness.js";
import { startIdentityHarness } from "./identity-harness.js";

let harness: IdentityHarness;
let identity: IdentityAccessContract;
let tenant: SeededTenant;
let other: SeededTenant;
let userId: string;
let otherUserId: string;
let entityId: string;
let siblingEntityId: string;

const NOW = new Date("2026-06-01T12:00:00.000Z");
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * A REAL digest, for the reason in the banner.
 *
 * Deterministic and injective, like the fake it replaces, and additionally the
 * shape the migrations' `tokenHash` check requires. It is the same construction
 * `token.service.ts` and `mcp-bearer-token.service.ts` use.
 */
/**
 * A REAL UUID generator, and the SECOND thing this suite found.
 *
 * `application/testing.ts`'s `sequentialIdGenerator` returns `id-1`, `id-2` — fine
 * for a Map keyed on strings, and refused outright by this store: `McpToken.id` and
 * `McpBearerToken.id` are `@db.Uuid`, so the driver rejects the value before any
 * constraint is even evaluated ("Error creating UUID, invalid character ... found
 * `i` at 1"). Every id below is therefore one PostgreSQL will store.
 */
function uuidIds(fake: IdGenerator): IdGenerator {
  return { ...fake, uuid: () => randomUUID() as never };
}

function sha256Hasher(fake: SecretHasher): SecretHasher {
  return {
    ...fake,
    // ONLY `hash` IS REPLACED. `equals` and `deriveCodeChallenge` belong to paths
    // this suite does not exercise (constant-time comparison and PKCE), and
    // substituting real ones would be inventing coverage rather than adding it.
    hash: (secret: string) => createHash("sha256").update(secret).digest("hex") as never,
  };
}

function seedEntityRow(projectId: string, label: string): string {
  const id = harness.freshId("0301");
  // THROUGH THE HARNESS, not through a spawn of this suite's own.
  // `scripts/arch/env-access.mjs` refuses an ambient environment read outside its
  // declared list, and `governance-harness.ts`'s declaration gives the reason the
  // door belongs there: "so the door stays in one file". The variable name is
  // deliberately not spelled here — that file's own independent TEXT scan keeps a
  // list of prose-only matches, and a comment is not worth a sixth entry on it.
  harness.applyPeerRows(
    `INSERT INTO "Entity" ("id", "projectId", "externalId", "displayName", "connectionStatus",
                           "connectionKind", "createdAt", "updatedAt")
     VALUES ('${id}', '${projectId}', 'ext-${label}-${id.slice(-8)}', '${label}',
             'CONNECTED', 'MCP', '2026-05-01T09:00:00Z', '2026-05-01T09:00:00Z');`,
  );
  return id;
}

function scopeOf(seeded: SeededTenant): TenantScope {
  return environmentScope(
    asIdentifier(seeded.organizationId),
    asIdentifier(seeded.projectId),
    asIdentifier(seeded.environmentId),
  );
}

async function mintPlatform(
  label: string,
  ttlSeconds: number | null = null,
  seeded: SeededTenant = tenant,
  actor: string = userId,
): Promise<MintedBearerCredentialView> {
  const minted = await identity.mintBearerCredential({
    kind: "mcp-token",
    scope: scopeOf(seeded),
    label,
    permissions: ["tools.*"],
    createdByUserId: actor,
    principalId: asIdentifier<PrincipalId>(actor),
    subjectId: null,
    permissionTier: "scope",
    ttlSeconds,
  });
  expect(minted.ok, JSON.stringify(minted)).toBe(true);
  if (!minted.ok) throw new Error("unreachable");
  return minted.value;
}

async function mintEntity(label: string, subjectId: string): Promise<MintedBearerCredentialView> {
  const minted = await identity.mintBearerCredential({
    kind: "entity-bearer-token",
    scope: scopeOf(tenant),
    label,
    permissions: ["mcp:tools"],
    createdByUserId: userId,
    principalId: null,
    subjectId,
    permissionTier: null,
    ttlSeconds: null,
  });
  expect(minted.ok, JSON.stringify(minted)).toBe(true);
  if (!minted.ok) throw new Error("unreachable");
  return minted.value;
}

beforeAll(async () => {
  harness = await startIdentityHarness();
  const ports = testPorts();
  ports.clock.set(NOW);
  identity = createIdentityAccessService({
    ...ports,
    repository: harness.repository,
    hasher: sha256Hasher(ports.hasher),
    ids: uuidIds(ports.ids),
  });
  tenant = await harness.seedTenant("bearer-lifecycle");
  other = await harness.seedTenant("bearer-other");
  userId = await harness.seedUser("lifecycle-owner@example.test");
  otherUserId = await harness.seedUser("lifecycle-other@example.test");
  await harness.seedMembership(tenant.organizationId, userId);
  await harness.seedMembership(other.organizationId, otherUserId);
  entityId = seedEntityRow(tenant.projectId, "primary");
  siblingEntityId = seedEntityRow(tenant.projectId, "sibling");
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

describe("WIN-268 — a revoked credential stops authenticating, and the row says so", () => {
  test("the SAME raw secret authenticates, then is refused as REVOKED", async () => {
    const minted = await mintPlatform("revocation subject");

    // BEFORE. Without this the case would pass against a token that never worked.
    const before = await identity.authenticateBearer({
      presentedToken: minted.token,
      requestedScope: scopeOf(tenant),
    });
    expect(before.ok, JSON.stringify(before)).toBe(true);
    if (before.ok) expect(before.value.credentialId).toBe(minted.credentialId);

    const revoked = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId: minted.credentialId,
      scope: scopeOf(tenant),
      revokedByUserId: userId,
    });
    expect(revoked.ok, JSON.stringify(revoked)).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.value.newlyRevoked).toBe(true);
    expect(revoked.value.previousState).toBe("active");
    expect(revoked.value.revokedAt).toEqual(NOW);
    expect(revoked.value.revokedBy).toBe(userId);

    // THE ROW, READ BACK THROUGH THE DATABASE — not through the value the
    // revocation returned and not through any cache. It is ENDED rather than gone:
    // the row is still there, which is what makes the refusal below `REVOKED`
    // instead of `UNAUTHENTICATED`.
    const row = await harness.client.mcpToken.findUnique({
      where: { id: minted.credentialId },
      select: { revokedAt: true, revokedBy: true },
    });
    expect(row).not.toBeNull();
    expect(row?.revokedAt).toEqual(NOW);
    expect(row?.revokedBy).toBe(userId);

    // AFTER. The same secret, the same method, a different answer.
    const after = await identity.authenticateBearer({
      presentedToken: minted.token,
      requestedScope: scopeOf(tenant),
    });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("CREDENTIAL_REVOKED");
  }, 180_000);

  test("REVOKED, EXPIRED and NEVER-EXISTED are three different codes", async () => {
    // EXPIRED: a one-second lifetime, and the clock moved past it. The credential
    // was never revoked, so the only thing that ended it is the clock.
    const lapsed = await mintPlatform("lapsed credential", 1);
    const ports = testPorts();
    ports.clock.set(new Date(NOW.getTime() + 60_000));
    const later = createIdentityAccessService({
      ...ports,
      repository: harness.repository,
      hasher: sha256Hasher(ports.hasher),
      ids: uuidIds(ports.ids),
    });
    const expired = await later.authenticateBearer({
      presentedToken: lapsed.token,
      requestedScope: scopeOf(tenant),
    });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.error.code).toBe("CREDENTIAL_EXPIRED");

    // NEVER EXISTED: a correctly PREFIXED token no row carries, so the failure is
    // the lookup rather than the routing.
    const unknown = await identity.authenticateBearer({
      presentedToken: "plt_mcp_no-such-credential",
      requestedScope: scopeOf(tenant),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("UNAUTHENTICATED");

    // AND THE REVOCATION OF AN ID NO ROW CARRIES IS ITS OWN CODE, not a false
    // success and not `UNAUTHENTICATED`: the caller is authenticated, the id is not.
    const missing = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId: harness.freshId("0304"),
      scope: scopeOf(tenant),
      revokedByUserId: userId,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("CREDENTIAL_NOT_FOUND");

    // A LAPSED CREDENTIAL IS STILL ENDED ON REQUEST, and the state it was in is
    // reported rather than guessed.
    const ended = await later.revokeBearerCredential({
      kind: "mcp-token",
      credentialId: lapsed.credentialId,
      scope: scopeOf(tenant),
      revokedByUserId: userId,
    });
    expect(ended.ok, JSON.stringify(ended)).toBe(true);
    if (!ended.ok) return;
    expect(ended.value.newlyRevoked).toBe(true);
    expect(ended.value.previousState).toBe("expired");
  }, 180_000);

  test("a SECOND revoke is a SUCCESS that reports the first one's instant", async () => {
    const minted = await mintPlatform("double revoke subject");
    const first = await identity.revokeBearerCredential({
      kind: "mcp-token",
      credentialId: minted.credentialId,
      scope: scopeOf(tenant),
      revokedByUserId: userId,
    });
    expect(first.ok).toBe(true);

    // A DIFFERENT CLOCK AND A DIFFERENT ACTOR, so a rewrite would be visible rather
    // than coincidentally equal.
    const ports = testPorts();
    ports.clock.set(new Date(NOW.getTime() + 3_600_000));
    const laterService = createIdentityAccessService({
      ...ports,
      repository: harness.repository,
      hasher: sha256Hasher(ports.hasher),
      ids: uuidIds(ports.ids),
    });
    const second = await laterService.revokeBearerCredential({
      kind: "mcp-token",
      credentialId: minted.credentialId,
      scope: scopeOf(tenant),
      revokedByUserId: otherUserId,
    });
    // NOT A REFUSAL. `apps/core-api/src/http/idempotency-policy.ts` classes both
    // revoke templates `exempt` on the recorded ground that "a token revoked twice
    // is revoked"; a refusal here would falsify that exemption.
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.value.newlyRevoked).toBe(false);
    expect(second.value.previousState).toBe("revoked");
    expect(second.value.revokedAt).toEqual(NOW);
    expect(second.value.revokedBy).toBe(userId);
  }, 180_000);

  test("the ENTITY revocation carries the SAME precondition, proved separately", async () => {
    // A MUTATION SURVIVED WITHOUT THIS CASE. Dropping `revokedAt: null` from the
    // entity `updateMany` left every case in this file green, because the two
    // revocations are two SQL statements over two tables and the platform cases
    // above cannot reach the entity one. `identity-bearer-lifecycle.ts` writes the
    // predicate twice; this is the second half of the proof that it does.
    const minted = await mintEntity("entity precondition", entityId);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        identity.revokeBearerCredential({
          kind: "entity-bearer-token",
          credentialId: minted.credentialId,
          scope: scopeOf(tenant),
          subjectId: entityId,
          revokedByUserId: userId,
        }),
      ),
    );
    for (const outcome of outcomes) expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(outcomes.filter((outcome) => outcome.ok && outcome.value.newlyRevoked)).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.ok) expect(outcome.value.revokedAt).toEqual(NOW);
    }

    // AND A SEQUENTIAL SECOND CALL UNDER A LATER CLOCK, which is the shape an
    // operator's second click actually takes: the instant must still be the first
    // one's, so the row records when the credential was really ended.
    const ports = testPorts();
    ports.clock.set(new Date(NOW.getTime() + 7_200_000));
    const later = createIdentityAccessService({
      ...ports,
      repository: harness.repository,
      hasher: sha256Hasher(ports.hasher),
      ids: uuidIds(ports.ids),
    });
    const second = await later.revokeBearerCredential({
      kind: "entity-bearer-token",
      credentialId: minted.credentialId,
      scope: scopeOf(tenant),
      subjectId: entityId,
      revokedByUserId: userId,
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.value.newlyRevoked).toBe(false);
    expect(second.value.previousState).toBe("revoked");
    expect(second.value.revokedAt).toEqual(NOW);
  }, 180_000);

  test("SIXTEEN CONCURRENT revokes produce exactly one winner", async () => {
    const minted = await mintPlatform("concurrent revoke subject");
    const outcomes = await Promise.all(
      Array.from({ length: 16 }, () =>
        identity.revokeBearerCredential({
          kind: "mcp-token",
          credentialId: minted.credentialId,
          scope: scopeOf(tenant),
          revokedByUserId: userId,
        }),
      ),
    );
    for (const outcome of outcomes) expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    const winners = outcomes.filter((outcome) => outcome.ok && outcome.value.newlyRevoked);
    expect(winners).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.ok) expect(outcome.value.revokedAt).toEqual(NOW);
    }
  }, 180_000);
});

describe("WIN-268 — the listing's tenancy clause, and what it never returns", () => {
  test("one entity's listing EXCLUDES a sibling entity's credentials in the same environment", async () => {
    const mine = await mintEntity("mine", entityId);
    const theirs = await mintEntity("theirs", siblingEntityId);

    // THE FORGED PART IS THE ENTITY, NOT THE ENVIRONMENT. Both credentials sit in
    // the SAME environment and the SAME project, so an environment-only WHERE would
    // return both and a two-tenant test would not notice: its foreign scope would be
    // coherent.
    const page = await identity.listBearerCredentials({
      kind: "entity-bearer-token",
      scope: scopeOf(tenant),
      subjectId: entityId,
      limit: 50,
    });
    expect(page.ok, JSON.stringify(page)).toBe(true);
    if (!page.ok) return;
    const ids = page.value.credentials.map((credential) => credential.credentialId);
    expect(ids).toContain(mine.credentialId);
    expect(ids).not.toContain(theirs.credentialId);
    expect(page.value.total).toBe(ids.length);

    // NO SUMMARY CARRIES THE VERIFIER OR THE SECRET. Asserted against the value the
    // DATABASE produced, so widening the projection would have to get past this and
    // not only past the type.
    const digest = createHash("sha256").update(mine.token).digest("hex");
    for (const credential of page.value.credentials) {
      expect(Object.keys(credential)).not.toContain("tokenHash");
      const rendered = JSON.stringify(credential);
      expect(rendered).not.toContain(digest);
      expect(rendered).not.toContain(mine.token);
    }
    // AND THE PRINCIPAL IS THE ORACLE'S DEFAULT for a credential minted with none:
    // `mcp:pat:<credential id>`, applied by the use case because the id is minted
    // there.
    const listed = page.value.credentials.find((row) => row.credentialId === mine.credentialId);
    expect(listed?.principalId).toBe(`mcp:pat:${mine.credentialId}`);
    // An entity token has no MCP permission tier and its table has no `revokedBy`.
    expect(listed?.permissionTier).toBeNull();
    expect(listed?.revokedBy).toBeNull();
    expect(listed?.state).toBe("active");
  }, 180_000);

  test("the total is counted under the SAME tenancy clause as the page", async () => {
    // A credential in ANOTHER organization. A count without the environment clause
    // would include it and report a total no page in this tenant can reach.
    const foreign = await mintPlatform("foreign credential", null, other, otherUserId);
    const mine = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      limit: 100,
    });
    const theirs = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(other),
      limit: 100,
    });
    expect(mine.ok && theirs.ok).toBe(true);
    if (!mine.ok || !theirs.ok) return;
    // NOT VACUOUS: both tenants hold credentials.
    expect(mine.value.total).toBeGreaterThan(0);
    expect(theirs.value.total).toBe(1);
    expect(theirs.value.credentials[0]?.credentialId).toBe(foreign.credentialId);
    const mineIds = new Set(mine.value.credentials.map((row) => row.credentialId));
    expect(mineIds.has(foreign.credentialId)).toBe(false);
    expect(mine.value.credentials).toHaveLength(mine.value.total);
  }, 180_000);

  test("the page is newest-first, and two consecutive pages do not overlap", async () => {
    const first = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      limit: 2,
      offset: 0,
    });
    const second = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      limit: 2,
      offset: 2,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.total).toBeGreaterThan(2);
    expect(first.value.hasMore).toBe(true);
    expect(first.value.credentials).toHaveLength(2);
    const firstIds = new Set(first.value.credentials.map((row) => row.credentialId));
    for (const row of second.value.credentials) expect(firstIds.has(row.credentialId)).toBe(false);
    const created = [...first.value.credentials, ...second.value.credentials].map((row) =>
      row.createdAt.getTime(),
    );
    expect(created).toEqual([...created].sort((left, right) => right - left));
  }, 180_000);

  test("a junk `McpToken.tier` makes the row UNREADABLE rather than reading as the weaker tier", async () => {
    // A MUTATION SURVIVED WITHOUT THIS CASE, and the decision it left unproved is
    // the one `readMcpPermissionTier`'s note argues for at length. There is NO CHECK
    // CONSTRAINT on `McpToken.tier` — `EndUserSession.tier` has one and this column
    // does not — so nothing in the database stops a row holding `"adminn"`, and the
    // two available answers differ observably:
    //
    //   NORMALISE (what `token.service.ts` does)  the row reads as `scope`, and an
    //     operator auditing which credentials hold ADMIN is shown a junk row as the
    //     weaker tier and misses it.
    //   REFUSE (what this adapter does)  the row is unreadable and the page it
    //     appears on fails, loudly, under its own code.
    //
    // THE PRICE IS PROVED HERE TOO, not just the property: the whole page fails, so
    // an operator with one such row cannot list ANY credential in that environment
    // from this surface. That is recorded in the adapter's note and it is why this
    // case asserts the throw rather than a per-row fallback — a future stage that
    // decides the price is too high has to change this case, on purpose.
    const junkTenant = await harness.seedTenant("junk-tier");
    const junkUser = await harness.seedUser("junk-tier@example.test");
    await harness.seedMembership(junkTenant.organizationId, junkUser);
    await harness.seedMcpToken({
      environmentId: junkTenant.environmentId,
      mintedByUserId: junkUser,
      tokenHash: createHash("sha256").update("junk-tier-row").digest("hex"),
      permissions: ["tools.*"],
      // NEITHER of the two the domain enumerates. A typo an operator could really
      // make, and the exact one the legacy handler silently weakens.
      tier: "adminn",
    });
    await expect(
      identity.listBearerCredentials({ kind: "mcp-token", scope: scopeOf(junkTenant) }),
    ).rejects.toThrow(/unknown_mcp_permission_tier|McpToken\.tier/u);

    // NOT VACUOUS: the same listing over a tenant whose rows are all readable
    // answers normally, so the throw is about the VALUE and not about the query.
    const healthy = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      limit: 1,
    });
    expect(healthy.ok, JSON.stringify(healthy)).toBe(true);
  }, 180_000);

  test("an over-large limit is REFUSED rather than clamped", async () => {
    // Both oracles clamp with `boundedInteger(limit, 50, 1, 100)`. A caller that
    // asked for five thousand rows, received one hundred and was told nothing
    // believes it has seen everything.
    const refused = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      limit: 5000,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("CREDENTIAL_MATERIAL_INVALID");
  }, 60_000);

  test("a PLATFORM listing that names an entity is refused, and an ENTITY listing that omits one is too", async () => {
    // `McpToken` has no subject column, so a subject supplied for it could only be
    // silently dropped; `McpBearerToken` requires one, and widening to the
    // environment is the cross-entity leak.
    const withSubject = await identity.listBearerCredentials({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      subjectId: entityId,
    });
    expect(withSubject.ok).toBe(false);
    if (!withSubject.ok) expect(withSubject.error.code).toBe("CREDENTIAL_SUBJECT_MISMATCH");

    const withoutSubject = await identity.listBearerCredentials({
      kind: "entity-bearer-token",
      scope: scopeOf(tenant),
    });
    expect(withoutSubject.ok).toBe(false);
    if (!withoutSubject.ok) expect(withoutSubject.error.code).toBe("CREDENTIAL_SUBJECT_MISMATCH");
  }, 60_000);

  test("a credential's lifetime is capped by the DOMAIN, and the cap is the row's", async () => {
    // The one rule in the mint that is NEW rather than extracted: neither oracle has
    // a maximum, so both will issue a credential that outlives the company.
    const refused = await identity.mintBearerCredential({
      kind: "mcp-token",
      scope: scopeOf(tenant),
      label: "too long",
      permissions: ["tools.*"],
      createdByUserId: userId,
      principalId: asIdentifier<PrincipalId>(userId),
      subjectId: null,
      permissionTier: "scope",
      ttlSeconds: ONE_YEAR_SECONDS + 1,
    });
    expect(refused.ok).toBe(false);
    // AND THE BOUNDARY IS ACCEPTED, so the cap is a cap and not an off-by-one.
    const accepted = await mintPlatform("exactly one year", ONE_YEAR_SECONDS);
    const row = await harness.client.mcpToken.findUnique({
      where: { id: accepted.credentialId },
      select: { expiresAt: true },
    });
    expect(row?.expiresAt).toEqual(new Date(NOW.getTime() + ONE_YEAR_SECONDS * 1000));
  }, 120_000);
});
