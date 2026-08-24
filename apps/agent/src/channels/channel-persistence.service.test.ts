import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ChannelPersistenceService } from "./channel-persistence.service";

const ORG_A = "00000000-0000-0000-0000-000000000001";
const ORG_B = "00000000-0000-0000-0000-000000000002";
const PROJECT = "00000000-0000-0000-0000-000000000003";
const ENVIRONMENT = "00000000-0000-0000-0000-000000000004";
const APP = "00000000-0000-0000-0000-000000000005";
const CREDENTIAL = "00000000-0000-0000-0000-000000000006";
const INSTALLATION = "00000000-0000-0000-0000-000000000007";

const cryptoShim = {
  encryptJsonField: (value: unknown) => ({ envelope: value }),
  decryptJsonField: (value: any) => value.envelope,
};

function credential(payload: Record<string, unknown>) {
  return {
    id: "00000000-0000-0000-0000-000000000006",
    environmentId: ENVIRONMENT,
    encryptedReference: JSON.stringify({ envelope: payload }),
    revokedAt: null,
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
  };
}

function appRow(organizationId = ORG_A) {
  return {
    id: APP,
    environmentId: ENVIRONMENT,
    provider: "slack",
    displayName: "Ada",
    clientId: "client-id",
    scopes: ["chat:write"],
    distribution: "private",
    defaultAgentId: null,
    agentRouting: [],
    credential: credential({
      version: 1,
      kind: "channel-app",
      clientSecret: "client-secret",
      signingSecret: "signing-secret",
      linking: "required",
      tokenRotation: true,
    }),
    environment: {
      id: ENVIRONMENT,
      projectId: PROJECT,
      project: { id: PROJECT, organizationId },
    },
  };
}

function makeRefreshHarness(
  overrides: Record<string, unknown> = {},
  decryptJsonField = cryptoShim.decryptJsonField,
) {
  const installationCredential = {
    ...credential({
      version: 1,
      kind: "channel-installation",
      botToken: "xoxb-old",
      refreshToken: "xoxe-old",
      tokenExpiresAt: "2026-08-18T16:00:00.000Z",
      teamId: "T1",
      enterpriseId: null,
      isEnterpriseInstall: false,
    }),
    id: CREDENTIAL,
  };
  const state: any = {
    id: INSTALLATION,
    appId: APP,
    externalInstallationId: "slack:team:T1",
    displayName: "Workspace",
    credentialId: CREDENTIAL,
    grantedScopes: ["chat:write"],
    status: "active",
    revokedAt: null,
    tokenGeneration: 4,
    tokenRefreshState: "IDLE",
    tokenRefreshClaimId: null,
    tokenRefreshStartedAt: null,
    tokenRefreshRepairCode: null,
    ...overrides,
  };
  let credentialWrites = 0;
  const matches = (where: any) =>
    Object.entries(where).every(([key, value]) => {
      if (key === "updatedAt") {
        return new Date(installationCredential.updatedAt).getTime() === new Date(value as any).getTime();
      }
      return state[key] === value;
    });
  const applyData = (data: any) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "increment" in value) {
        state[key] += Number((value as any).increment);
      } else {
        state[key] = value;
      }
    }
  };
  const prisma: any = {
    channelInstallation: {
      updateMany: async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        applyData(data);
        return { count: 1 };
      },
      findFirst: async ({ where }: any) => {
        if (where.id !== state.id || (where.appId && where.appId !== state.appId)) return null;
        return {
          ...state,
          credential: { ...installationCredential },
          app: appRow(),
        };
      },
    },
    credential: {
      updateMany: async ({ where, data }: any) => {
        if (
          where.id !== installationCredential.id ||
          where.environmentId !== installationCredential.environmentId ||
          where.revokedAt !== installationCredential.revokedAt ||
          new Date(where.updatedAt).getTime() !== installationCredential.updatedAt.getTime()
        ) {
          return { count: 0 };
        }
        credentialWrites++;
        Object.assign(installationCredential, data, { updatedAt: new Date("2026-08-18T15:01:00.000Z") });
        return { count: 1 };
      },
    },
  };
  prisma.$transaction = async (callback: (tx: any) => Promise<unknown>) => {
    const stateSnapshot = { ...state };
    const credentialSnapshot = { ...installationCredential };
    try {
      return await callback(prisma);
    } catch (error) {
      Object.assign(state, stateSnapshot);
      Object.assign(installationCredential, credentialSnapshot);
      throw error;
    }
  };
  const service = new ChannelPersistenceService(
    prisma,
    { ...cryptoShim, decryptJsonField } as any,
  );
  const expectation = {
    credentialId: CREDENTIAL,
    credentialRevision: `${CREDENTIAL}:${installationCredential.updatedAt.getTime()}`,
    tokenGeneration: 4,
  };
  return {
    service,
    state,
    installationCredential,
    expectation,
    get credentialWrites() {
      return credentialWrites;
    },
  };
}

describe("ChannelPersistenceService", () => {
  it("searches a default Agent UUID only by validated exact equality", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = {
      environment: {
        findUnique: vi.fn().mockResolvedValue({
          id: ENVIRONMENT,
          projectId: PROJECT,
          project: { id: PROJECT, organizationId: ORG_A },
        }),
      },
      channelConnection: { findMany, count },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);
    const scope = { organizationId: ORG_A, projectId: PROJECT, environmentId: ENVIRONMENT };

    await service.listConnectionsPage(scope, { limit: 25, offset: 0, search: "support" });
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { displayName: { contains: "support", mode: "insensitive" } },
      { provider: { contains: "support", mode: "insensitive" } },
    ]);

    const agentId = "00000000-0000-4000-8000-000000000013";
    await service.listConnectionsPage(scope, { limit: 25, offset: 0, search: agentId });
    expect(findMany.mock.calls[1][0].where.OR).toContainEqual({ defaultAgentId: agentId });
    expect(findMany.mock.calls[1][0].where.OR).not.toContainEqual({
      defaultAgentId: { contains: agentId, mode: "insensitive" },
    });
  });

  it("fails closed for event admission when dedicated inbox crypto is unavailable", async () => {
    const service = new ChannelPersistenceService({} as any, cryptoShim as any);
    await expect(service.enqueueChannelEvent(APP, "Ev1", { text: "secret" })).rejects.toThrow(
      "encryption unavailable",
    );
  });

  it("derives app scope only from persisted Environment ancestry", async () => {
    const prisma = {
      channelApp: { findUnique: async () => appRow() },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);

    const app = await service.loadApp(APP);

    expect(app).toMatchObject({
      organizationId: ORG_A,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      clientSecret: "client-secret",
      signingSecret: "signing-secret",
      linking: "required",
      tokenRotation: true,
    });
  });

  it("rejects a credential reference from another Environment", async () => {
    const row = appRow();
    row.credential.environmentId = "00000000-0000-0000-0000-000000000099";
    const service = new ChannelPersistenceService(
      { channelApp: { findUnique: async () => row } } as any,
      cryptoShim as any
    );

    await expect(service.loadApp(APP)).rejects.toThrow("channel credential scope mismatch");
  });

  it("persists OAuth grants only through a same-Environment Credential reference", async () => {
    const writes: { credential?: any; installation?: any } = {};
    const tx = {
      channelInstallation: {
        findUnique: async () => null,
        create: async ({ data }: any) => {
          writes.installation = data;
          return { id: "00000000-0000-0000-0000-000000000007" };
        },
      },
      credential: {
        upsert: async ({ create }: any) => {
          writes.credential = create;
          return { id: "00000000-0000-0000-0000-000000000008" };
        },
      },
    };
    const prisma = {
      $transaction: async (callback: (client: any) => unknown) => callback(tx),
      channelInstallation: {
        findFirst: async () => ({
          id: "00000000-0000-0000-0000-000000000007",
          appId: APP,
          externalInstallationId: "slack:team:T1",
          displayName: "Workspace",
          credentialId: "00000000-0000-0000-0000-000000000008",
          grantedScopes: ["chat:write"],
          status: "active",
          revokedAt: null,
          credential: {
            ...credential({
              kind: "channel-installation",
              botToken: "xoxb-secret",
              refreshToken: "xoxe-secret",
              teamId: "T1",
              enterpriseId: null,
              isEnterpriseInstall: false,
            }),
            id: "00000000-0000-0000-0000-000000000008",
          },
          app: appRow(),
        }),
      },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);
    const app = (await service.loadApp(APP).catch(() => null)) ?? {
      ...appRow(),
      organizationId: ORG_A,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
    };

    await service.upsertInstallationGrant(
      app,
      { teamId: "T1", enterpriseId: null, isEnterpriseInstall: false },
      {
        botToken: "xoxb-secret",
        refreshToken: "xoxe-secret",
        grantedScopes: ["chat:write"],
        displayName: "Workspace",
      }
    );

    expect(writes.credential).toMatchObject({
      environmentId: ENVIRONMENT,
      name: `channel-installation:${APP}:slack:team:T1`,
      provider: "slack",
      externalClientId: "slack:team:T1",
    });
    expect(writes.credential.encryptedReference).toContain("xoxb-secret");
    expect(writes.installation).toMatchObject({
      appId: APP,
      externalInstallationId: "slack:team:T1",
      credentialId: "00000000-0000-0000-0000-000000000008",
      status: "active",
    });
    expect(writes.installation).not.toHaveProperty("botToken");
    expect(writes.installation).not.toHaveProperty("refreshToken");
  });

  it("rotates an installation grant by replacing only its referenced Credential", async () => {
    let payload: Record<string, unknown> = {
      kind: "channel-installation",
      botToken: "old-bot",
      refreshToken: "old-refresh",
      tokenExpiresAt: "2026-08-15T01:00:00.000Z",
      teamId: "T1",
      enterpriseId: null,
      isEnterpriseInstall: false,
    };
    let credentialWrites = 0;
    const installationRow = () => ({
      id: "00000000-0000-0000-0000-000000000007",
      appId: APP,
      externalInstallationId: "slack:team:T1",
      displayName: "Workspace",
      credentialId: "00000000-0000-0000-0000-000000000008",
      grantedScopes: ["chat:write"],
      status: "active",
      revokedAt: null,
      credential: {
        ...credential(payload),
        id: "00000000-0000-0000-0000-000000000008",
      },
      app: appRow(),
    });
    const prisma = {
      channelInstallation: { findFirst: async () => installationRow() },
      credential: {
        updateMany: async ({ data }: any) => {
          credentialWrites++;
          payload = JSON.parse(data.encryptedReference).envelope;
          return { count: 1 };
        },
      },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);

    const rotated = await service.rotateInstallationGrant(
      "00000000-0000-0000-0000-000000000007",
      APP,
      {
        botToken: "new-bot",
        refreshToken: "new-refresh",
        tokenExpiresAt: new Date("2026-08-15T12:00:00.000Z"),
      }
    );

    expect(credentialWrites).toBe(1);
    expect(payload).toMatchObject({
      botToken: "new-bot",
      refreshToken: "new-refresh",
      tokenExpiresAt: "2026-08-15T12:00:00.000Z",
    });
    expect(rotated).toMatchObject({
      botToken: "new-bot",
      refreshToken: "new-refresh",
    });
  });

  it("returns only the canonical generation-bound grant from a successful refresh claim", async () => {
    const harness = makeRefreshHarness();

    const claimed = await harness.service.beginInstallationRefresh(
      INSTALLATION,
      APP,
      "claim-1",
      harness.expectation,
    );

    expect(claimed).toMatchObject({
      id: INSTALLATION,
      credentialId: CREDENTIAL,
      credentialRevision: harness.expectation.credentialRevision,
      tokenGeneration: 4,
      tokenRefreshState: "REFRESHING",
      tokenRefreshClaimId: "claim-1",
      botToken: "xoxb-old",
      refreshToken: "xoxe-old",
    });
  });

  it("rejects stale refresh generation and credential revision claims", async () => {
    const generationHarness = makeRefreshHarness();
    const revisionHarness = makeRefreshHarness();

    await expect(
      generationHarness.service.beginInstallationRefresh(INSTALLATION, APP, "claim-1", {
        ...generationHarness.expectation,
        tokenGeneration: 3,
      }),
    ).resolves.toBeNull();
    await expect(
      revisionHarness.service.beginInstallationRefresh(INSTALLATION, APP, "claim-2", {
        ...revisionHarness.expectation,
        credentialRevision: `${CREDENTIAL}:0`,
      }),
    ).resolves.toBeNull();
    expect(generationHarness.state.tokenRefreshState).toBe("IDLE");
    expect(revisionHarness.state.tokenRefreshState).toBe("IDLE");
  });

  it("does not decrypt or mutate a replacement grant from stale finalize and repair workers", async () => {
    const decrypt = vi.fn(cryptoShim.decryptJsonField);
    const harness = makeRefreshHarness(
      {
        tokenGeneration: 5,
        tokenRefreshState: "IDLE",
      },
      decrypt,
    );
    const mark = await harness.service.markInstallationRefreshRepairRequired(
      INSTALLATION,
      APP,
      "claim-1",
      harness.expectation,
      "refresh_failed",
    );
    const finalized = await harness.service.finalizeInstallationRefresh(
      INSTALLATION,
      APP,
      "claim-1",
      harness.expectation,
      { botToken: "xoxb-stale", refreshToken: "xoxe-stale" },
    );
    const preserved = await harness.service.preserveInstallationRefreshGrantForRepair(
      INSTALLATION,
      APP,
      "claim-1",
      harness.expectation,
      { botToken: "xoxb-stale", refreshToken: "xoxe-stale" },
      "refresh_commit_failed",
    );

    expect({ mark, finalized, preserved }).toEqual({
      mark: false,
      finalized: null,
      preserved: false,
    });
    expect(decrypt).not.toHaveBeenCalled();
    expect(harness.credentialWrites).toBe(0);
    expect(harness.state).toMatchObject({
      tokenGeneration: 5,
      tokenRefreshState: "IDLE",
      tokenRefreshRepairCode: null,
    });
  });

  it("fences every durable inbox stage by lease owner and generation", async () => {
    const updates: any[] = [];
    const prisma = {
      channelEventInbox: {
        updateMany: async (args: any) => {
          updates.push(args);
          return { count: 0 };
        },
        findUnique: async () => ({
          turnId: null,
          leaseOwner: "successor",
          leaseGeneration: 8,
          status: "PROCESSING",
        }),
      },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);

    await expect(service.recordChannelEventTurn("inbox", "old-worker", 7, "turn")).resolves.toBe(false);
    await expect(service.recordChannelEventDelivery("inbox", "old-worker", 7)).resolves.toBe(false);
    await expect(service.completeChannelEvent("inbox", "old-worker", 7)).resolves.toBe(false);
    await expect(service.failChannelEvent("inbox", "old-worker", 7, 5_000, "network")).resolves.toBe(false);
    await expect(service.discardChannelEvent("inbox", "old-worker", 7, "invalid_auth")).resolves.toBe(false);

    expect(updates).toHaveLength(5);
    for (const update of updates) {
      expect(update.where).toMatchObject({
        id: "inbox",
        status: "PROCESSING",
        leaseOwner: "old-worker",
        leaseGeneration: 7,
        completedAt: null,
      });
    }
  });

  it("keys channel identities by canonical Organization and provider realm", async () => {
    const lookups: any[] = [];
    const prisma = {
      endUserIdentity: {
        findUnique: async ({ where }: any) => {
          lookups.push(where.organizationId_issuer_channel_subject);
          return null;
        },
      },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);

    await service.isSlackUserLinked(
      {
        ...appRow(ORG_B),
        organizationId: ORG_B,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
      },
      "T1",
      "U1"
    );

    expect(lookups).toEqual([
      {
        organizationId: ORG_B,
        issuer: "channel:slack:T1",
        channel: "slack",
        subject: "U1",
      },
    ]);
  });

  it("keeps shared channel threads detached from any participant identity", async () => {
    const created: any[] = [];
    const threadCreates: any[] = [];
    const identities = new Map<string, any>();
    const prisma = {
      // Empty erased-subject register. Required, not incidental: the identity
      // path fails closed, so a double without this delegate refuses the write
      // rather than silently skipping the barrier.
      erasureTombstone: { findFirst: async () => null },
      endUserIdentity: {
        findUnique: async ({ where }: any) => {
          const key = JSON.stringify(where.organizationId_issuer_channel_subject);
          return identities.get(key) ?? null;
        },
        updateMany: async () => ({ count: 1 }),
      },
      $transaction: async (callback: (client: any) => unknown) =>
        callback({
          endUser: {
            create: async ({ data }: any) => {
              created.push(data);
              return { id: "00000000-0000-0000-0000-000000000009" };
            },
          },
          endUserIdentity: {
            create: async ({ data }: any) => {
              identities.set(
                JSON.stringify({
                  organizationId: data.organizationId,
                  issuer: data.issuer,
                  channel: data.channel,
                  subject: data.subject,
                }),
                { ...data, id: "00000000-0000-0000-0000-000000000010" }
              );
            },
          },
        }),
      channelThread: {
        findUnique: async () => null,
        create: async ({ data }: any) => {
          threadCreates.push(data.thread.create);
          return {
            threadId: "00000000-0000-0000-0000-000000000011",
            thread: {
              agentId: data.thread.create.agentId,
              endUserId: data.thread.create.endUserId ?? "00000000-0000-0000-0000-000000000014",
            },
          };
        },
      },
      channelConnection: {
        findUnique: async () => ({
          id: "00000000-0000-0000-0000-000000000012",
          environmentId: ENVIRONMENT,
          provider: "slack",
          enabled: true,
          defaultAgentId: "00000000-0000-0000-0000-000000000013",
          credential: credential({
            kind: "channel-connection",
            credentials: { botToken: "secret" },
            config: { team_id: "T1" },
            webhookSecret: "webhook-secret",
          }),
          entity: null,
          environment: appRow().environment,
        }),
      },
      agentBinding: { findFirst: async () => ({ id: "binding" }) },
    };
    const service = new ChannelPersistenceService(prisma as any, cryptoShim as any);
    const connection = {
      ...appRow(),
      id: "00000000-0000-0000-0000-000000000012",
    };

    const result = await service.resolveConnectionThread({
      connection,
      provider: "slack",
      realm: "T1",
      authorSubject: "U1",
      channelThreadKey: "slack:C1:1.0",
      agentId: "00000000-0000-0000-0000-000000000013",
      singleEndUser: false,
    });

    expect(result.endUserId).not.toBe("00000000-0000-0000-0000-000000000009");
    expect(created).toHaveLength(1);
    expect(threadCreates[0]).toMatchObject({
      endUser: { create: { organizationId: ORG_A } },
      sessionContext: { singleEndUser: false },
    });
    expect([...identities.values()]).toHaveLength(1);
    expect([...identities.values()][0]).toMatchObject({
      organizationId: ORG_A,
      issuer: "channel:slack:T1",
      channel: "slack",
      subject: "U1",
    });
  });

  it("contains no active legacy channel or identity delegates", () => {
    const files = [
      "channel-app-events.controller.ts",
      "channel-app-oauth.controller.ts",
      "channel-link.controller.ts",
      "channel-runtime.service.ts",
      "channels-inbound.controller.ts",
      "channel-persistence.service.ts",
    ];
    const source = files.map((file) => readFileSync(join(__dirname, file), "utf8")).join("\n");

    expect(source).not.toMatch(/prisma\.platos(?:Channel|EndUser|Agent)/);
  });
});
