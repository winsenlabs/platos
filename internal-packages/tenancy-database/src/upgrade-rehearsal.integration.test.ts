import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "../generated/control";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const packageRoot = resolve(__dirname, "..");
const schemaPath = resolve(packageRoot, "prisma/schema.prisma");
const originMainInitial = readFileSync(
  resolve(packageRoot, "prisma/upgrade-baselines/origin-main/00000000000000_initial.sql"),
  "utf8"
);
const initialMigrationName = "00000000000000_initial";
const upgradeMigrationName = "20260824233000_m4_forward_upgrade_contract";
const originMainInitialSha256 = "5c43055e8b4d134676d7252ceba59bfe72d90b63c34be03e1807512b30ea19d3";

const ids = {
  user: "10000000-0000-4000-8000-000000000001",
  organization: "10000000-0000-4000-8000-000000000002",
  project: "10000000-0000-4000-8000-000000000003",
  environment: "10000000-0000-4000-8000-000000000004",
  secondEnvironment: "10000000-0000-4000-8000-000000000005",
  endUser: "10000000-0000-4000-8000-000000000006",
  agent: "10000000-0000-4000-8000-000000000007",
  agentVersion: "10000000-0000-4000-8000-000000000008",
  thread: "10000000-0000-4000-8000-000000000009",
  turn: "10000000-0000-4000-8000-00000000000a",
  attachment: "10000000-0000-4000-8000-00000000000b",
  unboundAttachment: "10000000-0000-4000-8000-00000000000c",
  entity: "10000000-0000-4000-8000-00000000000d",
  tool: "10000000-0000-4000-8000-00000000000e",
  mapping: "10000000-0000-4000-8000-00000000000f",
  ambiguousMapping: "10000000-0000-4000-8000-000000000010",
  policy: "10000000-0000-4000-8000-000000000011",
} as const;

describe.runIf(process.env.CI === "true")("origin/main forward-upgrade rehearsal", () => {
  let container: StartedPostgreSqlContainer;
  let databaseUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    databaseUrl = container.getConnectionUri();
    executeSql(originMainInitial, databaseUrl);

    runPrisma(["migrate", "resolve", "--applied", initialMigrationName], databaseUrl);
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await prisma.$executeRawUnsafe(
      'UPDATE "_prisma_migrations" SET "checksum" = $1 WHERE "migration_name" = $2',
      originMainInitialSha256,
      initialMigrationName
    );
    seedOriginMainRows(databaseUrl);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  test("fails loudly for non-derivable ownership, then preserves data and satisfies current runtime contracts", async () => {
    expect(() => runPrisma(["migrate", "deploy"], databaseUrl)).toThrow(
      /MessageAttachment ownership backfill failed: unattached=1, missing_turn_or_thread=0, scope_mismatch=0, conflicting_owner=0/
    );
    runPrisma(["migrate", "resolve", "--rolled-back", upgradeMigrationName], databaseUrl);
    await prisma.$executeRawUnsafe(
      'DELETE FROM "MessageAttachment" WHERE "id" = $1::uuid',
      ids.unboundAttachment
    );

    expect(() => runPrisma(["migrate", "deploy"], databaseUrl)).toThrow(
      /EntityToolPolicy ownership backfill failed: missing_owner=0, ambiguous_owner=1/
    );
    runPrisma(["migrate", "resolve", "--rolled-back", upgradeMigrationName], databaseUrl);
    await prisma.$executeRawUnsafe(
      'DELETE FROM "EnvironmentEntityTool" WHERE "id" = $1::uuid',
      ids.ambiguousMapping
    );

    runPrisma(["migrate", "deploy"], databaseUrl);

    await expect(
      prisma.messageAttachment.findUniqueOrThrow({ where: { id: ids.attachment } })
    ).resolves.toMatchObject({
      id: ids.attachment,
      environmentId: ids.environment,
      endUserId: ids.endUser,
      agentId: ids.agent,
      threadId: ids.thread,
      turnId: ids.turn,
      storageKey: "upgrade-preserved-attachment",
      originalName: "preserve-me.txt",
    });
    await expect(
      prisma.entityToolPolicy.findUniqueOrThrow({ where: { id: ids.policy } })
    ).resolves.toMatchObject({
      environmentId: ids.environment,
      entityId: ids.entity,
      toolId: ids.tool,
      effect: "ALLOW",
      minIdentityMode: "bearer",
      scopeLabels: ["tools:read"],
      addedBy: "origin-main-fixture",
    });
    await expect(
      prisma.thread.findUniqueOrThrow({ where: { id: ids.thread } })
    ).resolves.toMatchObject({
      forkedUpToTurnId: null,
      forkedTurnIds: [],
      title: "origin/main preserved thread",
    });

    const fork = await prisma.thread.create({
      data: {
        environmentId: ids.environment,
        agentId: ids.agent,
        endUserId: ids.endUser,
        parentThreadId: ids.thread,
        forkedUpToTurnId: ids.turn,
        forkedTurnIds: [ids.turn],
        title: "forward-upgrade fork",
      },
    });
    expect(fork).toMatchObject({
      parentThreadId: ids.thread,
      forkedUpToTurnId: ids.turn,
      forkedTurnIds: [ids.turn],
    });

    const execution = await prisma.postmanExecution.create({
      data: {
        environmentId: ids.environment,
        agentId: ids.agent,
        requestId: "20000000-0000-4000-8000-000000000001",
        requestFingerprint: "ab".repeat(32),
        actorUserId: ids.user,
        simulatedEndUserId: ids.endUser,
        contextHandle: "20000000-0000-4000-8000-000000000002",
        contextExpiresAt: new Date("2026-08-25T00:00:00.000Z"),
        threadId: ids.thread,
        turnId: ids.turn,
      },
    });
    expect(execution.turnId).toBe(ids.turn);
    await expect(
      prisma.postmanExecution.update({
        where: { id: execution.id },
        data: { requestFingerprint: "cd".repeat(32) },
      })
    ).rejects.toThrow(/PostmanExecution forensic attribution is immutable/);

    await expect(
      prisma.entityToolPolicy.create({
        data: {
          environmentId: ids.secondEnvironment,
          entityId: ids.entity,
          toolId: ids.tool,
          effect: "DENY",
          minIdentityMode: "oidc",
          addedBy: "upgrade-rehearsal",
        },
      })
    ).resolves.toMatchObject({ environmentId: ids.secondEnvironment });

    await expect(
      prisma.messageAttachment.update({
        where: { id: ids.attachment },
        data: { turnId: null },
      })
    ).rejects.toThrow(/MessageAttachment turn binding is one-way and immutable/);

    await expect(
      prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
        'SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL ORDER BY "migration_name"'
      )
    ).resolves.toEqual([
      { migration_name: initialMigrationName },
      { migration_name: "20260824010000_win144_observability_retry_vocabulary" },
      { migration_name: "20260824111500_memory_profile_key_and_source_contract" },
      { migration_name: upgradeMigrationName },
    ]);
  }, 180_000);
});

function seedOriginMainRows(databaseUrl: string): void {
  executeSql(
    `
    INSERT INTO "User" ("id", "email", "displayName", "updatedAt") VALUES
      ('${ids.user}', 'upgrade-rehearsal@example.test', 'Upgrade Rehearsal', NOW());
    INSERT INTO "Organization" ("id", "slug", "name", "updatedAt") VALUES
      ('${ids.organization}', 'upgrade-rehearsal', 'Upgrade Rehearsal', NOW());
    INSERT INTO "Project" ("id", "organizationId", "slug", "name", "updatedAt") VALUES
      ('${ids.project}', '${ids.organization}', 'upgrade-rehearsal', 'Upgrade Rehearsal', NOW());
    INSERT INTO "Environment" ("id", "projectId", "slug", "name", "updatedAt") VALUES
      ('${ids.environment}', '${ids.project}', 'development', 'Development', NOW()),
      ('${ids.secondEnvironment}', '${ids.project}', 'staging', 'Staging', NOW());
    INSERT INTO "EndUser" ("id", "organizationId", "displayName", "updatedAt") VALUES
      ('${ids.endUser}', '${ids.organization}', 'Preserved End User', NOW());
    INSERT INTO "Agent" ("id", "projectId", "name", "slug", "updatedAt") VALUES
      ('${ids.agent}', '${ids.project}', 'Upgrade Agent', 'upgrade-agent', NOW());
    INSERT INTO "AgentVersion" ("id", "agentId", "versionNumber", "model", "createdBy") VALUES
      ('${ids.agentVersion}', '${ids.agent}', 1, 'fixture:model', 'origin-main-fixture');
    INSERT INTO "Thread" ("id", "environmentId", "agentId", "endUserId", "title", "updatedAt") VALUES
      ('${ids.thread}', '${ids.environment}', '${ids.agent}', '${ids.endUser}', 'origin/main preserved thread', NOW());
    INSERT INTO "Turn" ("id", "threadId", "agentVersionId", "versionBucket", "sequence", "status") VALUES
      ('${ids.turn}', '${ids.thread}', '${ids.agentVersion}', 'CURRENT', 1, 'SUCCEEDED');
    INSERT INTO "MessageAttachment" (
      "id", "environmentId", "endUserId", "turnId", "kind", "mimeType", "bytes", "storageKey", "originalName"
    ) VALUES
      ('${ids.attachment}', '${ids.environment}', '${ids.endUser}', '${ids.turn}', 'file', 'text/plain', 17, 'upgrade-preserved-attachment', 'preserve-me.txt'),
      ('${ids.unboundAttachment}', '${ids.environment}', '${ids.endUser}', NULL, 'file', 'text/plain', 9, 'upgrade-unbound-attachment', 'unbound.txt');
    INSERT INTO "Entity" (
      "id", "projectId", "externalId", "displayName", "connectionStatus", "connectionKind", "updatedAt"
    ) VALUES
      ('${ids.entity}', '${ids.project}', 'upgrade-entity', 'Upgrade Entity', 'connected', 'mcp', NOW());
    INSERT INTO "Tool" ("id", "name", "description", "paramSchema", "schemaHash", "updatedAt") VALUES
      ('${ids.tool}', 'upgrade_tool', 'Upgrade rehearsal tool', '{}'::jsonb, 'upgrade-tool-v1', NOW());
    INSERT INTO "EnvironmentEntityTool" ("id", "environmentId", "entityId", "toolId", "updatedAt") VALUES
      ('${ids.mapping}', '${ids.environment}', '${ids.entity}', '${ids.tool}', NOW()),
      ('${ids.ambiguousMapping}', '${ids.secondEnvironment}', '${ids.entity}', '${ids.tool}', NOW());
    INSERT INTO "EntityToolPolicy" (
      "id", "entityId", "toolId", "effect", "minIdentityMode", "scopeLabels", "addedBy"
    ) VALUES
      ('${ids.policy}', '${ids.entity}', '${ids.tool}', 'ALLOW', 'bearer', ARRAY['tools:read']::TEXT[], 'origin-main-fixture');
  `,
    databaseUrl
  );
}

function runPrisma(args: string[], databaseUrl: string): string {
  try {
    return execFileSync(
      resolve(packageRoot, "node_modules/.bin/prisma"),
      [...args, "--schema", schemaPath],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        encoding: "utf8",
        stdio: "pipe",
      }
    );
  } catch (error: any) {
    const stdout = Buffer.isBuffer(error?.stdout)
      ? error.stdout.toString("utf8")
      : error?.stdout ?? "";
    const stderr = Buffer.isBuffer(error?.stderr)
      ? error.stderr.toString("utf8")
      : error?.stderr ?? "";
    throw new Error(`${stdout}\n${stderr}`.trim() || "Prisma command failed");
  }
}

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
