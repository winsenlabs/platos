import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@platos/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_REVISION_NOT_SUPPORTED,
  ConversationRevisionNotSupportedError,
  ConversationService,
} from "./conversation.service";

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
      resolve(process.cwd(), "../../internal-packages/database/prisma/schema.prisma"),
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
