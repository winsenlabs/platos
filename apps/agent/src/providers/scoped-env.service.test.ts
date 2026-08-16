import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecretsService } from "../auth/secrets.service";
import { ProviderRuntimeError } from "./provider-runtime.error";
import { ScopedEnvService, credentialReference } from "./scoped-env.service";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
};

function makeHarness() {
  const secrets = new SecretsService();
  const credential = {
    id: "credential-a",
    environmentId: scope.environmentId,
    name: "OPENAI_API_KEY",
    provider: "openai",
    encryptedReference: secrets.encrypt("tenant-provider-key"),
  };
  const providerKey = {
    id: "provider-key-a",
    environmentId: scope.environmentId,
    provider: "openai",
    environmentKeyName: credential.name,
    encryptedReference: credentialReference(credential.id),
    isDefault: true,
  };
  const prisma: any = {
    credential: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.environmentId !== scope.environmentId) return null;
        if (where.id && where.id !== credential.id) return null;
        if (where.name && where.name !== credential.name) return null;
        if (where.provider && where.provider !== credential.provider) return null;
        return credential;
      }),
      update: vi.fn(async () => credential),
    },
    providerKey: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.environmentId !== scope.environmentId) return null;
        if (where.provider !== providerKey.provider) return null;
        if (where.id && where.id !== providerKey.id) return null;
        return providerKey;
      }),
      update: vi.fn(async () => providerKey),
    },
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };
  return { service: new ScopedEnvService(prisma, secrets), prisma, credential, providerKey };
}

describe("ScopedEnvService clean credential runtime", () => {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("resolves an explicitly referenced same-Environment Credential without legacy delegates", async () => {
    const { service, prisma } = makeHarness();

    await expect(
      service.getProviderApiKey(scope, "openai", "OPENAI_API_KEY", "provider-key-a"),
    ).resolves.toBe("tenant-provider-key");

    expect(prisma.providerKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "provider-key-a",
        environmentId: scope.environmentId,
        provider: "openai",
      }),
    }));
    expect(prisma.credential.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "credential-a",
        name: "OPENAI_API_KEY",
        environmentId: scope.environmentId,
        provider: "openai",
      }),
    }));
    expect(prisma).not.toHaveProperty("platosProviderKey");
    expect(prisma).not.toHaveProperty("secretStore");
  });

  it("does not fall through from a foreign pinned key to the default or process.env", async () => {
    process.env.OPENAI_API_KEY = "ambient-secret-must-not-be-used";
    const { service, prisma } = makeHarness();

    await expect(
      service.getProviderApiKey(scope, "openai", "OPENAI_API_KEY", "foreign-key"),
    ).rejects.toMatchObject({
      code: "provider_configuration_unavailable",
      message: "Provider configuration is unavailable for this environment.",
    });
    expect(prisma.providerKey.findFirst).toHaveBeenCalledTimes(1);
  });

  it("maps decryption failure to a stable error without ciphertext detail", async () => {
    const { service, prisma, credential } = makeHarness();
    credential.encryptedReference = "not-a-valid-envelope";

    let error: unknown;
    try {
      await service.getProviderApiKey(scope, "openai", "OPENAI_API_KEY");
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(ProviderRuntimeError);
    expect((error as ProviderRuntimeError).code).toBe("provider_credential_unavailable");
    expect((error as ProviderRuntimeError).message).toBe("Provider credential is unavailable for this environment.");
    expect(JSON.stringify(error)).not.toContain("not-a-valid-envelope");
    expect(prisma.providerKey.update).not.toHaveBeenCalled();
    expect(prisma.providerKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }));
  });
});
