import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { MemoryProfileBackfillService } from "./memory-profile-backfill.service";
import {
  startPostgresIntegrationDatabase,
  type PostgresIntegrationDatabase,
} from "./postgres-integration-evidence";

const packageRoot = resolve(process.cwd(), "../../internal-packages/tenancy-database");
const schemaPath = resolve(packageRoot, "prisma/schema.prisma");
const initialSql = readFileSync(
  resolve(packageRoot, "prisma/migrations/00000000000000_initial/migration.sql"),
  "utf8"
);
const additiveSql = readFileSync(
  resolve(
    packageRoot,
    "prisma/migrations/20260824111500_memory_profile_key_and_source_contract/migration.sql"
  ),
  "utf8"
);

describe("Memory encrypted profile and legacy contract upgrade", () => {
  let database: PostgresIntegrationDatabase;
  let prisma: PrismaClient;
  let previousKey: string | undefined;
  let previousKeyVersion: string | undefined;

  beforeAll(async () => {
    database = await startPostgresIntegrationDatabase();
    const databaseUrl = database.databaseUrl;
    executeSql(initialSql, databaseUrl);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    previousKey = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    previousKeyVersion = process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V;
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = "11".repeat(32);
    process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V = "1";
  }, 180_000);

  afterAll(async () => {
    if (previousKey === undefined) delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY;
    else process.env.PLATOS_MESSAGE_ENCRYPTION_KEY = previousKey;
    if (previousKeyVersion === undefined) delete process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V;
    else process.env.PLATOS_MESSAGE_ENCRYPTION_KEY_V = previousKeyVersion;
    await prisma?.$disconnect();
    await database?.stop();
  });

  it("expands legacy rows, decrypts profiles, remaps losers, then installs uniqueness", async () => {
    const organization = await prisma.organization.create({
      data: { slug: "memory-profile-upgrade", name: "Memory profile upgrade" },
    });
    const project = await prisma.project.create({
      data: {
        organizationId: organization.id,
        slug: "memory-profile-upgrade",
        name: "Memory profile upgrade",
      },
    });
    // This fixture intentionally represents the catalog before later additive
    // migrations. Seed against that physical contract instead of asking the
    // current generated client to project columns that do not exist yet.
    const [environment] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "Environment" ("id", "projectId", "slug", "name", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1::uuid, 'development', 'Development', NOW(), NOW())
       RETURNING "id"`,
      project.id
    );
    if (!environment) throw new Error("Failed to seed legacy Environment fixture");
    const agent = await prisma.agent.create({
      data: { projectId: project.id, slug: "profile-upgrade", name: "Profile upgrade" },
    });
    const version = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "fixture:model",
        createdBy: "profile-upgrade-test",
      },
    });
    const endUser = await prisma.endUser.create({
      data: { organizationId: organization.id, displayName: "Profile upgrade subject" },
    });
    const thread = await prisma.thread.create({
      data: {
        environmentId: environment.id,
        agentId: agent.id,
        endUserId: endUser.id,
        title: "Legacy provenance",
      },
    });
    const turn = await prisma.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: version.id,
        versionBucket: "CURRENT",
        sequence: 1,
        status: "SUCCEEDED",
      },
    });
    const crypto = new MessageCryptoService();
    const profileEnvelope = crypto.encryptJsonField({ profileKey: " Preferred Name " });
    expect(profileEnvelope).toMatchObject({ __platos_enc: 1, v: 1 });

    const winnerId = "00000000-0000-4000-8000-000000000020";
    const loserId = "00000000-0000-4000-8000-000000000010";
    const privateLegacyId = "00000000-0000-4000-8000-000000000030";
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Memory" (
         "id", "environmentId", "endUserId", "agentId", "kind", "content", "metadata",
         "agentVisible", "visibility", "source", "sourceThreadId", "sourceTurnIds",
         "extractorVersion", "contentHash", "createdAt", "updatedAt"
       ) VALUES
         ($1::uuid, $4::uuid, $5::uuid, $6::uuid, 'profile', 'Ada', $7::jsonb,
          TRUE, 'subject', 'turn', $8::uuid, ARRAY[$9::uuid], 'legacy-extractor', repeat('a', 64), NOW() - INTERVAL '1 day', NOW()),
         ($2::uuid, $4::uuid, $5::uuid, $6::uuid, 'profile', 'Ada old', $7::jsonb,
          FALSE, 'subject', 'turn', $8::uuid, ARRAY[$9::uuid], 'legacy-extractor', repeat('b', 64), NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'),
         ($3::uuid, $4::uuid, $5::uuid, $6::uuid, 'fact', 'Private legacy', '{}'::jsonb,
          FALSE, 'subject', 'unknown_legacy', NULL, ARRAY[]::uuid[], NULL, NULL, NOW(), NOW())`,
      winnerId,
      loserId,
      privateLegacyId,
      environment.id,
      endUser.id,
      agent.id,
      JSON.stringify(profileEnvelope),
      thread.id,
      turn.id
    );
    const from = await prisma.memoryEntity.create({
      data: {
        environmentId: environment.id,
        endUserId: endUser.id,
        agentId: agent.id,
        entityKey: "person:ada",
        entityType: "person",
        label: "Ada",
      },
    });
    const to = await prisma.memoryEntity.create({
      data: {
        environmentId: environment.id,
        endUserId: endUser.id,
        agentId: agent.id,
        entityKey: "company:platos",
        entityType: "company",
        label: "Platos",
      },
    });
    const relationship = await prisma.memoryRelationship.create({
      data: {
        environmentId: environment.id,
        endUserId: endUser.id,
        agentId: agent.id,
        fromEntityId: from.id,
        toEntityId: to.id,
        relationshipType: "works_at",
        sourceMemoryId: loserId,
      },
    });

    executeSql(additiveSql, database.databaseUrl);
    await expect(indexNames(prisma)).resolves.toEqual([]);

    const normalized = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        visibility: string;
        agentVisible: boolean;
        source: string;
        originalSource: string | null;
        originalSourceThreadId: string | null;
        originalSourceTurnIds: string[];
      }>
    >(
      `SELECT "id", "visibility", "agentVisible", "source", "originalSource",
              "originalSourceThreadId", "originalSourceTurnIds"
       FROM "Memory" ORDER BY "id"`
    );
    expect(normalized.find(({ id }) => id === winnerId)).toMatchObject({
      visibility: "agent_visible",
      agentVisible: true,
      source: "extracted",
      originalSource: "turn",
      originalSourceThreadId: thread.id,
      originalSourceTurnIds: [turn.id],
    });
    expect(normalized.find(({ id }) => id === privateLegacyId)).toMatchObject({
      visibility: "private",
      agentVisible: false,
      source: "manual",
      originalSource: "unknown_legacy",
    });

    const result = await new MemoryProfileBackfillService(prisma, crypto).run();
    expect(result).toEqual({ profiles: 2, deduplicated: 1 });
    await expect(
      prisma.$queryRawUnsafe(`SELECT "id", "profileKey" FROM "Memory" WHERE "kind" = 'profile'`)
    ).resolves.toEqual([{ id: winnerId, profileKey: "preferred name" }]);
    await expect(
      prisma.memoryRelationship.findUniqueOrThrow({
        where: { id: relationship.id },
        select: { sourceMemoryId: true },
      })
    ).resolves.toEqual({ sourceMemoryId: winnerId });
    await expect(indexNames(prisma)).resolves.toEqual([
      "Memory_profile_cluster_key",
      "Memory_profile_standalone_key",
    ]);

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Memory" SET "visibility" = 'subject' WHERE "id" = $1::uuid`,
        privateLegacyId
      )
    ).rejects.toThrow(/Memory_visibility_check/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Memory" SET "source" = 'forged' WHERE "id" = $1::uuid`,
        privateLegacyId
      )
    ).rejects.toThrow(/Memory_source_check/);
  }, 180_000);
});

async function indexNames(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
    `SELECT indexname
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN ('Memory_profile_standalone_key', 'Memory_profile_cluster_key')
     ORDER BY indexname`
  );
  return rows.map(({ indexname }) => indexname);
}

function executeSql(sql: string, databaseUrl: string): void {
  execFileSync(
    resolve(packageRoot, "node_modules/.bin/prisma"),
    ["db", "execute", "--stdin", "--schema", schemaPath],
    {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      input: sql,
      stdio: "pipe",
    }
  );
}
