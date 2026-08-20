import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AgentVersionBucket,
  ModelRateSource,
  PrismaClient,
  WorkStatus,
} from "../generated/control";
import {
  ModelPricingUnavailableError,
  modelPriceSnapshotStepData,
  PlatosModelPricing,
} from "./model-pricing";

describe("canonical model pricing integration", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let pricing: PlatosModelPricing;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(resolve(process.cwd(), "node_modules/.bin/prisma"), [
      "migrate",
      "deploy",
      "--schema",
      resolve(process.cwd(), "prisma/schema.prisma"),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    pricing = new PlatosModelPricing(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  test("verified fields always override the fetched LiteLLM row", async () => {
    const fetchedAt = new Date("2026-08-18T05:23:00.000Z");
    const result = await pricing.ingestLiteLLMCatalog(
      {
        "gpt-5.6-luna": {
          litellm_provider: "openai",
          input_cost_per_token: 1e-6,
          output_cost_per_token: 6e-6,
          cache_read_input_token_cost: 1e-7,
          cache_creation_input_token_cost: 1.25e-6,
        },
      },
      fetchedAt
    );

    expect(result).toMatchObject({ modelsSeen: 1, pricesCreated: 1 });
    const resolved = await pricing.resolvePrice("openai:gpt-5.6-luna", fetchedAt);
    expect(resolved.input).toMatchObject({
      usdPerToken: 2e-7,
      source: ModelRateSource.VERIFIED_PROVIDER,
    });
    expect(resolved.output.usdPerToken).toBe(1.2e-6);
    expect(resolved.cacheRead.usdPerToken).toBe(2e-8);
    expect(resolved.cacheWrite.usdPerToken).toBe(5e-7);
    expect(resolved.cacheWrite.observedAt.toISOString()).toBe("2026-07-31T00:00:00.000Z");
  });

  test("keeps Azure and OpenAI aliases distinct and scopes verified overrides by provider", async () => {
    const fetchedAt = new Date("2026-08-18T05:24:00.000Z");
    await pricing.ingestLiteLLMCatalog(
      {
        "gpt-4o-mini": {
          litellm_provider: "openai",
          input_cost_per_token: 2e-7,
          output_cost_per_token: 8e-7,
        },
        "azure/gpt-4o-mini": {
          litellm_provider: "azure",
          input_cost_per_token: 9e-7,
          output_cost_per_token: 3.6e-6,
        },
        "azure/gpt-5.6-luna": {
          litellm_provider: "azure",
          input_cost_per_token: 7e-7,
          output_cost_per_token: 4.2e-6,
          cache_read_input_token_cost: 7e-8,
          cache_creation_input_token_cost: 8.75e-7,
        },
      },
      fetchedAt,
    );

    const azure = await pricing.resolvePrice("azure:gpt-4o-mini", fetchedAt);
    const openai = await pricing.resolvePrice("openai:gpt-4o-mini", fetchedAt);
    const azureLuna = await pricing.resolvePrice("azure:gpt-5.6-luna", fetchedAt);

    expect(azure.modelKey).toBe("azure/gpt-4o-mini");
    expect(azure.input.usdPerToken).toBe(9e-7);
    expect(openai.modelKey).toBe("gpt-4o-mini");
    expect(openai.input.usdPerToken).toBe(2e-7);
    expect(azureLuna.input).toMatchObject({
      usdPerToken: 7e-7,
      source: ModelRateSource.LITELLM,
    });
    expect(azureLuna.output.usdPerToken).toBe(4.2e-6);
  });

  test("resolves historical versions and never reprices persisted Step evidence", async () => {
    const firstAt = new Date("2026-08-18T06:00:00.000Z");
    const secondAt = new Date("2026-08-19T06:00:00.000Z");
    const model = "openai/test-history";

    await pricing.ingestLiteLLMCatalog(
      {
        [model]: {
          litellm_provider: "openai",
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
        },
      },
      firstAt
    );
    const first = await pricing.priceUsage(
      "openai:test-history",
      { inputTokens: 1_000, outputTokens: 500 },
      firstAt
    );

    const organization = await prisma.organization.create({
      data: { slug: "pricing-org", name: "Pricing org" },
    });
    const project = await prisma.project.create({
      data: { organizationId: organization.id, slug: "pricing", name: "Pricing" },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "pricing", name: "Pricing" },
    });
    const agent = await prisma.agent.create({
      data: { projectId: project.id, slug: "pricing", name: "Pricing" },
    });
    const version = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "openai:test-history",
        createdBy: "pricing-test",
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
      data: { organizationId: organization.id, displayName: "Pricing subject" },
    });
    const thread = await prisma.thread.create({
      data: { environmentId: environment.id, agentId: agent.id, endUserId: endUser.id },
    });
    const turn = await prisma.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: version.id,
        versionBucket: AgentVersionBucket.CURRENT,
        sequence: 1,
        costCents: first.costCents,
      },
    });
    const step = await prisma.step.create({
      data: {
        turnId: turn.id,
        sequence: 1,
        model: "openai:test-history",
        status: WorkStatus.SUCCEEDED,
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costCents: first.costCents,
        ...modelPriceSnapshotStepData(first.price),
      },
    });

    await pricing.ingestLiteLLMCatalog(
      {
        [model]: {
          litellm_provider: "openai",
          input_cost_per_token: 4e-6,
          output_cost_per_token: 8e-6,
        },
      },
      secondAt
    );
    const historical = await pricing.resolvePrice(
      "openai:test-history",
      new Date("2026-08-18T12:00:00.000Z")
    );
    const current = await pricing.resolvePrice("openai:test-history", secondAt);
    const persisted = await prisma.step.findUniqueOrThrow({ where: { id: step.id } });

    expect(historical.input.usdPerToken).toBe(1e-6);
    expect(current.input.usdPerToken).toBe(4e-6);
    expect(Number(persisted.inputRate)).toBe(1e-6);
    expect(Number(persisted.costCents)).toBe(first.costCents);
    await expect(
      prisma.step.update({ where: { id: step.id }, data: { inputRate: 4e-6 } })
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.step.create({
        data: {
          turnId: turn.id,
          sequence: 2,
          model: "openai:test-history",
          inputTokens: 1,
          outputTokens: 0,
          costCents: 0,
          ...modelPriceSnapshotStepData({
            ...first.price,
            input: { ...first.price.input, usdPerToken: 9e-6 },
          }),
        },
      })
    ).rejects.toThrow(/does not match/);
  });

  test("rejects mutation of append-only ModelPrice rows", async () => {
    const row = await prisma.modelPrice.findFirstOrThrow();
    await expect(
      prisma.modelPrice.update({ where: { id: row.id }, data: { inputRate: 9e-6 } })
    ).rejects.toThrow(/immutable/);
    await expect(prisma.modelPrice.delete({ where: { id: row.id } })).rejects.toThrow(
      /immutable/
    );
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE TABLE "ModelPrice" CASCADE')
    ).rejects.toThrow(/immutable/);
  });

  test("returns an explicit error for an unknown model", async () => {
    await expect(pricing.resolvePrice("openai:not-a-real-model")).rejects.toBeInstanceOf(
      ModelPricingUnavailableError
    );
  });
});
