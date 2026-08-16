import { describe, expect, it, vi } from "vitest";
import { PlatosSecretStoreError } from "@platos/tenancy-database";
import { ProviderKeyError, ProviderKeyService } from "./provider-key.service";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "user-1",
  principal: "operator" as const,
};

const now = new Date("2026-08-15T00:00:00.000Z");

function safeKey(overrides: Record<string, unknown> = {}) {
  return {
    id: "key-1",
    environmentId: "env-1",
    credentialId: "credential-1",
    provider: "anthropic",
    label: "Primary",
    environmentKeyName: "ANTHROPIC_API_KEY",
    isDefault: true,
    createdBy: "user-1",
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function safeCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: "credential-2",
    environmentId: "env-1",
    kind: "SERVICE_CREDENTIAL",
    name: "ANTHROPIC_API_KEY_V2",
    provider: "anthropic",
    permissions: [],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: "user-1",
    createdAt: now,
    updatedAt: now,
    activeSecretVersion: {
      id: "version-2",
      secretRevision: 2,
      formatVersion: 1,
      rootKeyVersion: 1,
      retiredAt: null,
      readableUntil: null,
      createdAt: now,
    },
    ...overrides,
  };
}

function makeHarness(options?: { credential?: any; updatedKey?: any; auditError?: Error }) {
  const tx = {
    credential: {
      findFirst: vi.fn(async () =>
        options?.credential === undefined
          ? safeCredential()
          : options.credential
      ),
    },
    providerKey: {
      findFirst: vi.fn(async () => safeKey()),
      findMany: vi.fn(async () => [safeKey()]),
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => safeKey()),
      update: vi.fn(async () => options?.updatedKey ?? safeKey()),
      delete: vi.fn(async () => safeKey()),
    },
    credentialAudit: {
      create: vi.fn(async () => {
        if (options?.auditError) throw options.auditError;
        return { id: "audit-1" };
      }),
    },
  };
  const prisma = {
    environment: {
      findUnique: vi.fn(async () => ({
        id: "env-1",
        archivedAt: null,
        project: {
          id: "project-1",
          archivedAt: null,
          organizationId: "org-1",
          organization: { archivedAt: null },
        },
      })),
    },
    organizationMembership: {
      findUnique: vi.fn(async () => ({ id: "membership-1", role: "ADMIN", deactivatedAt: null })),
    },
    projectMembership: { findUnique: vi.fn(async () => null) },
    providerKey: tx.providerKey,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const secretStore = {
    linkProviderKey: vi.fn(async () => {
      if (options?.credential === null) {
        throw new PlatosSecretStoreError("credential_unavailable");
      }
      return safeKey();
    }),
    relinkProviderKey: vi.fn(async () => {
      if (options?.credential === null) {
        throw new PlatosSecretStoreError("credential_unavailable");
      }
      return {
        key:
          options?.updatedKey ??
          safeKey({
            credentialId: "credential-2",
            environmentKeyName: "ANTHROPIC_API_KEY_V2",
          }),
        previousEnvVarName: "ANTHROPIC_API_KEY",
      };
    }),
  };
  return {
    service: new ProviderKeyService(prisma as any, secretStore as any),
    prisma,
    tx,
    secretStore,
  };
}

describe("ProviderKeyService clean-schema linking", () => {
  it("rejects a missing or provider-mismatched Credential before creating a key", async () => {
    const { service, tx, secretStore } = makeHarness({ credential: null });

    await expect(
      service.create(scope, {
        provider: "anthropic",
        label: "Primary",
        envVarName: "OPENAI_API_KEY",
        isDefault: true,
      })
    ).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(secretStore.linkProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        envVarName: "OPENAI_API_KEY",
      })
    );
    expect(tx.providerKey.updateMany).not.toHaveBeenCalled();
    expect(tx.providerKey.create).not.toHaveBeenCalled();
  });

  it("clears the old default and creates the new link in one transaction", async () => {
    const { service, prisma, tx, secretStore } = makeHarness();

    const result = await service.create(scope, {
      provider: "anthropic",
      label: "Primary",
      envVarName: "ANTHROPIC_API_KEY",
      isDefault: true,
    });

    expect(secretStore.linkProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        label: "Primary",
        envVarName: "ANTHROPIC_API_KEY",
        isDefault: true,
      })
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.providerKey.updateMany).not.toHaveBeenCalled();
    expect(tx.providerKey.create).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|authTag|nonce|salt|secret/i);
  });

  it("atomically relinks rotation metadata without exposing Credential envelope fields", async () => {
    const { service, prisma, tx, secretStore } = makeHarness({
      credential: safeCredential(),
      updatedKey: safeKey({
        credentialId: "credential-2",
        environmentKeyName: "ANTHROPIC_API_KEY_V2",
        updatedAt: new Date("2026-08-15T00:01:00.000Z"),
      }),
    });

    const result = await service.rotateReference(scope, "key-1", {
      envVarName: "ANTHROPIC_API_KEY_V2",
    });

    expect(secretStore.relinkProviderKey).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.providerKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          credentialId: "credential-2",
          environmentKeyName: "ANTHROPIC_API_KEY_V2",
        }),
      })
    );
    expect(tx.credentialAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        environmentId: "env-1",
        credentialId: "credential-2",
        action: "PROVIDER_KEY_RELINK",
        actorType: "operator",
        actorId: "user-1",
        effectiveUserId: "user-1",
        secretRevision: 2,
      }),
    });
    expect(result.previousEnvVarName).toBe("ANTHROPIC_API_KEY");
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|authTag|nonce|salt|secret/i);
  });

  it("fails closed when the same-transaction immutable relink audit fails", async () => {
    const { service, prisma, tx } = makeHarness({
      credential: safeCredential(),
      auditError: new Error("audit unavailable"),
    });

    await expect(
      service.rotateReference(scope, "key-1", { envVarName: "ANTHROPIC_API_KEY_V2" })
    ).rejects.toThrow("audit unavailable");
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.providerKey.update).toHaveBeenCalledTimes(1);
    expect(tx.credentialAudit.create).toHaveBeenCalledTimes(1);
  });

  it("uses one stable not-found code for a forged cross-scope key id", async () => {
    const { service, prisma } = makeHarness();
    prisma.providerKey.findFirst.mockResolvedValueOnce(null as any);

    await expect(service.get(scope, "cross-scope-key")).rejects.toEqual(
      expect.objectContaining<Partial<ProviderKeyError>>({ code: "not_found" })
    );
  });
});
