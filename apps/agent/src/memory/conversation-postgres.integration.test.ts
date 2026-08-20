import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  ModelRateSource,
  PlatosModelPricing,
  PrismaClient,
} from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_REVISION_NOT_SUPPORTED,
  ConversationRevisionNotSupportedError,
  ConversationService,
} from "./conversation.service";
import { ErasureService } from "../privacy/erasure.service";
import { roundCents } from "../monitoring/usage-ledger";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

describe("ConversationService PostgreSQL integrity", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: ConversationService;
  let ids: {
    agentId: string;
    agentVersionId: string;
    environmentId: string;
    organizationId: string;
    projectId: string;
    evidenceThreadId: string;
    sequenceThreadId: string;
    turnId: string;
  };

  const scope = () => ({
    organizationId: ids.organizationId,
    projectId: ids.projectId,
    environmentId: ids.environmentId,
    userId: "conversation-subject",
    agentId: ids.agentId,
  }) as any;

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

    const organization = await prisma.organization.create({
      data: { slug: "conversation-integrity", name: "Conversation Integrity" },
    });
    const project = await prisma.project.create({
      data: { organizationId: organization.id, slug: "conversation-integrity", name: "Conversation Integrity" },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    const user = await prisma.user.create({
      data: { email: "conversation-integrity@test.invalid", displayName: "Conversation Integrity" },
    });
    const agent = await prisma.agent.create({
      data: { projectId: project.id, slug: "conversation-integrity", name: "Conversation Integrity" },
    });
    const agentVersion = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "fixture:model",
        createdBy: user.id,
      },
    });
    await prisma.agentBinding.create({
      data: {
        environmentId: environment.id,
        agentId: agent.id,
        activeAgentVersionId: agentVersion.id,
      },
    });
    const endUser = await prisma.endUser.create({
      data: { organizationId: organization.id, displayName: "Conversation Subject" },
    });
    await prisma.endUserIdentity.create({
      data: {
        endUserId: endUser.id,
        organizationId: organization.id,
        issuer: "platos",
        channel: "session",
        subject: "conversation-subject",
        verifiedAt: new Date(),
      },
    });
    const [evidenceThread, sequenceThread] = await Promise.all([
      prisma.thread.create({
        data: { environmentId: environment.id, agentId: agent.id, endUserId: endUser.id, title: "Evidence" },
      }),
      prisma.thread.create({
        data: { environmentId: environment.id, agentId: agent.id, endUserId: endUser.id, title: "Sequence" },
      }),
    ]);
    const turn = await prisma.turn.create({
      data: {
        threadId: evidenceThread.id,
        agentVersionId: agentVersion.id,
        versionBucket: "CURRENT",
        sequence: 1,
        inputText: "original question",
        outputText: "original answer",
        status: "SUCCEEDED",
        startedAt: new Date("2026-08-15T00:00:00.000Z"),
        completedAt: new Date("2026-08-15T00:00:01.000Z"),
        steps: {
          create: {
            sequence: 1,
            model: "fixture:model",
            status: "SUCCEEDED",
            toolCalls: {
              create: {
                sequence: 1,
                toolName: "evidence_lookup",
                arguments: { query: "original" },
                result: { evidence: "retained" },
                status: "SUCCEEDED",
              },
            },
          },
        },
      },
    });
    await prisma.turn.create({
      data: {
        threadId: evidenceThread.id,
        agentVersionId: agentVersion.id,
        versionBucket: "CURRENT",
        sequence: 2,
        inputText: "downstream question",
        outputText: "downstream answer",
        status: "SUCCEEDED",
      },
    });

    ids = {
      agentId: agent.id,
      agentVersionId: agentVersion.id,
      environmentId: environment.id,
      organizationId: organization.id,
      projectId: project.id,
      evidenceThreadId: evidenceThread.id,
      sequenceThreadId: sequenceThread.id,
      turnId: turn.id,
    };
    service = new ConversationService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("fails edit/retry closed and retains every original Turn, Step, and ToolCall", async () => {
    const before = await readEvidence(prisma, ids.evidenceThreadId);

    for (const invoke of [
      () => service.editAndRerun(ids.evidenceThreadId, ids.turnId, scope(), "replacement question"),
      () => service.retryAssistantTurn(ids.evidenceThreadId, ids.turnId, scope()),
    ]) {
      const error = await invoke().catch((value) => value);
      expect(error).toBeInstanceOf(ConversationRevisionNotSupportedError);
      expect(error).toMatchObject(CONVERSATION_REVISION_NOT_SUPPORTED);
    }

    expect(await readEvidence(prisma, ids.evidenceThreadId)).toEqual(before);
    const read = await service.getMessages(ids.evidenceThreadId, scope());
    expect(read.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "original question"],
      ["assistant", "original answer"],
      ["user", "downstream question"],
      ["assistant", "downstream answer"],
    ]);
    expect(read.messages[1]?.toolCalls).toEqual([
      expect.objectContaining({
        name: "evidence_lookup",
        params: { query: "original" },
        result: { evidence: "retained" },
      }),
    ]);
  });

  it("allocates one unique monotonic sequence under real concurrent PostgreSQL writes", async () => {
    const writeCount = 24;
    const writes = Array.from({ length: writeCount }, (_, index) => service.storeMessage(
      ids.sequenceThreadId,
      scope(),
      {
        role: "user",
        content: `concurrent-${index}`,
        agentVersionId: ids.agentVersionId,
        versionBucket: "current",
      },
    ));

    const stored = await Promise.all(writes);
    expect(new Set(stored.map((message) => message.id)).size).toBe(writeCount);

    const rows = await prisma.turn.findMany({
      where: { threadId: ids.sequenceThreadId },
      orderBy: { sequence: "asc" },
      select: { sequence: true, inputText: true },
    });
    expect(rows.map((row) => row.sequence)).toEqual(
      Array.from({ length: writeCount }, (_, index) => index + 1),
    );
    expect(new Set(rows.map((row) => row.inputText)).size).toBe(writeCount);
  });

  it("persists a normally priced assistant Turn and immutable Step snapshot", async () => {
    const pricing = new PlatosModelPricing(prisma);
    const fetchedAt = new Date("2026-08-20T05:23:00.000Z");
    await pricing.ingestLiteLLMCatalog(
      {
        "openai/conversation-priced": {
          litellm_provider: "openai",
          input_cost_per_token: 1e-6,
          output_cost_per_token: 2e-6,
          cache_read_input_token_cost: 1e-7,
          cache_creation_input_token_cost: 1.25e-6,
        },
      },
      fetchedAt,
    );
    const priced = await pricing.priceUsage(
      "openai:conversation-priced",
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 30,
      },
      fetchedAt,
    );
    const identity = await prisma.endUserIdentity.findUniqueOrThrow({
      where: {
        organizationId_issuer_channel_subject: {
          organizationId: ids.organizationId,
          issuer: "platos",
          channel: "session",
          subject: "conversation-subject",
        },
      },
      select: { endUserId: true },
    });
    const thread = await prisma.thread.create({
      data: {
        environmentId: ids.environmentId,
        agentId: ids.agentId,
        endUserId: identity.endUserId,
        title: "Priced persistence",
      },
    });
    const opened = await service.storeMessage(thread.id, scope(), {
      role: "user",
      content: "price this response",
      agentVersionId: ids.agentVersionId,
      versionBucket: "current",
    });

    await expect(
      service.storeMessage(thread.id, scope(), {
        role: "assistant",
        turnId: opened.id,
        content: "persisted with evidence",
        model: "openai:conversation-priced",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 30,
        },
        costCents: priced.costCents,
        pricing: priced.price,
      }),
    ).resolves.toMatchObject({ role: "assistant", content: "persisted with evidence" });

    const persisted = await prisma.turn.findUniqueOrThrow({
      where: { id: opened.id },
      include: { steps: true },
    });
    expect(persisted).toMatchObject({
      status: "SUCCEEDED",
      outputText: "persisted with evidence",
    });
    // WIN-134 — the Turn carries the ledger-rounded aggregate so it agrees with
    // what CostService recomputes from the same Steps; the Step keeps the rate
    // engine's full-precision figure as evidence. Here they straddle a rounding
    // boundary, so a regression in either direction is visible.
    expect(Number(persisted.costCents)).toBe(roundCents(priced.costCents));
    expect(Number(persisted.steps[0]!.costCents)).toBe(priced.costCents);
    expect(persisted.steps).toHaveLength(1);
    expect(persisted.steps[0]).toMatchObject({
      modelPriceId: priced.price.modelPriceId,
      inputRateSource: ModelRateSource.LITELLM,
      outputRateSource: ModelRateSource.LITELLM,
      cacheReadRateSource: ModelRateSource.LITELLM,
      cacheWriteRateSource: ModelRateSource.LITELLM,
    });
    expect(Number(persisted.steps[0]!.inputRate)).toBe(1e-6);
    expect(Number(persisted.steps[0]!.cacheWriteRate)).toBe(1.25e-6);
    await expect(
      prisma.step.update({
        where: { id: persisted.steps[0]!.id },
        data: { inputRate: 9e-6 },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it("erases an ordinary authenticated runtime user through the canonical external tuple", async () => {
    const externalUserId = "ordinary-runtime-subject";
    const runtimeScope = {
      ...scope(),
      userId: externalUserId,
      principal: "end-user" as const,
      userIdentities: [
        { channel: "email", handle: "ordinary-runtime@test.invalid", verified: true },
      ],
    };
    const thread = await service.createThread(runtimeScope, ids.agentId, "Erase me");
    const identities = await prisma.endUserIdentity.findMany({
      where: { endUserId: thread.endUserId },
      orderBy: [{ issuer: "asc" }, { channel: "asc" }],
    });
    expect(identities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issuer: "platos:external",
        channel: "external",
        subject: externalUserId,
        verifiedAt: expect.any(Date),
      }),
      expect.objectContaining({
        issuer: "platos",
        channel: "session",
        subject: externalUserId,
        verifiedAt: expect.any(Date),
      }),
      expect.objectContaining({
        issuer: "channel:email",
        channel: "email",
        subject: "ordinary-runtime@test.invalid",
        verifiedAt: expect.any(Date),
      }),
    ]));

    const audit = await prisma.toolCallAudit.create({
      data: {
        environmentId: ids.environmentId,
        agentId: ids.agentId,
        threadId: thread.id,
        toolName: "runtime_tool",
        arguments: {
          __platosAudit: {
            userId: null,
            mcpUserId: null,
            endUserId: externalUserId,
          },
          value: { plaintext: "subject payload" },
        },
        result: { plaintext: "subject result" },
        error: "subject error",
        status: "FAILED",
        latencyMs: 12,
      },
    });
    await prisma.safetyEvent.create({
      data: {
        environmentId: ids.environmentId,
        agentId: ids.agentId,
        detector: "runtime",
        action: "block",
        severity: "high",
        metadata: { __platosSafety: { userId: externalUserId } },
      },
    });
    const otherOrganization = await prisma.organization.create({
      data: { slug: "erasure-other-org", name: "Erasure Other Org" },
    });
    const otherProject = await prisma.project.create({
      data: {
        organizationId: otherOrganization.id,
        slug: "erasure-other-project",
        name: "Erasure Other Project",
      },
    });
    const otherEnvironment = await prisma.environment.create({
      data: {
        projectId: otherProject.id,
        slug: "development",
        name: "Development",
      },
    });
    const otherAudit = await prisma.toolCallAudit.create({
      data: {
        environmentId: otherEnvironment.id,
        toolName: "other_org_runtime_tool",
        arguments: {
          __platosAudit: {
            userId: null,
            mcpUserId: null,
            endUserId: externalUserId,
          },
          value: { plaintext: "other organization payload" },
        },
        result: { plaintext: "other organization result" },
        error: "other organization error",
        status: "FAILED",
        latencyMs: 21,
      },
    });
    const otherSafety = await prisma.safetyEvent.create({
      data: {
        environmentId: otherEnvironment.id,
        detector: "runtime",
        action: "block",
        severity: "high",
        metadata: { __platosSafety: { userId: externalUserId } },
      },
    });

    const erasure = new ErasureService(prisma, {} as any);
    const subject = await erasure.discoverSubject(externalUserId, ids.organizationId);
    expect(subject.platosEndUserIds).toEqual([thread.endUserId]);
    const inventory = await erasure.inventory(subject, ids.organizationId);
    expect(inventory).toMatchObject({ toolCallAudits: 1, safetyEvents: 1 });
    const outcome = await (erasure as any).postgresExecutor(subject, ids.organizationId);

    expect(outcome).toMatchObject({ status: "done", verificationStatus: "passed" });
    await expect(prisma.endUser.findUnique({ where: { id: thread.endUserId } })).resolves.toBeNull();
    await expect(prisma.safetyEvent.count({
      where: {
        environment: { project: { organizationId: ids.organizationId } },
        metadata: { path: ["__platosSafety", "userId"], equals: externalUserId },
      },
    })).resolves.toBe(0);
    await expect(prisma.toolCallAudit.findUnique({ where: { id: audit.id } })).resolves.toMatchObject({
      endUserId: null,
      arguments: {
        __platosAudit: { userId: null, mcpUserId: null, endUserId: null },
      },
      result: null,
      error: null,
      toolName: "runtime_tool",
      status: "FAILED",
      latencyMs: 12,
    });
    await expect(prisma.toolCallAudit.findUnique({ where: { id: otherAudit.id } })).resolves.toMatchObject({
      arguments: {
        __platosAudit: { userId: null, mcpUserId: null, endUserId: externalUserId },
        value: { plaintext: "other organization payload" },
      },
      result: { plaintext: "other organization result" },
      error: "other organization error",
    });
    await expect(prisma.safetyEvent.findUnique({ where: { id: otherSafety.id } })).resolves.toMatchObject({
      metadata: { __platosSafety: { userId: externalUserId } },
    });
  });
});

async function readEvidence(prisma: PrismaClient, threadId: string) {
  return prisma.turn.findMany({
    where: { threadId },
    orderBy: { sequence: "asc" },
    select: {
      id: true,
      sequence: true,
      inputText: true,
      outputText: true,
      status: true,
      steps: {
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          model: true,
          status: true,
          toolCalls: {
            orderBy: { sequence: "asc" },
            select: {
              id: true,
              sequence: true,
              toolName: true,
              arguments: true,
              result: true,
              status: true,
            },
          },
        },
      },
    },
  });
}
