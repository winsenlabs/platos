import { describe, it, expect, beforeEach } from "vitest";
import { ChannelAppsController } from "./channel-apps.controller";

type CredentialRow = {
  id: string;
  environmentId: string;
  kind: string;
  name: string;
  provider: string | null;
  externalClientId: string | null;
  encryptedReference: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  updatedAt: Date;
};

type AppRow = {
  id: string;
  environmentId: string;
  provider: string;
  displayName: string | null;
  clientId: string;
  credentialId: string | null;
  scopes: string[];
  distribution: string;
  defaultAgentId: string | null;
  agentRouting: unknown;
  createdAt: Date;
};

type InstallRow = {
  id: string;
  appId: string;
  externalInstallationId: string;
  displayName: string | null;
  credentialId: string | null;
  grantedScopes: string[];
  defaultAgentId: string | null;
  agentRouting: unknown;
  status: string;
  revokedAt: Date | null;
  lastEventAt: Date | null;
  tokenGeneration: number;
  tokenRefreshState: string;
  tokenRefreshAttemptId: string | null;
  tokenRefreshStartedAt: Date | null;
  tokenRefreshRepairCode: string | null;
  createdAt: Date;
};

type AgentRow = {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
};

const messageCrypto = {
  encryptJsonField: (value: unknown) => ({
    __enc: true,
    payload: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  }),
  decryptJsonField: (envelope: any) =>
    JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")),
} as any;

const moduleRef = {
  get: () => {
    throw new Error("runtime unavailable in focused test");
  },
} as any;

const SCOPE = {
  organizationId: "org1",
  projectId: "proj1",
  environmentId: "env1",
  userId: "u1",
  principal: "operator" as const,
};
const req = (scope: unknown) => ({ scope }) as any;

function makePrisma(seed: { agents?: AgentRow[] } = {}) {
  const credentials: CredentialRow[] = [];
  const apps: AppRow[] = [
    {
      id: "app1",
      environmentId: "env1",
      provider: "slack",
      displayName: "Platos Slack",
      clientId: "client1",
      credentialId: null,
      scopes: [],
      distribution: "private",
      defaultAgentId: "appDefaultAgent",
      agentRouting: [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  ];
  const installs: InstallRow[] = [];
  const agents = seed.agents ?? [];
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${++sequence}`;

  const environment = {
    id: "env1",
    projectId: "proj1",
    project: { id: "proj1", organizationId: "org1" },
  };
  const credentialFor = (id: string | null) =>
    id ? credentials.find((credential) => credential.id === id) ?? null : null;
  const hydrateApp = (app: AppRow) => ({
    ...app,
    credential: credentialFor(app.credentialId),
    environment,
  });
  const hydrateInstall = (installation: InstallRow) => {
    const app = apps.find((candidate) => candidate.id === installation.appId)!;
    return {
      ...installation,
      credential: credentialFor(installation.credentialId),
      app: hydrateApp(app),
    };
  };

  const prisma: any = {
    apps,
    installs,
    credentials,
    agents,
    environment: {
      findUnique: async ({ where }: any) => (where.id === environment.id ? environment : null),
    },
    channelApp: {
      findUnique: async ({ where }: any) => {
        const app = apps.find((candidate) => candidate.id === where.id);
        return app ? hydrateApp(app) : null;
      },
      findFirst: async ({ where }: any) => {
        const app = apps.find(
          (candidate) =>
            candidate.id === where.id && candidate.environmentId === where.environmentId
        );
        return app ? hydrateApp(app) : null;
      },
      findMany: async ({ where }: any) =>
        apps
          .filter((candidate) => candidate.environmentId === where.environmentId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map(hydrateApp),
      create: async ({ data }: any) => {
        const row: AppRow = {
          id: nextId("app"),
          environmentId: data.environmentId,
          provider: data.provider,
          displayName: data.displayName ?? null,
          clientId: data.clientId,
          credentialId: data.credentialId ?? null,
          scopes: data.scopes ?? [],
          distribution: data.distribution,
          defaultAgentId: data.defaultAgentId ?? null,
          agentRouting: data.agentRouting ?? [],
          createdAt: new Date(Date.now() + sequence),
        };
        apps.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = apps.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("app not found");
        Object.assign(row, data);
        return hydrateApp(row);
      },
      delete: async ({ where }: any) => {
        const index = apps.findIndex((candidate) => candidate.id === where.id);
        if (index < 0) throw new Error("app not found");
        const [deleted] = apps.splice(index, 1);
        for (let installIndex = installs.length - 1; installIndex >= 0; installIndex--) {
          if (installs[installIndex].appId === deleted.id) installs.splice(installIndex, 1);
        }
        return deleted;
      },
    },
    channelInstallation: {
      findUnique: async ({ where }: any) => {
        const key = where.appId_externalInstallationId;
        const row = installs.find(
          (candidate) =>
            candidate.appId === key.appId &&
            candidate.externalInstallationId === key.externalInstallationId
        );
        return row ? hydrateInstall(row) : null;
      },
      findFirst: async ({ where }: any) => {
        const row = installs.find(
          (candidate) =>
            (!where.id || candidate.id === where.id) &&
            (!where.appId || candidate.appId === where.appId)
        );
        return row ? hydrateInstall(row) : null;
      },
      findMany: async ({ where }: any) =>
        installs
          .filter((candidate) => candidate.appId === where.appId)
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map(hydrateInstall),
      upsert: async ({ where, update, create }: any) => {
        const key = where.appId_externalInstallationId;
        let row = installs.find(
          (candidate) =>
            candidate.appId === key.appId &&
            candidate.externalInstallationId === key.externalInstallationId
        );
        if (row) {
          Object.assign(row, update);
        } else {
          row = {
            id: nextId("installation"),
            appId: create.appId,
            externalInstallationId: create.externalInstallationId,
            displayName: create.displayName ?? null,
            credentialId: create.credentialId ?? null,
            grantedScopes: create.grantedScopes ?? [],
            defaultAgentId: create.defaultAgentId ?? null,
            agentRouting: create.agentRouting ?? [],
            status: create.status,
            revokedAt: null,
            lastEventAt: null,
            tokenGeneration: 1,
            tokenRefreshState: "IDLE",
            tokenRefreshAttemptId: null,
            tokenRefreshStartedAt: null,
            tokenRefreshRepairCode: null,
            createdAt: new Date(Date.now() + sequence),
          };
          installs.push(row);
        }
        return { id: row.id };
      },
      create: async ({ data }: any) => {
        const row: InstallRow = {
          id: nextId("installation"),
          appId: data.appId,
          externalInstallationId: data.externalInstallationId,
          displayName: data.displayName ?? null,
          credentialId: data.credentialId ?? null,
          grantedScopes: data.grantedScopes ?? [],
          defaultAgentId: data.defaultAgentId ?? null,
          agentRouting: data.agentRouting ?? [],
          status: data.status,
          revokedAt: null,
          lastEventAt: null,
          tokenGeneration: 1,
          tokenRefreshState: "IDLE",
          tokenRefreshAttemptId: null,
          tokenRefreshStartedAt: null,
          tokenRefreshRepairCode: null,
          createdAt: new Date(Date.now() + sequence),
        };
        installs.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = installs.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("installation not found");
        const { tokenGeneration, ...rest } = data;
        Object.assign(row, rest);
        if (tokenGeneration?.increment) row.tokenGeneration += tokenGeneration.increment;
        else if (tokenGeneration !== undefined) row.tokenGeneration = tokenGeneration;
        return hydrateInstall(row);
      },
    },
    credential: {
      create: async ({ data }: any) => {
        const row: CredentialRow = {
          id: nextId("credential"),
          environmentId: data.environmentId,
          kind: data.kind,
          name: data.name,
          provider: data.provider ?? null,
          externalClientId: data.externalClientId ?? null,
          encryptedReference: data.encryptedReference ?? null,
          expiresAt: data.expiresAt ?? null,
          revokedAt: null,
          updatedAt: new Date(),
        };
        credentials.push(row);
        return { id: row.id };
      },
      upsert: async ({ where, update, create }: any) => {
        const key = where.environmentId_kind_name;
        let row = credentials.find(
          (candidate) =>
            candidate.environmentId === key.environmentId &&
            candidate.kind === key.kind &&
            candidate.name === key.name
        );
        if (row) {
          Object.assign(row, update, { updatedAt: new Date() });
        } else {
          row = {
            id: nextId("credential"),
            environmentId: create.environmentId,
            kind: create.kind,
            name: create.name,
            provider: create.provider ?? null,
            externalClientId: create.externalClientId ?? null,
            encryptedReference: create.encryptedReference ?? null,
            expiresAt: create.expiresAt ?? null,
            revokedAt: null,
            updatedAt: new Date(),
          };
          credentials.push(row);
        }
        return { id: row.id };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = credentials.filter(
          (candidate) =>
            candidate.id === where.id &&
            candidate.environmentId === where.environmentId &&
            candidate.kind === where.kind
        );
        rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
      deleteMany: async ({ where }: any) => {
        const ids = where.id?.in ?? [where.id];
        let count = 0;
        for (let index = credentials.length - 1; index >= 0; index--) {
          if (
            ids.includes(credentials[index].id) &&
            credentials[index].environmentId === where.environmentId
          ) {
            credentials.splice(index, 1);
            count++;
          }
        }
        return { count };
      },
    },
    agentBinding: {
      findFirst: async ({ where }: any) => {
        const agent = agents.find(
          (candidate) =>
            candidate.id === where.agentId &&
            candidate.environmentId === where.environmentId &&
            candidate.projectId === where.agent?.projectId &&
            candidate.projectId === where.environment?.project?.id &&
            candidate.organizationId === where.environment?.project?.organizationId
        );
        return agent ? { id: `binding_${agent.id}` } : null;
      },
    },
  };
  prisma.$transaction = async (callback: (tx: any) => Promise<unknown>) => callback(prisma);
  return prisma;
}

function credentialPayload(prisma: ReturnType<typeof makePrisma>, installation: InstallRow) {
  return payloadForCredential(prisma, installation.credentialId);
}

function payloadForCredential(prisma: ReturnType<typeof makePrisma>, credentialId: string | null) {
  const credential = prisma.credentials.find(
    (candidate: CredentialRow) => candidate.id === credentialId
  );
  return messageCrypto.decryptJsonField(JSON.parse(credential!.encryptedReference!));
}

describe("ChannelAppsController clean app management", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let controller: ChannelAppsController;

  beforeEach(() => {
    prisma = makePrisma();
    controller = new ChannelAppsController(prisma, messageCrypto, moduleRef);
  });

  it("creates and rotates app secrets only through a referenced Credential", async () => {
    const created = await controller.create(req(SCOPE), {
      provider: "slack",
      displayName: "Customer Support",
      clientId: "client-new",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
      aiAppsSurface: true,
      linking: "optional",
      scopes: ["chat:write", "chat:write"],
    });

    expect(created.app).toMatchObject({
      clientId: "client-new",
      hasClientSecret: true,
      hasSigningSecret: true,
      linking: "optional",
      scopes: ["chat:write"],
    });
    expect(created.app.credential).toBeUndefined();
    const stored = prisma.apps.find((app: AppRow) => app.id === created.app.id)!;
    expect(stored).not.toHaveProperty("clientSecret");
    expect(stored).not.toHaveProperty("signingSecret");
    expect(payloadForCredential(prisma, stored.credentialId)).toMatchObject({
      kind: "channel-app",
      clientSecret: "client-secret-one",
      signingSecret: "signing-secret-one",
      linking: "optional",
    });

    const updated = await controller.update(req(SCOPE), stored.id, {
      clientSecret: "client-secret-two",
      aiAppsSurface: false,
      linking: "required",
    });
    expect(prisma.credentials).toHaveLength(1);
    expect(updated.app).toMatchObject({ aiAppsSurface: false, linking: "required" });
    expect(payloadForCredential(prisma, stored.credentialId)).toMatchObject({
      clientSecret: "client-secret-two",
      signingSecret: "signing-secret-one",
      aiAppsSurface: false,
      linking: "required",
    });
  });

  it("lists scoped redacted metadata and deletes app credentials with the app", async () => {
    const created = await controller.create(req(SCOPE), {
      clientId: "client-new",
      clientSecret: "client-secret",
      signingSecret: "signing-secret",
    });
    const listed = await controller.list(req(SCOPE));
    const projected = listed.apps.find((app: any) => app.id === created.app.id);
    expect(projected).toMatchObject({
      hasClientSecret: true,
      hasSigningSecret: true,
    });
    expect(JSON.stringify(projected)).not.toContain("client-secret");
    expect(JSON.stringify(projected)).not.toContain("signing-secret");

    await controller.remove(req(SCOPE), created.app.id);
    expect(prisma.apps.some((app: AppRow) => app.id === created.app.id)).toBe(false);
    expect(prisma.credentials).toHaveLength(0);
  });
});

describe("ChannelAppsController clean installation management", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let controller: ChannelAppsController;

  beforeEach(() => {
    prisma = makePrisma();
    controller = new ChannelAppsController(prisma, messageCrypto, moduleRef);
  });

  it("imports only through a referenced same-Environment Credential", async () => {
    const result = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      teamName: "Acme",
      botToken: "xoxb-secret",
    });

    expect(result.installation).toMatchObject({
      teamId: "T100",
      externalInstallationId: "slack:team:T100",
      status: "active",
      hasBotToken: true,
    });
    expect(result.installation.botToken).toBeUndefined();
    expect(result.installation.credential).toBeUndefined();
    expect(prisma.installs[0]).not.toHaveProperty("botToken");
    expect(prisma.credentials).toHaveLength(1);
    expect(prisma.credentials[0].environmentId).toBe("env1");
    expect(prisma.credentials[0].encryptedReference).not.toContain("xoxb-secret");
    expect(credentialPayload(prisma, prisma.installs[0]).botToken).toBe("xoxb-secret");
  });

  it("is idempotent, un-revokes, and clears stale OAuth rotation state", async () => {
    const first = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb-1",
    });
    const firstTokenGeneration = prisma.installs[0].tokenGeneration;
    const credential = prisma.credentials[0];
    credential.encryptedReference = JSON.stringify(
      messageCrypto.encryptJsonField({
        ...credentialPayload(prisma, prisma.installs[0]),
        refreshToken: "xoxe-stale",
        tokenExpiresAt: new Date(0).toISOString(),
      })
    );
    await controller.revokeInstallation(req(SCOPE), "app1", first.installation.id);

    const second = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb-2",
    });

    expect(prisma.installs).toHaveLength(1);
    expect(prisma.credentials).toHaveLength(1);
    expect(second.installation.id).toBe(first.installation.id);
    expect(prisma.installs[0].tokenGeneration).toBe(firstTokenGeneration + 1);
    expect(prisma.installs[0]).toMatchObject({ status: "active", revokedAt: null });
    expect(prisma.credentials[0].revokedAt).toBeNull();
    expect(credentialPayload(prisma, prisma.installs[0])).toMatchObject({
      botToken: "xoxb-2",
      refreshToken: null,
      tokenExpiresAt: null,
    });
  });

  it("derives scope from persisted Environment ancestry", async () => {
    await expect(
      controller.importInstallation(req({ ...SCOPE, organizationId: "forged-org" }), "app1", {
        teamId: "T100",
        botToken: "xoxb",
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.installs).toHaveLength(0);
  });

  it("requires a token and workspace anchor", async () => {
    await expect(
      controller.importInstallation(req(SCOPE), "app1", { teamId: "T100" })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.importInstallation(req(SCOPE), "app1", { botToken: "xoxb" })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("binds only canonically scoped clean AgentBindings", async () => {
    prisma.agents.push({
      id: "agentA",
      organizationId: "org1",
      projectId: "proj1",
      environmentId: "env1",
    });
    const imported = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb",
      agentId: "agentA",
    });
    expect(imported.installation.agentId).toBe("agentA");

    await expect(
      controller.importInstallation(req(SCOPE), "app1", {
        teamId: "T200",
        botToken: "xoxb",
        agentId: "forged-agent",
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("keeps installations, thread keys, and identity realms distinct", async () => {
    const first = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      botToken: "xoxb-1",
    });
    const second = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T200",
      botToken: "xoxb-2",
    });

    expect(first.installation.id).not.toBe(second.installation.id);
    expect(first.installation.externalInstallationId).not.toBe(
      second.installation.externalInstallationId
    );
    const threadKey = "slack:C1:1700000000.1";
    expect(`${first.installation.id}:${threadKey}`).not.toBe(
      `${second.installation.id}:${threadKey}`
    );
    expect(`channel:slack:T100:U9`).not.toBe(`channel:slack:T200:U9`);
  });

  it("projects effective agent lifecycle and soft revocation without secrets", async () => {
    const imported = await controller.importInstallation(req(SCOPE), "app1", {
      teamId: "T100",
      teamName: "Acme",
      botToken: "xoxb",
    });

    let status = await controller.installationsStatus(req(SCOPE), "app1");
    expect(status.installations[0]).toMatchObject({
      teamId: "T100",
      status: "active",
      tokenRefresh: {
        state: "IDLE",
        repairCode: null,
        action: null,
      },
      agentBinding: {
        agentId: null,
        effectiveAgentId: "appDefaultAgent",
        source: "app",
        hasRoutingOverride: false,
      },
    });
    expect(JSON.stringify(status)).not.toContain("xoxb");

    await controller.revokeInstallation(req(SCOPE), "app1", imported.installation.id);
    status = await controller.installationsStatus(req(SCOPE), "app1");
    expect(status.installations[0].status).toBe("revoked");
    expect(status.installations[0].revokedAt).toBeInstanceOf(Date);
  });

  it("rejects non-operator principals", async () => {
    await expect(
      controller.importInstallation(req({ ...SCOPE, principal: "end-user" }), "app1", {
        teamId: "T100",
        botToken: "xoxb",
      })
    ).rejects.toBeTruthy();
    expect(prisma.installs).toHaveLength(0);
  });
});
