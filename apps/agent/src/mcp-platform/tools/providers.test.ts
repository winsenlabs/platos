import { describe, expect, it, vi } from "vitest";
import { ProviderKeyError } from "../../providers/provider-key.service";
import { buildProviderToolHandlers } from "./providers";

const scope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "user-1",
  principal: "operator" as const,
};

function makeHarness() {
  const providerKeys = {
    list: vi.fn(async () => [
      {
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
      },
    ]),
    get: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    rotateReference: vi.fn(),
    existingIds: vi.fn(async () => new Set()),
  };
  const scopedEnv = {
    getProviderApiKey: vi.fn(async () => "sentinel-plaintext-never-serialize"),
    invalidate: vi.fn(),
  };
  const toolAudit = { record: vi.fn(async () => undefined) };
  const handlers = buildProviderToolHandlers({
    agentCrud: {} as any,
    providers: { getOne: vi.fn() } as any,
    providerKeys: providerKeys as any,
    scopedEnv: scopedEnv as any,
    toolAudit: toolAudit as any,
    prisma: {},
  });
  const handler = (name: string) => handlers.find((entry) => entry.name === name)!;
  return { providerKeys, scopedEnv, toolAudit, handler };
}

describe("providers MCP safe credential references", () => {
  it("serializes only safe ProviderKey metadata even when readiness decrypts a sentinel", async () => {
    const { handler } = makeHarness();

    const result = await handler("providers.list_keys").execute({}, scope as any, {} as any);
    const payload = JSON.stringify(result);

    expect(payload).toContain("credential-1");
    expect(payload).not.toContain("sentinel-plaintext-never-serialize");
    expect(payload).not.toMatch(/ciphertext|authTag|nonce|salt/i);
  });

  it("maps provider-mismatched rotation references to a stable safe error", async () => {
    const { providerKeys, toolAudit, handler } = makeHarness();
    providerKeys.rotateReference.mockRejectedValueOnce(
      new ProviderKeyError("credential_unavailable"),
    );

    const result = await handler("providers.rotate_key").execute(
      { keyId: "key-1", envVarName: "WRONG_PROVIDER_KEY" },
      scope as any,
      {} as any,
    );

    expect(result).toEqual({ error: "credential_unavailable", keyId: "key-1" });
    const auditPayload = JSON.stringify(toolAudit.record.mock.calls);
    expect(auditPayload).not.toMatch(/ciphertext|authTag|nonce|salt|sentinel-plaintext/i);
  });

  it("returns rotation reference metadata without material", async () => {
    const { providerKeys, handler } = makeHarness();
    providerKeys.rotateReference.mockResolvedValueOnce({
      previousEnvVarName: "ANTHROPIC_API_KEY",
      key: {
        id: "key-1",
        environmentId: "env-1",
        credentialId: "credential-2",
        provider: "anthropic",
        label: "Primary",
        envVarName: "ANTHROPIC_API_KEY_V2",
        isDefault: true,
        createdBy: "user-1",
        lastUsedAt: null,
        createdAt: new Date("2026-08-15T00:00:00.000Z"),
        updatedAt: new Date("2026-08-15T00:01:00.000Z"),
      },
    });

    const result = await handler("providers.rotate_key").execute(
      { keyId: "key-1", envVarName: "ANTHROPIC_API_KEY_V2" },
      scope as any,
      {} as any,
    );

    expect(result).toMatchObject({
      rotated: true,
      previousEnvVarName: "ANTHROPIC_API_KEY",
      envVarName: "ANTHROPIC_API_KEY_V2",
    });
    expect(result).not.toHaveProperty("credentialId");
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|authTag|nonce|salt|plaintext/i);
  });
});
