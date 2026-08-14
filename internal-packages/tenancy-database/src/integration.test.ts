import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  ApprovalStatus,
  AgentToolDefaultPolicy,
  AuthorizationScopeKind,
  CredentialKind,
  OrganizationRole,
  PolicyEffect,
  Prisma,
  PrismaClient,
  PrincipalTier,
  ProjectRole,
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
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
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
    expect(modelNames).toHaveLength(77);
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
      data: { threadId: thread.id, sequence: 1, inputText: "private" },
    });
    const memory = await control.memory.create({
      data: {
        environmentId: seeded.environment.id,
        endUserId: subject.id,
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
  track("AgentBinding", await control.agentBinding.create({
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
      name: "provider",
      secretHash: "hash",
      permissions: ["invoke"],
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
      provider: "anthropic",
      label: "primary",
      environmentKeyName: "ANTHROPIC_API_KEY",
      encryptedReference: "secret://provider",
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
    data: { threadId: thread.id, sequence: 1, inputText: "hello", output: { text: "hi" } },
  }));
  const step = track("Step", await control.step.create({
    data: { turnId: turn.id, sequence: 1, model: "test:model", status: WorkStatus.SUCCEEDED },
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
      rating: 5,
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
  track("Memory", await control.memory.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
      agentId: agent.id,
      kind: "fact",
      content: "Likes tests",
      metadata: {},
      visibility: "subject",
      source: "turn",
      sourceTurnIds: [turn.id],
    },
  }));
  const memoryEntityA = track("MemoryEntity", await control.memoryEntity.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
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
      entityKey: "place",
      entityType: "place",
      label: "Place",
    },
  });
  track("MemoryRelationship", await control.memoryRelationship.create({
    data: {
      environmentId: environment.id,
      endUserId: endUser.id,
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
    thread,
    installation,
    oauthClient,
    memoryEntityA,
    personalAccessToken,
    oauthAccessToken,
    oauthRefreshToken,
    rotatedRefreshToken,
    mcpBearerToken,
  };
}
