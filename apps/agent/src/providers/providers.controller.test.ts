import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ProvidersController } from "./providers.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
  userId: "user-a",
  principal: "operator" as const,
};

function request() {
  return { scope } as any;
}

describe("ProvidersController clean ProviderKey contract", () => {
  it("creates a reference-only key and clears the prior default in one transaction", async () => {
    const created = {
      id: "key-new",
      provider: "openai",
      label: "primary",
      environmentKeyName: "OPENAI_API_KEY",
      isDefault: true,
      createdBy: scope.userId,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUsedAt: null,
    };
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ pg_advisory_xact_lock: null }]),
      providerKey: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue(created),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const scopedEnv = {
      findCredentialMetadata: vi.fn().mockResolvedValue({
        id: "credential-a",
        name: "OPENAI_API_KEY",
        provider: "openai",
      }),
    };
    const catalog = { invalidate: vi.fn() };
    const controller = new ProvidersController(
      prisma as any,
      {} as any,
      scopedEnv as any,
      catalog as any,
    );

    const result = await controller.createKey(request(), {
      provider: "openai",
      label: "primary",
      envVarName: "OPENAI_API_KEY",
      isDefault: true,
    });

    expect(tx.providerKey.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        environmentId: scope.environmentId,
        environmentKeyName: "OPENAI_API_KEY",
        encryptedReference: "credential://credential-a",
      }),
    }));
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked",
      `${scope.environmentId}:openai`,
    );
    expect(JSON.stringify(result)).not.toContain("encryptedReference");
    expect(result.key).toMatchObject({ envVarName: "OPENAI_API_KEY", isDefault: true });
  });

  it("returns the same scoped 404 for a foreign ProviderKey id", async () => {
    const tx = {
      providerKey: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const controller = new ProvidersController(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
    );

    let error: unknown;
    try {
      await controller.updateKey(request(), "foreign-key", { label: "probe" });
    } catch (value) {
      error = value;
    }

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
    expect((error as HttpException).message).toBe("Key not found");
    expect(tx.providerKey.findFirst).toHaveBeenCalledWith({
      where: {
        id: "foreign-key",
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
      },
      select: { id: true, provider: true },
    });
  });

  it("serializes a default rotation before clearing and selecting the replacement", async () => {
    const updated = {
      id: "key-b",
      provider: "openai",
      label: "replacement",
      environmentKeyName: "OPENAI_API_KEY_B",
      isDefault: true,
    };
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([{ locked: "" }]),
      providerKey: {
        findFirst: vi.fn().mockResolvedValue({ id: updated.id, provider: updated.provider }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue(updated),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const controller = new ProvidersController(
      prisma as any,
      {} as any,
      {} as any,
      { invalidate: vi.fn() } as any,
    );

    await expect(controller.updateKey(request(), updated.id, { isDefault: true }))
      .resolves.toMatchObject({ key: { id: updated.id, isDefault: true } });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))::text AS locked",
      `${scope.environmentId}:openai`,
    );
    expect(tx.providerKey.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        environmentId: scope.environmentId,
        provider: "openai",
        isDefault: true,
        id: { not: updated.id },
      }),
    }));
    expect(tx.$queryRawUnsafe.mock.invocationCallOrder[0])
      .toBeLessThan(tx.providerKey.updateMany.mock.invocationCallOrder[0]);
  });

  it("returns 409 without deleting when any canonically bound version references the key", async () => {
    const tx = {
      $queryRawUnsafe: vi.fn()
        .mockResolvedValueOnce([{ pg_advisory_xact_lock: null }])
        .mockResolvedValueOnce([{ id: "historical-locked-version" }]),
      providerKey: {
        findFirst: vi.fn().mockResolvedValue({ id: "key-a", provider: "openai" }),
        delete: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const controller = new ProvidersController(
      prisma as any,
      {} as any,
      {} as any,
      { invalidate: vi.fn() } as any,
    );

    await expect(controller.deleteKey(request(), "key-a")).rejects.toMatchObject({
      status: 409,
      message: "Cannot delete a provider key referenced by an executable agent version",
    });
    expect(tx.providerKey.delete).not.toHaveBeenCalled();
    const referenceSql = tx.$queryRawUnsafe.mock.calls[1]?.[0] as string;
    expect(referenceSql).toContain('JOIN "AgentBinding"');
    expect(referenceSql).toContain("'{__runtime,providerKeyId}'");
    expect(referenceSql).toContain("providerCredentialId");
    expect(referenceSql).toContain("providerKeyId");
    expect(referenceSql).not.toContain("encryptedReference");
  });

  it("maps database reference races to the same 409", async () => {
    const tx = {
      $queryRawUnsafe: vi.fn()
        .mockResolvedValueOnce([{ pg_advisory_xact_lock: null }])
        .mockResolvedValueOnce([]),
      providerKey: {
        findFirst: vi.fn().mockResolvedValue({ id: "key-a", provider: "openai" }),
        delete: vi.fn().mockRejectedValue({ code: "P2003" }),
      },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    };
    const controller = new ProvidersController(
      prisma as any,
      {} as any,
      {} as any,
      { invalidate: vi.fn() } as any,
    );

    await expect(controller.deleteKey(request(), "key-a")).rejects.toMatchObject({ status: 409 });
  });

  it("maps a concurrent unique conflict to 409 without invalidating the catalog", async () => {
    const prisma = {
      $transaction: vi.fn().mockRejectedValue({ code: "P2002" }),
    };
    const catalog = { invalidate: vi.fn() };
    const controller = new ProvidersController(
      prisma as any,
      {} as any,
      { findCredentialMetadata: vi.fn().mockResolvedValue({
        id: "credential-a",
        name: "OPENAI_API_KEY",
        provider: "openai",
      }) } as any,
      catalog as any,
    );

    await expect(controller.createKey(request(), {
      provider: "openai",
      label: "primary",
      envVarName: "OPENAI_API_KEY",
      isDefault: true,
    })).rejects.toMatchObject({ status: 409, message: "Provider key already exists" });
    expect(catalog.invalidate).not.toHaveBeenCalled();
  });
});
