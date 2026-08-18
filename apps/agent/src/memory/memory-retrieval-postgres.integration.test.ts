import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryService } from "./memory.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const DIMENSIONS = 1_536;
const KIND = "filtered-hnsw-test";
const queryVector = unitVectorValues(1);

type ScopeFixture = Awaited<ReturnType<typeof seedScope>>;

describe("memory PostgreSQL HNSW retrieval", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let memory: MemoryService;
  let primary: ScopeFixture;
  let secondary: ScopeFixture;
  let otherAgentId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
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
      }
    );

    prisma = new PrismaClient({
      datasources: { db: { url: `${databaseUrl}?connection_limit=1` } },
    });
    memory = new MemoryService(prisma, { embed: async () => queryVector } as any);
    primary = await seedScope(prisma, "primary", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    secondary = await seedScope(prisma, "secondary", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    otherAgentId = await seedAgent(prisma, primary.projectId, primary.environmentId, "other");
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("fills selective filtered recall and exposes stable cosine/confidence reranking", async () => {
    await Promise.all([
      createMemoryBatch(prisma, secondary, {
        count: 450,
        cosine: 1,
        contentPrefix: "outside tenant",
      }),
      createMemoryBatch(prisma, primary, {
        count: 450,
        cosine: 0.999,
        agentId: otherAgentId,
        contentPrefix: "outside agent",
      }),
      createMemoryBatch(prisma, primary, {
        count: 450,
        cosine: 0.998,
        quarantinedAt: new Date(),
        contentPrefix: "quarantined",
      }),
      createMemoryBatch(prisma, primary, {
        count: 205,
        cosine: 0.9,
        contentPrefix: "eligible filler",
      }),
    ]);

    const boostedId = "00000000-0000-4000-8000-000000000010";
    const lowerTieId = "00000000-0000-4000-8000-000000000020";
    const higherTieId = "00000000-0000-4000-8000-000000000021";
    const closestId = "00000000-0000-4000-8000-000000000030";
    await Promise.all([
      createMemory(prisma, primary, {
        id: boostedId,
        content: "boosted lower cosine",
        cosine: 0.98,
        confidence: 1,
      }),
      createMemory(prisma, primary, {
        id: higherTieId,
        content: "higher stable tie",
        cosine: 0.97,
        confidence: 0.8,
      }),
      createMemory(prisma, primary, {
        id: lowerTieId,
        content: "lower stable tie",
        cosine: 0.97,
        confidence: 0.8,
      }),
      createMemory(prisma, primary, {
        id: closestId,
        content: "closest neutral cosine",
        cosine: 0.99,
        confidence: 0.5,
      }),
    ]);
    await prisma.$executeRawUnsafe('ANALYZE "Memory"');
    // Keep this regression on the ANN path even when the small test container
    // assigns an unrealistically cheap cost to sorting the filtered heap.
    await prisma.$executeRawUnsafe("SET enable_seqscan = off");
    await prisma.$executeRawUnsafe("SET enable_bitmapscan = off");
    await prisma.$executeRawUnsafe("SET enable_sort = off");

    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
      `EXPLAIN (COSTS OFF)
       SELECT "id"
       FROM "Memory"
       WHERE "environmentId" = $2::uuid
         AND "endUserId" = $3::uuid
         AND "embedding" IS NOT NULL
         AND "quarantinedAt" IS NULL
         AND "archivedAt" IS NULL
         AND "kind" = $4
         AND "agentId" = ANY($5::uuid[])
         AND "visibility" = ANY($6::text[])
       ORDER BY "embedding" <=> $1::vector
       LIMIT 200`,
      unitVector(1),
      primary.environmentId,
      primary.endUserId,
      KIND,
      [primary.agentId],
      ["agent_visible", "hidden"]
    );
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
      "Memory_embedding_hnsw_cosine_idx"
    );

    const first = await search(memory, primary, 50);
    const second = await search(memory, primary, 50);

    expect(first).toHaveLength(50);
    expect(second.slice(0, 4).map(({ id }) => id)).toEqual(first.slice(0, 4).map(({ id }) => id));
    expect(first.slice(0, 4).map(({ id }) => id)).toEqual([
      boostedId,
      lowerTieId,
      higherTieId,
      closestId,
    ]);
    expect(first[0]).toMatchObject({ id: boostedId });
    expect(first[0]!.score).toBeCloseTo(0.98, 5);
    expect(first[0]!.rankingScore).toBeCloseTo(0.984, 5);
    expect(first[3]!.score).toBeCloseTo(0.99, 5);
    expect(first[3]!.rankingScore).toBeCloseTo(0.892, 5);
    expect(
      first.every((hit) => hit.agentId === primary.agentId && hit.quarantinedAt === null)
    ).toBe(true);

    const cosineThreshold = await memory.semanticSearch(searchScope(primary), {
      query: "query",
      userId: primary.externalUserId,
      kind: KIND,
      limit: 50,
      minScore: 0.985,
    });
    expect(cosineThreshold.map(({ id }) => id)).toEqual([closestId]);
  });
});

async function seedScope(prisma: PrismaClient, slug: string, subject: string) {
  const organization = await prisma.organization.create({
    data: { slug: `retrieval-${slug}`, name: `Retrieval ${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: organization.id,
      slug: `retrieval-${slug}`,
      name: `Retrieval ${slug}`,
    },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, slug: "development", name: "Development" },
  });
  const agentId = await seedAgent(prisma, project.id, environment.id, slug);
  const endUser = await prisma.endUser.create({
    data: { organizationId: organization.id, displayName: `Retrieval ${slug} subject` },
  });
  await prisma.endUserIdentity.create({
    data: {
      endUserId: endUser.id,
      organizationId: organization.id,
      issuer: "platos",
      channel: "session",
      subject,
      verifiedAt: new Date(),
    },
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    agentId,
    endUserId: endUser.id,
    externalUserId: subject,
  };
}

async function seedAgent(
  prisma: PrismaClient,
  projectId: string,
  environmentId: string,
  slug: string
): Promise<string> {
  const agent = await prisma.agent.create({
    data: { projectId, slug: `retrieval-${slug}`, name: `Retrieval ${slug}` },
  });
  const version = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      model: "fixture:model",
      createdBy: "memory-retrieval-test",
    },
  });
  await prisma.agentBinding.create({
    data: {
      environmentId,
      agentId: agent.id,
      activeAgentVersionId: version.id,
    },
  });
  return agent.id;
}

async function createMemoryBatch(
  prisma: PrismaClient,
  fixture: ScopeFixture,
  input: {
    count: number;
    cosine: number;
    contentPrefix: string;
    agentId?: string;
    quarantinedAt?: Date;
  }
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Memory" (
       "id", "environmentId", "endUserId", "agentId", "kind", "content",
       "visibility", "source", "confidence", "quarantinedAt", "embedding",
       "createdAt", "updatedAt"
     )
     SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4,
            concat($5::text, ' ', series), 'agent_visible', 'extracted', 0.5,
            $6::timestamp, $7::vector, NOW(), NOW()
     FROM generate_series(1, $8::integer) AS series`,
    fixture.environmentId,
    fixture.endUserId,
    input.agentId ?? fixture.agentId,
    KIND,
    input.contentPrefix,
    input.quarantinedAt ?? null,
    unitVector(input.cosine),
    input.count
  );
}

async function createMemory(
  prisma: PrismaClient,
  fixture: ScopeFixture,
  input: {
    id: string;
    content: string;
    cosine: number;
    confidence: number;
  }
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Memory" (
       "id", "environmentId", "endUserId", "agentId", "kind", "content",
       "visibility", "source", "confidence", "embedding", "createdAt", "updatedAt"
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
               'agent_visible', 'extracted', $7, $8::vector, NOW(), NOW())`,
    input.id,
    fixture.environmentId,
    fixture.endUserId,
    fixture.agentId,
    KIND,
    input.content,
    input.confidence,
    unitVector(input.cosine)
  );
}

function search(memory: MemoryService, fixture: ScopeFixture, limit: number) {
  return memory.semanticSearch(searchScope(fixture), {
    query: "query",
    userId: fixture.externalUserId,
    kind: KIND,
    limit,
  });
}

function searchScope(fixture: ScopeFixture) {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    agentId: fixture.agentId,
  };
}

function unitVector(cosine: number): string {
  return `[${unitVectorValues(cosine).join(",")}]`;
}

function unitVectorValues(cosine: number): number[] {
  const values = Array<number>(DIMENSIONS).fill(0);
  values[0] = cosine;
  values[1] = Math.sqrt(Math.max(0, 1 - cosine ** 2));
  return values;
}
