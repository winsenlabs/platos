import { describe, expect, it, vi } from "vitest";
import { ProviderRegistryService } from "./provider-registry.service";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
};

describe("ProviderRegistryService clean provider state", () => {
  it("reads EnvironmentProvider and explicit ProviderKey readiness without legacy delegates", async () => {
    const prisma: any = {
      environmentProvider: {
        findFirst: vi.fn().mockResolvedValue({
          enabled: true,
          linkedAt: new Date("2026-08-15T00:00:00.000Z"),
        }),
      },
    };
    const scopedEnv = {
      hasProviderCredential: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue(undefined),
    };
    const catalog = { listFor: vi.fn().mockResolvedValue([]) };
    const service = new ProviderRegistryService(prisma, scopedEnv as any, catalog as any);

    const result = await service.getOne(scope, "openai");

    expect(result).toMatchObject({
      id: "openai",
      linked: true,
      enabled: true,
      envReady: true,
      requiredEnv: [{ name: "OPENAI_API_KEY", set: true }],
    });
    expect(prisma.environmentProvider.findFirst).toHaveBeenCalledWith({
      where: {
        environmentId: scope.environmentId,
        environment: {
          projectId: scope.projectId,
          project: { organizationId: scope.organizationId },
        },
        providerId: "openai",
      },
      select: { enabled: true, linkedAt: true },
    });
    expect(prisma).not.toHaveProperty("platosProviderEnabled");
    expect(prisma).not.toHaveProperty("platosProviderKey");
  });

  it("links only after persisted Environment ancestry is verified", async () => {
    const tx = {
      environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
      environmentProvider: { upsert: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<void>) => callback(tx)),
      environmentProvider: {
        findFirst: vi.fn().mockResolvedValue({ enabled: true, linkedAt: new Date() }),
      },
    };
    const service = new ProviderRegistryService(
      prisma as any,
      { hasProviderCredential: vi.fn().mockResolvedValue(false), get: vi.fn() } as any,
      { listFor: vi.fn() } as any,
    );

    await service.link(scope, "openai");

    expect(tx.environment.findFirst).toHaveBeenCalledWith({
      where: {
        id: scope.environmentId,
        project: { id: scope.projectId, organizationId: scope.organizationId },
      },
      select: { id: true },
    });
    expect(tx.environmentProvider.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        environmentId_providerId: {
          environmentId: scope.environmentId,
          providerId: "openai",
        },
      },
    }));
  });
});
