import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryImportService } from "./memory-import.service";
import { validateMemoryBundle } from "./memory-bundle";
import { MemoryService } from "./memory.service";
import {
  startPostgresIntegrationDatabase,
  type PostgresIntegrationDatabase,
} from "./postgres-integration-evidence";

type Fixture = Awaited<ReturnType<typeof seedScope>>;

describe("Memory PostgreSQL import/export transactions", () => {
  let database: PostgresIntegrationDatabase;
  let prisma: PrismaClient;
  let mutator: PrismaClient;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await startPostgresIntegrationDatabase();
    const databaseUrl = database.databaseUrl;
    execFileSync(
      resolve(process.cwd(), "../../node_modules/.bin/prisma"),
      [
        "migrate",
        "deploy",
        "--schema",
        resolve(process.cwd(), "../../internal-packages/tenancy-database/prisma/schema.prisma"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      },
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    mutator = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    fixture = await seedScope(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await mutator?.$disconnect();
    await database?.stop();
  });

  it("rolls back replace deletion when a required relationship insert fails", async () => {
    const memory = await prisma.memory.create({
      data: {
        environmentId: fixture.environmentId,
        endUserId: fixture.endUserId,
        agentId: fixture.agentId,
        kind: "fact",
        content: "Original memory",
        visibility: "agent_visible",
        agentVisible: true,
        source: "manual",
      },
    });
    const from = await prisma.memoryEntity.create({
      data: {
        environmentId: fixture.environmentId,
        endUserId: fixture.endUserId,
        agentId: fixture.agentId,
        entityKey: "person:original",
        entityType: "person",
        label: "Original",
      },
    });
    const to = await prisma.memoryEntity.create({
      data: {
        environmentId: fixture.environmentId,
        endUserId: fixture.endUserId,
        agentId: fixture.agentId,
        entityKey: "company:original",
        entityType: "company",
        label: "Original company",
      },
    });
    const relationship = await prisma.memoryRelationship.create({
      data: {
        environmentId: fixture.environmentId,
        endUserId: fixture.endUserId,
        agentId: fixture.agentId,
        fromEntityId: from.id,
        toEntityId: to.id,
        relationshipType: "works_at",
        sourceMemoryId: memory.id,
      },
    });
    const before = await persistedIds(prisma, fixture);
    const faultingPrisma = transactionFaultClient(prisma);
    const importer = new MemoryImportService(
      faultingPrisma as any,
      { embed: async () => Array.from({ length: 1_536 }, (_, index) => index === 0 ? 1 : 0) } as any,
    );
    const bundle = validateMemoryBundle({
      version: 2,
      memories: [{
        id: "import-memory",
        kind: "fact",
        content: "Imported memory",
        metadata: null,
        visibility: "agent_visible",
        agentVisible: true,
        source: "manual",
        sourceThreadId: null,
        sourceTurnIds: [],
      }],
      entities: [
        {
          id: "import-from",
          entityKey: "person:imported",
          entityType: "person",
          label: "Imported person",
        },
        {
          id: "import-to",
          entityKey: "company:imported",
          entityType: "company",
          label: "Imported company",
        },
      ],
      relationships: [{
        id: "import-relationship",
        fromEntityId: "import-from",
        toEntityId: "import-to",
        fromEntityKey: "person:imported",
        toEntityKey: "company:imported",
        relationshipType: "works_at",
        sourceMemoryId: "import-memory",
      }],
    });

    await expect(importer.importBundle(
      scope(fixture),
      fixture.externalUserId,
      bundle,
      "replace",
    )).rejects.toThrow("injected required relationship failure");

    await expect(persistedIds(prisma, fixture)).resolves.toEqual(before);
    expect(before).toEqual({
      memories: [memory.id],
      entities: [from.id, to.id].sort(),
      relationships: [relationship.id],
    });
  }, 180_000);

  it("exports each snapshot memory exactly once across pages during a concurrent mutation", async () => {
    await prisma.memoryRelationship.deleteMany({ where: { environmentId: fixture.environmentId } });
    await prisma.memoryEntity.deleteMany({ where: { environmentId: fixture.environmentId } });
    await prisma.memory.deleteMany({ where: { environmentId: fixture.environmentId } });
    const originalIds = [
      "10000000-0000-4000-8000-000000000010",
      "10000000-0000-4000-8000-000000000020",
      "10000000-0000-4000-8000-000000000030",
      "10000000-0000-4000-8000-000000000040",
    ];
    for (const [index, id] of originalIds.entries()) {
      await createFact(prisma, fixture, id, `Snapshot ${index}`);
    }
    const service = new MemoryService(prisma, { embed: async () => [0.1] } as any);

    const exportedIds = await prisma.$transaction(async (tx) => {
      const first = await service.listExportKeysetPage(
        scope(fixture),
        fixture.externalUserId,
        null,
        2,
        tx as any,
      );
      await createFact(
        mutator,
        fixture,
        "10000000-0000-4000-8000-000000000025",
        "Concurrent insert",
      );
      await mutator.memory.delete({ where: { id: originalIds[3]! } });

      const ids = first.items.map(({ id }) => id);
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await service.listExportKeysetPage(
          scope(fixture),
          fixture.externalUserId,
          cursor,
          2,
          tx as any,
        );
        ids.push(...page.items.map(({ id }) => id));
        cursor = page.items.length ? page.nextCursor : null;
      }
      return ids;
    }, { isolationLevel: "RepeatableRead", timeout: 120_000 });

    expect(exportedIds).toEqual(originalIds);
    expect(new Set(exportedIds).size).toBe(originalIds.length);
  }, 180_000);
});

function transactionFaultClient(prisma: PrismaClient): PrismaClient {
  return new Proxy(prisma, {
    get(target, property, receiver) {
      if (property !== "$transaction") return Reflect.get(target, property, receiver);
      return (callback: (tx: unknown) => Promise<unknown>, options: unknown) =>
        target.$transaction(async (tx) => callback(new Proxy(tx, {
          get(txTarget, txProperty, txReceiver) {
            if (txProperty !== "memoryRelationship") {
              const value = Reflect.get(txTarget, txProperty, txReceiver);
              return typeof value === "function" ? value.bind(txTarget) : value;
            }
            const delegate = Reflect.get(txTarget, txProperty, txReceiver);
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                if (delegateProperty === "upsert") {
                  return async () => {
                    throw new Error("injected required relationship failure");
                  };
                }
                const value = Reflect.get(delegateTarget, delegateProperty, delegateReceiver);
                return typeof value === "function" ? value.bind(delegateTarget) : value;
              },
            });
          },
        }) as any), options as any);
    },
  });
}

async function seedScope(prisma: PrismaClient) {
  const organization = await prisma.organization.create({
    data: { slug: "memory-import-export", name: "Memory import export" },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: organization.id,
      slug: "memory-import-export",
      name: "Memory import export",
    },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, slug: "development", name: "Development" },
  });
  const agent = await prisma.agent.create({
    data: { projectId: project.id, slug: "memory-import-export", name: "Memory import export" },
  });
  const version = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      model: "fixture:model",
      createdBy: "memory-import-export-test",
    },
  });
  await prisma.agentBinding.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      activeAgentVersionId: version.id,
    },
  });
  const endUser = await prisma.endUser.create({
    data: { organizationId: organization.id, displayName: "Import export subject" },
  });
  const externalUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await prisma.endUserIdentity.create({
    data: {
      endUserId: endUser.id,
      organizationId: organization.id,
      issuer: "platos",
      channel: "session",
      subject: externalUserId,
      verifiedAt: new Date(),
    },
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    agentId: agent.id,
    endUserId: endUser.id,
    externalUserId,
  };
}

function scope(fixture: Fixture) {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    agentId: fixture.agentId,
  };
}

async function createFact(
  prisma: PrismaClient,
  fixture: Fixture,
  id: string,
  content: string,
): Promise<void> {
  await prisma.memory.create({
    data: {
      id,
      environmentId: fixture.environmentId,
      endUserId: fixture.endUserId,
      agentId: fixture.agentId,
      kind: "fact",
      content,
      visibility: "agent_visible",
      agentVisible: true,
      source: "manual",
    },
  });
}

async function persistedIds(prisma: PrismaClient, fixture: Fixture) {
  const where = { environmentId: fixture.environmentId, endUserId: fixture.endUserId };
  const [memories, entities, relationships] = await Promise.all([
    prisma.memory.findMany({ where, select: { id: true }, orderBy: { id: "asc" } }),
    prisma.memoryEntity.findMany({ where, select: { id: true }, orderBy: { id: "asc" } }),
    prisma.memoryRelationship.findMany({ where, select: { id: true }, orderBy: { id: "asc" } }),
  ]);
  return {
    memories: memories.map(({ id }) => id),
    entities: entities.map(({ id }) => id),
    relationships: relationships.map(({ id }) => id),
  };
}
