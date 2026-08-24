import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";
import { traceSessionContext } from "./postman-context-handle";
import { buildSessionScope } from "./session-scope";
import { SafetyEventService } from "../monitoring/safety-event.service";
import { ToolAuditService } from "../monitoring/tool-audit.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const baseDatabaseUrl =
  process.env.POSTMAN_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;
const sentinel = "OVERRIDE_SECRET_SENTINEL";
const { Client } = require("pg") as { Client: new (options: unknown) => any };

class MemoryRedis {
  private readonly values = new Map<string, string>();

  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes("NX") && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }
}

describeWithDatabase("Postman execution PostgreSQL concurrency and leakage", () => {
  let admin: any;
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let ids: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    operatorUserId: string;
    memberUserId: string;
    agentId: string;
    agentVersionId: string;
    endUserId: string;
    templateId: string;
    outOfScopeTemplateId: string;
  };

  beforeAll(async () => {
    schemaName = `postman_${process.pid}_${Date.now()}`;
    admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    adminConnected = true;
    const migrationPath = resolve(
      process.cwd(),
      "../../internal-packages/tenancy-database/prisma/migrations/00000000000000_initial/migration.sql",
    );
    const migration = readFileSync(migrationPath, "utf8")
      .replaceAll('"public"', `"${schemaName}"`);
    await admin.query(migration);

    const url = new URL(baseDatabaseUrl!);
    url.searchParams.set("schema", schemaName);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    const operator = await prisma.user.create({
      data: {
        email: `${schemaName}@test.invalid`,
        displayName: "Postman Operator",
      },
    });
    const organization = await prisma.organization.create({
      data: { slug: schemaName, name: "Postman integration" },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: operator.id,
        role: "OWNER",
      },
    });
    const member = await prisma.user.create({
      data: {
        email: `${schemaName}-member@test.invalid`,
        displayName: "Postman Member",
      },
    });
    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: member.id,
        role: "MEMBER",
      },
    });
    const project = await prisma.project.create({
      data: {
        organizationId: organization.id,
        slug: schemaName,
        name: "Postman integration",
      },
    });
    const environment = await prisma.environment.create({
      data: {
        projectId: project.id,
        slug: "development",
        name: "Development",
      },
    });
    const agent = await prisma.agent.create({
      data: {
        projectId: project.id,
        slug: schemaName,
        name: "Postman integration",
      },
    });
    const agentVersion = await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "fixture:model",
        createdBy: operator.id,
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
      data: {
        organizationId: organization.id,
        displayName: "Simulated customer",
      },
    });
    await prisma.endUserIdentity.create({
      data: {
        endUserId: endUser.id,
        organizationId: organization.id,
        issuer: "platos:external",
        channel: "external",
        subject: "postman-external-subject",
        verifiedAt: new Date(),
      },
    });
    await prisma.thread.create({
      data: {
        environmentId: environment.id,
        agentId: agent.id,
        endUserId: endUser.id,
        title: "Environment presence seed",
      },
    });
    const template = await prisma.postmanTemplate.create({
      data: {
        environmentId: environment.id,
        agentId: agent.id,
        name: "Concurrent execution",
        simulateUserId: endUser.id,
        sessionContext: { account: "template" },
        createdBy: operator.id,
      },
    });
    const outOfScopeEnvironment = await prisma.environment.create({
      data: {
        projectId: project.id,
        slug: "staging",
        name: "Staging",
      },
    });
    const outOfScopeTemplate = await prisma.postmanTemplate.create({
      data: {
        environmentId: outOfScopeEnvironment.id,
        agentId: agent.id,
        name: "Out-of-scope execution",
        simulateUserId: endUser.id,
        sessionContext: {},
        createdBy: operator.id,
      },
    });
    ids = {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      operatorUserId: operator.id,
      memberUserId: member.id,
      agentId: agent.id,
      agentVersionId: agentVersion.id,
      endUserId: endUser.id,
      templateId: template.id,
      outOfScopeTemplateId: outOfScopeTemplate.id,
    };
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
    }
  });

  it("enforces the real Organization role and Environment target scope before dispatch", async () => {
    const dispatch = { collectTurn: vi.fn() };
    const controller: any = Object.create(AgentController.prototype);
    controller.agentService = { prisma };
    controller.dispatch = dispatch;
    controller.redis = new MemoryRedis();
    const body = {
      message: "Must not dispatch",
      requestId: "77777777-7777-4777-8777-777777777777",
      sessionContextOverride: {},
    };

    await expect(controller.executePostmanTemplate({
      scope: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        userId: ids.memberUserId,
        principal: "operator",
      },
    }, ids.templateId, body)).rejects.toMatchObject({
      response: { code: "POSTMAN_EXECUTION_FORBIDDEN" },
    });

    await expect(controller.executePostmanTemplate({
      scope: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        userId: ids.operatorUserId,
        principal: "operator",
      },
    }, ids.outOfScopeTemplateId, body)).rejects.toMatchObject({
      response: { code: "POSTMAN_EXECUTION_NOT_FOUND" },
    });
    expect(dispatch.collectTurn).not.toHaveBeenCalled();
  });

  it("admits one concurrent request, recovers retries, and persists actor-only forensic metadata", async () => {
    const redis = new MemoryRedis();
    let dispatchCount = 0;
    let releaseDispatch!: () => void;
    let signalDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolveStarted) => {
      signalDispatchStarted = resolveStarted;
    });
    const dispatchRelease = new Promise<void>((resolveRelease) => {
      releaseDispatch = resolveRelease;
    });
    const capturedDispatchScopes: Array<Record<string, unknown>> = [];
    const dispatch = {
      collectTurn: vi.fn(async (_agentId: string, options: any) => {
        dispatchCount += 1;
        capturedDispatchScopes.push(options.scope);
        signalDispatchStarted();
        await dispatchRelease;
        const thread = await prisma.thread.create({
          data: {
            environmentId: ids.environmentId,
            agentId: ids.agentId,
            endUserId: ids.endUserId,
            title: "Postman execution",
          },
        });
        const turn = await prisma.turn.create({
          data: {
            threadId: thread.id,
            agentVersionId: ids.agentVersionId,
            versionBucket: "CURRENT",
            sequence: 1,
            inputText: options.message,
            outputText: "persisted answer",
            status: "SUCCEEDED",
            idempotencyKey: options.idempotencyKey,
            completedAt: new Date(),
          },
        });
        return { threadId: thread.id, messageId: turn.id, text: turn.outputText };
      }),
    };
    const controller: any = Object.create(AgentController.prototype);
    controller.agentService = { prisma };
    controller.dispatch = dispatch;
    controller.redis = redis;

    const req = {
      scope: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
        userId: ids.operatorUserId,
        principal: "operator",
      },
    } as any;
    const requestId = "88888888-8888-4888-8888-888888888888";
    const body = {
      message: "Run once",
      requestId,
      sessionContextOverride: { account: sentinel },
    };

    const first = controller.executePostmanTemplate(req, ids.templateId, body);
    const second = controller.executePostmanTemplate(req, ids.templateId, body);
    await dispatchStarted;
    const earlySettlement = await Promise.race([
      first.then(
        () => ({ status: "fulfilled" as const }),
        (reason: any) => ({ status: "rejected" as const, reason }),
      ),
      second.then(
        () => ({ status: "fulfilled" as const }),
        (reason: any) => ({ status: "rejected" as const, reason }),
      ),
      new Promise<{ status: "timeout" }>((resolveTimeout) => {
        setTimeout(() => resolveTimeout({ status: "timeout" }), 10_000);
      }),
    ]);
    releaseDispatch();
    expect(earlySettlement.status).toBe("rejected");
    if (earlySettlement.status === "rejected") {
      expect(earlySettlement.reason.getResponse()).toMatchObject({
        code: "POSTMAN_EXECUTION_IN_PROGRESS",
      });
    }
    const settled = await Promise.allSettled([first, second]);

    expect(dispatchCount).toBe(1);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason.getResponse()).toMatchObject({
      code: "POSTMAN_EXECUTION_IN_PROGRESS",
    });

    const retry = await controller.executePostmanTemplate(req, ids.templateId, body);
    expect(retry.execution).toMatchObject({
      requestId,
      templateId: ids.templateId,
      agentId: ids.agentId,
      simulatedEndUserId: ids.endUserId,
      turnCount: 1,
      recovered: true,
    });
    expect(dispatchCount).toBe(1);

    const idempotencyKey = `postman:${ids.templateId}:${requestId}`;
    const [executionRows, matchingTurns] = await Promise.all([
      prisma.postmanExecution.findMany({
        where: { templateId: ids.templateId, requestId },
      }),
      prisma.turn.findMany({
        where: { idempotencyKey },
      }),
    ]);
    expect(executionRows).toHaveLength(1);
    expect(matchingTurns).toHaveLength(1);
    expect(executionRows[0]).toMatchObject({
      actorUserId: ids.operatorUserId,
      simulatedEndUserId: ids.endUserId,
      threadId: matchingTurns[0]!.threadId,
      turnId: matchingTurns[0]!.id,
      status: "SUCCEEDED",
    });
    expect(JSON.stringify(executionRows[0])).not.toContain(sentinel);

    const triggerScope = buildSessionScope(capturedDispatchScopes[0] as any);
    expect(triggerScope).toMatchObject({
      userId: "postman-external-subject",
      operatorUserId: ids.operatorUserId,
      sessionContextHandle: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(triggerScope).not.toHaveProperty("sessionContext");
    expect(JSON.stringify(triggerScope)).not.toContain(sentinel);
    expect(traceSessionContext({
      ...(capturedDispatchScopes[0] as any),
      sessionContext: { account: sentinel },
    })).toBeUndefined();
    expect(JSON.stringify(retry)).not.toContain(sentinel);

    const toolAudit = new ToolAuditService(prisma as any);
    const safetyEvents = new SafetyEventService(prisma as any);
    await toolAudit.record({
      scope: {
        organizationId: ids.organizationId,
        projectId: ids.projectId,
        environmentId: ids.environmentId,
      },
      toolName: "fixture.lookup",
      userId: "postman-external-subject",
      actorUserId: ids.operatorUserId,
      args: { safe: true },
      status: "success",
      latencyMs: 1,
    });
    await safetyEvents.record({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId: ids.environmentId,
      operatorUserId: ids.operatorUserId,
    }, {
      detector: "tool_param",
      action: "warn",
      severity: "medium",
      userId: "postman-external-subject",
      meta: { safe: true },
    });

    const [auditRow, safetyRow] = await Promise.all([
      prisma.toolCallAudit.findFirstOrThrow({
        where: { environmentId: ids.environmentId, toolName: "fixture.lookup" },
      }),
      prisma.safetyEvent.findFirstOrThrow({
        where: { environmentId: ids.environmentId, detector: "tool_param" },
      }),
    ]);
    expect(auditRow.arguments).toMatchObject({
      __platosAudit: {
        userId: "postman-external-subject",
        actorUserId: ids.operatorUserId,
      },
    });
    expect(safetyRow.metadata).toMatchObject({
      __platosSafety: {
        userId: "postman-external-subject",
        actorUserId: ids.operatorUserId,
      },
    });
    expect(JSON.stringify(auditRow.arguments)).not.toContain(sentinel);
    expect(JSON.stringify(safetyRow.metadata)).not.toContain(sentinel);
  });
});
