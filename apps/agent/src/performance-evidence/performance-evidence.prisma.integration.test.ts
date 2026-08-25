import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@platos/tenancy-database";
import { instrumentPerformanceEvidencePrisma } from "./performance-evidence.prisma";
import { PerformanceEvidenceService } from "./performance-evidence.service";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const QUERY_ID = "11111111-1111-4111-8111-111111111112";

describe("performance evidence Prisma integration", () => {
  let container: StartedPostgreSqlContainer;
  let basePrisma: PrismaClient;
  let prisma: PrismaClient;
  let evidence: PerformanceEvidenceService;
  const previousEnabled = process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
  const previousToken = process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;

  beforeAll(async () => {
    process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = "1";
    process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN = "performance-evidence-token-for-tests";
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    const repositoryRoot = resolve(process.cwd(), "../..");
    execFileSync(
      resolve(repositoryRoot, "node_modules/.bin/prisma"),
      [
        "migrate",
        "deploy",
        "--schema",
        resolve(repositoryRoot, "internal-packages/tenancy-database/prisma/schema.prisma"),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      }
    );
    evidence = new PerformanceEvidenceService();
    basePrisma = new PrismaClient({
      datasourceUrl: databaseUrl,
      log: [{ emit: "event", level: "query" }],
    });
    prisma = instrumentPerformanceEvidencePrisma(basePrisma, evidence);
    await basePrisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await basePrisma?.$disconnect();
    await container?.stop();
    if (previousEnabled === undefined) delete process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED;
    else process.env.PLATOS_PERFORMANCE_EVIDENCE_ENABLED = previousEnabled;
    if (previousToken === undefined) delete process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN;
    else process.env.PLATOS_PERFORMANCE_EVIDENCE_TOKEN = previousToken;
  });

  it("binds the engine query event to context captured by the real Prisma query extension", async () => {
    await evidence.runRequest(
      { requestId: REQUEST_ID, method: "GET", path: "/api/v1/agent/agents?limit=1&offset=0" },
      async () => {
        await prisma.user.findMany({ where: { id: QUERY_ID }, take: 1 });
      }
    );
    evidence.complete(REQUEST_ID, 200);

    const captured = evidence.consume(REQUEST_ID);
    expect(captured).toMatchObject({
      requestId: REQUEST_ID,
      path: "/api/v1/agent/agents?limit=1&offset=0",
      correlationStatus: "bound",
      queryCount: 1,
      queries: [
        {
          sequence: 1,
          replayable: true,
          correlation: "request-bound-prisma-extension",
        },
      ],
    });
    expect(captured?.queries[0].normalizedSql).toMatch(/^SELECT\b/);
    expect(captured?.queries[0].parameters).toContain(QUERY_ID);
  });
});
