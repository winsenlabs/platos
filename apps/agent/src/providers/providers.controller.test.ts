import { describe, expect, it, vi } from "vitest";
import { ProvidersController } from "./providers.controller";

const request = {
  scope: {
    organizationId: "org-1",
    projectId: "project-1",
    environmentId: "env-1",
    userId: "user-1",
    principal: "operator",
  },
} as any;

function makeController() {
  const key = {
    id: "key-1",
    environmentId: "env-1",
    credentialId: "credential-1",
    provider: "anthropic",
    label: "Primary",
    envVarName: "ANTHROPIC_API_KEY",
    isDefault: true,
    createdBy: "user-1",
    lastUsedAt: null,
    createdAt: new Date("2026-08-15T00:00:00.000Z"),
    updatedAt: new Date("2026-08-15T00:00:00.000Z"),
  };
  const providerKeys = {
    canonicalScope: vi.fn(async () => ({
      organizationId: "org-1",
      projectId: "project-1",
      environmentId: "env-1",
    })),
    listPage: vi.fn(async () => ({ items: [key], total: 1 })),
    createWithSecret: vi.fn(async () => key),
    rotateSecret: vi.fn(async () => key),
  };
  const modelCatalog = { invalidate: vi.fn() };
  const registry = { list: vi.fn(async () => [{ id: "anthropic", probeModel: "claude-haiku-4-5-20251001", models: ["claude-sonnet-4-6"] }]) };
  const controller = new ProvidersController(
    registry as any,
    modelCatalog as any,
    providerKeys as any,
  );
  return { controller, providerKeys, modelCatalog, registry };
}

describe("ProvidersController safe payloads", () => {
  it("owns provider listing and exposes the manifest probe model as safe metadata", async () => {
    const { controller, registry } = makeController();

    const result = await controller.listProviders(request);

    expect(result.providers).toEqual([
      expect.objectContaining({ id: "anthropic", probeModel: "claude-haiku-4-5-20251001" }),
    ]);
    expect(registry.list).toHaveBeenCalledWith(expect.objectContaining({ environmentId: "env-1" }));
  });

  it("lists safe ProviderKey metadata without decrypting or probing credentials", async () => {
    const { controller, providerKeys } = makeController();

    const result = await controller.listKeys(request);
    const payload = JSON.stringify(result);

    expect(payload).toContain("credential-1");
    expect(payload).not.toMatch(/ciphertext|authTag|nonce|salt/i);
    expect(providerKeys.listPage).toHaveBeenCalledWith(
      request.scope,
      expect.objectContaining({ limit: 25, offset: 0 }),
    );
  });

  it("rejects end-user access before listing ProviderKey metadata", async () => {
    const { controller, providerKeys } = makeController();
    const endUserRequest = {
      scope: { ...request.scope, principal: "end-user" },
    } as any;

    await expect(controller.listKeys(endUserRequest)).rejects.toMatchObject({ status: 403 });
    expect(providerKeys.listPage).not.toHaveBeenCalled();
  });

  it("accepts fresh BYOK material but returns ProviderKey metadata only", async () => {
    const { controller, providerKeys } = makeController();
    const sentinel = "SENTINEL_FRESH_PROVIDER_SECRET";

    const result = await controller.createKeyWithSecret(request, {
      provider: "anthropic",
      label: "Primary",
      envVarName: "ANTHROPIC_API_KEY",
      plaintext: sentinel,
      isDefault: true,
    });

    expect(providerKeys.createWithSecret).toHaveBeenCalledWith(request.scope, {
      provider: "anthropic",
      label: "Primary",
      envVarName: "ANTHROPIC_API_KEY",
      plaintext: sentinel,
      isDefault: true,
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result).toMatchObject({ key: { id: "key-1", credentialId: "credential-1" } });
  });

  it("rotates BYOK material without echoing it in the normal response", async () => {
    const { controller, providerKeys } = makeController();
    const sentinel = "SENTINEL_ROTATED_PROVIDER_SECRET";

    const result = await controller.rotateKeySecret(request, "key-1", { plaintext: sentinel });

    expect(providerKeys.rotateSecret).toHaveBeenCalledWith(request.scope, "key-1", sentinel);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(result).toMatchObject({ key: { id: "key-1", envVarName: "ANTHROPIC_API_KEY" } });
  });
});
