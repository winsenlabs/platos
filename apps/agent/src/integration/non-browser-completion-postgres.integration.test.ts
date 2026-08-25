import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CredentialKind, PrismaClient, ToolKind } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentController } from "../agent-runtime/agent.controller";
import { AgentCrudService } from "../agent-runtime/agent-crud.service";
import { AttachmentUploadController } from "../agent-runtime/attachment-upload.controller";
import { AttachmentsService } from "../agent-runtime/attachments.service";
import { AuthService } from "../auth/auth.service";
import type { RequestScope } from "../auth/scope.guard";
import { RatingService } from "../evals/rating.service";
import { McpBearerTokenService } from "../mcp-platform/mcp-bearer-token.service";
import { McpEntityController } from "../mcp-platform/mcp-entity.controller";
import { McpPlatformController } from "../mcp-platform/mcp-platform.controller";
import { McpToolAclService } from "../mcp-platform/mcp-tool-acl.service";
import { PlatosMCPTokenService } from "../mcp-platform/token.service";
import { ConversationService } from "../memory/conversation.service";

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(async () => "https://objects.example.test/presigned"),
}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const REQUIRED_FLAG = "PLATOS_NON_BROWSER_EVIDENCE_REQUIRED";
const requiredEvidence = process.env[REQUIRED_FLAG] === "1";
const databaseUrl = process.env.DATABASE_URL;
const candidateSha = process.env.PLATOS_NON_BROWSER_EVIDENCE_CANDIDATE_SHA;
const evidenceRunId = process.env.PLATOS_NON_BROWSER_EVIDENCE_RUN_ID;
const setupStubUrl = "postgresql://test:test@localhost:5432/platos_test";
const liveDatabaseUrl =
  requiredEvidence && databaseUrl && databaseUrl !== setupStubUrl ? databaseUrl : null;
const describeWithPostgres = describe.runIf(requiredEvidence);
const contractPath = path.resolve(
  process.cwd(),
  "../../tests/persisted-state-gate/non-browser-evidence-contract.json"
);
const outputPath = path.resolve(
  process.cwd(),
  process.env.PLATOS_NON_BROWSER_EVIDENCE_OUTPUT ??
    "../../artifacts/win235/non-browser-evidence.json"
);

interface ScopeFixture {
  key: "alpha" | "beta";
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  endUserId: string;
  externalUserId: string;
  agentId: string;
  agentVersionId: string;
  entityId: string;
  entityExternalId: string;
  toolId: string;
  mappingId: string;
  threadId: string;
  turnId: string;
  credentialId: string;
}

interface EvidenceAssertion {
  id: string;
  capabilityId: string;
  category: "concurrency" | "idempotency" | "persistedReadBack";
  status: "passed";
  facts: EvidenceFacts;
}

interface EvidenceFacts {
  stableError: { status: number | null; code: string };
  foreignState: { model: string; beforeCount: number; afterCount: number };
  recovery: { operation: string; outcome: string };
  readBack: { model: string; count: number; invariant: string };
}

const evidence = new Map<string, EvidenceAssertion>();
const noOpRedis = {
  del: vi.fn(async () => 0),
  publish: vi.fn(async () => 1),
  get: vi.fn(async () => null),
  set: vi.fn(async () => "OK"),
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function operatorScope(fixture: ScopeFixture): RequestScope {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    userId: fixture.userId,
    principal: "operator",
  } as RequestScope;
}

function endUserScope(fixture: ScopeFixture): RequestScope {
  return {
    organizationId: fixture.organizationId,
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    userId: fixture.externalUserId,
    agentId: fixture.agentId,
    principal: "end-user",
  } as RequestScope;
}

function request(scope: RequestScope) {
  return { scope } as any;
}

function controller<T>(prototype: object, dependencies: Record<string, unknown>): T {
  return Object.assign(Object.create(prototype), dependencies) as T;
}

function record(
  contract: Array<{
    id: string;
    capabilityId: string;
    category: EvidenceAssertion["category"];
    expectedFacts: EvidenceFacts;
  }>,
  ids: string[],
  facts: EvidenceFacts
) {
  for (const id of ids) {
    const expected = contract.find((item) => item.id === id);
    if (!expected)
      throw new Error(`Assertion ${id} is absent from the non-browser evidence contract`);
    if (evidence.has(id)) throw new Error(`Assertion ${id} was recorded more than once`);
    evidence.set(id, {
      id: expected.id,
      capabilityId: expected.capabilityId,
      category: expected.category,
      status: "passed",
      facts,
    });
  }
}

async function stableRejection(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error: any) {
    const response =
      typeof error?.getResponse === "function" ? error.getResponse() : error?.response;
    const status =
      typeof error?.getStatus === "function"
        ? error.getStatus()
        : typeof error?.status === "number"
        ? error.status
        : typeof error?.statusCode === "number"
        ? error.statusCode
        : typeof response?.statusCode === "number"
        ? response.statusCode
        : null;
    const code =
      (typeof response === "object" && response !== null
        ? response.code ?? response.message ?? response.error
        : response) ??
      error?.code ??
      error?.message;
    if (typeof code !== "string" || code.length === 0) {
      throw new Error("Rejected production operation did not expose a stable code or message");
    }
    return { status, code };
  }
  throw new Error("Expected production operation to reject");
}

function lockBarrier() {
  let signalAcquired!: () => void;
  let signalRelease!: () => void;
  const acquired = new Promise<void>((resolve) => (signalAcquired = resolve));
  const released = new Promise<void>((resolve) => (signalRelease = resolve));
  return {
    acquired,
    release: signalRelease,
    pause: async () => {
      signalAcquired();
      await released;
    },
  };
}

function withEnvironmentLockBarrier(database: PrismaClient, pause: () => Promise<void>) {
  return new Proxy(database, {
    get(target, property) {
      if (property === "$transaction") {
        return async (callback: (tx: unknown) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            let paused = false;
            const wrapped = new Proxy(tx, {
              get(transaction, transactionProperty) {
                if (transactionProperty === "$queryRaw") {
                  return async (...args: unknown[]) => {
                    const result = await (transaction.$queryRaw as any)(...args);
                    if (!paused) {
                      paused = true;
                      await pause();
                    }
                    return result;
                  };
                }
                const value = Reflect.get(transaction, transactionProperty, transaction);
                return typeof value === "function" ? value.bind(transaction) : value;
              },
            });
            return callback(wrapped);
          });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function withRevocationSnapshotSignal(database: PrismaClient, signal: () => void) {
  return new Proxy(database, {
    get(target, property) {
      if (property === "environment") {
        return new Proxy(target.environment, {
          get(delegate, delegateProperty) {
            if (delegateProperty === "findUnique") {
              return async (args: any) => {
                const result = await delegate.findUnique(args);
                if (args?.select?.accessKeyRevocationVersion) signal();
                return result;
              };
            }
            const value = Reflect.get(delegate, delegateProperty, delegate);
            return typeof value === "function" ? value.bind(delegate) : value;
          },
        });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedScope(prisma: PrismaClient, key: "alpha" | "beta"): Promise<ScopeFixture> {
  const suffix = `${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}-${key}`;
  const user = await prisma.user.create({
    data: { email: `nonbrowser-${suffix}@example.test`, displayName: `Non-browser ${key}` },
  });
  const organization = await prisma.organization.create({
    data: { slug: `nonbrowser-${suffix}`, name: `Non-browser ${key}` },
  });
  const membership = await prisma.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: "OWNER" },
  });
  const project = await prisma.project.create({
    data: {
      organizationId: organization.id,
      slug: `nonbrowser-${suffix}`,
      name: `Non-browser ${key}`,
    },
  });
  await prisma.projectMembership.create({
    data: {
      projectId: project.id,
      organizationMembershipId: membership.id,
      organizationId: organization.id,
      role: "ADMIN",
    },
  });
  const environment = await prisma.environment.create({
    data: { projectId: project.id, slug: "development", name: "Development" },
  });
  const endUser = await prisma.endUser.create({
    data: { organizationId: organization.id, displayName: `Evidence ${key} EndUser` },
  });
  const externalUserId = `nonbrowser-${suffix}-end-user`;
  await prisma.endUserIdentity.create({
    data: {
      endUserId: endUser.id,
      organizationId: organization.id,
      issuer: "platos:external",
      channel: "external",
      subject: externalUserId,
      verifiedAt: new Date(),
    },
  });
  const agent = await prisma.agent.create({
    data: { projectId: project.id, slug: `nonbrowser-${key}`, name: `Non-browser ${key}` },
  });
  const agentVersion = await prisma.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      model: "fixture:non-browser",
      createdBy: user.id,
      toolDefaultPolicy: "ALL",
    },
  });
  await prisma.agentBinding.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      activeAgentVersionId: agentVersion.id,
    },
  });
  const entity = await prisma.entity.create({
    data: {
      projectId: project.id,
      externalId: `nonbrowser-${key}`,
      displayName: `Non-browser ${key}`,
      connectionStatus: "connected",
      connectionKind: "mcp",
      mcpConfig: {
        create: {
          enabled: true,
          identityMode: "bearer",
          identityProviders: [],
          branding: {},
          toolAllowlist: [],
          redirectUriAllowlist: [],
          rateLimitPerMinute: 60,
        },
      },
    },
  });
  const tool = await prisma.tool.create({
    data: {
      name: `nonbrowser_${key}`,
      description: "Non-browser evidence tool",
      kind: ToolKind.ENTITY,
      paramSchema: { type: "object", properties: {} },
      schemaHash: hash(`nonbrowser-${suffix}`),
    },
  });
  const mapping = await prisma.environmentEntityTool.create({
    data: {
      environmentId: environment.id,
      entityId: entity.id,
      toolId: tool.id,
      enabled: true,
    },
  });
  const thread = await prisma.thread.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      endUserId: endUser.id,
      title: `Non-browser ${key}`,
    },
  });
  const turn = await prisma.turn.create({
    data: {
      threadId: thread.id,
      agentVersionId: agentVersion.id,
      versionBucket: "CURRENT",
      sequence: 1,
      inputText: "evidence input",
      outputText: "evidence output",
      status: "SUCCEEDED",
    },
  });
  const credential = await prisma.credential.create({
    data: {
      environmentId: environment.id,
      kind: CredentialKind.SECRET_REFERENCE,
      name: "NON_BROWSER_MCP_KEY",
      createdBy: user.id,
    },
  });
  return {
    key,
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    userId: user.id,
    endUserId: endUser.id,
    externalUserId,
    agentId: agent.id,
    agentVersionId: agentVersion.id,
    entityId: entity.id,
    entityExternalId: entity.externalId,
    toolId: tool.id,
    mappingId: mapping.id,
    threadId: thread.id,
    turnId: turn.id,
    credentialId: credential.id,
  };
}

describeWithPostgres("WIN-234 non-browser completion evidence", () => {
  let prisma: PrismaClient;
  let alpha: ScopeFixture;
  let beta: ScopeFixture;
  let contract: {
    schemaVersion: number;
    gate: string;
    suite: string;
    assertions: Array<{
      id: string;
      capabilityId: string;
      category: EvidenceAssertion["category"];
      expectedFacts: EvidenceFacts;
    }>;
  };
  let serverVersion = "";

  beforeAll(async () => {
    if (requiredEvidence && !liveDatabaseUrl) {
      throw new Error(`${REQUIRED_FLAG}=1 requires an explicit live DATABASE_URL`);
    }
    if (!liveDatabaseUrl)
      throw new Error("Live PostgreSQL evidence suite started without DATABASE_URL");
    if (!/^[a-f0-9]{40}$/.test(candidateSha ?? "")) {
      throw new Error("Required non-browser evidence needs an exact candidate SHA");
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(evidenceRunId ?? "")) {
      throw new Error("Required non-browser evidence needs an exact run ID");
    }
    await rm(outputPath, { force: true });
    contract = JSON.parse(await readFile(contractPath, "utf8"));
    prisma = new PrismaClient({ datasourceUrl: liveDatabaseUrl });
    await prisma.$connect();
    const version = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    serverVersion = version[0]?.version ?? "";
    if (!/^PostgreSQL\s+\d+/i.test(serverVersion)) {
      throw new Error("Non-browser completion evidence requires PostgreSQL");
    }
    [alpha, beta] = await Promise.all([seedScope(prisma, "alpha"), seedScope(prisma, "beta")]);
  });

  afterAll(async () => {
    try {
      if (requiredEvidence && contract) {
        const expectedIds = contract.assertions.map((item) => item.id).sort();
        const observedIds = [...evidence.keys()].sort();
        expect(observedIds).toEqual(expectedIds);
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(
          outputPath,
          `${JSON.stringify(
            {
              schemaVersion: contract.schemaVersion,
              gate: contract.gate,
              suite: contract.suite,
              requiredEvidence: true,
              commitSha: candidateSha,
              runId: evidenceRunId,
              generatedAt: new Date().toISOString(),
              database: {
                provider: "postgresql",
                serverVersion,
              },
              assertions: expectedIds.map((id) => evidence.get(id)),
            },
            null,
            2
          )}\n`
        );
      }
    } finally {
      if (prisma) {
        // This gate runs against a fresh disposable database. Keep append-only
        // AdminAudit evidence intact rather than running cascading DML cleanup.
        await prisma.$disconnect();
      }
    }
  });

  describe("credential references and uploads", () => {
    it("races and replays MCP credential-reference registration with canonical scope read-back", async () => {
      const auth = new AuthService(prisma, noOpRedis as any);
      const value = controller<AgentController>(AgentController.prototype, {
        authService: auth,
        agentService: { prisma },
        entityMcpDiscovery: undefined,
      });
      const body = {
        entityId: `reference-${randomUUID().slice(0, 8)}`,
        displayName: "Reference evidence",
        connectionKind: "mcp" as const,
        mcpClient: {
          transport: "remote-http",
          url: "https://mcp.example.test",
          credsSecretKey: "NON_BROWSER_MCP_KEY",
          headersTemplate: { Authorization: "Bearer {{secret}}" },
        },
      };
      const foreignBefore = await prisma.entity.count({
        where: { projectId: beta.projectId, externalId: body.entityId },
      });
      const concurrent = await Promise.allSettled([
        value.registerEntity(request(operatorScope(alpha)), body),
        value.registerEntity(request(operatorScope(alpha)), body),
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(concurrent.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(value.registerEntity(request(operatorScope(alpha)), body)).rejects.toMatchObject(
        {
          status: 409,
        }
      );

      const row = await prisma.entity.findUniqueOrThrow({
        where: { projectId_externalId: { projectId: alpha.projectId, externalId: body.entityId } },
        include: { mcpClient: { include: { credential: true } } },
      });
      expect(row.mcpClient).toMatchObject({ credentialId: alpha.credentialId });
      expect(row.mcpClient?.credential?.environmentId).toBe(alpha.environmentId);
      expect(row.mcpClient?.headersTemplate).toEqual({ Authorization: "Bearer {{secret}}" });
      expect(row.mcpClient?.credentialId).not.toBe(beta.credentialId);

      const stableError = await stableRejection(() =>
        value.registerEntity(request(operatorScope(alpha)), {
          ...body,
          entityId: `reference-rejected-${randomUUID().slice(0, 8)}`,
          mcpClient: { ...body.mcpClient, credsSecretKey: "MISSING_NON_BROWSER_KEY" },
        })
      );
      const recovered = await value.registerEntity(request(operatorScope(alpha)), {
        ...body,
        entityId: `reference-recovery-${randomUUID().slice(0, 8)}`,
      });
      expect(recovered.mcpClient.credsSecretKey).toBe("NON_BROWSER_MCP_KEY");
      const foreignAfter = await prisma.entity.count({
        where: { projectId: beta.projectId, externalId: body.entityId },
      });
      const canonicalCount = await prisma.entityMcpClient.count({
        where: { entityId: row.id, credentialId: alpha.credentialId },
      });
      record(
        contract.assertions,
        [
          "nonbrowser.mcp-credential-reference-migration.concurrency",
          "nonbrowser.mcp-credential-reference-migration.idempotency",
          "nonbrowser.mcp-credential-reference-migration.persisted-read-back",
        ],
        {
          stableError,
          foreignState: {
            model: "Entity",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "AgentController.registerEntity",
            outcome: recovered.id ? "entity-created" : "missing-id",
          },
          readBack: {
            model: "EntityMcpClient",
            count: canonicalCount,
            invariant: "same-environment-credential-linked",
          },
        }
      );
    });

    it("creates concurrent presigns only inside the canonical Agent/Thread boundary", async () => {
      process.env.MINIO_PUBLIC_ENDPOINT = "https://objects.example.test";
      const conversations = new ConversationService(prisma);
      const attachments = new AttachmentsService(prisma);
      const value = new AttachmentUploadController(conversations, attachments);
      const body = {
        agentId: alpha.agentId,
        threadId: alpha.threadId,
        filename: "evidence.txt",
        mimeType: "text/plain",
        bytes: 32,
      };
      const foreignBefore = await prisma.messageAttachment.count({
        where: { environmentId: beta.environmentId },
      });
      const created = await Promise.all([
        value.presign(request(operatorScope(alpha)), body),
        value.presign(request(operatorScope(alpha)), body),
      ]);
      expect(new Set(created.map((item) => item.attachmentId)).size).toBe(2);
      expect(getSignedUrl).toHaveBeenCalled();
      const stableError = await stableRejection(() =>
        value.presign(request(operatorScope(beta)), body)
      );
      const recovered = await value.presign(request(operatorScope(alpha)), body);
      expect(recovered.uploadUrl).toBe("https://objects.example.test/presigned");
      const rows = await prisma.messageAttachment.findMany({
        where: {
          id: { in: [...created.map((item) => item.attachmentId), recovered.attachmentId] },
        },
      });
      expect(rows).toHaveLength(3);
      expect(
        rows.every(
          (row) => row.environmentId === alpha.environmentId && row.threadId === alpha.threadId
        )
      ).toBe(true);
      const foreignAfter = await prisma.messageAttachment.count({
        where: { environmentId: beta.environmentId },
      });
      record(contract.assertions, ["nonbrowser.attachment-presign-upload.concurrency"], {
        stableError,
        foreignState: {
          model: "MessageAttachment",
          beforeCount: foreignBefore,
          afterCount: foreignAfter,
        },
        recovery: {
          operation: "AttachmentUploadController.presign",
          outcome: recovered.attachmentId ? "attachment-created" : "missing-id",
        },
        readBack: {
          model: "MessageAttachment",
          count: rows.length,
          invariant: "three-unique-alpha-pending-uploads",
        },
      });
    });
  });

  describe("template and access-key lifecycle", () => {
    it("races, replays, reads back, and deletes Postman templates through the controller", async () => {
      const value = controller<AgentController>(AgentController.prototype, {
        agentService: { prisma },
      });
      const created = await value.createPostmanTemplate(request(operatorScope(alpha)), {
        agentId: alpha.agentId,
        name: `template-${randomUUID().slice(0, 8)}`,
        simulateUserId: alpha.endUserId,
        sessionContext: { source: "evidence" },
      });
      const names = ["concurrent-left", "concurrent-right"];
      await Promise.all(
        names.map((name) =>
          value.updatePostmanTemplate(request(operatorScope(alpha)), created.template.id, { name })
        )
      );
      const winner = await prisma.postmanTemplate.findUniqueOrThrow({
        where: { id: created.template.id },
      });
      expect(names).toContain(winner.name);
      await Promise.all([
        value.updatePostmanTemplate(request(operatorScope(alpha)), created.template.id, {
          name: winner.name,
        }),
        value.updatePostmanTemplate(request(operatorScope(alpha)), created.template.id, {
          name: winner.name,
        }),
      ]);
      const betaTemplate = await prisma.postmanTemplate.create({
        data: {
          environmentId: beta.environmentId,
          agentId: beta.agentId,
          name: "beta-only",
          simulateUserId: beta.endUserId,
          createdBy: beta.userId,
        },
      });
      const foreignBefore = await prisma.postmanTemplate.count({
        where: { id: betaTemplate.id },
      });
      const stableError = await stableRejection(() =>
        value.updatePostmanTemplate(request(operatorScope(alpha)), betaTemplate.id, {
          name: "forged",
        })
      );
      expect(
        (await prisma.postmanTemplate.findUniqueOrThrow({ where: { id: betaTemplate.id } })).name
      ).toBe("beta-only");
      const recovered = await value.deletePostmanTemplate(
        request(operatorScope(alpha)),
        created.template.id
      );
      await value.deletePostmanTemplate(request(operatorScope(alpha)), created.template.id);
      const canonicalCount = await prisma.postmanTemplate.count({
        where: { id: created.template.id },
      });
      expect(canonicalCount).toBe(0);
      const foreignAfter = await prisma.postmanTemplate.count({
        where: { id: betaTemplate.id },
      });
      record(
        contract.assertions,
        [
          "nonbrowser.postman-template-crud.concurrency",
          "nonbrowser.postman-template-crud.idempotency",
          "nonbrowser.postman-template-crud.persisted-read-back",
        ],
        {
          stableError,
          foreignState: {
            model: "PostmanTemplate",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "AgentController.deletePostmanTemplate",
            outcome: recovered.ok ? "template-deleted" : "delete-failed",
          },
          readBack: {
            model: "PostmanTemplate",
            count: canonicalCount,
            invariant: "canonical-template-deleted",
          },
        }
      );
    });

    it("serializes allowed-origin replacement with both rotation lock interleavings", async () => {
      const auth = new AuthService(prisma, noOpRedis as any);
      const value = controller<AgentController>(AgentController.prototype, {
        authService: auth,
        agentService: { prisma },
      });
      await value.createOrRotateAccessKey(request(operatorScope(alpha)), {
        requestId: randomUUID(),
        keyHash: hash("origins-initial"),
        keyPrefix: "platos_live_org0",
      });
      await value.createOrRotateAccessKey(request(operatorScope(beta)), {
        requestId: randomUUID(),
        keyHash: hash("origins-beta"),
        keyPrefix: "platos_live_beta",
      });
      const foreignBefore = await prisma.accessKey.count({
        where: { environmentId: beta.environmentId, revokedAt: null, validUntil: null },
      });
      const firstDatabase = new PrismaClient({ datasourceUrl: liveDatabaseUrl! });
      const secondDatabase = new PrismaClient({ datasourceUrl: liveDatabaseUrl! });
      try {
        const rotationFirst = lockBarrier();
        const rotationController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(
            withEnvironmentLockBarrier(firstDatabase, rotationFirst.pause) as any,
            noOpRedis as any
          ),
        });
        const originsController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(secondDatabase, noOpRedis as any),
        });
        const firstOrigins = ["https://rotation-first.example.test"];
        const rotation = rotationController.createOrRotateAccessKey(request(operatorScope(alpha)), {
          requestId: randomUUID(),
          keyHash: hash("origins-rotation-first"),
          keyPrefix: "platos_live_org1",
        });
        await rotationFirst.acquired;
        const originUpdate = originsController.setAllowedOrigins(request(operatorScope(alpha)), {
          origins: firstOrigins,
        });
        rotationFirst.release();
        await Promise.all([rotation, originUpdate]);
        expect(
          (
            await prisma.accessKey.findFirstOrThrow({
              where: { environmentId: alpha.environmentId, revokedAt: null, validUntil: null },
            })
          ).allowedOrigins
        ).toEqual(firstOrigins);

        const originsFirst = lockBarrier();
        const lockedOriginsController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(
            withEnvironmentLockBarrier(firstDatabase, originsFirst.pause) as any,
            noOpRedis as any
          ),
        });
        const secondOrigins = ["https://origins-first.example.test"];
        const lockedOriginUpdate = lockedOriginsController.setAllowedOrigins(
          request(operatorScope(alpha)),
          { origins: secondOrigins }
        );
        await originsFirst.acquired;
        const queuedRotation = originsController.createOrRotateAccessKey(
          request(operatorScope(alpha)),
          {
            requestId: randomUUID(),
            keyHash: hash("origins-origins-first"),
            keyPrefix: "platos_live_org2",
          }
        );
        originsFirst.release();
        await Promise.all([lockedOriginUpdate, queuedRotation]);

        const active = await prisma.accessKey.findFirstOrThrow({
          where: { environmentId: alpha.environmentId, revokedAt: null, validUntil: null },
        });
        expect(active.allowedOrigins).toEqual(secondOrigins);
        const canonicalCount = await prisma.accessKey.count({
          where: { environmentId: alpha.environmentId, revokedAt: null, validUntil: null },
        });
        const stableError = await stableRejection(() =>
          value.setAllowedOrigins(
            request({ ...operatorScope(alpha), environmentId: beta.environmentId } as RequestScope),
            { origins: ["https://forged.example.test"] }
          )
        );
        const recovered = await value.setAllowedOrigins(request(operatorScope(alpha)), {
          origins: secondOrigins,
        });
        const foreignAfter = await prisma.accessKey.count({
          where: { environmentId: beta.environmentId, revokedAt: null, validUntil: null },
        });
        expect(
          (
            await prisma.accessKey.findFirstOrThrow({
              where: { environmentId: beta.environmentId, revokedAt: null, validUntil: null },
            })
          ).allowedOrigins
        ).toEqual([]);
        record(contract.assertions, ["nonbrowser.access-key-allowed-origins.concurrency"], {
          stableError,
          foreignState: {
            model: "AccessKey",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "AgentController.setAllowedOrigins",
            outcome: recovered.ok ? "origins-replayed" : "origin-replay-failed",
          },
          readBack: {
            model: "AccessKey",
            count: canonicalCount,
            invariant: "active-key-has-exact-origins-after-both-interleavings",
          },
        });
      } finally {
        await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
      }
    });

    it("makes revoke dominate both rotation lock interleavings before replay recovery", async () => {
      const auth = new AuthService(prisma, noOpRedis as any);
      const value = controller<AgentController>(AgentController.prototype, {
        authService: auth,
        agentService: { prisma },
      });
      const foreignBefore = await prisma.accessKey.count({
        where: { environmentId: beta.environmentId, revokedAt: null },
      });
      const firstDatabase = new PrismaClient({ datasourceUrl: liveDatabaseUrl! });
      const secondDatabase = new PrismaClient({ datasourceUrl: liveDatabaseUrl! });
      try {
        const rotationFirst = lockBarrier();
        const rotationController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(
            withEnvironmentLockBarrier(firstDatabase, rotationFirst.pause) as any,
            noOpRedis as any
          ),
        });
        const revokeController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(secondDatabase, noOpRedis as any),
        });
        const rotation = rotationController.createOrRotateAccessKey(request(operatorScope(alpha)), {
          requestId: randomUUID(),
          keyHash: hash("revoke-rotation-first"),
          keyPrefix: "platos_live_rev1",
        });
        await rotationFirst.acquired;
        const queuedRevoke = revokeController.deleteAccessKey(request(operatorScope(alpha)));
        rotationFirst.release();
        await Promise.all([rotation, queuedRevoke]);
        expect(
          await prisma.accessKey.count({
            where: { environmentId: alpha.environmentId, revokedAt: null },
          })
        ).toBe(0);

        await value.createOrRotateAccessKey(request(operatorScope(alpha)), {
          requestId: randomUUID(),
          keyHash: hash("revoke-second-fixture"),
          keyPrefix: "platos_live_rev2",
        });
        const revokeFirst = lockBarrier();
        const lockedRevokeController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(
            withEnvironmentLockBarrier(firstDatabase, revokeFirst.pause) as any,
            noOpRedis as any
          ),
        });
        const lockedRevoke = lockedRevokeController.deleteAccessKey(request(operatorScope(alpha)));
        await revokeFirst.acquired;
        let signalSnapshot!: () => void;
        const snapshot = new Promise<void>((resolve) => (signalSnapshot = resolve));
        const snapshotRotationController = controller<AgentController>(AgentController.prototype, {
          authService: new AuthService(
            withRevocationSnapshotSignal(secondDatabase, signalSnapshot) as any,
            noOpRedis as any
          ),
        });
        const supersededRotation = snapshotRotationController.createOrRotateAccessKey(
          request(operatorScope(alpha)),
          {
            requestId: randomUUID(),
            keyHash: hash("revoke-revoke-first"),
            keyPrefix: "platos_live_rev3",
          }
        );
        const supersededRejection = expect(supersededRotation).rejects.toThrow(
          "access_key_rotation_superseded"
        );
        await snapshot;
        revokeFirst.release();
        await lockedRevoke;
        await supersededRejection;
        const canonicalCount = await prisma.accessKey.count({
          where: { environmentId: alpha.environmentId, revokedAt: null },
        });
        expect(canonicalCount).toBe(0);

        const stableError = await stableRejection(() =>
          value.deleteAccessKey(
            request({ ...operatorScope(alpha), environmentId: beta.environmentId } as RequestScope)
          )
        );
        await value.deleteAccessKey(request(operatorScope(alpha)));
        const recovered = await value.createOrRotateAccessKey(request(operatorScope(alpha)), {
          requestId: randomUUID(),
          keyHash: hash("revoke-recovery"),
          keyPrefix: "platos_live_rev4",
        });
        expect(recovered.key.environmentId).toBe(alpha.environmentId);
        const foreignAfter = await prisma.accessKey.count({
          where: { environmentId: beta.environmentId, revokedAt: null },
        });
        record(contract.assertions, ["nonbrowser.access-key-revoke.concurrency"], {
          stableError,
          foreignState: {
            model: "AccessKey",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "AgentController.createOrRotateAccessKey",
            outcome: recovered.key.id ? "new-key-created-after-revocation-fence" : "missing-id",
          },
          readBack: {
            model: "AccessKey",
            count: canonicalCount,
            invariant: "no-active-key-after-both-interleavings",
          },
        });
      } finally {
        await Promise.all([firstDatabase.$disconnect(), secondDatabase.$disconnect()]);
      }
    });
  });

  describe("MCP token and ACL management", () => {
    it("mints collision-free platform tokens for concurrent and duplicate submissions", async () => {
      const service = new PlatosMCPTokenService(prisma);
      const value = controller<McpPlatformController>(McpPlatformController.prototype, {
        tokenService: service,
      });
      const body = { name: "evidence-token", permissions: ["agents.read"], ttlSeconds: 3600 };
      const foreignBefore = await prisma.mcpToken.count({
        where: { environmentId: beta.environmentId, name: body.name },
      });
      const first = await Promise.all([
        value.mintToken(request(operatorScope(alpha)), body),
        value.mintToken(request(operatorScope(alpha)), body),
      ]);
      const stableError = await stableRejection(() =>
        value.mintToken(
          request({ ...operatorScope(alpha), environmentId: beta.environmentId } as RequestScope),
          body
        )
      );
      const replay = await value.mintToken(request(operatorScope(alpha)), body);
      expect(new Set([...first, replay].map((item) => item.id)).size).toBe(3);
      expect(new Set([...first, replay].map((item) => item.token)).size).toBe(3);
      const rows = await prisma.mcpToken.findMany({
        where: { environmentId: alpha.environmentId, name: body.name },
      });
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.tokenHash.length === 64)).toBe(true);
      const foreignAfter = await prisma.mcpToken.count({
        where: { environmentId: beta.environmentId, name: body.name },
      });
      record(
        contract.assertions,
        ["nonbrowser.mcp-token-create.concurrency", "nonbrowser.mcp-token-create.idempotency"],
        {
          stableError,
          foreignState: {
            model: "McpToken",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "McpPlatformController.mintToken",
            outcome: replay.id ? "token-created" : "missing-id",
          },
          readBack: {
            model: "McpToken",
            count: rows.length,
            invariant: "three-distinct-hash-only-platform-tokens",
          },
        }
      );
    });

    it("mints collision-free entity bearers through the scoped management controller", async () => {
      const bearerTokens = new McpBearerTokenService(prisma);
      const value = controller<McpEntityController>(McpEntityController.prototype, {
        prisma,
        bearerTokenService: bearerTokens,
      });
      const body = { label: "evidence PAT", scopes: ["mcp:tools"], expiresIn: 3600 };
      const foreignBefore = await prisma.mcpBearerToken.count({
        where: { entityId: beta.entityId, environmentId: beta.environmentId, label: body.label },
      });
      const first = await Promise.all([
        value.generateBearerToken(request(operatorScope(alpha)), alpha.entityExternalId, body),
        value.generateBearerToken(request(operatorScope(alpha)), alpha.entityExternalId, body),
      ]);
      const stableError = await stableRejection(() =>
        value.generateBearerToken(request(operatorScope(beta)), alpha.entityExternalId, body)
      );
      const replay = await value.generateBearerToken(
        request(operatorScope(alpha)),
        alpha.entityExternalId,
        body
      );
      expect(new Set([...first, replay].map((item) => item.id)).size).toBe(3);
      expect(new Set([...first, replay].map((item) => item.raw)).size).toBe(3);
      const rows = await prisma.mcpBearerToken.findMany({
        where: { entityId: alpha.entityId, environmentId: alpha.environmentId, label: body.label },
      });
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.tokenHash.length === 64)).toBe(true);
      const foreignAfter = await prisma.mcpBearerToken.count({
        where: { entityId: beta.entityId, environmentId: beta.environmentId, label: body.label },
      });
      record(
        contract.assertions,
        [
          "nonbrowser.entity-mcp-bearer-token-create.concurrency",
          "nonbrowser.entity-mcp-bearer-token-create.idempotency",
        ],
        {
          stableError,
          foreignState: {
            model: "McpBearerToken",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "McpEntityController.generateBearerToken",
            outcome: replay.id ? "bearer-created" : "missing-id",
          },
          readBack: {
            model: "McpBearerToken",
            count: rows.length,
            invariant: "three-distinct-hash-only-entity-bearers",
          },
        }
      );
    });

    it("converges concurrent ACL writes to one canonical policy and recovers by replay", async () => {
      const acl = new McpToolAclService(prisma);
      const value = controller<McpEntityController>(McpEntityController.prototype, {
        prisma,
        toolAclService: acl,
      });
      const foreignBefore = await prisma.entityToolPolicy.count({
        where: {
          environmentId: beta.environmentId,
          entityId: beta.entityId,
          toolId: beta.toolId,
        },
      });
      const outcomes = await Promise.all([
        value.patchToolAcl(request(operatorScope(alpha)), alpha.entityExternalId, alpha.mappingId, {
          exposed: true,
          minIdentityMode: "bearer",
          scopeLabels: ["mcp:tools"],
        }),
        value.patchToolAcl(request(operatorScope(alpha)), alpha.entityExternalId, alpha.mappingId, {
          exposed: false,
          minIdentityMode: "oidc",
          scopeLabels: ["mcp:admin"],
        }),
      ]);
      const winner = outcomes.at(-1)!;
      const stableError = await stableRejection(() =>
        value.patchToolAcl(request(operatorScope(beta)), alpha.entityExternalId, alpha.mappingId, {
          exposed: true,
        })
      );
      const recovered = await value.patchToolAcl(
        request(operatorScope(alpha)),
        alpha.entityExternalId,
        alpha.mappingId,
        {
          exposed: winner.exposed,
          minIdentityMode: winner.minIdentityMode,
          scopeLabels: winner.scopeLabels,
        }
      );
      const rows = await prisma.entityToolPolicy.findMany({
        where: {
          environmentId: alpha.environmentId,
          entityId: alpha.entityId,
          toolId: alpha.toolId,
        },
      });
      expect(rows).toHaveLength(1);
      const foreignAfter = await prisma.entityToolPolicy.count({
        where: {
          environmentId: beta.environmentId,
          entityId: beta.entityId,
          toolId: beta.toolId,
        },
      });
      record(contract.assertions, ["nonbrowser.mcp-tool-acl-policy.concurrency"], {
        stableError,
        foreignState: {
          model: "EntityToolPolicy",
          beforeCount: foreignBefore,
          afterCount: foreignAfter,
        },
        recovery: {
          operation: "McpEntityController.patchToolAcl",
          outcome: recovered.id ? "policy-replayed" : "missing-id",
        },
        readBack: {
          model: "EntityToolPolicy",
          count: rows.length,
          invariant: "one-canonical-policy-after-race",
        },
      });
    });
  });

  describe("conversation and Agent tool state", () => {
    it("records explicit append semantics for concurrent and replayed Thread forks", async () => {
      const conversations = new ConversationService(prisma);
      const value = controller<AgentController>(AgentController.prototype, {
        conversationService: conversations,
        agentService: { prisma },
      });
      const body = { upToMessageId: alpha.turnId, title: "Evidence fork" };
      const foreignBefore = await prisma.thread.count({
        where: { environmentId: beta.environmentId, parentThreadId: alpha.threadId },
      });
      const concurrent = await Promise.all([
        value.forkThread(request(operatorScope(alpha)), alpha.threadId, body),
        value.forkThread(request(operatorScope(alpha)), alpha.threadId, body),
      ]);
      const stableError = await stableRejection(() =>
        value.forkThread(request(operatorScope(beta)), alpha.threadId, body)
      );
      const replay = await value.forkThread(request(operatorScope(alpha)), alpha.threadId, body);
      expect(new Set([...concurrent, replay].map((thread) => thread.id)).size).toBe(3);
      const rows = await prisma.thread.findMany({ where: { parentThreadId: alpha.threadId } });
      expect(rows).toHaveLength(3);
      expect(
        rows.every((row) => row.forkedUpToTurnId === alpha.turnId && row.forkedTurnIds.length === 1)
      ).toBe(true);
      expect(
        await prisma.turn.count({ where: { threadId: { in: rows.map((row) => row.id) } } })
      ).toBe(0);
      const foreignAfter = await prisma.thread.count({
        where: { environmentId: beta.environmentId, parentThreadId: alpha.threadId },
      });
      record(
        contract.assertions,
        ["nonbrowser.thread-fork.concurrency", "nonbrowser.thread-fork.idempotency"],
        {
          stableError,
          foreignState: {
            model: "Thread",
            beforeCount: foreignBefore,
            afterCount: foreignAfter,
          },
          recovery: {
            operation: "AgentController.forkThread",
            outcome: replay.id ? "child-thread-created" : "missing-id",
          },
          readBack: {
            model: "Thread",
            count: rows.length,
            invariant: "three-append-only-child-threads",
          },
        }
      );
    });

    it("replays the same rating into one canonical row and preserves scope isolation", async () => {
      const ratings = new RatingService(prisma);
      const value = controller<AgentController>(AgentController.prototype, {
        ratingService: ratings,
        agentService: { prisma },
      });
      const scope = endUserScope(alpha);
      const foreignBefore = await prisma.messageRating.count({
        where: { endUserId: beta.endUserId, turnId: alpha.turnId },
      });
      await value.rateMessage(request(scope), alpha.turnId, { rating: 1, comment: "stable" });
      await value.rateMessage(request(scope), alpha.turnId, { rating: 1, comment: "stable" });
      const stableError = await stableRejection(() =>
        value.rateMessage(request(endUserScope(beta)), alpha.turnId, { rating: -1 })
      );
      const rows = await prisma.messageRating.findMany({
        where: { turnId: alpha.turnId, endUserId: alpha.endUserId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rating: 1, revision: 2, comment: "stable" });
      const read = await value.getMessageRating(request(scope), alpha.turnId);
      expect(read).toMatchObject({ userRating: { rating: 1 }, aggregate: { ups: 1, downs: 0 } });
      const foreignAfter = await prisma.messageRating.count({
        where: { endUserId: beta.endUserId, turnId: alpha.turnId },
      });
      record(contract.assertions, ["nonbrowser.message-rating-lifecycle.idempotency"], {
        stableError,
        foreignState: {
          model: "MessageRating",
          beforeCount: foreignBefore,
          afterCount: foreignAfter,
        },
        recovery: {
          operation: "AgentController.getMessageRating",
          outcome: read.userRating?.rating === 1 ? "rating-read" : "rating-missing",
        },
        readBack: {
          model: "MessageRating",
          count: rows.length,
          invariant: "one-rating-at-revision-two",
        },
      });
    });

    it("replays Agent tool state through replacement versions without changing Environment exposure", async () => {
      const crud = new AgentCrudService(prisma, noOpRedis as any);
      const value = controller<AgentController>(AgentController.prototype, {
        agentCrud: crud,
        agentService: { prisma },
        toolRegistry: { refreshEnvironmentPolicies: vi.fn(async () => undefined) },
      });
      const beforeVersions = await prisma.agentVersion.count({ where: { agentId: alpha.agentId } });
      const foreignBefore = await prisma.agentVersion.count({ where: { agentId: beta.agentId } });
      await value.setAgentToolEnabled(request(operatorScope(alpha)), alpha.agentId, alpha.toolId, {
        enabled: false,
      });
      await value.setAgentToolEnabled(request(operatorScope(alpha)), alpha.agentId, alpha.toolId, {
        enabled: false,
      });
      const stableError = await stableRejection(() =>
        value.setAgentToolEnabled(request(operatorScope(beta)), alpha.agentId, alpha.toolId, {
          enabled: true,
        })
      );
      const recovered = await value.setAgentToolEnabled(
        request(operatorScope(alpha)),
        alpha.agentId,
        alpha.toolId,
        { enabled: false }
      );
      const binding = await prisma.agentBinding.findUniqueOrThrow({
        where: {
          environmentId_agentId: { environmentId: alpha.environmentId, agentId: alpha.agentId },
        },
      });
      const policy = await prisma.agentToolPolicy.findUniqueOrThrow({
        where: {
          agentVersionId_toolId: {
            agentVersionId: binding.activeAgentVersionId,
            toolId: alpha.toolId,
          },
        },
      });
      const mapping = await prisma.environmentEntityTool.findUniqueOrThrow({
        where: { id: alpha.mappingId },
      });
      expect(policy.effect).toBe("DENY");
      expect(mapping.enabled).toBe(true);
      expect(await prisma.agentVersion.count({ where: { agentId: alpha.agentId } })).toBe(
        beforeVersions + 3
      );
      const foreignAfter = await prisma.agentVersion.count({ where: { agentId: beta.agentId } });
      record(contract.assertions, ["nonbrowser.agent-tools-loader-action-mismatch.idempotency"], {
        stableError,
        foreignState: {
          model: "AgentVersion",
          beforeCount: foreignBefore,
          afterCount: foreignAfter,
        },
        recovery: {
          operation: "AgentController.setAgentToolEnabled",
          outcome: recovered.ok ? "replacement-version-created" : "replacement-failed",
        },
        readBack: {
          model: "AgentToolPolicy",
          count: 1,
          invariant: "active-version-denies-tool-without-disabling-environment-mapping",
        },
      });
    });
  });
});
