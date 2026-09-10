/**
 * WIN-268 (M4.2) stage 2 — THE CREDENTIAL LISTING AND REVOCATION, AGAINST A REAL
 * PostgreSQL, AND THE CROSS-ENVIRONMENT DELETE THAT MUST NOT WORK.
 *
 * WHAT A DOUBLE CANNOT ESTABLISH HERE, ONE ITEM PER TEST BELOW.
 *
 *   THE CROSS-ENVIRONMENT REVOCATION. `revoke` puts the environment in the same
 *   `where` as the id, so a credential from a sibling environment updates zero
 *   rows and reads back as `absent`. A fake keyed by id alone passes a test that
 *   only checks the RETURN VALUE, which is why the assertion below also reads the
 *   VICTIM ROW back out of the database and requires `revokedAt` still null. That
 *   second half is what separates a real tenancy guard from a return value.
 *
 *   THE FORGED PAIR. An `McpBearerToken` is keyed by (entity, environment), and
 *   both tenants seeded below are internally COHERENT — the lesson this programme
 *   recorded as "a two-tenant test is not automatically a tenancy test ... the
 *   FORGED scope is what separates them". So the forged case is constructed
 *   explicitly: entity from tenant BETA, environment from tenant ALPHA, a
 *   combination every individual foreign key accepts.
 *
 *   THE CONCURRENCY. Two revocations of one credential run at once against the
 *   real row. The conditional `updateMany ... revokedAt: null` is what makes the
 *   outcome exactly one `revoked` and one `alreadyRevoked`; a read-then-write
 *   would report two revocations and stamp the loser's instant and actor over the
 *   winner's. `Promise.all` on two in-memory maps cannot fail this.
 *
 *   THE PAGING ORDER UNDER A SHARED INSTANT. Four credentials are minted with the
 *   SAME `createdAt`, which the mint now writes explicitly. Without the `id`
 *   tie-break PostgreSQL is free to return them in any order, and two consecutive
 *   pages can then both contain one row and both omit another. A Map preserves
 *   insertion order and cannot reproduce that.
 *
 *   THE `tier` COLUMN'S UNRECOGNISED VALUES. `McpToken.tier` is a String, so
 *   `'weird'` is a storable value that the legacy `normalizeTier` silently maps to
 *   `"scope"` — a DOWNGRADE of an admin credential that looks like data. It is
 *   written here with raw SQL, because no port can write it, and the refusal is
 *   asserted.
 *
 *   THE DIGEST'S ABSENCE. The tokenHash is read out of the ROW and every property
 *   of the summary is compared against it. That joins to the database rather than
 *   to this file: a projection that started returning the digest would fail even
 *   if this suite's own expectations were regenerated from the code.
 *
 * IT IS ENV-DRIVEN AND NOT TESTCONTAINERS, deliberately. Every other integration
 * suite in this package builds on `startTenancyHarness`, which starts a Docker
 * container; Docker is unavailable in the environment this tranche was built in,
 * and a suite that could not run at all would have proved nothing. The URL points
 * at any PostgreSQL with the canonical migrations applied — a native
 * `postgresql@17` on a non-default port is what this was proved against. A SKIP IS
 * MADE VISIBLE the way `registry-incoherent-pair-postgres.integration.test.ts`
 * does it: set `PLATOS_BEARER_LIFECYCLE_REQUIRED=1` and a missing URL is a
 * FAILURE rather than a silent green, because this repository has already merged
 * two regressions behind silently skipped suites.
 */

import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  BearerCredentialSummary,
  IdentityAccessRepository,
} from "@platos/context-identity-access/application/ports/index.js";

import { buildPostgresTenancyAdapter } from "./adapter.js";
import type { TenancyDatabaseClient } from "./client.js";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// NO `DATABASE_URL` FALLBACK. A generic variable is set in a great many shells
// and a suite that fell back to one would decide it had a database and then fail
// `beforeAll` on every machine without PostgreSQL — turning a SKIP into a RED.
const databaseUrl = process.env["PLATOS_POSTGRES_INTEGRATION_DATABASE_URL"];

if (process.env["PLATOS_BEARER_LIFECYCLE_REQUIRED"] === "1" && databaseUrl === undefined) {
  throw new Error(
    "PLATOS_BEARER_LIFECYCLE_REQUIRED=1 but no database URL is set; " +
      "export PLATOS_POSTGRES_INTEGRATION_DATABASE_URL",
  );
}

const describeWithDatabase = databaseUrl === undefined ? describe.skip : describe;

/** A 64-lowercase-hex digest, which the migrations' CHECK constraints require. */
const digestOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** The instant every credential in the ordering case shares. */
const SHARED_INSTANT = new Date("2026-03-01T09:00:00.000Z");

interface Tenant {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly entityId: string;
  readonly operatorUserId: string;
}

describeWithDatabase("bearer credential lifecycle against real PostgreSQL", () => {
  let client: TenancyDatabaseClient;
  let repository: IdentityAccessRepository;
  let alpha: Tenant;
  let beta: Tenant;
  const run = randomUUID().slice(0, 8);

  async function seedTenant(label: string): Promise<Tenant> {
    const operator = await client.user.create({
      data: { email: `${run}-${label}@test.invalid`, displayName: `${label} operator` },
    });
    const organization = await client.organization.create({
      data: { slug: `${run}-${label}`, name: `${label} org` },
    });
    // REQUIRED BY THE MIGRATIONS AND BY NOTHING IN `schema.prisma`.
    // `enforce_domain_ancestry` refuses an `McpToken` or `McpBearerToken` whose
    // acting user is not an ACTIVE member of the organization the scope resolves
    // to, and that rule is in neither the schema file nor the in-memory double.
    await client.organizationMembership.create({
      data: { organizationId: organization.id, userId: operator.id, role: "OWNER" },
    });
    const project = await client.project.create({
      data: { organizationId: organization.id, slug: `${run}-${label}`, name: `${label} project` },
    });
    const environment = await client.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    const entity = await client.entity.create({
      data: {
        projectId: project.id,
        externalId: `${run}-${label}-backend`,
        displayName: `${label} backend`,
        connectionKind: "wire",
        connectionStatus: "connected",
      },
    });
    return {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      entityId: entity.id,
      operatorUserId: operator.id,
    };
  }

  /** A platform credential, MINTED THROUGH THE PORT so the write path is the real one. */
  async function mintPlatform(
    tenant: Tenant,
    label: string,
    overrides: { readonly createdAt?: Date; readonly tier?: "scope" | "admin" } = {},
  ): Promise<BearerCredentialSummary> {
    const now = overrides.createdAt ?? new Date("2026-02-01T10:00:00.000Z");
    const record = await repository.bearerCredentials.mint({
      credentialId: randomUUID(),
      kind: "mcp-token",
      tokenHash: digestOf(`${run}:${label}`) as never,
      scope: {
        kind: "ENVIRONMENT",
        tenant: {
          level: "environment",
          organizationId: tenant.organizationId as never,
          projectId: tenant.projectId as never,
          environmentId: tenant.environmentId as never,
        },
      },
      label,
      permissions: ["agents.*"],
      createdByUserId: tenant.operatorUserId,
      principalId: tenant.operatorUserId as never,
      subjectId: null,
      permissionTier: overrides.tier ?? "scope",
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    return {
      credentialId: record.credentialId,
      kind: "mcp-token",
      label,
      principalId: record.principalId,
      permissions: record.permissions,
      permissionTier: overrides.tier ?? "scope",
      subjectId: null,
      scope: record.scope,
      createdAt: now,
      expiresAt: record.expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
  }

  /** An entity credential, likewise through the port. */
  async function mintEntity(
    tenant: Tenant,
    label: string,
    entityId: string = tenant.entityId,
  ): Promise<string> {
    const record = await repository.bearerCredentials.mint({
      credentialId: randomUUID(),
      kind: "entity-bearer-token",
      tokenHash: digestOf(`${run}:entity:${label}`) as never,
      scope: {
        kind: "ENVIRONMENT",
        tenant: {
          level: "environment",
          organizationId: tenant.organizationId as never,
          projectId: tenant.projectId as never,
          environmentId: tenant.environmentId as never,
        },
      },
      label,
      permissions: ["mcp:tools"],
      createdByUserId: tenant.operatorUserId,
      principalId: `mcp:pat:${label}` as never,
      subjectId: entityId,
      permissionTier: null,
      createdAt: new Date("2026-02-02T10:00:00.000Z"),
      expiresAt: new Date("2026-05-02T10:00:00.000Z"),
    });
    return record.credentialId;
  }

  beforeAll(async () => {
    const { PrismaClient } = await import("@platos/tenancy-database");
    client = new PrismaClient({
      datasources: { db: { url: databaseUrl as string } },
    }) as TenancyDatabaseClient;
    await client.$connect();
    repository = buildPostgresTenancyAdapter(client);
    alpha = await seedTenant("alpha");
    beta = await seedTenant("beta");
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  it("lists only the credentials of the environment it was asked about", async () => {
    const mine = await mintPlatform(alpha, "alpha-listing");
    await mintPlatform(beta, "beta-listing");

    const page = await repository.bearerCredentials.list({
      kind: "mcp-token",
      environmentId: alpha.environmentId,
      subjectId: null,
      limit: 50,
      offset: 0,
    });
    const ids = page.map((row) => row.credentialId);
    expect(ids).toContain(mine.credentialId);
    // THE NEGATIVE HALF, and it is the half that matters: the sibling
    // environment's credential exists, was written through the same port on the
    // same connection, and is NOT in this answer.
    const beforeCount = await repository.bearerCredentials.count({
      kind: "mcp-token",
      environmentId: beta.environmentId,
      subjectId: null,
      limit: 50,
      offset: 0,
    });
    expect(beforeCount).toBeGreaterThan(0);
    for (const row of page) {
      expect(row.scope).toMatchObject({
        kind: "ENVIRONMENT",
        tenant: { environmentId: alpha.environmentId },
      });
    }
  });

  it("re-derives each row's scope from the environment's own ancestry", async () => {
    const minted = await mintPlatform(alpha, "alpha-ancestry");
    const page = await repository.bearerCredentials.list({
      kind: "mcp-token",
      environmentId: alpha.environmentId,
      subjectId: null,
      limit: 50,
      offset: 0,
    });
    const row = page.find((candidate) => candidate.credentialId === minted.credentialId);
    expect(row).toBeDefined();
    // THE WHOLE TRIPLE, not just the leaf. The organization and the project come
    // from `environment.project.organizationId` and `environment.projectId` — the
    // database's own answer — so a forged triple could not survive even if one had
    // reached the store.
    expect(row?.scope).toEqual({
      kind: "ENVIRONMENT",
      tenant: {
        level: "environment",
        organizationId: alpha.organizationId,
        projectId: alpha.projectId,
        environmentId: alpha.environmentId,
      },
    });
  });

  it("returns no token digest, checked against the digest the row actually holds", async () => {
    const minted = await mintPlatform(alpha, "alpha-digest");
    const stored = await client.mcpToken.findUniqueOrThrow({
      where: { id: minted.credentialId },
      select: { tokenHash: true, createdAt: true },
    });
    const page = await repository.bearerCredentials.list({
      kind: "mcp-token",
      environmentId: alpha.environmentId,
      subjectId: null,
      limit: 50,
      offset: 0,
    });
    const row = page.find((candidate) => candidate.credentialId === minted.credentialId);
    expect(row).toBeDefined();
    // JOINED TO THE DATABASE, not to an expectation in this file. Every value on
    // the projection — at any depth — is compared against the digest the row
    // holds, so a summary that started carrying it fails here regardless of what
    // this suite expected the shape to be.
    expect(JSON.stringify(row)).not.toContain(stored.tokenHash);
    // AND the mint's own instant is the row's, which is the claim the `createdAt`
    // field was added to make true. Before it the response's instant came from the
    // application clock and the column's from the database server's.
    expect(stored.createdAt.toISOString()).toBe(minted.createdAt.toISOString());
  });

  it("refuses a tier column value that is neither scope nor admin, instead of downgrading it", async () => {
    const minted = await mintPlatform(alpha, "alpha-weird-tier", { tier: "admin" });
    // RAW SQL BECAUSE NO PORT CAN WRITE THIS. The column is a String and the
    // migrations do not constrain it, so `'weird'` is storable — and the legacy
    // `normalizeTier` maps anything unrecognised to `"scope"`, silently
    // downgrading an admin credential.
    await client.$executeRawUnsafe(
      `UPDATE "McpToken" SET "tier" = 'weird' WHERE "id" = $1::uuid`,
      minted.credentialId,
    );
    await expect(
      repository.bearerCredentials.list({
        kind: "mcp-token",
        environmentId: alpha.environmentId,
        subjectId: null,
        limit: 50,
        offset: 0,
      }),
    ).rejects.toThrow(/neither "scope" nor "admin"/u);
    // Put it back, so the ordering case that follows is not reading a poisoned row.
    await client.$executeRawUnsafe(
      `UPDATE "McpToken" SET "tier" = 'admin' WHERE "id" = $1::uuid`,
      minted.credentialId,
    );
  });

  it("REFUSES A REVOCATION FROM A SIBLING ENVIRONMENT, and leaves the victim row alone", async () => {
    const victim = await mintPlatform(beta, "beta-victim");
    const outcome = await repository.bearerCredentials.revoke({
      kind: "mcp-token",
      // THE FORGED PAIR: beta's credential id, alpha's environment. Both values
      // are real and both tenants are internally coherent; what is wrong is the
      // combination, which is the only thing that separates this from a
      // two-tenant test that would pass either way.
      credentialId: victim.credentialId,
      environmentId: alpha.environmentId,
      subjectId: null,
      revokedByUserId: alpha.operatorUserId,
      now: new Date("2026-03-05T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("absent");
    // THE ROW ITSELF, read back. A store that returned `absent` and revoked the
    // row anyway would pass an assertion on the return value alone.
    const row = await client.mcpToken.findUniqueOrThrow({
      where: { id: victim.credentialId },
      select: { revokedAt: true, revokedBy: true },
    });
    expect(row.revokedAt).toBeNull();
    expect(row.revokedBy).toBeNull();
  });

  it("revokes in its own environment, records the actor, and is idempotent with a distinct outcome", async () => {
    const target = await mintPlatform(alpha, "alpha-revoke");
    const first = await repository.bearerCredentials.revoke({
      kind: "mcp-token",
      credentialId: target.credentialId,
      environmentId: alpha.environmentId,
      subjectId: null,
      revokedByUserId: alpha.operatorUserId,
      now: new Date("2026-03-06T00:00:00.000Z"),
    });
    expect(first.kind).toBe("revoked");
    const stored = await client.mcpToken.findUniqueOrThrow({
      where: { id: target.credentialId },
      select: { revokedAt: true, revokedBy: true },
    });
    expect(stored.revokedAt?.toISOString()).toBe("2026-03-06T00:00:00.000Z");
    expect(stored.revokedBy).toBe(alpha.operatorUserId);

    const second = await repository.bearerCredentials.revoke({
      kind: "mcp-token",
      credentialId: target.credentialId,
      environmentId: alpha.environmentId,
      subjectId: null,
      // A DIFFERENT ACTOR AND A LATER INSTANT, both of which must be ignored.
      revokedByUserId: beta.operatorUserId,
      now: new Date("2026-03-07T00:00:00.000Z"),
    });
    // `alreadyRevoked` AND NOT `revoked`. Both legacy services return `true` here
    // and for the first call, which is the collapse this outcome exists to undo.
    expect(second.kind).toBe("alreadyRevoked");
    const after = await client.mcpToken.findUniqueOrThrow({
      where: { id: target.credentialId },
      select: { revokedAt: true, revokedBy: true },
    });
    expect(after.revokedAt?.toISOString()).toBe("2026-03-06T00:00:00.000Z");
    expect(after.revokedBy).toBe(alpha.operatorUserId);
  });

  it("gives exactly one winner when two revocations race the same credential", async () => {
    const target = await mintPlatform(alpha, "alpha-race");
    const [left, right] = await Promise.all([
      repository.bearerCredentials.revoke({
        kind: "mcp-token",
        credentialId: target.credentialId,
        environmentId: alpha.environmentId,
        subjectId: null,
        revokedByUserId: alpha.operatorUserId,
        now: new Date("2026-03-08T00:00:00.000Z"),
      }),
      repository.bearerCredentials.revoke({
        kind: "mcp-token",
        credentialId: target.credentialId,
        environmentId: alpha.environmentId,
        subjectId: null,
        revokedByUserId: beta.operatorUserId,
        now: new Date("2026-03-09T00:00:00.000Z"),
      }),
    ]);
    // ONE OF EACH, in either order. The conditional `revokedAt: null` in the
    // update is the whole mechanism: whichever statement commits first is the only
    // one whose `updateMany` reports a count of 1.
    expect([left.kind, right.kind].sort()).toEqual(["alreadyRevoked", "revoked"]);
    const stored = await client.mcpToken.findUniqueOrThrow({
      where: { id: target.credentialId },
      select: { revokedAt: true, revokedBy: true },
    });
    // THE WINNER'S VALUES SURVIVED. A read-then-write would have let the loser
    // overwrite the instant and the actor, so this row would carry a revocation
    // attributed to whoever committed second.
    expect(
      [
        `2026-03-08T00:00:00.000Z:${alpha.operatorUserId}`,
        `2026-03-09T00:00:00.000Z:${beta.operatorUserId}`,
      ],
    ).toContain(`${stored.revokedAt?.toISOString() ?? ""}:${stored.revokedBy ?? ""}`);
  });

  it("keys an entity listing on the entity AND the environment, refusing the forged pair", async () => {
    const own = await mintEntity(alpha, "alpha-entity-own");
    const page = await repository.bearerCredentials.list({
      kind: "entity-bearer-token",
      environmentId: alpha.environmentId,
      subjectId: alpha.entityId,
      limit: 50,
      offset: 0,
    });
    expect(page.map((row) => row.credentialId)).toContain(own);
    expect(page.every((row) => row.subjectId === alpha.entityId)).toBe(true);
    // THE FORGED PAIR AS A LISTING: beta's entity, alpha's environment. Every
    // foreign key involved is satisfiable and the answer must still be empty.
    const forged = await repository.bearerCredentials.list({
      kind: "entity-bearer-token",
      environmentId: alpha.environmentId,
      subjectId: beta.entityId,
      limit: 50,
      offset: 0,
    });
    expect(forged).toEqual([]);
    expect(
      await repository.bearerCredentials.count({
        kind: "entity-bearer-token",
        environmentId: alpha.environmentId,
        subjectId: beta.entityId,
        limit: 50,
        offset: 0,
      }),
    ).toBe(0);
  });

  it("refuses a cross-entity revocation inside one environment", async () => {
    // TWO ENTITIES IN ONE PROJECT, so the environment matches and only the entity
    // differs. This is the narrower forgery: an operator legitimately authorized
    // for the environment, naming somebody else's entity.
    const second = await client.entity.create({
      data: {
        projectId: alpha.projectId,
        externalId: `${run}-alpha-second`,
        displayName: "alpha second",
        connectionKind: "wire",
        connectionStatus: "connected",
      },
    });
    const victim = await mintEntity(alpha, "alpha-entity-victim");
    const outcome = await repository.bearerCredentials.revoke({
      kind: "entity-bearer-token",
      credentialId: victim,
      environmentId: alpha.environmentId,
      subjectId: second.id,
      revokedByUserId: alpha.operatorUserId,
      now: new Date("2026-03-10T00:00:00.000Z"),
    });
    expect(outcome.kind).toBe("absent");
    const row = await client.mcpBearerToken.findUniqueOrThrow({
      where: { id: victim },
      select: { revokedAt: true },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("pages a shared instant without overlap, because the order breaks ties on the id", async () => {
    const tenant = await seedTenant("paging");
    const minted: string[] = [];
    for (const label of ["p1", "p2", "p3", "p4"]) {
      const row = await mintPlatform(tenant, `paging-${label}`, { createdAt: SHARED_INSTANT });
      minted.push(row.credentialId);
    }
    const query = {
      kind: "mcp-token" as const,
      environmentId: tenant.environmentId,
      subjectId: null,
      limit: 2,
    };
    const first = await repository.bearerCredentials.list({ ...query, offset: 0 });
    const second = await repository.bearerCredentials.list({ ...query, offset: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    const seen = [...first, ...second].map((row) => row.credentialId);
    // FOUR DISTINCT ROWS ACROSS TWO PAGES. Every one of the four shares
    // `createdAt`, so without the `id` tie-break PostgreSQL may return them in any
    // order and this set can legally come out with three ids and a duplicate.
    expect(new Set(seen).size).toBe(4);
    expect(seen.sort()).toEqual([...minted].sort());
    expect(await repository.bearerCredentials.count({ ...query, offset: 0 })).toBe(4);
  });

  it("counts under the same filter the page used", async () => {
    const tenant = await seedTenant("counting");
    await mintPlatform(tenant, "counting-one");
    await mintPlatform(tenant, "counting-two");
    const query = {
      kind: "mcp-token" as const,
      environmentId: tenant.environmentId,
      subjectId: null,
      limit: 1,
      offset: 0,
    };
    const page = await repository.bearerCredentials.list(query);
    expect(page).toHaveLength(1);
    // THE WINDOW NARROWS THE PAGE AND NOT THE TOTAL. A count that applied `limit`
    // would answer 1 and make `hasMore` permanently false.
    expect(await repository.bearerCredentials.count(query)).toBe(2);
  });

  it("stops a revoked credential authenticating, so the two views of one row agree", async () => {
    const target = await mintPlatform(alpha, "alpha-coherence");
    const hash = digestOf(`${run}:alpha-coherence`);
    const before = await repository.bearerCredentials.findByTokenHash("mcp-token", hash as never);
    expect(before?.revokedAt).toBeNull();
    await repository.bearerCredentials.revoke({
      kind: "mcp-token",
      credentialId: target.credentialId,
      environmentId: alpha.environmentId,
      subjectId: null,
      revokedByUserId: alpha.operatorUserId,
      now: new Date("2026-03-11T00:00:00.000Z"),
    });
    // THE VERIFICATION PATH SEES IT. `findByTokenHash` is keyed by the digest and
    // `revoke` by the id, so this is the one assertion that proves the two
    // addressings reach the same row — the coherence a two-map double has to be
    // written carefully to preserve and a real table gets for free.
    const after = await repository.bearerCredentials.findByTokenHash("mcp-token", hash as never);
    expect(after?.revokedAt?.toISOString()).toBe("2026-03-11T00:00:00.000Z");
  });
});
