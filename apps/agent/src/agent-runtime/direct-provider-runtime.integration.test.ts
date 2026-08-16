import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient, CredentialKind } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SecretsService } from "../auth/secrets.service";
import { ConversationService } from "../memory/conversation.service";
import { ModelCatalogService } from "../providers/model-catalog.service";
import { ProviderRegistryService } from "../providers/provider-registry.service";
import { ProviderRuntimeError } from "../providers/provider-runtime.error";
import { ScopedEnvService, credentialReference } from "../providers/scoped-env.service";
import { AgentService, type AgentStreamEvent } from "./agent.service";
import { AgentTaskService } from "./agent-task.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

class MemoryRedis {
  private readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  async eval(script: string, keyCount: number, key: string, token: string) {
    if (keyCount !== 1 || this.values.get(key) !== token) return 0;
    if (script.includes("del")) return this.del(key);
    if (script.includes("pexpire")) return 1;
    throw new Error("Unexpected Redis mutex script");
  }

  async publish() {
    return 0;
  }
}

async function collect(stream: AsyncGenerator<AgentStreamEvent>) {
  const events: AgentStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("direct provider runtime on a clean database", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let fixture: Server;
  let fixtureBaseURL: string;
  let failProvider = false;
  let service: AgentTaskService;
  let ids: { agentId: string; environmentId: string; organizationId: string; projectId: string };

  beforeAll(async () => {
    fixture = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        if (failProvider) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "upstream-body-with-secret-fixture-key" }));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        const created = Math.floor(Date.now() / 1000);
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion.chunk",
          created,
          model: "fixture-model",
          choices: [{ index: 0, delta: { role: "assistant", content: "deterministic reply" }, finish_reason: null }],
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: "chatcmpl-fixture",
          object: "chat.completion.chunk",
          created,
          model: "fixture-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolveReady) => fixture.listen(0, "127.0.0.1", resolveReady));
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
    fixtureBaseURL = `http://127.0.0.1:${address.port}`;

    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    const schemaPath = resolve(process.cwd(), "../../internal-packages/tenancy-database/prisma/schema.prisma");
    execFileSync(resolve(process.cwd(), "../../node_modules/.bin/prisma"), [
      "migrate",
      "deploy",
      "--schema",
      schemaPath,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    const organization = await prisma.organization.create({ data: { slug: "runtime-org", name: "Runtime Org" } });
    const project = await prisma.project.create({
      data: { organizationId: organization.id, slug: "runtime-project", name: "Runtime Project" },
    });
    const environment = await prisma.environment.create({
      data: { projectId: project.id, slug: "development", name: "Development" },
    });
    const user = await prisma.user.create({ data: { email: "runtime@test.invalid", displayName: "Runtime" } });
    const agent = await prisma.agent.create({
      data: { projectId: project.id, slug: "runtime-agent", name: "Runtime Agent" },
    });
    const version = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "openai:fixture-model",
        systemPrompt: "Reply deterministically.",
        promptBlocks: [],
        dynamicBlocks: [],
        toolsBlockConfig: { mode: "direct" },
        modelRoutes: [],
        memoryConfig: {
          __runtime: {
            executionMode: "direct",
            agentRetryConfig: { rules: [] },
            metaTools: {},
          },
        },
        maxSteps: 1,
        contextLimit: 20,
        createdBy: user.id,
      },
    });
    await prisma.agentBinding.create({
      data: {
        environmentId: environment.id,
        agentId: agent.id,
        activeAgentVersionId: version.id,
      },
    });
    await prisma.environmentProvider.create({
      data: { environmentId: environment.id, providerId: "openai", enabled: true },
    });

    const secrets = new SecretsService();
    const keyCredential = await prisma.credential.create({
      data: {
        environmentId: environment.id,
        kind: CredentialKind.SERVICE_CREDENTIAL,
        name: "OPENAI_API_KEY",
        provider: "openai",
        encryptedReference: secrets.encrypt("fixture-key"),
      },
    });
    await prisma.credential.create({
      data: {
        environmentId: environment.id,
        kind: CredentialKind.SECRET_REFERENCE,
        name: "OPENAI_BASE_URL",
        provider: "openai",
        encryptedReference: secrets.encrypt(fixtureBaseURL),
      },
    });
    await prisma.providerKey.create({
      data: {
        environmentId: environment.id,
        provider: "openai",
        label: "fixture",
        environmentKeyName: keyCredential.name,
        encryptedReference: credentialReference(keyCredential.id),
        isDefault: true,
        createdBy: user.id,
      },
    });

    ids = {
      agentId: agent.id,
      environmentId: environment.id,
      organizationId: organization.id,
      projectId: project.id,
    };

    const redis = new MemoryRedis();
    const scopedEnv = new ScopedEnvService(prisma, secrets);
    const catalog = new ModelCatalogService(scopedEnv);
    const registry = new ProviderRegistryService(prisma, scopedEnv, catalog);
    const agentService = new AgentService(
      redis as any,
      prisma,
      scopedEnv,
      { get: () => null } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registry,
    );
    const conversation = new ConversationService(prisma);
    const safety = {
      checkText: () => ({ passed: true, flags: [] }),
      checkGroundedness: () => ({ grounded: true, unsupportedClaims: [] }),
    };
    const cost = {
      beginReservation: vi.fn(),
      settleReservation: vi.fn().mockResolvedValue(undefined),
      calculateCost: vi.fn().mockResolvedValue(0),
      calculateCostWithCache: vi.fn().mockResolvedValue(0),
      recordUsage: vi.fn(),
    };
    const spans = {
      startTrace: () => ({ traceId: "a".repeat(32), rootSpanId: "b".repeat(16) }),
      nextSpanId: () => "c".repeat(16),
      record: vi.fn(),
    };
    const budget = {
      evaluate: vi.fn().mockResolvedValue({ blocked: false, caps: [] }),
      recordUserSpend: vi.fn(),
      detectThresholdCrossings: vi.fn().mockResolvedValue([]),
    };
    service = new AgentTaskService(
      agentService,
      conversation,
      safety as any,
      cost as any,
      spans as any,
      {} as any,
      {} as any,
      {
        resolveAttachments: vi.fn().mockResolvedValue([]),
        markAttachedToMessage: vi.fn(),
      } as any,
      budget as any,
      { checkUserMessage: vi.fn().mockResolvedValue({ allowed: true }) } as any,
      { record: vi.fn() } as any,
      redis as any,
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
    await new Promise<void>((resolveClosed, reject) => fixture?.close((error) => error ? reject(error) : resolveClosed()));
  });

  it("persists two successful direct turns and a failed Turn/Step on provider failure", async () => {
    const scope = {
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      userId: "runtime-end-user",
      agentId: ids.agentId,
    } as any;

    const first = await collect(service.executeStreamingTurn("first", scope, { agentId: ids.agentId }));
    const threadId = (first.find((event) => event.type === "meta") as any)?.thread_id as string;
    expect(first.filter((event) => event.type === "token").map((event: any) => event.text).join(""))
      .toBe("deterministic reply");
    expect(first.at(-1)).toMatchObject({ type: "done" });
    expect(first.findIndex((event) => event.type === "message_persisted"))
      .toBeLessThan(first.findIndex((event) => event.type === "done"));

    const second = await collect(service.executeStreamingTurn("second", scope, {
      agentId: ids.agentId,
      threadId,
    }));
    expect(second.filter((event) => event.type === "token").map((event: any) => event.text).join(""))
      .toBe("deterministic reply");
    expect(second.at(-1)).toMatchObject({ type: "done" });
    expect(second.findIndex((event) => event.type === "message_persisted"))
      .toBeLessThan(second.findIndex((event) => event.type === "done"));

    failProvider = true;
    const error = await collect(service.executeStreamingTurn("third", scope, {
      agentId: ids.agentId,
      threadId,
    })).catch((value) => value as ProviderRuntimeError);
    expect(error).toBeInstanceOf(ProviderRuntimeError);
    expect(error).toMatchObject({
      code: "provider_request_failed",
      message: "Provider request failed.",
    });

    const turns = await prisma.turn.findMany({
      where: { threadId },
      orderBy: { sequence: "asc" },
      include: { steps: true },
    });
    expect(turns).toHaveLength(3);
    expect(turns.slice(0, 2).map((turn) => ({
      status: turn.status,
      outputText: turn.outputText,
      stepStatus: turn.steps[0]?.status,
      model: turn.steps[0]?.model,
    }))).toEqual([
      { status: "SUCCEEDED", outputText: "deterministic reply", stepStatus: "SUCCEEDED", model: "openai:fixture-model" },
      { status: "SUCCEEDED", outputText: "deterministic reply", stepStatus: "SUCCEEDED", model: "openai:fixture-model" },
    ]);
    expect(turns[2]).toMatchObject({ status: "FAILED", outputText: null });
    expect(turns[2].steps).toHaveLength(1);
    expect(turns[2].steps[0]).toMatchObject({
      status: "FAILED",
      model: "openai:fixture-model",
      error: "Provider request failed.",
    });
    expect(JSON.stringify(turns[2])).not.toContain("upstream-body-with-secret-fixture-key");
    expect(JSON.stringify(turns[2])).not.toContain("fixture-key");
  });
});
