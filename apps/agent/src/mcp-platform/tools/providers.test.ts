import { describe, expect, it, vi } from "vitest";
import { buildProviderToolHandlers } from "./providers";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
  userId: "user-a",
  principal: "operator" as const,
};

const SECRET_SENTINELS = [
  "raw-provider-secret",
  "ciphertext-provider-secret",
  "provider-secret-hash",
];

function cleanFixture() {
  const now = new Date("2026-08-15T00:00:00.000Z");
  const credentials = [
    {
      id: "credential-openai",
      environmentId: scope.environmentId,
      provider: "openai",
      name: "OPENAI_API_KEY",
      encryptedReference: SECRET_SENTINELS[0],
      secretHash: SECRET_SENTINELS[2],
    },
    {
      id: "credential-anthropic",
      environmentId: scope.environmentId,
      provider: "anthropic",
      name: "ANTHROPIC_API_KEY",
      encryptedReference: SECRET_SENTINELS[0],
      secretHash: SECRET_SENTINELS[2],
    },
    {
      id: "credential-anthropic-next",
      environmentId: scope.environmentId,
      provider: "anthropic",
      name: "ANTHROPIC_API_KEY_NEXT",
      encryptedReference: SECRET_SENTINELS[0],
      secretHash: SECRET_SENTINELS[2],
    },
  ];
  const providerKeys: any[] = [
    {
      id: "key-openai",
      environmentId: scope.environmentId,
      provider: "openai",
      label: "primary",
      environmentKeyName: "OPENAI_API_KEY",
      encryptedReference: "credential://credential-openai",
      isDefault: true,
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      ciphertext: SECRET_SENTINELS[1],
      secretHash: SECRET_SENTINELS[2],
    },
    {
      id: "key-delete",
      environmentId: scope.environmentId,
      provider: "openai",
      label: "unused",
      environmentKeyName: "OPENAI_API_KEY",
      encryptedReference: "credential://credential-openai",
      isDefault: false,
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    },
    {
      id: "key-foreign",
      environmentId: "environment-b",
      provider: "openai",
      label: "foreign",
      environmentKeyName: "OPENAI_API_KEY",
      encryptedReference: "credential://credential-openai",
      isDefault: true,
      createdBy: "user-b",
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
    },
  ];
  const agents: any[] = [
    {
      id: "agent-a",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      slug: "agent-a",
      name: "Agent A",
      model: "openai:gpt-4.1",
      providerKeyId: "key-openai",
      modelRoutes: null,
    },
  ];
  const pinned = new Set<string>();

  function scopedKey(where: any) {
    return providerKeys.find((key) =>
      (!where.id || key.id === where.id)
      && key.environmentId === where.environmentId
    ) ?? null;
  }

  const prisma: any = {
    providerKey: {
      findFirst: vi.fn(async ({ where }: any) => scopedKey(where)),
      findMany: vi.fn(async ({ where }: any) => providerKeys.filter((key) => {
        if (key.environmentId !== where.environmentId) return false;
        if (where.provider && key.provider !== where.provider) return false;
        if (where.id?.in && !where.id.in.includes(key.id)) return false;
        return true;
      })),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const key of providerKeys) {
          if (
            key.environmentId === where.environmentId
            && key.provider === where.provider
            && key.isDefault === where.isDefault
          ) {
            Object.assign(key, data);
            count += 1;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        const key = {
          id: `key-${data.provider}`,
          ...data,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null,
        };
        providerKeys.push(key);
        return key;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const key = providerKeys.find((candidate) => candidate.id === where.id);
        if (!key) throw new Error("missing key");
        Object.assign(key, data, { updatedAt: now });
        return key;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const index = providerKeys.findIndex((candidate) => candidate.id === where.id);
        if (index < 0) throw new Error("missing key");
        return providerKeys.splice(index, 1)[0];
      }),
    },
    $queryRawUnsafe: vi.fn(async (sql: string, keyId?: string) =>
      sql.includes("FROM \"ProviderKey\"") && keyId && pinned.has(keyId)
        ? [{ id: "version-pinned" }]
        : []
    ),
  };
  prisma.$transaction = vi.fn(async (operation: (tx: typeof prisma) => Promise<unknown>) =>
    operation(prisma)
  );

  const scopedEnv = {
    findCredentialMetadata: vi.fn(async (requestedScope: typeof scope, name: string, provider: string) => {
      const credential = credentials.find((candidate) =>
        candidate.environmentId === requestedScope.environmentId
        && candidate.name === name
        && candidate.provider === provider
      );
      return credential
        ? { id: credential.id, name: credential.name, provider: credential.provider }
        : null;
    }),
    hasProviderCredential: vi.fn(async (requestedScope: typeof scope, provider: string, keyId: string) => {
      const key = providerKeys.find((candidate) =>
        candidate.id === keyId
        && candidate.environmentId === requestedScope.environmentId
        && candidate.provider === provider
      );
      if (!key?.encryptedReference?.startsWith("credential://")) return false;
      const credentialId = key.encryptedReference.slice("credential://".length);
      return credentials.some((credential) =>
        credential.id === credentialId
        && credential.environmentId === requestedScope.environmentId
        && credential.provider === provider
        && credential.name === key.environmentKeyName
        && !!credential.encryptedReference
      );
    }),
    invalidate: vi.fn(),
  };

  const providerState = {
    id: "openai",
    displayName: "OpenAI",
    description: "OpenAI models",
    requiredEnv: [{ name: "OPENAI_API_KEY", set: true }],
    optionalEnv: [],
    envReady: true,
    enabled: true,
    linked: true,
    linkedAt: now.toISOString(),
    models: ["openai:gpt-4.1"],
  };
  const providers = {
    getOne: vi.fn(async (_requestedScope: typeof scope, providerId: string) =>
      providerId === "openai" ? providerState : undefined
    ),
  };
  const agentCrud = {
    findById: vi.fn(async (agentId: string, requestedScope: typeof scope) =>
      agents.find((agent) =>
        agent.id === agentId
        && agent.environmentId === requestedScope.environmentId
        && agent.projectId === requestedScope.projectId
        && agent.organizationId === requestedScope.organizationId
      ) ?? null
    ),
    list: vi.fn(async (requestedScope: typeof scope) => agents.filter((agent) =>
      agent.environmentId === requestedScope.environmentId
      && agent.projectId === requestedScope.projectId
      && agent.organizationId === requestedScope.organizationId
    )),
    update: vi.fn(async (agentId: string, requestedScope: typeof scope, data: any) => {
      const agent = agents.find((candidate) =>
        candidate.id === agentId && candidate.environmentId === requestedScope.environmentId
      );
      if (!agent) throw new Error("Agent not found");
      agent.modelRoutes = data.modelRoutes;
      return agent;
    }),
  };
  const toolAudit = { record: vi.fn().mockResolvedValue(undefined) };
  const handlers = buildProviderToolHandlers({
    agentCrud: agentCrud as any,
    providers: providers as any,
    scopedEnv: scopedEnv as any,
    toolAudit: toolAudit as any,
    prisma,
  });
  const byName = new Map(handlers.map((handler) => [handler.name, handler]));
  const execute = (name: string, params: Record<string, unknown>) => {
    const handler = byName.get(name);
    if (!handler) throw new Error(`Missing handler: ${name}`);
    return handler.execute(params, scope as any, {} as any);
  };

  return {
    agentCrud,
    byName,
    execute,
    pinned,
    prisma,
    providerKeys,
    scopedEnv,
    toolAudit,
  };
}

function expectSafe(payload: unknown) {
  const serialized = JSON.stringify(payload);
  for (const sentinel of SECRET_SENTINELS) expect(serialized).not.toContain(sentinel);
  expect(serialized).not.toContain("encryptedReference");
  expect(serialized).not.toContain("secretHash");
  expect(serialized).not.toContain("ciphertext");
}

describe("registered providers.* clean-client handlers", () => {
  it("invokes every registered operation without inherited Prisma delegates or secret serialization", async () => {
    const fixture = cleanFixture();

    expect([...fixture.byName.keys()]).toEqual([
      "providers.get",
      "providers.test_credentials",
      "providers.list_keys",
      "providers.add_key",
      "providers.delete_key",
      "providers.rotate_key",
      "providers.set_routes",
      "providers.get_routes",
    ]);
    expect(fixture.prisma).not.toHaveProperty("platosProviderKey");
    expect(fixture.prisma).not.toHaveProperty("platosAgent");

    const results = [
      await fixture.execute("providers.get", { providerId: "openai" }),
      await fixture.execute("providers.test_credentials", { keyId: "key-openai" }),
      await fixture.execute("providers.list_keys", { provider: "openai" }),
      await fixture.execute("providers.add_key", {
        provider: "anthropic",
        label: "primary",
        envVarName: "ANTHROPIC_API_KEY",
        isDefault: true,
      }),
      await fixture.execute("providers.rotate_key", {
        keyId: "key-anthropic",
        envVarName: "ANTHROPIC_API_KEY_NEXT",
        label: "rotated",
      }),
      await fixture.execute("providers.set_routes", {
        agentId: "agent-a",
        routes: [{
          label: "primary",
          model: "openai:gpt-4.1",
          providerKeyId: "key-openai",
          isDefault: true,
        }],
      }),
      await fixture.execute("providers.get_routes", { agentId: "agent-a" }),
      await fixture.execute("providers.delete_key", { keyId: "key-delete" }),
    ];

    expect(results[1]).toMatchObject({ ok: true, exists: true, decryptable: true });
    expect(results[2]).toMatchObject({ keys: expect.arrayContaining([
      expect.objectContaining({ id: "key-openai", envVarName: "OPENAI_API_KEY", envVarSet: true }),
    ]) });
    expect(results[3]).toMatchObject({ keyId: "key-anthropic", envVarName: "ANTHROPIC_API_KEY" });
    expect(results[4]).toMatchObject({
      rotated: true,
      previousEnvVarName: "ANTHROPIC_API_KEY",
      envVarName: "ANTHROPIC_API_KEY_NEXT",
    });
    expect(results[5]).toEqual({ ok: true, agentId: "agent-a", routeCount: 1, labels: ["primary"] });
    expect(results[6]).toMatchObject({ agents: [expect.objectContaining({
      agentId: "agent-a",
      routes: [expect.objectContaining({ providerKeyId: "key-openai" })],
    })] });
    expect(results[7]).toMatchObject({ deleted: true, keyId: "key-delete" });
    expect(fixture.agentCrud.update).toHaveBeenCalledWith(
      "agent-a",
      scope,
      expect.objectContaining({ versionNote: "Updated by providers.set_routes" }),
    );
    expect(fixture.providerKeys.find((key) => key.id === "key-anthropic")).toMatchObject({
      environmentKeyName: "ANTHROPIC_API_KEY_NEXT",
      encryptedReference: "credential://credential-anthropic-next",
    });
    for (const result of results) expectSafe(result);
    for (const [audit] of fixture.toolAudit.record.mock.calls) expectSafe(audit);
  });

  it("fails closed for foreign scope, wrong-provider credentials, mismatched routes, and pinned keys", async () => {
    const fixture = cleanFixture();

    await expect(fixture.execute("providers.test_credentials", { keyId: "key-foreign" }))
      .resolves.toEqual({ error: "not_found", keyId: "key-foreign" });
    await expect(fixture.execute("providers.add_key", {
      provider: "anthropic",
      label: "wrong-provider",
      envVarName: "OPENAI_API_KEY",
    })).resolves.toEqual({ error: "credential_not_found" });
    await expect(fixture.execute("providers.rotate_key", {
      keyId: "key-openai",
      envVarName: "ANTHROPIC_API_KEY",
    })).resolves.toEqual({ error: "credential_not_found" });
    await expect(fixture.execute("providers.set_routes", {
      agentId: "agent-a",
      routes: [{
        label: "wrong-provider",
        model: "anthropic:claude-sonnet-4-6",
        providerKeyId: "key-openai",
        isDefault: true,
      }],
    })).resolves.toEqual({
      error: "unknown_provider_key_ids",
      unknownProviderKeyIds: ["key-openai"],
    });

    fixture.pinned.add("key-delete");
    await expect(fixture.execute("providers.delete_key", { keyId: "key-delete" }))
      .resolves.toEqual({
        error: "pinned_agents",
        message: "One or more executable agent versions reference this key. Update them first.",
      });
    expect(fixture.providerKeys.some((key) => key.id === "key-delete")).toBe(true);
    expect(fixture.agentCrud.update).not.toHaveBeenCalled();
  });
});
