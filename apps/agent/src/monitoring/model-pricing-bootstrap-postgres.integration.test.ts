import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  LITELLM_MODEL_CATALOG_URL,
  ModelRateSource,
  PrismaClient,
} from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CostService } from "./cost.service";
import { createCredibleLiteLLMCatalog } from "./litellm-catalog-validation.test-fixture";
import { ModelPricingBootstrapService } from "./model-pricing-bootstrap.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

describe("ModelPricingBootstrapService PostgreSQL bootstrap", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: ModelPricingBootstrapService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(resolve(process.cwd(), "../../node_modules/.bin/prisma"), [
      "migrate",
      "deploy",
      "--schema",
      resolve(process.cwd(), "../../internal-packages/tenancy-database/prisma/schema.prisma"),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    service = new ModelPricingBootstrapService(
      prisma,
      new CostService(prisma, {} as any),
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("fails closed while empty, then ingests canonical models idempotently", async () => {
    const sourceFailure = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(
      service.bootstrapIfEmpty(sourceFailure as typeof fetch, new Date("2026-08-20T00:00:00.000Z")),
    ).rejects.toThrow("LiteLLM bootstrap failed with HTTP 503");
    expect(await prisma.model.count()).toBe(0);
    expect(await prisma.modelPrice.count()).toBe(0);

    const fetchedAt = new Date("2026-08-20T01:00:00.000Z");
    const fixtureFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe(LITELLM_MODEL_CATALOG_URL);
      return Response.json({
        ...createCredibleLiteLLMCatalog(),
        "gpt-5.6-luna": {
          litellm_provider: "openai",
          input_cost_per_token: 1e-6,
          output_cost_per_token: 6e-6,
          cache_read_input_token_cost: 1e-7,
          cache_creation_input_token_cost: 1.25e-6,
          max_input_tokens: 128_000,
        },
      });
    });

    await expect(service.bootstrapIfEmpty(fixtureFetch as typeof fetch, fetchedAt)).resolves.toEqual({
      status: "bootstrapped",
      modelsSeen: 1_001,
      pricesCreated: 1_001,
      unchanged: 0,
    });

    const model = await prisma.model.findUniqueOrThrow({
      where: { key: "gpt-5.6-luna" },
      include: { prices: true },
    });
    expect(model).toMatchObject({ provider: "openai", name: "gpt-5.6-luna" });
    expect(model.prices).toHaveLength(1);
    expect(model.prices[0]).toMatchObject({
      inputSource: ModelRateSource.VERIFIED_PROVIDER,
      outputSource: ModelRateSource.VERIFIED_PROVIDER,
      cacheReadSource: ModelRateSource.VERIFIED_PROVIDER,
      cacheWriteSource: ModelRateSource.VERIFIED_PROVIDER,
      inputSourceRef: "https://developers.openai.com/api/docs/pricing",
    });
    expect(model.prices[0]?.inputRate.toNumber()).toBe(2e-7);
    expect(model.prices[0]?.cacheWriteRate.toNumber()).toBe(5e-7);

    const unexpectedFetch = vi.fn();
    await expect(service.bootstrapIfEmpty(unexpectedFetch as typeof fetch, fetchedAt)).resolves.toEqual({
      status: "already_ready",
    });
    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(await prisma.model.count()).toBe(1_001);
    expect(await prisma.modelPrice.count()).toBe(1_001);
  });
});
