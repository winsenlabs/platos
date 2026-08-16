import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelsController } from "./channels.controller";

type CredentialRow = {
  id: string;
  environmentId: string;
  kind: string;
  name: string;
  provider: string | null;
  externalClientId: string | null;
  encryptedReference: string | null;
  revokedAt: Date | null;
  updatedAt: Date;
};

type ConnectionRow = {
  id: string;
  environmentId: string;
  entityId: string | null;
  provider: string;
  displayName: string | null;
  defaultAgentId: string | null;
  agentRouting: unknown;
  enabled: boolean;
  credentialId: string | null;
  createdAt: Date;
};

let decryptCalls = 0;
const messageCrypto = {
  encryptJsonField: (value: unknown) => ({
    encrypted: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
  }),
  decryptJsonField: (envelope: any) => {
    decryptCalls++;
    return JSON.parse(Buffer.from(envelope.encrypted, "base64").toString("utf8"));
  },
} as any;

const SCOPE = {
  organizationId: "org1",
  projectId: "project1",
  environmentId: "environment1",
  userId: "user1",
  principal: "operator" as const,
};
const req = (scope: unknown = SCOPE) => ({ scope }) as any;

function makePrisma() {
  const credentials: CredentialRow[] = [];
  const connections: ConnectionRow[] = [];
  let sequence = 0;
  let failCredentialUpdates = false;
  const environment = {
    id: "environment1",
    projectId: "project1",
    project: { id: "project1", organizationId: "org1" },
  };
  const credentialFor = (id: string | null) =>
    id ? credentials.find((candidate) => candidate.id === id) ?? null : null;
  const hydrate = (connection: ConnectionRow) => ({
    ...connection,
    credential: credentialFor(connection.credentialId),
    entity: null,
    environment,
  });

  const prisma: any = {
    credentials,
    connections,
    setFailCredentialUpdates(value: boolean) {
      failCredentialUpdates = value;
    },
    environment: {
      findUnique: async ({ where }: any) => (where.id === environment.id ? environment : null),
    },
    agentBinding: {
      findFirst: async ({ where }: any) =>
        where.agentId === "agent1" &&
        where.environmentId === "environment1" &&
        where.agent?.projectId === "project1" &&
        where.environment?.project?.id === "project1" &&
        where.environment?.project?.organizationId === "org1"
          ? { id: "binding1", agent: { id: "agent1", name: "Ada" } }
          : null,
    },
    channelConnection: {
      create: async ({ data }: any) => {
        const row: ConnectionRow = {
          id: `connection_${++sequence}`,
          environmentId: data.environmentId,
          entityId: data.entityId ?? null,
          provider: data.provider,
          displayName: data.displayName ?? null,
          defaultAgentId: data.defaultAgentId ?? null,
          agentRouting: data.agentRouting ?? [],
          enabled: data.enabled ?? true,
          credentialId: data.credentialId ?? null,
          createdAt: new Date(Date.now() + sequence),
        };
        connections.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => {
        const row = connections.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("connection not found");
        Object.assign(row, data);
        return hydrate(row);
      },
      findUnique: async ({ where }: any) => {
        const row = connections.find((candidate) => candidate.id === where.id);
        return row ? hydrate(row) : null;
      },
      findFirst: async ({ where }: any) => {
        const row = connections.find(
          (candidate) =>
            candidate.id === where.id && candidate.environmentId === where.environmentId
        );
        return row ? hydrate(row) : null;
      },
      findMany: async ({ where }: any) =>
        connections
          .filter(
            (candidate) =>
              (!where.environmentId || candidate.environmentId === where.environmentId) &&
              (!where.provider || candidate.provider === where.provider) &&
              (where.enabled === undefined || candidate.enabled === where.enabled)
          )
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map(hydrate),
      delete: async ({ where }: any) => {
        const index = connections.findIndex((candidate) => candidate.id === where.id);
        if (index < 0) throw new Error("connection not found");
        return connections.splice(index, 1)[0];
      },
    },
    credential: {
      create: async ({ data }: any) => {
        const row: CredentialRow = {
          id: `credential_${++sequence}`,
          environmentId: data.environmentId,
          kind: data.kind,
          name: data.name,
          provider: data.provider ?? null,
          externalClientId: data.externalClientId ?? null,
          encryptedReference: data.encryptedReference ?? null,
          revokedAt: null,
          updatedAt: new Date(),
        };
        credentials.push(row);
        return { id: row.id };
      },
      updateMany: async ({ where, data }: any) => {
        if (failCredentialUpdates) throw new Error("credential store unavailable");
        const rows = credentials.filter(
          (candidate) =>
            candidate.id === where.id &&
            candidate.environmentId === where.environmentId &&
            candidate.kind === where.kind
        );
        rows.forEach((row) => Object.assign(row, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
      upsert: async () => {
        throw new Error("unexpected detached credential upsert");
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
  };
  prisma.$transaction = async (callback: (tx: any) => Promise<unknown>) => callback(prisma);
  return prisma;
}

function payload(prisma: ReturnType<typeof makePrisma>, connection: ConnectionRow) {
  const credential = prisma.credentials.find(
    (candidate: CredentialRow) => candidate.id === connection.credentialId
  );
  return messageCrypto.decryptJsonField(JSON.parse(credential!.encryptedReference!));
}

describe("ChannelsController clean connection management", () => {
  let prisma: ReturnType<typeof makePrisma>;
  let controller: ChannelsController;
  let invalidated: string[];
  const originalFetch = globalThis.fetch;
  const originalPublicOrigin = process.env.PLATOS_PUBLIC_BASE_URL;

  beforeEach(() => {
    prisma = makePrisma();
    invalidated = [];
    decryptCalls = 0;
    controller = new ChannelsController(prisma, messageCrypto, {
      get: () => ({ invalidate: (id: string) => invalidated.push(id) }),
    } as any);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPublicOrigin === undefined) {
      delete process.env.PLATOS_PUBLIC_BASE_URL;
    } else {
      process.env.PLATOS_PUBLIC_BASE_URL = originalPublicOrigin;
    }
  });

  it("creates a clean connection with one-time webhook reveal and Credential payload", async () => {
    const result = await controller.create(req(), {
      provider: "slack",
      agentId: "agent1",
      displayName: "Support",
      credentials: { botToken: "xoxb-secret" },
      config: { teamId: "T1" },
    });

    expect(result.webhookSecret).toMatch(/^[a-f0-9]{64}$/);
    expect(result.webhookPath).toContain(result.webhookSecret);
    expect(result.channel).toMatchObject({
      provider: "slack",
      agentId: "agent1",
      defaultAgentId: "agent1",
      hasCredentials: true,
    });
    expect(result.channel.credentials).toBeUndefined();
    expect(result.channel.credential).toBeUndefined();
    expect(prisma.connections[0]).not.toHaveProperty("credentials");
    expect(prisma.connections[0]).not.toHaveProperty("webhookSecret");
    expect(prisma.credentials[0].environmentId).toBe("environment1");
    expect(payload(prisma, prisma.connections[0])).toEqual({
      version: 1,
      kind: "channel-connection",
      credentials: { botToken: "xoxb-secret" },
      config: { teamId: "T1" },
      webhookSecret: result.webhookSecret,
    });
  });

  it("rotates only the referenced Credential and invalidates runtime cache", async () => {
    const created = await controller.create(req(), {
      provider: "slack",
      agentId: "agent1",
      credentials: { botToken: "xoxb-secret" },
    });
    const oldSecret = created.webhookSecret;
    const connectionId = created.channel.id;

    const rotated = await controller.rotateSecret(req(), connectionId);

    expect(rotated.webhookSecret).not.toBe(oldSecret);
    expect(prisma.connections).toHaveLength(1);
    expect(prisma.credentials).toHaveLength(1);
    expect(payload(prisma, prisma.connections[0])).toMatchObject({
      credentials: { botToken: "xoxb-secret" },
      webhookSecret: rotated.webhookSecret,
    });
    expect(invalidated).toEqual([connectionId]);
  });

  it("rejects forged ancestry even when the Environment id matches", async () => {
    const created = await controller.create(req(), {
      provider: "discord",
      agentId: "agent1",
    });
    const beforeForgedRead = decryptCalls;
    await expect(
      controller.getOne(req({ ...SCOPE, organizationId: "forged-org" }), created.channel.id)
    ).rejects.toMatchObject({ status: 404 });
    expect(decryptCalls).toBe(beforeForgedRead);
  });

  it("rolls back the clean row and Credential when Slack is unreachable", async () => {
    process.env.PLATOS_PUBLIC_BASE_URL = "https://agent.example.com";
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    await expect(
      controller.mintFromManifest(req(), {
        provider: "slack",
        agentId: "agent1",
        configToken: "xoxe-config",
      })
    ).rejects.toMatchObject({ status: 502 });
    expect(prisma.connections).toHaveLength(0);
    expect(prisma.credentials).toHaveLength(0);
  });

  it("keeps the clean row when Slack succeeds but Credential persistence fails", async () => {
    process.env.PLATOS_PUBLIC_BASE_URL = "https://agent.example.com";
    globalThis.fetch = async () =>
      ({
        json: async () => ({
          ok: true,
          app_id: "A1",
          oauth_authorize_url: "https://slack.com/oauth/v2/authorize",
          credentials: {
            client_id: "client-id",
            client_secret: "client-secret",
            signing_secret: "signing-secret",
          },
        }),
      }) as any;
    prisma.setFailCredentialUpdates(true);

    await expect(
      controller.mintFromManifest(req(), {
        provider: "slack",
        agentId: "agent1",
        configToken: "xoxe-config",
      })
    ).rejects.toMatchObject({
      status: 500,
      response: { error: "secret_store_failed", connectionId: "connection_1" },
    });
    expect(prisma.connections).toHaveLength(1);
    expect(prisma.credentials).toHaveLength(1);
  });
});
