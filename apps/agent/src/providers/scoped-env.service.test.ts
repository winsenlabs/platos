import { describe, expect, it, vi } from "vitest";
import { SecretMaterial } from "@platos/tenancy-database";
import { ProviderRuntimeError } from "./provider-runtime.error";
import { ScopedEnvService, type ScopeTuple } from "./scoped-env.service";

const scope: ScopeTuple = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
};

function makeHarness(options?: {
  ancestry?: { organizationId: string; projectId: string };
  providerKey?: null | { id: string; credentialId: string; provider: string };
  reads?: Array<string | Error>;
  providerKeyLookupError?: Error;
  lastUseError?: Error;
}) {
  const reads = [...(options?.reads ?? ["stored-secret"])];
  const readForRuntime = vi.fn(async () => {
    const next = reads.shift() ?? "stored-secret";
    if (next instanceof Error) throw next;
    return new SecretMaterial(next);
  });
  const prisma = {
    environment: {
      findUnique: vi.fn(async () => ({
        id: scope.environmentId,
        archivedAt: null,
        project: {
          id: options?.ancestry?.projectId ?? scope.projectId,
          archivedAt: null,
          organizationId: options?.ancestry?.organizationId ?? scope.organizationId,
          organization: { archivedAt: null },
        },
      })),
    },
    environmentVariable: {
      findFirst: vi.fn(async (): Promise<any> => ({
        kind: "SECRET",
        value: null,
        credentialId: "credential-environment-variable",
      })),
    },
    providerKey: {
      findFirst: vi.fn(async (query: any) => {
        if (options?.providerKeyLookupError) throw options.providerKeyLookupError;
        const key = options?.providerKey;
        if (!key || query.where.provider !== key.provider) return null;
        return {
          ...key,
          environmentId: scope.environmentId,
          label: "Primary",
          environmentKeyName: "ANTHROPIC_API_KEY",
          isDefault: true,
          createdBy: "user-1",
          lastUsedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
      update: vi.fn(async () => {
        if (options?.lastUseError) throw options.lastUseError;
        return {};
      }),
    },
    credential: {
      findFirst: vi.fn(async (query: any) => {
        if (options?.providerKeyLookupError) throw options.providerKeyLookupError;
        const key = options?.providerKey;
        if (!key) return null;
        return { id: key.credentialId, provider: key.provider };
      }),
      findMany: vi.fn(async (query: any) =>
        (query.where.name.in as string[]).map((name) => ({ name })),
      ),
    },
  };
  const service = new ScopedEnvService(prisma as any, { readForRuntime } as any);
  return { service, prisma, readForRuntime };
}

describe("ScopedEnvService Platos credential resolution", () => {
  it("never falls back to a populated deployment env var", async () => {
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "deployment-secret-must-not-be-used";
    const { service, readForRuntime } = makeHarness({ reads: [new Error("missing")] });

    await expect(
      service.getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY"),
    ).resolves.toBeUndefined();
    expect(readForRuntime).not.toHaveBeenCalled();

    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });

  it("keeps missing default configuration distinguishable from credential failure", async () => {
    const { service, readForRuntime } = makeHarness({ providerKey: null });

    await expect(
      service.getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY"),
    ).resolves.toBeUndefined();
    expect(readForRuntime).not.toHaveBeenCalled();
  });

  it("rejects forged organization/project ancestry before decrypting", async () => {
    const { service, readForRuntime } = makeHarness({
      ancestry: { organizationId: "org-2", projectId: "project-2" },
    });

    await expect(service.get(scope, "ANTHROPIC_API_KEY")).resolves.toBeUndefined();
    expect(readForRuntime).not.toHaveBeenCalled();
  });

  it("fails active provider resolution loudly when scope authorization fails", async () => {
    const { service, readForRuntime } = makeHarness({
      ancestry: { organizationId: "org-2", projectId: "project-2" },
      providerKey: { id: "key-1", credentialId: "credential-1", provider: "anthropic" },
    });

    await expect(
      service.getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY"),
    ).rejects.toMatchObject({ code: "provider_configuration_unavailable" });
    expect(readForRuntime).not.toHaveBeenCalled();
  });

  it("fails a wrong-provider pinned key without falling through by bare name", async () => {
    const { service, readForRuntime, prisma } = makeHarness({
      providerKey: { id: "key-1", credentialId: "credential-1", provider: "openai" },
    });

    await expect(
      service.getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY", "key-1"),
    ).rejects.toMatchObject({
      name: "ProviderRuntimeError",
      code: "provider_configuration_unavailable",
      message: "Provider configuration is unavailable for this environment.",
    });
    expect(prisma.providerKey.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: "anthropic", environmentId: "env-1" }),
      }),
    );
    expect(readForRuntime).not.toHaveBeenCalled();
  });

  it("escapes configured-key decrypt failures as a stable safe runtime error", async () => {
    const cryptoDetail = "Unsupported state or unable to authenticate data: sentinel-ciphertext";
    const { service } = makeHarness({
      providerKey: { id: "key-1", credentialId: "credential-1", provider: "anthropic" },
      reads: [new Error(cryptoDetail)],
    });

    const error = await service
      .getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY")
      .catch((value) => value as ProviderRuntimeError);

    expect(error).toBeInstanceOf(ProviderRuntimeError);
    expect(error).toMatchObject({
      code: "provider_credential_unavailable",
      message: "Provider credential is unavailable for this environment.",
    });
    expect(JSON.stringify(error)).not.toContain(cryptoDetail);
    expect(JSON.stringify(error)).not.toContain("sentinel-ciphertext");
  });

  it("fails loudly when configured-key last-use handling cannot complete", async () => {
    const { service } = makeHarness({
      providerKey: { id: "key-1", credentialId: "credential-1", provider: "anthropic" },
      lastUseError: new Error("prisma connection detail"),
    });

    await expect(
      service.getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY"),
    ).rejects.toMatchObject({ code: "provider_credential_unavailable" });
  });

  it("redacts configured-key lookup failures behind a configuration code", async () => {
    const { service } = makeHarness({
      providerKeyLookupError: new Error("prisma host and query detail"),
    });

    const error = await service
      .getProviderApiKey(scope, "anthropic", "ANTHROPIC_API_KEY")
      .catch((value) => value as ProviderRuntimeError);
    expect(error).toMatchObject({ code: "provider_configuration_unavailable" });
    expect(JSON.stringify(error)).not.toContain("prisma");
  });

  it("does not cache plaintext and observes a rotated active revision", async () => {
    const { service, readForRuntime } = makeHarness({ reads: ["old-value", "new-value"] });

    await expect(service.get(scope, "OPENAI_API_KEY")).resolves.toBe("old-value");
    await expect(service.get(scope, "OPENAI_API_KEY")).resolves.toBe("new-value");
    expect(readForRuntime).toHaveBeenCalledTimes(2);
  });

  it("returns a canonical plain Environment variable without decrypting", async () => {
    const { service, readForRuntime, prisma } = makeHarness();
    prisma.environmentVariable.findFirst.mockResolvedValueOnce({
      kind: "PLAIN",
      value: "https://api.example.test",
      credentialId: null,
    });

    await expect(service.get(scope, "API_ORIGIN")).resolves.toBe("https://api.example.test");
    expect(readForRuntime).not.toHaveBeenCalled();
  });

  it("does not fall back when configured provider runtime configuration cannot decrypt", async () => {
    const { service } = makeHarness({
      providerKey: { id: "key-1", credentialId: "credential-1", provider: "openai" },
      reads: [new Error("AES-GCM sentinel detail")],
    });

    await expect(
      service.getProviderConfiguration(scope, "OPENAI_BASE_URL", "openai"),
    ).rejects.toMatchObject({ code: "provider_configuration_unavailable" });
  });

  it("uses metadata-only same-provider readiness without decrypting", async () => {
    const { service, readForRuntime, prisma } = makeHarness();

    await expect(
      service.setMapForProvider(scope, ["ANTHROPIC_API_KEY"], "anthropic"),
    ).resolves.toEqual({ ANTHROPIC_API_KEY: true });
    expect(prisma.credential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "anthropic",
          name: { in: ["ANTHROPIC_API_KEY"] },
        }),
      }),
    );
    expect(readForRuntime).not.toHaveBeenCalled();
  });
});
