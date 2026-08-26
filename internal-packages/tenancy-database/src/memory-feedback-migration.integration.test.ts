import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "../generated/control";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const packageRoot = resolve(__dirname, "..");
const schemaPath = resolve(packageRoot, "prisma/schema.prisma");
const initialMigration = resolve(
  packageRoot,
  "prisma/migrations/00000000000000_initial/migration.sql"
);
const feedbackSectionMarker = "-- Memory feedback quarantine and thumbs-feedback constraints";
const initialMigrationSql = readFileSync(initialMigration, "utf8");
const feedbackSectionOffset = initialMigrationSql.indexOf(feedbackSectionMarker);
if (feedbackSectionOffset === -1) throw new Error("Initial migration is missing feedback DDL");
const initialSchemaBeforeFeedback = initialMigrationSql.slice(0, feedbackSectionOffset);
const initialSchemaFromFeedback = initialMigrationSql.slice(feedbackSectionOffset);

describe("memory feedback migration", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    databaseUrl = container.getConnectionUri();
    executeSql(initialSchemaBeforeFeedback, databaseUrl);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  test("fails before DDL with actionable counts, then preserves authorized thumbs data", async () => {
    const organization = await prisma.organization.create({
      data: { slug: "feedback-migration", name: "Feedback migration" },
      select: { id: true },
    });
    const project = await prisma.project.create({
      data: {
        organizationId: organization.id,
        slug: "feedback-migration",
        name: "Feedback migration",
      },
      select: { id: true },
    });
    // This fixture intentionally stops before later additive migrations. Insert
    // through the legacy physical contract so the current generated client does
    // not project fields that do not exist at this historical migration point.
    const [environment] = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO "Environment" ("id", "projectId", "slug", "name", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), $1::uuid, 'development', 'Development', NOW(), NOW())
       RETURNING "id"`,
      project.id
    );
    if (!environment) throw new Error("Failed to seed legacy Environment fixture");
    const agent = await prisma.agent.create({
      data: { projectId: project.id, slug: "feedback-migration", name: "Feedback migration" },
      select: { id: true },
    });
    const version = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "fixture:model",
        createdBy: "migration-test",
      },
      select: { id: true },
    });
    const endUser = await prisma.endUser.create({
      data: { organizationId: organization.id, displayName: "Migration subject" },
      select: { id: true },
    });
    const thread = await prisma.thread.create({
      data: {
        environmentId: environment.id,
        agentId: agent.id,
        endUserId: endUser.id,
        title: "Migration fixture",
      },
      select: { id: true },
    });
    const turn = await prisma.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: version.id,
        versionBucket: "CURRENT",
        sequence: 1,
        status: "SUCCEEDED",
      },
      select: { id: true },
    });
    const ratingId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await prisma.$executeRawUnsafe(
      `INSERT INTO "MessageRating" (
         "id", "environmentId", "turnId", "agentId", "agentVersionId",
         "endUserId", "rating", "createdAt", "updatedAt"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, 2, NOW(), NOW())`,
      ratingId,
      environment.id,
      turn.id,
      agent.id,
      version.id,
      endUser.id
    );

    expect(() => executeSql(initialSchemaFromFeedback, databaseUrl)).toThrow(
      /MessageRating thumbs preflight failed: unsupported rows rating=2:1, rating=3:0, rating=4:0, rating=5:0, other:0/
    );
    await expect(
      prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'MessageRating'
             AND column_name = 'revision'
         ) AS "exists"`
      )
    ).resolves.toEqual([{ exists: false }]);

    // Product history authorizes 1 as thumbs-up. Once an operator deliberately
    // remediates unsupported source data, migration preserves that meaning.
    await prisma.$executeRawUnsafe(
      'UPDATE "MessageRating" SET "rating" = 1 WHERE "id" = $1::uuid',
      ratingId
    );
    executeSql(initialSchemaFromFeedback, databaseUrl);
    await expect(
      prisma.messageRating.findUniqueOrThrow({ where: { id: ratingId } })
    ).resolves.toMatchObject({ rating: 1, revision: 1 });
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "MessageRating" SET "rating" = 2 WHERE "id" = $1::uuid',
        ratingId
      )
    ).rejects.toThrow(/MessageRating_rating_check/);
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE "MessageRating" SET "rating" = -1 WHERE "id" = $1::uuid',
        ratingId
      )
    ).resolves.toBe(1);
  });
});

function executeSql(sql: string, databaseUrl: string): void {
  try {
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
  } catch (error: any) {
    const stdout = Buffer.isBuffer(error?.stdout) ? error.stdout.toString("utf8") : "";
    const stderr = Buffer.isBuffer(error?.stderr) ? error.stderr.toString("utf8") : "";
    throw new Error(`${stdout}\n${stderr}`.trim() || "Prisma db execute failed");
  }
}
