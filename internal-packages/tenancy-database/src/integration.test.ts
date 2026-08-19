import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ApprovalStatus,
  AgentToolDefaultPolicy,
  AgentVersionBucket,
  AuthorizationScopeKind,
  CredentialKind,
  OrganizationRole,
  PolicyEffect,
  Prisma,
  PrismaClient,
  PrincipalTier,
  ProjectRole,
  ThreadCompactionState,
  ToolKind,
  WorkStatus,
  AuthRateLimitAction,
  ImpersonationAction,
  OperatorIdentityProvider,
} from "../generated/control";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createEndUserClient, endUserDelegateNames, type EndUserClient } from "./end-user";
import { resolveAgentToolIds } from "./tool-policy";

const future = () => new Date(Date.now() + 60 * 60 * 1000);
type UniqueWhere = Record<string, string>;
type Registry = Map<string, UniqueWhere>;

describe("domain schema integration", () => {
  let container: StartedPostgreSqlContainer;
  let control: PrismaClient;
  let endUser: EndUserClient;
  let seeded: Awaited<ReturnType<typeof seedEveryModel>>;

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

    control = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    endUser = createEndUserClient({ datasources: { db: { url: databaseUrl } } });
    seeded = await seedEveryModel(control);
  }, 120_000);

  afterAll(async () => {
    await endUser?.disconnect();
    await control?.$disconnect();
    await container?.stop();
  });

  test("round-trips every generated model and capability", async () => {
    const modelNames = Prisma.dmmf.datamodel.models.map((model) => model.name);
    expect(modelNames).toHaveLength(81);
    expect([...seeded.registry.keys()].sort()).toEqual([...modelNames].sort());

    for (const modelName of modelNames) {
      const delegateName = `${modelName[0].toLowerCase()}${modelName.slice(1)}`;
      const delegate = (control as unknown as Record<string, {
        findUnique(args: { where: UniqueWhere }): Promise<unknown>;
      }>)[delegateName];
      expect(delegate, modelName).toBeDefined();
      await expect(delegate.findUnique({ where: seeded.registry.get(modelName)! }), modelName)
        .resolves.not.toBeNull();
    }
  });

  test("exposes only subject delegates and no operator, configuration, or raw SQL path", async () => {
    expect(Object.keys(endUser).sort()).toEqual([...endUserDelegateNames, "disconnect"].sort());
    for (const forbidden of [
      "user",
      "organization",
      "project",
      "environment",
      "agent",
      "agentVersion",
      "credential",
      "entity",
      "tool",
      "toolCallAudit",
      "safetyEvent",
      "adminAudit",
      "erasureOperation",
      "$queryRaw",
      "$executeRaw",
      "$transaction",
      "$extends",
    ]) {
      expect(forbidden in endUser).toBe(false);
    }

    const visible = await endUser.thread.findUnique({
      where: { id: seeded.thread.id },
      include: {
        turns: { include: { steps: { include: { toolCalls: true } } } },
        artifacts: true,
        approvals: true,
        endUser: { include: { identities: true } },
      },
    });
    expect(visible?.endUser.id).toBe(seeded.endUser.id);
    expect(visible?.turns[0]?.steps[0]?.toolCalls[0]?.toolName).toBe("remember");

    if (false) {
      // @ts-expect-error The restricted client has no operator delegate.
      endUser.user;
      // @ts-expect-error Agent configuration is structurally unreachable.
      endUser.agentVersion;
      // @ts-expect-error Environment is a scalar scope pin, never a relation.
      endUser.thread.findMany({ include: { environment: true } });
    }
  });

  test("rejects cross-owner ancestry and canonical-owner reparenting", async () => {
    const otherOrganization = await control.organization.create({
      data: { slug: "other-organization", name: "Other organization" },
    });
    const otherProject = await control.project.create({
      data: { organizationId: otherOrganization.id, slug: "other", name: "Other" },
    });
    const otherEnvironment = await control.environment.create({
      data: { projectId: otherProject.id, slug: "other", name: "Other" },
    });

    await expect(control.thread.create({
      data: {
        environmentId: otherEnvironment.id,
        agentId: seeded.agent.id,
        endUserId: seeded.endUser.id,
        status: WorkStatus.ACTIVE,
      },
    })).rejects.toThrow(/ancestry/);

    await expect(control.environment.update({
      where: { id: seeded.environment.id },
      data: { projectId: otherProject.id },
    })).rejects.toThrow(/immutable/);

    await expect(control.agentBinding.create({
      data: {
        environmentId: otherEnvironment.id,
        agentId: seeded.agent.id,
        activeAgentVersionId: seeded.agentVersion.id,
      },
    })).rejects.toThrow(/ancestry/);

    const sameOrganizationSubject = await control.endUser.create({
      data: { organizationId: seeded.organization.id, displayName: "Other subject" },
    });
    await expect(control.endUserIdentity.update({
      where: { id: seeded.endUserIdentity.id },
      data: { endUserId: sameOrganizationSubject.id },
    })).rejects.toThrow(/immutable/);
    await expect(control.endUserIdentity.findUnique({ where: { id: seeded.endUserIdentity.id } }))
      .resolves.toMatchObject({ endUserId: seeded.endUser.id, organizationId: seeded.organization.id });
    await expect(control.endUserSession.findFirst({
      where: { identityId: seeded.endUserIdentity.id, revokedAt: null },
    })).resolves.not.toBeNull();
    const crossOrganizationSubject = await control.endUser.create({
      data: { organizationId: otherOrganization.id, displayName: "Cross-organization subject" },
    });
    await expect(control.endUserIdentity.update({
      where: { id: seeded.endUserIdentity.id },
      data: {
        endUserId: crossOrganizationSubject.id,
        organizationId: otherOrganization.id,
      },
    })).rejects.toThrow(/immutable/);

    const siblingApp = await control.channelApp.create({
      data: {
        environmentId: seeded.environment.id,
        provider: "teams",
        clientId: "sibling-client",
        distribution: "private",
        agentRouting: [],
      },
    });
    await expect(control.channelInstallation.update({
      where: { id: seeded.installation.id },
      data: { appId: siblingApp.id },
    })).rejects.toThrow(/immutable/);
    await expect(control.channelInstallation.findUnique({ where: { id: seeded.installation.id } }))
      .resolves.toMatchObject({ appId: seeded.installation.appId });

    await control.organizationMembership.create({
      data: {
        organizationId: otherOrganization.id,
        userId: seeded.user.id,
        role: OrganizationRole.MEMBER,
      },
    });
    await expect(control.mcpBearerToken.create({
      data: {
        entityId: seeded.mcpBearerToken.entityId,
        environmentId: otherEnvironment.id,
        createdByUserId: seeded.user.id,
        tokenHash: "cross-environment-mcp-bearer",
        label: "invalid",
        mcpUserId: "invalid",
        scopes: ["tools:call"],
      },
    })).rejects.toThrow(/ancestry/);
    await expect(control.oAuthClient.update({
      where: { id: seeded.oauthClient.id },
      data: { organizationId: otherOrganization.id, entityId: null },
    })).rejects.toThrow(/immutable/);
    await expect(control.oAuthClient.findUnique({ where: { id: seeded.oauthClient.id } }))
      .resolves.toMatchObject({ organizationId: seeded.organization.id });

    const sameSubjectEntity = await control.memoryEntity.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: sameOrganizationSubject.id,
        agentId: seeded.agent.id,
        entityKey: "other-subject-entity",
        entityType: "person",
        label: "Other",
      },
    });
    await expect(control.memoryEntity.update({
      where: { id: seeded.memoryEntityA.id },
      data: { endUserId: sameSubjectEntity.endUserId },
    })).rejects.toThrow(/immutable/);
  });

  test("keeps AdminAudit append-only and rolls back a promotion when audit insertion fails", async () => {
    const audit = await control.adminAudit.create({
      data: {
        environmentId: seeded.environment.id,
        actorUserId: seeded.user.id,
        action: "agent.canary.promote",
        subjectType: "Agent",
        subjectId: seeded.agent.id,
        before: { previousCurrentVersionId: seeded.agentVersion.id },
        after: { currentVersionId: seeded.agentVersion.id },
        source: "integration-test",
      },
    });
    await expect(control.adminAudit.update({
      where: { id: audit.id },
      data: { reason: "rewrite" },
    })).rejects.toThrow(/immutable/);
    await expect(control.adminAudit.delete({ where: { id: audit.id } })).rejects.toThrow(/immutable/);
    await expect(control.$executeRawUnsafe('TRUNCATE TABLE "AdminAudit"')).rejects.toThrow(/immutable/);

    const canary = await control.agentVersion.create({
      data: {
        agentId: seeded.agent.id,
        versionNumber: 991,
        model: "integration:canary",
        createdBy: seeded.user.id,
      },
    });
    await control.agentBinding.update({
      where: { id: seeded.agentBinding.id },
      data: { canaryAgentVersionId: canary.id, canaryPercent: 25 },
    });
    const before = await control.agentBinding.findUniqueOrThrow({
      where: { id: seeded.agentBinding.id },
      select: { activeAgentVersionId: true, canaryAgentVersionId: true, canaryPercent: true },
    });
    await control.$executeRawUnsafe(`CREATE FUNCTION "public"."block_admin_audit_insert_for_test"() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END; $$`);
    await control.$executeRawUnsafe(`CREATE TRIGGER "AdminAudit_block_insert_for_test"
      BEFORE INSERT ON "public"."AdminAudit" FOR EACH ROW
      EXECUTE FUNCTION "public"."block_admin_audit_insert_for_test"()`);
    try {
      await expect(control.$transaction(async (tx) => {
        await tx.agentBinding.update({
          where: { id: seeded.agentBinding.id },
          data: {
            activeAgentVersionId: canary.id,
            canaryAgentVersionId: null,
            canaryPercent: 0,
          },
        });
        await tx.adminAudit.create({
          data: {
            environmentId: seeded.environment.id,
            actorUserId: seeded.user.id,
            action: "agent.canary.promote",
            subjectType: "Agent",
            subjectId: seeded.agent.id,
            before,
            after: { currentVersionId: canary.id },
          },
        });
      })).rejects.toThrow(/audit unavailable/);
    } finally {
      await control.$executeRawUnsafe(
        'DROP TRIGGER "AdminAudit_block_insert_for_test" ON "public"."AdminAudit"'
      );
      await control.$executeRawUnsafe(
        'DROP FUNCTION "public"."block_admin_audit_insert_for_test"()'
      );
    }
    await expect(control.agentBinding.findUniqueOrThrow({
      where: { id: seeded.agentBinding.id },
      select: { activeAgentVersionId: true, canaryAgentVersionId: true, canaryPercent: true },
    })).resolves.toEqual(before);
  });

  test("enforces one provider default under real concurrent PostgreSQL writes", async () => {
    const direct = await Promise.allSettled(
      Array.from({ length: 8 }, async (_, index) => {
        const credential = await control.credential.create({
          data: {
            environmentId: seeded.environment.id,
            kind: CredentialKind.SERVICE_CREDENTIAL,
            name: `DIRECT_${index}`,
            provider: "concurrent-direct",
          },
        });
        return control.providerKey.create({ data: {
          environmentId: seeded.environment.id,
          credentialId: credential.id,
          provider: "concurrent-direct",
          label: `direct-${index}`,
          environmentKeyName: `DIRECT_${index}`,
          isDefault: true,
          createdBy: seeded.user.id,
        } });
      }),
    );
    expect(direct.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    await expect(control.providerKey.count({
      where: {
        environmentId: seeded.environment.id,
        provider: "concurrent-direct",
        isDefault: true,
      },
    })).resolves.toBe(1);

    const replaceDefault = async (index: number) => {
      const credential = await control.credential.create({
        data: {
          environmentId: seeded.environment.id,
          kind: CredentialKind.SERVICE_CREDENTIAL,
          name: `SERIALIZED_${index}`,
          provider: "concurrent-serialized",
        },
      });
      return control.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked",
        `${seeded.environment.id}:concurrent-serialized`,
      );
      await tx.providerKey.updateMany({
        where: {
          environmentId: seeded.environment.id,
          provider: "concurrent-serialized",
          isDefault: true,
        },
        data: { isDefault: false },
      });
      return tx.providerKey.create({
        data: {
          environmentId: seeded.environment.id,
          credentialId: credential.id,
          provider: "concurrent-serialized",
          label: `serialized-${index}`,
          environmentKeyName: `SERIALIZED_${index}`,
          isDefault: true,
          createdBy: seeded.user.id,
        },
      });
      });
    };
    const serialized = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => replaceDefault(index)));
    expect(serialized.flatMap((result) => result.status === "rejected"
      ? [{ code: result.reason?.code, message: result.reason?.message }]
      : [])).toEqual([]);
    await expect(control.providerKey.count({
      where: {
        environmentId: seeded.environment.id,
        provider: "concurrent-serialized",
        isDefault: true,
      },
    })).resolves.toBe(1);
  });

  test("serializes channel refresh claims and durably fences interrupted attempts", async () => {
    await control.channelInstallation.update({
      where: { id: seeded.installation.id },
      data: {
        tokenRefreshState: "IDLE",
        tokenRefreshAttemptId: null,
        tokenRefreshStartedAt: null,
        tokenGeneration: 5,
      },
    });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        control.channelInstallation.updateMany({
          where: {
            id: seeded.installation.id,
            credentialId: seeded.installation.credentialId,
            tokenGeneration: 5,
            tokenRefreshState: "IDLE",
          },
          data: {
            tokenRefreshState: "REFRESHING",
            tokenRefreshAttemptId: `00000000-0000-0000-0000-${String(index + 20).padStart(12, "0")}`,
            tokenRefreshStartedAt: new Date(),
          },
        })
      )
    );
    expect(claims.filter(({ count }) => count === 1)).toHaveLength(1);
    await expect(control.channelInstallation.findUnique({ where: { id: seeded.installation.id } }))
      .resolves.toMatchObject({ tokenRefreshState: "REFRESHING" });

    const claimed = await control.channelInstallation.findUniqueOrThrow({
      where: { id: seeded.installation.id },
      select: { tokenRefreshAttemptId: true },
    });
    await control.channelInstallation.update({
      where: { id: seeded.installation.id },
      data: {
        tokenGeneration: { increment: 1 },
        tokenRefreshState: "IDLE",
        tokenRefreshAttemptId: null,
        tokenRefreshRepairCode: null,
      },
    });
    await expect(control.channelInstallation.updateMany({
      where: {
        id: seeded.installation.id,
        tokenGeneration: 5,
        tokenRefreshState: "REFRESHING",
        tokenRefreshAttemptId: claimed.tokenRefreshAttemptId,
      },
      data: { tokenRefreshState: "REPAIR_REQUIRED", tokenRefreshRepairCode: "STALE" },
    })).resolves.toMatchObject({ count: 0 });
    await expect(control.channelInstallation.findUnique({ where: { id: seeded.installation.id } }))
      .resolves.toMatchObject({ tokenGeneration: 6, tokenRefreshState: "IDLE", tokenRefreshRepairCode: null });
  });

  test("admits a channel event once, leases it once, and keeps its payload immutable", async () => {
    await expect(control.channelEventInbox.create({
      data: {
        appId: seeded.channelInbox.appId,
        eventId: seeded.channelInbox.eventId,
        payloadFormatVersion: 1,
        payloadKeyVersion: 1,
        encryptedPayload: "different",
      },
    })).rejects.toThrow();

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        control.channelEventInbox.updateMany({
          where: { id: seeded.channelInbox.id, status: "PENDING" },
          data: {
            status: "PROCESSING",
            leaseGeneration: { increment: 1 },
            leaseOwner: `worker-${index}`,
            leaseExpiresAt: new Date(Date.now() + 60_000),
          },
        })
      )
    );
    expect(claims.filter(({ count }) => count === 1)).toHaveLength(1);
    const winner = await control.channelEventInbox.findUniqueOrThrow({
      where: { id: seeded.channelInbox.id },
      select: { leaseOwner: true, leaseGeneration: true },
    });
    await expect(control.channelEventInbox.updateMany({
      where: {
        id: seeded.channelInbox.id,
        leaseOwner: winner.leaseOwner,
        leaseGeneration: winner.leaseGeneration - 1,
      },
      data: { status: "COMPLETED" },
    })).resolves.toMatchObject({ count: 0 });
    await expect(control.channelEventInbox.update({
      where: { id: seeded.channelInbox.id },
      data: { encryptedPayload: "mutated" },
    })).rejects.toThrow(/immutable/);
    await expect(control.channelEventInbox.update({
      where: { id: seeded.channelInbox.id },
      data: { payloadFormatVersion: 2 },
    })).rejects.toThrow(/immutable/);
  });

  test("rejects deletion for every provider-key path reachable by an executable version", async () => {
    const createKey = async (provider: string, label: string) => {
      const environmentKeyName = `${label.toUpperCase()}_KEY`;
      const credential = await control.credential.create({
        data: {
          environmentId: seeded.environment.id,
          kind: CredentialKind.SERVICE_CREDENTIAL,
          name: environmentKeyName,
          provider,
        },
      });
      return control.providerKey.create({ data: {
        environmentId: seeded.environment.id,
        credentialId: credential.id,
        provider,
        label,
        environmentKeyName,
        createdBy: seeded.user.id,
      } });
    };
    const [runtimeKey, canaryKey, lockedKey, fallbackKey, compactionKey, wrongProviderKey] = await Promise.all([
      createKey("openai", "runtime-reference"),
      createKey("anthropic", "canary-reference"),
      createKey("mistral", "locked-reference"),
      createKey("together", "fallback-reference"),
      createKey("google", "compaction-reference"),
      createKey("anthropic", "wrong-provider-reference"),
    ]);
    const agent = await control.agent.create({
      data: { projectId: seeded.project.id, name: "Provider references", slug: "provider-references" },
    });
    const historical = await control.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "mistral:historical",
        modelRoutes: [{
          label: "default",
          model: "mistral:historical",
          providerKeyId: lockedKey.id,
          isDefault: true,
        }],
        createdBy: seeded.user.id,
      },
    });
    const active = await control.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 2,
        model: "openai:active",
        memoryConfig: { __runtime: { providerKeyId: runtimeKey.id } },
        modelRoutes: [
          { label: "default", model: "openai:active", isDefault: true },
          {
            label: "fallback",
            model: "together:fallback",
            providerCredentialId: fallbackKey.id,
            isDefault: false,
          },
          {
            label: "compaction",
            model: "google:compaction",
            providerKeyId: compactionKey.id,
            isDefault: false,
          },
          {
            label: "wrong-provider",
            model: "openai:mismatch",
            providerKeyId: wrongProviderKey.id,
            isDefault: false,
          },
        ],
        createdBy: seeded.user.id,
      },
    });
    const canary = await control.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 3,
        model: "anthropic:canary",
        modelRoutes: [{
          label: "default",
          model: "anthropic:canary",
          providerCredentialId: canaryKey.id,
          isDefault: true,
        }],
        createdBy: seeded.user.id,
      },
    });
    await control.agentBinding.create({
      data: {
        environmentId: seeded.environment.id,
        agentId: agent.id,
        activeAgentVersionId: active.id,
        canaryAgentVersionId: canary.id,
        canaryPercent: 25,
      },
    });

    expect(historical.id).not.toBe(active.id);
    for (const key of [runtimeKey, canaryKey, lockedKey, fallbackKey, compactionKey]) {
      await expect(control.providerKey.delete({ where: { id: key.id } }))
        .rejects.toMatchObject({ code: "P2003" });
    }
    await expect(control.providerKey.delete({ where: { id: wrongProviderKey.id } }))
      .resolves.toMatchObject({ id: wrongProviderKey.id });

    const otherEnvironment = await control.environment.create({
      data: { projectId: seeded.project.id, slug: "provider-reference-other", name: "Provider reference other" },
    });
    const crossEnvironmentKey = await createKey("cohere", "cross-environment-reference");
    const otherAgent = await control.agent.create({
      data: { projectId: seeded.project.id, name: "Other environment provider", slug: "other-environment-provider" },
    });
    const otherVersion = await control.agentVersion.create({
      data: {
        agentId: otherAgent.id,
        versionNumber: 1,
        model: "cohere:other",
        memoryConfig: { __runtime: { providerKeyId: crossEnvironmentKey.id } },
        createdBy: seeded.user.id,
      },
    });
    await control.agentBinding.create({
      data: {
        environmentId: otherEnvironment.id,
        agentId: otherAgent.id,
        activeAgentVersionId: otherVersion.id,
      },
    });
    await expect(control.providerKey.delete({ where: { id: crossEnvironmentKey.id } }))
      .resolves.toMatchObject({ id: crossEnvironmentKey.id });
  });

  test("persists immutable Turn attribution and detailed non-negative Step usage", async () => {
    expect(seeded.turn).toMatchObject({
      agentVersionId: seeded.agentVersion.id,
      versionBucket: AgentVersionBucket.CURRENT,
      latencyMs: 120,
    });
    expect(Number(seeded.turn.costCents)).toBe(0.25);
    expect(seeded.step).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      reasoningTokens: 4,
      latencyMs: 100,
    });
    expect(Number(seeded.step.costCents)).toBe(0.2);

    const otherAgent = await control.agent.create({
      data: { projectId: seeded.project.id, name: "Other agent", slug: "other-agent" },
    });
    const otherVersion = await control.agentVersion.create({
      data: {
        agentId: otherAgent.id,
        versionNumber: 1,
        model: "test:other",
        createdBy: seeded.user.id,
      },
    });
    await expect(control.turn.create({
      data: {
        threadId: seeded.thread.id,
        agentVersionId: otherVersion.id,
        versionBucket: AgentVersionBucket.CURRENT,
        sequence: 20,
      },
    })).rejects.toThrow(/ancestry/);

    await expect(control.turn.update({
      where: { id: seeded.turn.id },
      data: { versionBucket: AgentVersionBucket.CANARY },
    })).rejects.toThrow(/immutable/);
    await expect(control.step.create({
      data: {
        turnId: seeded.turn.id,
        sequence: 20,
        model: "test:model",
        inputTokens: 5,
        cacheCreationInputTokens: 4,
        cacheReadInputTokens: 2,
      },
    })).rejects.toThrow();
  });

  test("acquires and advances the durable compaction cursor atomically", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => control.thread.updateMany({
        where: { id: seeded.thread.id, compactionState: ThreadCompactionState.IDLE },
        data: { compactionState: ThreadCompactionState.IN_PROGRESS },
      }))
    );
    expect(attempts.reduce((total, attempt) => total + attempt.count, 0)).toBe(1);

    const compactedAt = new Date();
    await control.$transaction(async (tx) => {
      const advanced = await tx.thread.updateMany({
        where: {
          id: seeded.thread.id,
          compactionState: ThreadCompactionState.IN_PROGRESS,
        },
        data: {
          summary: "Compacted summary",
          compactedUpToTurnId: seeded.turn.id,
          compactedAt,
          compactionState: ThreadCompactionState.IDLE,
        },
      });
      expect(advanced.count).toBe(1);
    });
    await expect(control.thread.findUnique({ where: { id: seeded.thread.id } })).resolves.toMatchObject({
      summary: "Compacted summary",
      compactedUpToTurnId: seeded.turn.id,
      compactedAt,
      compactionState: ThreadCompactionState.IDLE,
    });

    const otherThread = await control.thread.create({
      data: {
        environmentId: seeded.environment.id,
        agentId: seeded.agent.id,
        endUserId: seeded.endUser.id,
        clusterId: seeded.cluster.id,
      },
    });
    const otherTurn = await control.turn.create({
      data: {
        threadId: otherThread.id,
        agentVersionId: seeded.agentVersion.id,
        versionBucket: AgentVersionBucket.CURRENT,
        sequence: 1,
      },
    });
    await expect(control.thread.update({
      where: { id: seeded.thread.id },
      data: { compactedUpToTurnId: otherTurn.id },
    })).rejects.toThrow(/ancestry/);
  });

  test("supports pgvector cosine search with HNSW indexes", async () => {
    const second = await control.memory.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: seeded.agent.id,
        clusterId: seeded.cluster.id,
        kind: "fact",
        content: "Orthogonal fact",
        visibility: "subject",
        source: "manual",
      },
    });
    const firstVector = vectorLiteral(0);
    const secondVector = vectorLiteral(1);
    await control.$executeRawUnsafe(
      'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2::uuid',
      firstVector,
      seeded.memory.id
    );
    await control.$executeRawUnsafe(
      'UPDATE "Memory" SET "embedding" = $1::vector WHERE "id" = $2::uuid',
      secondVector,
      second.id
    );
    await control.$executeRawUnsafe(
      'UPDATE "MemoryEntity" SET "embedding" = $1::vector WHERE "id" = $2::uuid',
      firstVector,
      seeded.memoryEntityA.id
    );

    const nearest = await control.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "Memory" WHERE "embedding" IS NOT NULL ORDER BY "embedding" <=> $1::vector LIMIT 2',
      firstVector
    );
    expect(nearest.map(({ id }) => id)).toEqual([seeded.memory.id, second.id]);

    const indexes = await control.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('Memory_embedding_hnsw_cosine_idx', 'MemoryEntity_embedding_hnsw_cosine_idx')
      ORDER BY indexname
    `;
    expect(indexes).toHaveLength(2);
    for (const index of indexes) {
      expect(index.indexdef).toContain("USING hnsw");
      expect(index.indexdef).toContain("vector_cosine_ops");
    }
  });

  test("permits cross-agent memory access only through an Environment cluster", async () => {
    const clusteredAgent = await createBoundAgent(control, seeded, "clustered", seeded.cluster.id);
    const privateAgent = await createBoundAgent(control, seeded, "private", null);

    const privateMemory = await control.memory.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: seeded.agent.id,
        kind: "fact",
        content: "Private to the owner",
        visibility: "subject",
        source: "manual",
      },
    });
    const shared = await control.memory.findMany({
      where: memoryAccessWhere(
        seeded.environment.id,
        seeded.endUser.id,
        clusteredAgent.id
      ),
      select: { id: true },
    });
    expect(shared.map(({ id }) => id)).toContain(seeded.memory.id);
    expect(shared.map(({ id }) => id)).not.toContain(privateMemory.id);
    await expect(control.memory.findMany({
      where: memoryAccessWhere(seeded.environment.id, seeded.endUser.id, privateAgent.id),
      select: { id: true },
    })).resolves.not.toContainEqual({ id: seeded.memory.id });

    const clusteredEntity = await control.memoryEntity.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: clusteredAgent.id,
        clusterId: seeded.cluster.id,
        entityKey: "clustered-agent-entity",
        entityType: "person",
        label: "Clustered",
      },
    });
    await expect(control.memoryEntity.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: clusteredAgent.id,
        clusterId: seeded.cluster.id,
        entityKey: seeded.memoryEntityA.entityKey,
        entityType: "person",
        label: "Duplicate shared key",
      },
    })).rejects.toThrow();
    await expect(control.memoryRelationship.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: clusteredAgent.id,
        clusterId: seeded.cluster.id,
        fromEntityId: seeded.memoryEntityA.id,
        toEntityId: clusteredEntity.id,
        relationshipType: "shared-with",
        sourceMemoryId: seeded.memory.id,
      },
    })).resolves.toMatchObject({ clusterId: seeded.cluster.id });

    const privateEntity = await control.memoryEntity.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: privateAgent.id,
        entityKey: "private-agent-entity",
        entityType: "person",
        label: "Private",
      },
    });
    await expect(control.memoryRelationship.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: seeded.agent.id,
        fromEntityId: seeded.memoryEntityA.id,
        toEntityId: privateEntity.id,
        relationshipType: "must-not-leak",
      },
    })).rejects.toThrow(/ancestry/);
    await expect(control.memoryEntity.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: privateAgent.id,
        clusterId: seeded.cluster.id,
        entityKey: "forged-cluster-share",
        entityType: "person",
        label: "Forged",
      },
    })).rejects.toThrow(/ancestry/);
  });

  test("deduplicates concurrent extraction writes and validates provenance", async () => {
    const contentHash = "b".repeat(64);
    const writes = await Promise.allSettled(
      Array.from({ length: 8 }, () => control.memory.create({
        data: {
          environmentId: seeded.environment.id,
          endUserId: seeded.endUser.id,
          agentId: seeded.agent.id,
          clusterId: seeded.cluster.id,
          kind: "fact",
          content: "Concurrently extracted fact",
          visibility: "subject",
          source: "extracted",
          sourceThreadId: seeded.thread.id,
          sourceTurnIds: [seeded.turn.id],
          extractorVersion: "extractor-v2",
          contentHash,
        },
      }))
    );
    expect(writes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    await expect(control.memory.count({
      where: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        sourceThreadId: seeded.thread.id,
        contentHash,
      },
    })).resolves.toBe(1);

    await expect(control.memory.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: seeded.endUser.id,
        agentId: seeded.agent.id,
        kind: "fact",
        content: "Missing extraction version",
        visibility: "subject",
        source: "extracted",
        sourceThreadId: seeded.thread.id,
        sourceTurnIds: [seeded.turn.id],
        contentHash: "c".repeat(64),
      },
    })).rejects.toThrow();
  });

  test("represents global PAT, OAuth principal/rotation, and entity bearer semantics", async () => {
    expect(seeded.personalAccessToken).toMatchObject({
      userId: seeded.user.id,
      scopeKind: AuthorizationScopeKind.GLOBAL,
      organizationId: null,
      projectId: null,
      environmentId: null,
    });
    expect(seeded.oauthAccessToken).toMatchObject({
      clientId: seeded.oauthClient.id,
      userId: seeded.user.id,
      scopeKind: AuthorizationScopeKind.ENVIRONMENT,
      environmentId: seeded.environment.id,
    });
    expect(seeded.rotatedRefreshToken).toMatchObject({
      parentRefreshTokenId: seeded.oauthRefreshToken.id,
      rotationFamilyId: seeded.oauthRefreshToken.rotationFamilyId,
    });
    expect(seeded.mcpBearerToken).toMatchObject({
      entityId: expect.any(String),
      environmentId: seeded.environment.id,
      createdByUserId: seeded.user.id,
      mcpUserId: "entity-user",
      scopes: ["tools:call"],
    });

    await expect(control.personalAccessToken.create({
      data: {
        userId: seeded.user.id,
        scopeKind: AuthorizationScopeKind.GLOBAL,
        organizationId: seeded.organization.id,
        tokenHash: "invalid-global-pat",
        name: "invalid",
        role: "operator",
      },
    })).rejects.toThrow();
  });

  test("distinguishes zero-row no-tools and all-tools defaults", async () => {
    const noTools = await control.agentVersion.create({
      data: {
        agentId: seeded.agent.id,
        versionNumber: 10,
        model: "test:model",
        toolDefaultPolicy: AgentToolDefaultPolicy.NONE,
        createdBy: seeded.user.id,
      },
      include: { toolPolicies: true },
    });
    const allTools = await control.agentVersion.create({
      data: {
        agentId: seeded.agent.id,
        versionNumber: 11,
        model: "test:model",
        toolDefaultPolicy: AgentToolDefaultPolicy.ALL,
        createdBy: seeded.user.id,
      },
      include: { toolPolicies: true },
    });
    const candidates = (await control.tool.findMany({ select: { id: true } })).map(({ id }) => id);

    expect(noTools.toolPolicies).toHaveLength(0);
    expect(allTools.toolPolicies).toHaveLength(0);
    expect(resolveAgentToolIds(noTools.toolDefaultPolicy, noTools.toolPolicies, candidates)).toEqual([]);
    expect(resolveAgentToolIds(allTools.toolDefaultPolicy, allTools.toolPolicies, candidates))
      .toEqual([...candidates].sort());

    const newlyRegistered = await control.tool.create({
      data: {
        name: "new-after-version",
        description: "Registered later",
        paramSchema: { type: "object" },
        schemaHash: "new-after-version-v1",
      },
    });
    expect(resolveAgentToolIds(noTools.toolDefaultPolicy, [], [newlyRegistered.id])).toEqual([]);
    expect(resolveAgentToolIds(allTools.toolDefaultPolicy, [], [newlyRegistered.id]))
      .toEqual([newlyRegistered.id]);
  });

  test("database constraints reject encoded Json roots and ambiguous enabledTools", async () => {
    await expect(control.agentVersion.create({
      data: {
        agentId: seeded.agent.id,
        versionNumber: 2,
        model: "test:model",
        promptBlocks: JSON.stringify([]),
        dynamicBlocks: [],
        toolsBlockConfig: {},
        modelRoutes: [],
        createdBy: seeded.user.id,
      },
    })).rejects.toThrow();

    await expect(control.agentVersion.create({
      data: {
        agentId: seeded.agent.id,
        versionNumber: 3,
        model: "test:model",
        promptBlocks: [],
        dynamicBlocks: [],
        toolsBlockConfig: { enabledTools: ["remember"] },
        modelRoutes: [],
        createdBy: seeded.user.id,
      },
    })).rejects.toThrow();
  });

  test("erases the subject graph while preserving pseudonymized audits and operators", async () => {
    const subject = await control.endUser.create({
      data: { organizationId: seeded.organization.id, displayName: "Erase me" },
    });
    const thread = await control.thread.create({
      data: {
        environmentId: seeded.environment.id,
        agentId: seeded.agent.id,
        endUserId: subject.id,
      },
    });
    const turn = await control.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: seeded.agentVersion.id,
        versionBucket: AgentVersionBucket.CURRENT,
        sequence: 1,
        inputText: "private",
      },
    });
    const memory = await control.memory.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: subject.id,
        agentId: seeded.agent.id,
        kind: "fact",
        content: "private",
        visibility: "subject",
        source: "turn",
      },
    });
    const audit = await control.toolCallAudit.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: subject.id,
        toolName: "remember",
        arguments: {},
        status: WorkStatus.SUCCEEDED,
        latencyMs: 1,
      },
    });
    const unattachedUpload = await control.messageAttachment.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: subject.id,
        kind: "file",
        mimeType: "text/plain",
        bytes: 7,
        storageKey: "unattached-subject-upload",
      },
    });

    await control.endUser.delete({ where: { id: subject.id } });

    await expect(control.thread.findUnique({ where: { id: thread.id } })).resolves.toBeNull();
    await expect(control.turn.findUnique({ where: { id: turn.id } })).resolves.toBeNull();
    await expect(control.memory.findUnique({ where: { id: memory.id } })).resolves.toBeNull();
    await expect(control.messageAttachment.findUnique({ where: { id: unattachedUpload.id } }))
      .resolves.toBeNull();
    await expect(control.toolCallAudit.findUnique({ where: { id: audit.id } }))
      .resolves.toMatchObject({ endUserId: null });
    await expect(control.user.findUnique({ where: { id: seeded.user.id } })).resolves.not.toBeNull();
  });

  test("enforces principal tiers in the database", async () => {
    await expect(endUser.endUserSession.create({
      data: {
        identityId: seeded.endUserIdentity.id,
        environmentId: seeded.environment.id,
        tokenHash: "f".repeat(64),
        tier: PrincipalTier.OPERATOR,
        expiresAt: future(),
      },
    })).rejects.toThrow();
    await expect(control.operatorSession.create({
      data: {
        userId: seeded.user.id,
        tokenHash: "0".repeat(64),
        tier: PrincipalTier.END_USER,
        expiresAt: future(),
      },
    })).rejects.toThrow();
  });
});

async function seedEveryModel(control: PrismaClient) {
  const registry: Registry = new Map();
  const track = <T extends { id?: string; entityId?: string | null }>(model: string, record: T): T => {
    registry.set(model, record.id ? { id: record.id } : { entityId: record.entityId! });
    return record;
  };

  const user = track("User", await control.user.create({
    data: { email: "owner@example.test", displayName: "Owner", platformOperator: true },
  }));
  const operatorSession = track("OperatorSession", await control.operatorSession.create({
    data: { userId: user.id, tokenHash: "a".repeat(64), expiresAt: future() },
  }));
  track("OperatorIdentity", await control.operatorIdentity.create({
    data: {
      userId: user.id,
      provider: OperatorIdentityProvider.GITHUB,
      subject: "github-owner",
      providerEmail: user.email,
    },
  }));
  track("MagicLinkToken", await control.magicLinkToken.create({
    data: { email: user.email, tokenHash: "b".repeat(64), expiresAt: future() },
  }));
  track("OperatorMfaTotp", await control.operatorMfaTotp.create({
    data: { userId: user.id, encryptedSecret: "encrypted-totp", enabledAt: new Date() },
  }));
  track("OperatorMfaRecoveryCode", await control.operatorMfaRecoveryCode.create({
    data: { userId: user.id, codeHash: "c".repeat(64) },
  }));
  track("AuthRateLimitBucket", await control.authRateLimitBucket.create({
    data: {
      action: AuthRateLimitAction.LOGIN,
      identifierHash: "d".repeat(64),
      windowStart: new Date(0),
      expiresAt: new Date(60_000),
    },
  }));
  const impersonationTarget = await control.user.create({
    data: { email: "impersonation-target@example.test" },
  });
  track("ImpersonationAudit", await control.impersonationAudit.create({
    data: {
      action: ImpersonationAction.START,
      actorUserId: user.id,
      targetUserId: impersonationTarget.id,
      impersonationSessionId: operatorSession.id,
    },
  }));
  const organization = track("Organization", await control.organization.create({
    data: { slug: "round-trip-organization", name: "Round-trip organization" },
  }));
  const organizationMembership = track("OrganizationMembership", await control.organizationMembership.create({
    data: { organizationId: organization.id, userId: user.id, role: OrganizationRole.OWNER },
  }));
  track("OrganizationInvitation", await control.organizationInvitation.create({
    data: {
      organizationId: organization.id,
      inviterId: user.id,
      email: "invitee@example.test",
      tokenHash: "e".repeat(64),
      expiresAt: future(),
    },
  }));
  const project = track("Project", await control.project.create({
    data: { organizationId: organization.id, slug: "round-trip-project", name: "Project" },
  }));
  track("ProjectMembership", await control.projectMembership.create({
    data: {
      projectId: project.id,
      organizationMembershipId: organizationMembership.id,
      organizationId: organization.id,
      role: ProjectRole.ADMIN,
    },
  }));
  const environment = track("Environment", await control.environment.create({
    data: { projectId: project.id, slug: "isolated", name: "Isolated" },
  }));
  track("EnvironmentSession", await control.environmentSession.create({
    data: { environmentId: environment.id, operatorSessionId: operatorSession.id },
  }));
  const endUser = track("EndUser", await control.endUser.create({
    data: { organizationId: organization.id, displayName: "End user" },
  }));
  const endUserIdentity = track("EndUserIdentity", await control.endUserIdentity.create({
    data: {
      endUserId: endUser.id,
      organizationId: organization.id,
      issuer: "integration-test",
      channel: "web",
      subject: "end-user-subject",
      profile: { locale: "en" },
      verifiedAt: new Date(),
    },
  }));
  track("EndUserSession", await control.endUserSession.create({
    data: {
      identityId: endUserIdentity.id,
      environmentId: environment.id,
      tokenHash: "end-user-session",
      expiresAt: future(),
    },
  }));

  const agent = track("Agent", await control.agent.create({
    data: { projectId: project.id, name: "Assistant", slug: "assistant" },
  }));
  const cluster = track("AgentCluster", await control.agentCluster.create({
    data: { environmentId: environment.id, name: "Primary", slug: "primary", metadata: {} },
  }));
  const agentVersion = track("AgentVersion", await control.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      model: "test:model",
      promptBlocks: [],
      dynamicBlocks: [],
      toolsBlockConfig: { mode: "direct" },
      modelRoutes: [],
      memoryConfig: {},
      createdBy: user.id,
    },
  }));
  const agentBinding = track("AgentBinding", await control.agentBinding.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      activeAgentVersionId: agentVersion.id,
      clusterId: cluster.id,
    },
  }));
  const credential = track("Credential", await control.credential.create({
    data: {
      environmentId: environment.id,
      kind: CredentialKind.SERVICE_CREDENTIAL,
      name: "ANTHROPIC_API_KEY",
      provider: "anthropic",
      permissions: ["invoke"],
    },
  }));
  const credentialSecretVersion = track("CredentialSecretVersion", await control.credentialSecretVersion.create({
    data: {
      credentialId: credential.id,
      secretRevision: 1,
      formatVersion: 1,
      rootKeyVersion: 1,
      salt: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(12, 2),
      ciphertext: Buffer.from("seed-ciphertext"),
      authTag: Buffer.alloc(16, 3),
    },
  }));
  await control.credential.update({
    where: { id: credential.id },
    data: { activeSecretVersionId: credentialSecretVersion.id },
  });
  track("CredentialAudit", await control.credentialAudit.create({
    data: {
      environmentId: environment.id,
      credentialId: credential.id,
      action: "CREATE",
      outcome: "SUCCESS",
      actorType: "operator",
      actorId: user.id,
      effectiveUserId: user.id,
      secretRevision: 1,
      toRootKeyVersion: 1,
    },
  }));
  track("AccessKey", await control.accessKey.create({
    data: {
      environmentId: environment.id,
      keyPrefix: "pk_test",
      keyHash: "access-key-hash",
      allowedOrigins: ["https://example.test"],
    },
  }));
  track("ProviderKey", await control.providerKey.create({
    data: {
      environmentId: environment.id,
      credentialId: credential.id,
      provider: "anthropic",
      label: "primary",
      environmentKeyName: "ANTHROPIC_API_KEY",
      isDefault: true,
      createdBy: user.id,
    },
  }));
  track("McpToken", await control.mcpToken.create({
    data: {
      environmentId: environment.id,
      mintedByUserId: user.id,
      name: "runtime",
      tokenHash: "mcp-token-hash",
      permissions: ["invoke"],
      tier: "service",
    },
  }));
  const personalAccessToken = track("PersonalAccessToken", await control.personalAccessToken.create({
    data: {
      userId: user.id,
      scopeKind: AuthorizationScopeKind.GLOBAL,
      tokenHash: "pat-hash",
      name: "all-scope",
      role: "operator",
      permissions: ["admin"],
    },
  }));
  track("PostmanTemplate", await control.postmanTemplate.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      name: "Default",
      simulateUserId: "subject",
      sessionContext: {},
      createdBy: user.id,
    },
  }));
  const thread = track("Thread", await control.thread.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      endUserId: endUser.id,
      clusterId: cluster.id,
      sessionContext: {},
    },
  }));
  const turn = track("Turn", await control.turn.create({
    data: {
      threadId: thread.id,
      agentVersionId: agentVersion.id,
      versionBucket: AgentVersionBucket.CURRENT,
      sequence: 1,
      inputText: "hello",
      output: { text: "hi" },
      costCents: 0.25,
      latencyMs: 120,
    },
  }));
  const step = track("Step", await control.step.create({
    data: {
      turnId: turn.id,
      sequence: 1,
      model: "test:model",
      status: WorkStatus.SUCCEEDED,
      inputTokens: 30,
      outputTokens: 12,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 5,
      reasoningTokens: 4,
      costCents: 0.2,
      latencyMs: 100,
    },
  }));
  const tool = track("Tool", await control.tool.create({
    data: {
      name: "remember",
      description: "Remember a fact",
      kind: ToolKind.RUNTIME,
      paramSchema: { type: "object", properties: {} },
      schemaHash: "remember-v1",
    },
  }));
  track("ToolCall", await control.toolCall.create({
    data: {
      stepId: step.id,
      toolId: tool.id,
      sequence: 1,
      toolName: tool.name,
      arguments: {},
      result: { remembered: true },
      status: WorkStatus.SUCCEEDED,
    },
  }));
  track("Artifact", await control.artifact.create({
    data: {
      environmentId: environment.id,
      threadId: thread.id,
      producedByTurnId: turn.id,
      artifactKey: "answer",
      kind: "text",
      content: "hi",
      metadata: {},
      createdBy: user.id,
    },
  }));
  track("MessageAttachment", await control.messageAttachment.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
      turnId: turn.id,
      kind: "file",
      mimeType: "text/plain",
      bytes: 2,
      storageKey: "attachment",
    },
  }));
  const entity = track("Entity", await control.entity.create({
    data: {
      projectId: project.id,
      externalId: "entity",
      displayName: "Entity",
      connectionStatus: "connected",
      connectionKind: "mcp",
    },
  }));
  const channelConnection = track("ChannelConnection", await control.channelConnection.create({
    data: {
      environmentId: environment.id,
      entityId: entity.id,
      provider: "slack",
      agentRouting: [],
      defaultAgentId: agent.id,
      credentialId: credential.id,
    },
  }));
  track("ChannelThread", await control.channelThread.create({
    data: { connectionId: channelConnection.id, threadId: thread.id, channelThreadKey: "channel-thread" },
  }));
  const channelApp = track("ChannelApp", await control.channelApp.create({
    data: {
      environmentId: environment.id,
      provider: "slack",
      clientId: "client",
      credentialId: credential.id,
      distribution: "private",
      defaultAgentId: agent.id,
      agentRouting: [],
    },
  }));
  const channelInbox = track("ChannelEventInbox", await control.channelEventInbox.create({
    data: {
      appId: channelApp.id,
      eventId: "Ev-seeded",
      payloadFormatVersion: 1,
      payloadKeyVersion: 1,
      encryptedPayload: "encrypted-provider-envelope",
    },
  }));
  const installation = track("ChannelInstallation", await control.channelInstallation.create({
    data: {
      appId: channelApp.id,
      externalInstallationId: "installation",
      credentialId: credential.id,
      defaultAgentId: agent.id,
      agentRouting: [],
      status: "active",
    },
  }));
  track("ChannelAppThread", await control.channelAppThread.create({
    data: { installationId: installation.id, threadId: thread.id, channelThreadKey: "app-thread" },
  }));
  track("EntityMcpConfig", await control.entityMcpConfig.create({
    data: { entityId: entity.id, identityMode: "anonymous", identityProviders: [], branding: {} },
  }));
  track("EntityMcpClient", await control.entityMcpClient.create({
    data: { entityId: entity.id, transport: "http", credentialId: credential.id, headersTemplate: {} },
  }));
  track("EnvironmentEntityTool", await control.environmentEntityTool.create({
    data: { environmentId: environment.id, entityId: entity.id, toolId: tool.id },
  }));
  track("ToolHealth", await control.toolHealth.create({
    data: { environmentId: environment.id, toolId: tool.id, entityExternalId: entity.externalId },
  }));
  track("ToolCallAudit", await control.toolCallAudit.create({
    data: {
      environmentId: environment.id,
      toolId: tool.id,
      endUserId: endUser.id,
      agentId: agent.id,
      threadId: thread.id,
      toolName: tool.name,
      arguments: {},
      result: {},
      status: WorkStatus.SUCCEEDED,
      latencyMs: 1,
    },
  }));
  track("AdminAudit", await control.adminAudit.create({
    data: { environmentId: environment.id, action: "create", subjectType: "Agent", after: {} },
  }));
  track("AgentApproval", await control.agentApproval.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      threadId: thread.id,
      turnId: turn.id,
      action: "send",
      status: ApprovalStatus.APPROVED,
      arguments: {},
      resolution: {},
    },
  }));
  track("EnvironmentProvider", await control.environmentProvider.create({
    data: { environmentId: environment.id, providerId: "anthropic" },
  }));
  track("Budget", await control.budget.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      scope: "agent",
      period: "month",
      limitCents: 1000,
      alertThresholds: [80],
    },
  }));
  track("SafetyEvent", await control.safetyEvent.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      threadId: thread.id,
      turnId: turn.id,
      endUserId: endUser.id,
      detector: "pii",
      action: "allow",
      severity: "low",
      metadata: {},
    },
  }));
  track("MessageRating", await control.messageRating.create({
    data: {
      environmentId: environment.id,
      turnId: turn.id,
      agentId: agent.id,
      agentVersionId: agentVersion.id,
      endUserId: endUser.id,
      rating: 1,
    },
  }));
  const criterion = track("EvalCriterion", await control.evalCriterion.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      name: "Helpful",
      judgePrompt: "Judge helpfulness",
      createdBy: user.id,
    },
  }));
  track("AgentEval", await control.agentEval.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      agentVersionId: agentVersion.id,
      threadId: thread.id,
      turnId: turn.id,
      criterionId: criterion.id,
      criterionSnapshot: { name: "Helpful" },
      judgeModel: "test:judge",
      judgePromptUsed: "Judge helpfulness",
      score: 1,
      passed: true,
    },
  }));
  track("GoldenSet", await control.goldenSet.create({
    data: {
      environmentId: environment.id,
      agentId: agent.id,
      name: "Golden",
      threadIds: [thread.id],
      criterionIds: [criterion.id],
      createdBy: user.id,
    },
  }));
  track("Job", await control.job.create({
    data: {
      environmentId: environment.id,
      externalId: "job",
      displayName: "Background work",
      triggerType: "manual",
      payloadSchema: { type: "object" },
      handler: "background",
      createdBy: user.id,
    },
  }));
  const skill = track("Skill", await control.skill.create({
    data: {
      organizationId: organization.id,
      slug: "research",
      name: "Research",
      description: "Research skill",
      version: "1.0.0",
      origin: "local",
      source: "instructions",
      manifest: {},
      promptBlock: "Research",
      providesTools: [],
    },
  }));
  const projectSkill = track("ProjectSkill", await control.projectSkill.create({
    data: { projectId: project.id, skillId: skill.id },
  }));
  const environmentSkill = track("EnvironmentSkill", await control.environmentSkill.create({
    data: { environmentId: environment.id, projectSkillId: projectSkill.id, config: {} },
  }));
  track("AgentSkill", await control.agentSkill.create({
    data: { agentVersionId: agentVersion.id, environmentSkillId: environmentSkill.id, config: {} },
  }));
  track("AgentToolPolicy", await control.agentToolPolicy.create({
    data: { agentVersionId: agentVersion.id, toolId: tool.id, effect: PolicyEffect.ALLOW },
  }));
  const memory = track("Memory", await control.memory.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
      agentId: agent.id,
      clusterId: cluster.id,
      kind: "fact",
      content: "Likes tests",
      metadata: {},
      visibility: "subject",
      source: "turn",
      sourceThreadId: thread.id,
      sourceTurnIds: [turn.id],
      extractorVersion: "test-extractor-v1",
      contentHash: "a".repeat(64),
    },
  }));
  const memoryEntityA = track("MemoryEntity", await control.memoryEntity.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
      agentId: agent.id,
      clusterId: cluster.id,
      entityKey: "person",
      entityType: "person",
      label: "Person",
      metadata: {},
    },
  }));
  const memoryEntityB = await control.memoryEntity.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
      agentId: agent.id,
      clusterId: cluster.id,
      entityKey: "place",
      entityType: "place",
      label: "Place",
    },
  });
  track("MemoryRelationship", await control.memoryRelationship.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
      agentId: agent.id,
      clusterId: cluster.id,
      fromEntityId: memoryEntityA.id,
      toEntityId: memoryEntityB.id,
      relationshipType: "visited",
      metadata: {},
    },
  }));
  track("OrganizationMcpPolicy", await control.organizationMcpPolicy.create({
    data: { organizationId: organization.id, pattern: "*", effect: PolicyEffect.ALLOW },
  }));
  track("Macro", await control.macro.create({
    data: { environmentId: environment.id, name: "Summarize", steps: [], paramSchema: {}, createdBy: user.id },
  }));
  track("Event", await control.event.create({
    data: { environmentId: environment.id, eventType: "turn.completed", payload: {} },
  }));
  track("NotificationRule", await control.notificationRule.create({
    data: { environmentId: environment.id, name: "Failures", filters: {}, delivery: {}, createdBy: user.id },
  }));
  const oauthClient = track("OAuthClient", await control.oAuthClient.create({
    data: {
      organizationId: organization.id,
      clientId: "oauth-client",
      clientName: "OAuth client",
      redirectUris: ["https://example.test/callback"],
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code"],
      scopes: ["invoke"],
      registeredByUserId: user.id,
      entityId: entity.id,
    },
  }));
  const oauthAccessToken = track("OAuthAccessToken", await control.oAuthAccessToken.create({
    data: {
      tokenHash: "oauth-access-hash",
      clientId: oauthClient.id,
      userId: user.id,
      scopeKind: AuthorizationScopeKind.ENVIRONMENT,
      environmentId: environment.id,
      scopes: ["invoke"],
      expiresAt: future(),
    },
  }));
  const refreshFamily = "10000000-0000-4000-8000-000000000001";
  const oauthRefreshToken = track("OAuthRefreshToken", await control.oAuthRefreshToken.create({
    data: {
      tokenHash: "oauth-refresh-hash",
      accessTokenId: oauthAccessToken.id,
      clientId: oauthClient.id,
      userId: user.id,
      scopeKind: AuthorizationScopeKind.ENVIRONMENT,
      environmentId: environment.id,
      scopes: ["invoke"],
      rotationFamilyId: refreshFamily,
      expiresAt: future(),
    },
  }));
  const rotatedRefreshToken = await control.oAuthRefreshToken.create({
    data: {
      tokenHash: "oauth-refresh-rotated-hash",
      accessTokenId: oauthAccessToken.id,
      clientId: oauthClient.id,
      userId: user.id,
      scopeKind: AuthorizationScopeKind.ENVIRONMENT,
      environmentId: environment.id,
      scopes: ["invoke"],
      rotationFamilyId: refreshFamily,
      parentRefreshTokenId: oauthRefreshToken.id,
      expiresAt: future(),
    },
  });
  const mcpBearerToken = track("McpBearerToken", await control.mcpBearerToken.create({
    data: {
      entityId: entity.id,
      environmentId: environment.id,
      createdByUserId: user.id,
      tokenHash: "mcp-bearer-hash",
      label: "entity bearer",
      mcpUserId: "entity-user",
      scopes: ["tools:call"],
    },
  }));
  track("OAuthAuthorizationCode", await control.oAuthAuthorizationCode.create({
    data: {
      scopeKind: AuthorizationScopeKind.ENVIRONMENT,
      environmentId: environment.id,
      clientId: oauthClient.id,
      userId: user.id,
      codeHash: "oauth-code",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      redirectUri: "https://example.test/callback",
      scopes: ["invoke"],
      expiresAt: future(),
    },
  }));
  track("OAuthConsentTransaction", await control.oAuthConsentTransaction.create({
    data: {
      tokenHash: "oauth-consent-token-hash",
      nonce: randomUUID(),
      clientId: oauthClient.id,
      redirectUri: "https://example.test/callback",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      scopes: ["mcp:tools"],
      entityId: entity.id,
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      state: "state",
      expiresAt: future(),
    },
  }));
  track("McpAnonymousSession", await control.mcpAnonymousSession.create({
    data: { environmentId: environment.id, entityId: entity.id, mcpUserId: "anonymous" },
  }));
  track("McpOidcSession", await control.mcpOidcSession.create({
    data: {
      environmentId: environment.id,
      entityId: entity.id,
      mcpUserId: "oidc",
      provider: "example",
      externalSubject: "subject",
      credentialId: credential.id,
    },
  }));
  track("EntityToolPolicy", await control.entityToolPolicy.create({
    data: {
      entityId: entity.id,
      toolId: tool.id,
      effect: PolicyEffect.ALLOW,
      minIdentityMode: "anonymous",
      addedBy: user.id,
    },
  }));
  track("ErasureOperation", await control.erasureOperation.create({
    data: {
      organizationId: organization.id,
      idempotencyKey: "erasure",
      subjectKeyHash: "subject-hash",
      scopes: [],
      stores: [],
      inventory: {},
      policyVersion: "1",
    },
  }));

  return {
    registry,
    user,
    organization,
    project,
    environment,
    endUser,
    endUserIdentity,
    agent,
    agentVersion,
    agentBinding,
    credential,
    cluster,
    thread,
    turn,
    step,
    memory,
    installation,
    channelInbox,
    oauthClient,
    memoryEntityA,
    personalAccessToken,
    oauthAccessToken,
    oauthRefreshToken,
    rotatedRefreshToken,
    mcpBearerToken,
  };
}

function vectorLiteral(hotIndex: number): string {
  return `[${Array.from({ length: 1536 }, (_, index) => index === hotIndex ? 1 : 0).join(",")}]`;
}

async function createBoundAgent(
  control: PrismaClient,
  seeded: {
    project: { id: string };
    environment: { id: string };
    user: { id: string };
  },
  slug: string,
  clusterId: string | null,
) {
  const agent = await control.agent.create({
    data: { projectId: seeded.project.id, name: slug, slug },
  });
  const version = await control.agentVersion.create({
    data: {
      agentId: agent.id,
      versionNumber: 1,
      model: `test:${slug}`,
      createdBy: seeded.user.id,
    },
  });
  await control.agentBinding.create({
    data: {
      environmentId: seeded.environment.id,
      agentId: agent.id,
      activeAgentVersionId: version.id,
      clusterId,
    },
  });
  return agent;
}

function memoryAccessWhere(
  environmentId: string,
  endUserId: string,
  agentId: string,
): Prisma.MemoryWhereInput {
  return {
    environmentId,
    endUserId,
    OR: [
      { agentId },
      {
        cluster: {
          bindings: { some: { environmentId, agentId } },
        },
      },
    ],
  };
}
