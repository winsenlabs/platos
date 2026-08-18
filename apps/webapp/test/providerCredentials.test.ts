import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeProviderKeysPayload } from "../app/services/platosSecretPayloads.server";

const RAW_PROVIDER_SECRET = "sk-provider-SENTINEL-raw";
const CIPHERTEXT = "ciphertext-SENTINEL";

describe("provider credential serialization", () => {
  it("serializes only safe Platos provider metadata from the complete payload", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = {
      keys: sanitizeProviderKeysPayload({
        keys: [
          {
            id: "provider-key-1",
            credentialId: "credential-1",
            provider: "anthropic",
            label: "Production primary",
            environmentKeyName: "ANTHROPIC_API_KEY",
            isDefault: true,
            status: "verifying",
            createdAt: "2026-08-15T10:00:00.000Z",
            updatedAt: "2026-08-15T10:05:00.000Z",
            lastUsedAt: null,
            plaintext: RAW_PROVIDER_SECRET,
            credentialValue: RAW_PROVIDER_SECRET,
            ciphertext: CIPHERTEXT,
            nonce: "nonce-SENTINEL",
            authTag: "tag-SENTINEL",
            salt: "salt-SENTINEL",
          },
        ],
        rawSecret: RAW_PROVIDER_SECRET,
      }),
    };

    const serialized = JSON.stringify(result);
    const serializedLogs = JSON.stringify([...log.mock.calls, ...error.mock.calls]);

    expect(JSON.parse(serialized)).toEqual({
      keys: [
        {
          id: "provider-key-1",
          credentialId: "credential-1",
          provider: "anthropic",
          label: "Production primary",
          referenceName: "ANTHROPIC_API_KEY",
          isDefault: true,
          status: "verifying",
          createdAt: "2026-08-15T10:00:00.000Z",
          updatedAt: "2026-08-15T10:05:00.000Z",
          lastUsedAt: null,
        },
      ],
    });
    for (const forbidden of [
      RAW_PROVIDER_SECRET,
      CIPHERTEXT,
      "nonce-SENTINEL",
      "tag-SENTINEL",
      "salt-SENTINEL",
    ]) {
      expect(serialized).not.toContain(forbidden);
      expect(serializedLogs).not.toContain(forbidden);
    }

    log.mockRestore();
    error.mockRestore();
  });

  it("lists readiness from safe metadata without invoking a decrypt path", () => {
    const routeSource = readFileSync(
      new URL(
        "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx",
        import.meta.url
      ),
      "utf8"
    );
    const storeSource = readFileSync(
      new URL("../app/services/platosCredentialStore.server.ts", import.meta.url),
      "utf8"
    );

    expect(routeSource).not.toContain('agentFetch<unknown>("/api/v1/agent/providers/keys"');
    expect(routeSource).not.toContain('agentMutate("/api/v1/agent/providers/keys"');
    expect(storeSource).toContain("PROVIDER_KEY_SAFE_SELECT");
    expect(storeSource).toContain("secretStore.listSafe(authorization)");
    expect(storeSource).toContain("secretStore.createProviderCredentialAndKey(");
    expect(storeSource).toContain("secretStore.rotateProviderCredentialAndKey(");
    expect(storeSource).not.toContain("readForRuntime(");
  });
});
