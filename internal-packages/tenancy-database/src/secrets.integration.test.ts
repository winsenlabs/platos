import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CredentialKind,
  OrganizationRole,
  PrismaClient,
  ProjectRole,
} from "../generated/control";
import {
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
  type OperatorAuthorization,
} from "./auth";
import { rotateAccessKey } from "./access-key";
import {
  authorizeCredentialRootOperations,
  CredentialRootKeyRing,
  PlatosSecretStore,
  PURGE_RETIRED_HARD_LIMIT,
} from "./secrets";

describe("Platos secret store integration", () => {
  let container: StartedPostgreSqlContainer;
  let database: PrismaClient;
  let environmentId: string;
  let otherEnvironmentId: string;
  let userId: string;
  let store: PlatosSecretStore;
  let rootKeyV1: Buffer;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(process.cwd(), "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", resolve(process.cwd(), "prisma/schema.prisma")],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" }
    );
    database = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    const user = await database.user.create({ data: { email: "secrets@example.test" } });
    userId = user.id;
    const organization = await database.organization.create({
      data: { slug: "secret-org", name: "Secret org" },
    });
    const membership = await database.organizationMembership.create({
      data: { organizationId: organization.id, userId, role: OrganizationRole.MEMBER },
    });
    const project = await database.project.create({
      data: { organizationId: organization.id, slug: "secret-project", name: "Secret project" },
    });
    await database.projectMembership.create({
      data: {
        projectId: project.id,
        organizationMembershipId: membership.id,
        organizationId: organization.id,
        role: ProjectRole.ADMIN,
      },
    });
    environmentId = (
      await database.environment.create({
        data: { projectId: project.id, slug: "dev", name: "Development" },
      })
    ).id;

    const otherOrganization = await database.organization.create({
      data: { slug: "other-secret-org", name: "Other secret org" },
    });
    const otherProject = await database.project.create({
      data: { organizationId: otherOrganization.id, slug: "other", name: "Other" },
    });
    otherEnvironmentId = (
      await database.environment.create({
        data: { projectId: otherProject.id, slug: "dev", name: "Development" },
      })
    ).id;

    rootKeyV1 = randomBytes(32);
    store = new PlatosSecretStore(
      database,
      new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: rootKeyV1 } })
    );
  }, 120_000);

  afterAll(async () => {
    await database?.$disconnect();
    await container?.stop();
  });

  test("enforces environment ancestry, audits every read, and rotates without invalidating acquired material", async () => {
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:test",
      environmentId,
    });
    const created = await store.create({
      authorization: operator,
      name: "ANTHROPIC_API_KEY",
      provider: "anthropic",
      plaintext: "old-secret",
    });
    expect(JSON.stringify(created)).not.toContain("old-secret");
    expect(JSON.stringify(created)).not.toContain("ciphertext");

    const acquiredBeforeRotation = await store.readForRuntime({
      authorization: runtime,
      credentialId: created.id,
      provider: "anthropic",
    });
    await store.rotateCredential({
      authorization: operator,
      credentialId: created.id,
      plaintext: "new-secret",
    });
    const acquiredAfterRotation = await store.readForRuntime({
      authorization: runtime,
      credentialId: created.id,
      provider: "anthropic",
    });
    expect(acquiredBeforeRotation.reveal()).toBe("old-secret");
    expect(acquiredAfterRotation.reveal()).toBe("new-secret");
    expect(
      await database.credentialAudit.count({ where: { credentialId: created.id, action: "READ" } })
    ).toBe(2);

    const foreignRuntime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:foreign",
      environmentId: otherEnvironmentId,
    });
    await expect(
      store.readForRuntime({ authorization: foreignRuntime, credentialId: created.id })
    ).rejects.toMatchObject({ code: "credential_unavailable" });
  });

  test("keeps audit rows immutable and fails closed when audit insertion fails", async () => {
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:audit",
      environmentId,
    });
    const created = await store.create({
      authorization: operator,
      name: "OPENAI_API_KEY",
      provider: "openai",
      plaintext: "audit-secret",
    });
    const audit = await database.credentialAudit.findFirstOrThrow({
      where: { credentialId: created.id },
    });
    expect(audit.outcome).toBe("SUCCESS");
    await expect(
      database.credentialAudit.update({ where: { id: audit.id }, data: { action: "ALTERED" } })
    ).rejects.toThrow(/immutable/);
    await expect(database.credentialAudit.delete({ where: { id: audit.id } })).rejects.toThrow(
      /immutable/
    );
    await expect(database.$executeRawUnsafe('TRUNCATE TABLE "CredentialAudit"')).rejects.toThrow(
      /immutable/
    );

    await database.$executeRawUnsafe(`CREATE FUNCTION "public"."reject_credential_audit_insert_for_test"()
      RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'audit insert blocked'; END; $$ LANGUAGE plpgsql`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "CredentialAudit_block_insert_for_test"
      BEFORE INSERT ON "public"."CredentialAudit" FOR EACH ROW
      EXECUTE FUNCTION "public"."reject_credential_audit_insert_for_test"()`);
    const purgeCandidateId = "40000000-0000-4000-8000-000000000001";
    const purgeCutoff = new Date("2001-01-01T00:00:00.000Z");
    await database.credentialSecretVersion.create({
      data: retiredVersion(
        created.id,
        purgeCandidateId,
        2,
        40,
        new Date("2000-01-01T00:00:00.000Z"),
        new Date("2000-01-01T00:00:00.000Z")
      ),
    });
    await expect(
      store.readForRuntime({ authorization: runtime, credentialId: created.id })
    ).rejects.toThrow(/audit insert blocked/);
    await expect(
      store.purgeRetired({
        authorization: authorizeCredentialRootOperations({
          actorId: "deployment:audit-failure",
          deploymentRole: "credential-root-operator",
        }),
        cutoff: purgeCutoff,
      })
    ).rejects.toThrow(/audit insert blocked/);
    await database.$executeRawUnsafe(
      'DROP TRIGGER "CredentialAudit_block_insert_for_test" ON "public"."CredentialAudit"'
    );
    await database.$executeRawUnsafe(
      'DROP FUNCTION "public"."reject_credential_audit_insert_for_test"()'
    );
    await expect(
      database.credentialSecretVersion.findUnique({ where: { id: purgeCandidateId } })
    ).resolves.not.toBeNull();
    await expect(
      store.purgeRetired({
        authorization: authorizeCredentialRootOperations({
          actorId: "deployment:audit-recovery",
          deploymentRole: "credential-root-operator",
        }),
        cutoff: purgeCutoff,
      })
    ).resolves.toEqual({ purgedCount: 1 });
  });

  test("rolls back credential create/rotation when ProviderKey linkage fails", async () => {
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:provider-link-rollback",
      environmentId,
    });
    const created = await store.createProviderCredentialAndKey({
      authorization: operator,
      provider: "anthropic",
      name: "ANTHROPIC_ROLLBACK_PRIMARY",
      plaintext: "original-provider-secret",
      label: "Rollback duplicate label",
      isDefault: true,
    });

    await expect(
      store.createProviderCredentialAndKey({
        authorization: operator,
        provider: "anthropic",
        name: "ANTHROPIC_ROLLBACK_ORPHAN",
        plaintext: "must-not-persist",
        label: "Rollback duplicate label",
        isDefault: true,
      })
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await database.credential.findFirst({
        where: { environmentId, name: "ANTHROPIC_ROLLBACK_ORPHAN" },
      })
    ).toBeNull();
    expect(
      await database.providerKey.findUniqueOrThrow({ where: { id: created.key.id } })
    ).toMatchObject({ isDefault: true, credentialId: created.credential.id });

    await database.$executeRawUnsafe(`CREATE FUNCTION "public"."reject_provider_key_link_for_test"()
      RETURNS TRIGGER AS $$ BEGIN RAISE EXCEPTION 'provider key link blocked'; END; $$ LANGUAGE plpgsql`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "ProviderKey_block_link_for_test"
      BEFORE UPDATE ON "public"."ProviderKey" FOR EACH ROW
      WHEN (OLD."id" = '${created.key.id}'::uuid)
      EXECUTE FUNCTION "public"."reject_provider_key_link_for_test"()`);
    try {
      await expect(
        store.rotateProviderCredentialAndKey({
          authorization: operator,
          keyId: created.key.id,
          plaintext: "must-roll-back",
        })
      ).rejects.toThrow(/provider key link blocked/);
    } finally {
      await database.$executeRawUnsafe(
        'DROP TRIGGER "ProviderKey_block_link_for_test" ON "public"."ProviderKey"'
      );
      await database.$executeRawUnsafe(
        'DROP FUNCTION "public"."reject_provider_key_link_for_test"()'
      );
    }

    expect(
      (
        await store.readForRuntime({
          authorization: runtime,
          credentialId: created.credential.id,
          provider: "anthropic",
        })
      ).reveal()
    ).toBe("original-provider-secret");
    expect(
      await database.credentialAudit.count({
        where: { credentialId: created.credential.id, action: "ROTATE" },
      })
    ).toBe(0);
  });

  test("rejects a same-name provider mismatch before mutating secret material", async () => {
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:provider-name-mismatch",
      environmentId,
    });
    const credential = await store.create({
      authorization: operator,
      name: "PROVIDER_NAME_MISMATCH",
      provider: "openai",
      plaintext: "openai-secret-remains",
    });

    await expect(
      store.createProviderCredentialAndKey({
        authorization: operator,
        provider: "anthropic",
        name: "PROVIDER_NAME_MISMATCH",
        plaintext: "must-not-rotate",
        label: "Mismatched provider",
        isDefault: false,
      })
    ).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(
      (
        await store.readForRuntime({
          authorization: runtime,
          credentialId: credential.id,
          provider: "openai",
        })
      ).reveal()
    ).toBe("openai-secret-remains");
    expect(
      await database.credentialAudit.count({
        where: { credentialId: credential.id, action: "ROTATE" },
      })
    ).toBe(0);
    expect(
      await database.providerKey.count({
        where: { environmentId, label: "Mismatched provider" },
      })
    ).toBe(0);
  });

  test("serializes concurrent access-key rotations and enforces one active key", async () => {
    const firstDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const secondDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const rotations = await Promise.all([
        rotateAccessKey(firstDatabase, {
          environmentId,
          keyHash: "a".repeat(64),
          keyPrefix: "platos_live_first",
        }),
        rotateAccessKey(secondDatabase, {
          environmentId,
          keyHash: "b".repeat(64),
          keyPrefix: "platos_live_second",
        }),
      ]);
      expect(JSON.stringify(rotations)).not.toContain("keyHash");
      const persisted = await database.accessKey.findMany({
        where: { environmentId, revokedAt: null },
        select: {
          id: true,
          keyHash: true,
          keyPrefix: true,
          validUntil: true,
          replacedById: true,
        },
      });
      const active = persisted.filter((key) => key.validUntil === null);
      const retiring = persisted.filter((key) => key.validUntil !== null);
      expect(active).toHaveLength(1);
      expect(retiring).toHaveLength(1);
      expect(retiring[0]?.replacedById).toBe(active[0]?.id);
      expect(active[0]?.keyHash).toBe(
        active[0]?.keyPrefix === "platos_live_first" ? "a".repeat(64) : "b".repeat(64)
      );
      expect(rotations.flatMap((rotation) => [rotation.key.id, rotation.retiringKey?.id]).filter(Boolean))
        .toEqual(expect.arrayContaining([active[0]?.id, retiring[0]?.id]));
      await expect(
        database.accessKey.create({
          data: {
            environmentId,
            keyHash: "c".repeat(64),
            keyPrefix: "platos_live_third",
          },
        })
      ).rejects.toThrow();
    } finally {
      await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
    }
  });

  test("serializes plaintext rotation against root rewrap without losing plaintext", async () => {
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:concurrent-rotation",
      environmentId,
    });
    const created = await store.create({
      authorization: operator,
      name: "CONCURRENT_API_KEY",
      provider: "concurrent",
      plaintext: "old-concurrent-secret",
    });
    const rootKeyV2 = randomBytes(32);
    const rotateDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const rewrapDatabase = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const rotateStore = new PlatosSecretStore(
      rotateDatabase,
      new CredentialRootKeyRing({ activeVersion: 1, keys: { 1: rootKeyV1 } })
    );
    const rewrapStore = new PlatosSecretStore(
      rewrapDatabase,
      new CredentialRootKeyRing({ activeVersion: 2, keys: { 1: rootKeyV1, 2: rootKeyV2 } })
    );
    await Promise.all([rotateDatabase.$connect(), rewrapDatabase.$connect()]);
    await database.$executeRawUnsafe(`CREATE FUNCTION "public"."delay_concurrent_envelope_for_test"()
      RETURNS TRIGGER AS $$ BEGIN
        IF NEW."credentialId" = '${created.id}'::uuid THEN
          PERFORM pg_sleep(CASE WHEN NEW."rootKeyVersion" = 2 THEN 0.2 ELSE 0.1 END);
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await database.$executeRawUnsafe(`CREATE TRIGGER "CredentialSecretVersion_delay_concurrent_for_test"
      BEFORE INSERT ON "public"."CredentialSecretVersion" FOR EACH ROW
      EXECUTE FUNCTION "public"."delay_concurrent_envelope_for_test"()`);
    try {
      await Promise.all([
        rotateStore.rotateCredential({
          authorization: operator,
          credentialId: created.id,
          plaintext: "new-concurrent-secret",
        }),
        rewrapStore.rewrapActive({ authorization: operator, credentialId: created.id }),
      ]);
      expect(
        (
          await rewrapStore.readForRuntime({
            authorization: runtime,
            credentialId: created.id,
          })
        ).reveal()
      ).toBe("new-concurrent-secret");
      expect(
        (
          await database.credential.findUniqueOrThrow({
            where: { id: created.id },
            include: { activeSecretVersion: true },
          })
        ).activeSecretVersion?.secretRevision
      ).toBe(2);
    } finally {
      await database.$executeRawUnsafe(
        'DROP TRIGGER "CredentialSecretVersion_delay_concurrent_for_test" ON "public"."CredentialSecretVersion"'
      );
      await database.$executeRawUnsafe(
        'DROP FUNCTION "public"."delay_concurrent_envelope_for_test"()'
      );
      await Promise.all([rotateDatabase.$disconnect(), rewrapDatabase.$disconnect()]);
    }
  });

  test("purges only cutoff-eligible retired versions in deterministic order and records metadata-only evidence", async () => {
    const rootOperations = authorizeCredentialRootOperations({
      actorId: "deployment:purge-eligibility",
      deploymentRole: "credential-root-operator",
    });
    const credential = await database.credential.create({
      data: {
        environmentId,
        kind: CredentialKind.SERVICE_CREDENTIAL,
        name: "PURGE_ELIGIBILITY",
      },
    });
    const old = new Date(Date.now() - 4 * 60 * 60 * 1_000);
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const recent = new Date(Date.now() - 60 * 60 * 1_000);
    const future = new Date(Date.now() + 60 * 60 * 1_000);
    const activeId = "50000000-0000-4000-8000-000000000005";
    const firstEligibleId = "50000000-0000-4000-8000-000000000001";
    const secondEligibleId = "50000000-0000-4000-8000-000000000002";
    const futureReadableId = "50000000-0000-4000-8000-000000000003";
    const recentRetirementId = "50000000-0000-4000-8000-000000000004";
    await database.credentialSecretVersion.createMany({
      data: [
        retiredVersion(credential.id, firstEligibleId, 1, 50, old, old),
        retiredVersion(credential.id, secondEligibleId, 2, 50, old, old),
        retiredVersion(credential.id, futureReadableId, 3, 50, old, future),
        retiredVersion(credential.id, recentRetirementId, 4, 50, recent, old),
        retiredVersion(credential.id, activeId, 5, 50, old, old),
      ],
    });
    await database.credential.update({
      where: { id: credential.id },
      data: { activeSecretVersionId: activeId },
    });

    await expect(
      store.purgeRetired({ authorization: rootOperations, cutoff, limit: 0 })
    ).rejects.toMatchObject({ code: "invalid_purge_request" });
    await expect(
      store.purgeRetired({
        authorization: rootOperations,
        cutoff: new Date(Date.now() + 60_000),
      })
    ).rejects.toMatchObject({ code: "invalid_purge_request" });
    await expect(
      store.purgeRetired({ authorization: ({} as never), cutoff })
    ).rejects.toMatchObject({ code: "credential_forbidden" });

    expect(
      await store.purgeRetired({ authorization: rootOperations, cutoff, limit: 1 })
    ).toEqual({ purgedCount: 1 });
    expect(
      await database.credentialSecretVersion.findMany({
        where: { credentialId: credential.id },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).not.toContainEqual({ id: firstEligibleId });
    expect(
      await store.purgeRetired({ authorization: rootOperations, cutoff, limit: 10 })
    ).toEqual({ purgedCount: 1 });
    expect(
      await database.credentialSecretVersion.findMany({
        where: { credentialId: credential.id },
        select: { id: true },
      })
    ).toEqual(
      expect.arrayContaining([
        { id: activeId },
        { id: futureReadableId },
        { id: recentRetirementId },
      ])
    );

    const audits = await database.credentialAudit.findMany({
      where: { credentialId: credential.id, action: "PURGE" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(audits.map((audit) => audit.secretRevision)).toEqual([1, 2]);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        environmentId,
        credentialId: credential.id,
        action: "PURGE",
        outcome: "SUCCESS",
        actorType: "operations",
        actorId: "deployment:purge-eligibility",
        fromRootKeyVersion: 50,
      });
      expect(audit.createdAt).toBeInstanceOf(Date);
      expect(JSON.stringify(audit)).not.toMatch(/ciphertext|authTag|nonce|salt|secret-material/);
    }
  });

  test("enforces the purge hard maximum even when a larger batch is requested", async () => {
    const rootOperations = authorizeCredentialRootOperations({
      actorId: "deployment:purge-bound",
      deploymentRole: "credential-root-operator",
    });
    const credential = await database.credential.create({
      data: {
        environmentId,
        kind: CredentialKind.SERVICE_CREDENTIAL,
        name: "PURGE_BOUND",
      },
    });
    const old = new Date("1990-01-01T00:00:00.000Z");
    await database.credentialSecretVersion.createMany({
      data: Array.from({ length: PURGE_RETIRED_HARD_LIMIT + 1 }, (_, index) =>
        retiredVersion(credential.id, undefined, index + 1, 51, old, old)
      ),
    });

    expect(
      await store.purgeRetired({
        authorization: rootOperations,
        cutoff: new Date("1991-01-01T00:00:00.000Z"),
        limit: PURGE_RETIRED_HARD_LIMIT + 500,
      })
    ).toEqual({ purgedCount: PURGE_RETIRED_HARD_LIMIT });
    expect(
      await database.credentialSecretVersion.count({ where: { credentialId: credential.id } })
    ).toBe(1);
    expect(
      await database.credentialAudit.count({
        where: { credentialId: credential.id, action: "PURGE", outcome: "SUCCESS" },
      })
    ).toBe(PURGE_RETIRED_HARD_LIMIT);
  });

  test("retires revoked envelopes until retention expires, then purges and unblocks root removal", async () => {
    const rootKeyV70 = randomBytes(32);
    const rootKeyV71 = randomBytes(32);
    const oldRootStore = new PlatosSecretStore(
      database,
      new CredentialRootKeyRing({ activeVersion: 70, keys: { 70: rootKeyV70 } })
    );
    const retiringRootStore = new PlatosSecretStore(
      database,
      new CredentialRootKeyRing({
        activeVersion: 71,
        keys: { 70: rootKeyV70, 71: rootKeyV71 },
      })
    );
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const rootOperations = authorizeCredentialRootOperations({
      actorId: "deployment:revoke-retention",
      deploymentRole: "credential-root-operator",
    });
    const created = await oldRootStore.create({
      authorization: operator,
      name: "REVOKED_RETENTION_API_KEY",
      provider: "retention",
      plaintext: "revoked-retention-secret",
    });
    const activeVersionId = created.activeSecretVersion?.id;
    expect(activeVersionId).toBeDefined();
    expect(await retiringRootStore.canRemoveRoot(rootOperations, 70)).toBe(false);

    const beforeRevoke = Date.now();
    await retiringRootStore.revoke({
      authorization: operator,
      credentialId: created.id,
      retentionMs: 500,
    });
    const revoked = await database.credential.findUniqueOrThrow({
      where: { id: created.id },
      include: { secretVersions: true },
    });
    const retiredVersion = revoked.secretVersions.find((version) => version.id === activeVersionId);
    expect(revoked.activeSecretVersionId).toBeNull();
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(retiredVersion?.retiredAt).toEqual(revoked.revokedAt);
    expect(retiredVersion?.readableUntil?.getTime()).toBeGreaterThanOrEqual(beforeRevoke + 500);
    expect(
      await database.credentialAudit.findFirstOrThrow({
        where: { credentialId: created.id, action: "REVOKE" },
      })
    ).toMatchObject({
      outcome: "SUCCESS",
      actorType: "operator",
      actorId: userId,
      secretRevision: 1,
      fromRootKeyVersion: 70,
    });

    await retiringRootStore.purgeRetired({
      authorization: rootOperations,
      cutoff: new Date(),
    });
    expect(
      await database.credentialSecretVersion.findUnique({ where: { id: activeVersionId! } })
    ).not.toBeNull();
    expect(await retiringRootStore.canRemoveRoot(rootOperations, 70)).toBe(false);

    const waitMs = Math.max(0, (retiredVersion?.readableUntil?.getTime() ?? 0) - Date.now() + 20);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    expect(
      (
        await retiringRootStore.purgeRetired({
          authorization: rootOperations,
          cutoff: new Date(),
        })
      ).purgedCount
    ).toBeGreaterThanOrEqual(1);
    expect(
      await database.credentialSecretVersion.findUnique({ where: { id: activeVersionId! } })
    ).toBeNull();
    expect(await retiringRootStore.canRemoveRoot(rootOperations, 70)).toBe(true);
    expect(
      await database.credentialAudit.count({
        where: { credentialId: created.id, action: "PURGE", outcome: "SUCCESS" },
      })
    ).toBe(1);
  });

  test("requires privileged global status and blocks root removal until every version is purged", async () => {
    const operator = await authorizeEnvironmentOperator(
      database,
      operatorAuth(userId),
      environmentId,
      "secret:mutate"
    );
    const runtime = await authorizeEnvironmentRuntime(database, {
      actorId: "agent:rewrap",
      environmentId,
    });
    const created = await store.create({
      authorization: operator,
      name: "VOYAGE_API_KEY",
      provider: "voyage",
      plaintext: "rewrap-secret",
    });
    const rootKeyV2 = randomBytes(32);
    const rotatingStore = new PlatosSecretStore(
      database,
      new CredentialRootKeyRing({ activeVersion: 2, keys: { 1: rootKeyV1, 2: rootKeyV2 } })
    );
    const rootOperations = authorizeCredentialRootOperations({
      actorId: "deployment:test",
      deploymentRole: "credential-root-operator",
    });
    await expect(rotatingStore.status(operator as never)).rejects.toMatchObject({
      code: "credential_forbidden",
    });
    expect(await rotatingStore.canRemoveRoot(rootOperations, 1)).toBe(false);
    await expect(
      rotatingStore.readForRuntime({ authorization: runtime, credentialId: created.id })
    ).resolves.toMatchObject({});
    const rewrapped = await rotatingStore.rewrapActive({
      authorization: operator,
      credentialId: created.id,
    });
    expect(rewrapped.activeSecretVersion?.rootKeyVersion).toBe(2);
    expect(
      (
        await rotatingStore.readForRuntime({ authorization: runtime, credentialId: created.id })
      ).reveal()
    ).toBe("rewrap-secret");
    for (const credential of await rotatingStore.listSafe(operator)) {
      if (credential.activeSecretVersion?.rootKeyVersion === 1) {
        await rotatingStore.rewrapActive({ authorization: operator, credentialId: credential.id });
      }
    }
    const foreignCredential = await database.credential.create({
      data: {
        environmentId: otherEnvironmentId,
        kind: CredentialKind.SERVICE_CREDENTIAL,
        name: "FOREIGN_RETIRED_ROOT_REFERENCE",
      },
    });
    await database.credentialSecretVersion.create({
      data: {
        credentialId: foreignCredential.id,
        secretRevision: 1,
        formatVersion: 1,
        rootKeyVersion: 1,
        salt: Buffer.alloc(32, 1),
        nonce: Buffer.alloc(12, 2),
        ciphertext: Buffer.from("unpurged"),
        authTag: Buffer.alloc(16, 3),
        retiredAt: new Date(Date.now() - 120_000),
        readableUntil: new Date(Date.now() - 60_000),
      },
    });
    const status = await rotatingStore.status(rootOperations);
    expect(status.unpurgedVersionsByRoot[1]).toBeGreaterThan(0);
    expect(await rotatingStore.canRemoveRoot(rootOperations, 1)).toBe(false);
    let purgedCount: number;
    do {
      ({ purgedCount } = await rotatingStore.purgeRetired({
        authorization: rootOperations,
        cutoff: new Date(),
      }));
    } while (purgedCount > 0);
    expect(await rotatingStore.canRemoveRoot(rootOperations, 1)).toBe(true);
    await expect(
      new PlatosSecretStore(
        database,
        new CredentialRootKeyRing({ activeVersion: 2, keys: { 2: rootKeyV2 } })
      ).readForRuntime({ authorization: runtime, credentialId: created.id })
    ).resolves.toMatchObject({});
    expect(
      await database.credentialAudit.count({
        where: { credentialId: created.id, action: "REWRAP" },
      })
    ).toBe(1);
  });
});

function operatorAuth(userId: string): OperatorAuthorization {
  return {
    sessionId: "test-session",
    actorUserId: userId,
    effectiveUserId: userId,
    email: "secrets@example.test",
    expiresAt: new Date(Date.now() + 60_000),
    mfaVerifiedAt: new Date(),
    impersonation: null,
  };
}

function retiredVersion(
  credentialId: string,
  id: string | undefined,
  secretRevision: number,
  rootKeyVersion: number,
  retiredAt: Date,
  readableUntil: Date
) {
  return {
    ...(id ? { id } : {}),
    credentialId,
    secretRevision,
    formatVersion: 1,
    rootKeyVersion,
    salt: Buffer.alloc(32, secretRevision % 255),
    nonce: Buffer.alloc(12, secretRevision % 255),
    ciphertext: Buffer.from(`retired-version-${secretRevision}`),
    authTag: Buffer.alloc(16, secretRevision % 255),
    retiredAt,
    readableUntil,
    createdAt: retiredAt,
  };
}
