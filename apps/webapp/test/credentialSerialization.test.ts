import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: {
    PLATOS_AGENT_API_URL: "http://agent.invalid",
    PLATOS_INTERNAL_AUTH_TOKEN: "dashboard-control-plane-token",
  },
}));
vi.mock("~/services/auth.server", () => ({
  requireEnvironmentScope: vi.fn(async () => ({
    scope: {
      organizationId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      environmentId: "33333333-3333-4333-8333-333333333333",
      userId: "44444444-4444-4444-8444-444444444444",
    },
  })),
}));

import { action as accessKeyAction, loader as accessKeyLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route";
import { action as providerAction, loader as providerLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route";
import { assertCredentialSafePayload, credentialRequest } from "../app/services/platosAgent.server";

const params = { organizationSlug: "acme", projectParam: "support", envParam: "production" };
const sentinel = "SENTINEL_PROVIDER_OR_ACCESS_KEY_MATERIAL";
const attemptId = "11111111-1111-4111-8111-111111111111";
const environmentId = "33333333-3333-4333-8333-333333333333";

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function serialized(result: Response) {
  return JSON.stringify(await result.json());
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credential route serialization boundaries", () => {
  it("fails closed when an AccessKey loader payload contains a hash field", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ id: "key-1", keyPrefix: "platos_live_abc", keyHash: sentinel }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await accessKeyLoader({ request: new Request("http://dashboard/apikeys"), params, context: {} });
    const body = await serialized(result);
    expect(body).toContain("UNSAFE_CREDENTIAL_RESPONSE");
    expect(body).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-Platos-Internal-Auth": "dashboard-control-plane-token",
    });
  });

  it("submits only hash metadata and refuses to serialize a malicious rotation response", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ attemptId, key: { id: "key-2", keyHash: sentinel }, retiringKey: null }));
    const form = new URLSearchParams({
      intent: "rotate",
      attemptId,
      keyHash: "a".repeat(64),
      keyPrefix: "platos_live_abcdefghijkl",
    });
    const result = await accessKeyAction({
      request: new Request("http://dashboard/apikeys", { method: "POST", body: form }),
      params,
      context: {},
    });
    const body = await serialized(result);
    const request = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      attemptId,
      keyHash: "a".repeat(64),
      keyPrefix: "platos_live_abcdefghijkl",
    });
    expect(body).toContain("UNSAFE_CREDENTIAL_RESPONSE");
    expect(body).not.toContain(sentinel);
  });

  it("returns success only when the persisted response echoes the submitted attempt ID", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      attemptId,
      key: {
        id: "key-2",
        environmentId,
        keyPrefix: "platos_live_abcdefghijkl",
        allowedOrigins: [],
        lastUsedAt: null,
        validUntil: null,
        replacedById: null,
        revokedAt: null,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      retiringKey: null,
    }));
    const form = new URLSearchParams({
      intent: "rotate",
      attemptId,
      keyHash: "a".repeat(64),
      keyPrefix: "platos_live_abcdefghijkl",
    });

    const result = await accessKeyAction({
      request: new Request("http://dashboard/apikeys", { method: "POST", body: form }),
      params,
      context: {},
    });

    expect(await result.json()).toMatchObject({
      ok: true,
      attemptId,
      result: { attemptId, key: { id: "key-2" } },
    });
  });

  it.each([
    ["attempt only", { attemptId }],
    ["null persisted key", { attemptId, key: null, retiringKey: null }],
    ["missing persisted ID", { attemptId, key: { environmentId, keyPrefix: "platos_live_abcdefghijkl" }, retiringKey: null }],
    ["mismatched submitted prefix", { attemptId, key: { id: "key-2", environmentId, keyPrefix: "platos_live_wrong" }, retiringKey: null }],
    ["mismatched Environment", { attemptId, key: { id: "key-2", environmentId: "other-env", keyPrefix: "platos_live_abcdefghijkl" }, retiringKey: null }],
  ])("rejects correlated success with %s", async (_name, payload) => {
    vi.mocked(fetch).mockResolvedValue(response(payload));
    const form = new URLSearchParams({
      intent: "rotate",
      attemptId,
      keyHash: "a".repeat(64),
      keyPrefix: "platos_live_abcdefghijkl",
    });

    const result = await accessKeyAction({
      request: new Request("http://dashboard/apikeys", { method: "POST", body: form }),
      params,
      context: {},
    });

    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      ok: false,
      attemptId,
      error: "Access key response did not match request",
    });
  });

  it("fails closed and returns the submitted correlation when the persisted response mismatches", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      attemptId: "22222222-2222-4222-8222-222222222222",
      key: null,
      retiringKey: null,
    }));
    const form = new URLSearchParams({
      intent: "rotate",
      attemptId,
      keyHash: "a".repeat(64),
      keyPrefix: "platos_live_abcdefghijkl",
    });

    const result = await accessKeyAction({
      request: new Request("http://dashboard/apikeys", { method: "POST", body: form }),
      params,
      context: {},
    });

    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      ok: false,
      attemptId,
      error: "Access key response did not match request",
    });
  });

  it("fails closed across complete provider loader payloads with encrypted material", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ keys: [{ id: "provider-key", ciphertext: sentinel, nonce: sentinel }] }));
    const result = await providerLoader({ request: new Request("http://dashboard/providers"), params, context: {} });
    const body = await serialized(result);
    expect(body).toContain("UNSAFE_CREDENTIAL_RESPONSE");
    expect(body).not.toContain(sentinel);
  });

  it("accepts ProviderKey references only and refuses to serialize a malicious action payload", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ id: "provider-key", credentialValue: sentinel }));
    const form = new URLSearchParams({
      intent: "create-key",
      provider: "anthropic",
      label: "Primary",
      envVarName: "ANTHROPIC_API_KEY",
      isDefault: "on",
    });
    const result = await providerAction({
      request: new Request("http://dashboard/providers", { method: "POST", body: form }),
      params,
      context: {},
    });
    const body = await serialized(result);
    const request = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      provider: "anthropic",
      label: "Primary",
      envVarName: "ANTHROPIC_API_KEY",
      isDefault: true,
    });
    expect(body).toContain("UNSAFE_CREDENTIAL_RESPONSE");
    expect(body).not.toContain(sentinel);
  });

  it("fails closed across the whole loader body for nested plaintext and generic value fields", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/agent/providers")) {
        return response({
          providers: [{
            id: "anthropic",
            displayName: "Anthropic",
            description: "Provider",
            requiredEnv: [{ name: "ANTHROPIC_API_KEY", set: true }],
            optionalEnv: [],
            envReady: true,
            enabled: true,
            linked: true,
            linkedAt: null,
            models: [],
            diagnostics: { plaintext: sentinel },
          }],
        });
      }
      if (url.endsWith("/api/v1/agent/providers/keys")) {
        return response({ keys: [{ id: "provider-key", value: sentinel }] });
      }
      return response([]);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await providerLoader({ request: new Request("http://dashboard/providers"), params, context: {} });
    const body = await serialized(result);

    expect(body.match(/UNSAFE_CREDENTIAL_RESPONSE/g)).toHaveLength(2);
    expect(body).not.toContain(sentinel);
    expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
  });

  it.each(["plaintext", "PlainText", "plain_text", "value", "VALUE", "raw", "raw_data", "rawPayload", "credentialValue", "Credential_Value"])(
    "rejects forbidden credential field variant %s",
    (field) => {
      expect(() => assertCredentialSafePayload({ nested: { [field]: sentinel } })).toThrowError(
        expect.objectContaining({ code: "UNSAFE_CREDENTIAL_RESPONSE" }),
      );
    },
  );

  it("projects known credential endpoints to their endpoint-safe metadata schemas", async () => {
    vi.mocked(fetch).mockResolvedValue(response({
      key: {
        id: "key-1",
        environmentId: "env-1",
        keyPrefix: "platos_live_abc",
        allowedOrigins: ["https://app.example"],
        lastUsedAt: null,
        validUntil: null,
        replacedById: null,
        revokedAt: null,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
      retiringKey: null,
    }));

    await expect(credentialRequest("/api/v1/agent/access-key", {
      organizationId: "org-1",
      projectId: "project-1",
      environmentId: "env-1",
      userId: "user-1",
    })).resolves.toMatchObject({
      key: { id: "key-1", keyPrefix: "platos_live_abc" },
      retiringKey: null,
    });
  });

  it("preserves the hash-only persisted read-back contract after a correlated rotation", async () => {
    const persisted = {
      id: "key-2",
      environmentId: "env-1",
      keyPrefix: "platos_live_abcdefghijkl",
      allowedOrigins: ["https://app.example"],
      lastUsedAt: null,
      validUntil: null,
      replacedById: null,
      revokedAt: null,
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ attemptId, key: persisted, retiringKey: null }))
      .mockResolvedValueOnce(response({ key: persisted, retiringKey: null }));
    const scope = {
      organizationId: "org-1",
      projectId: "project-1",
      environmentId: "env-1",
      userId: "user-1",
    };

    const rotated = await credentialRequest("/api/v1/agent/access-key", scope, {
      method: "POST",
      body: { attemptId, keyHash: "a".repeat(64), keyPrefix: persisted.keyPrefix },
    });
    const readBack = await credentialRequest("/api/v1/agent/access-key", scope);

    expect(rotated).toMatchObject({ attemptId, key: { id: persisted.id, keyPrefix: persisted.keyPrefix } });
    expect(readBack).toMatchObject({ key: { id: persisted.id, keyPrefix: persisted.keyPrefix } });
    expect(JSON.stringify({ rotated, readBack })).not.toContain("keyHash");
  });

  it.each([
    ["origins", new URLSearchParams({ intent: "origins", origins: "https://one.example\nhttps://two.example" }), "/api/v1/agent/access-key/origins", "POST", { origins: ["https://one.example", "https://two.example"] }, { ok: true, origins: ["https://one.example", "https://two.example"] }],
    ["revoke", new URLSearchParams({ intent: "revoke" }), "/api/v1/agent/access-key", "DELETE", undefined, { ok: true }],
  ])("keeps the %s mutation on its exact safe AccessKey contract", async (_name, form, path, method, body, payload) => {
    vi.mocked(fetch).mockResolvedValue(response(payload));

    const result = await accessKeyAction({
      request: new Request("http://dashboard/apikeys", { method: "POST", body: form }),
      params,
      context: {},
    });
    const upstream = vi.mocked(fetch).mock.calls[0];

    expect(String(upstream?.[0])).toContain(path);
    expect(upstream?.[1]?.method).toBe(method);
    expect(upstream?.[1]?.body === undefined ? undefined : JSON.parse(String(upstream[1].body))).toEqual(body);
    expect(await result.json()).toEqual({ ok: true, result: payload });
  });

  it("rejects unknown fields even when their names are not on the denylist", async () => {
    vi.mocked(fetch).mockResolvedValue(response({ key: null, retiringKey: null, debug: "unexpected" }));

    await expect(credentialRequest("/api/v1/agent/access-key", {
      organizationId: "org-1",
      projectId: "project-1",
      environmentId: "env-1",
      userId: "user-1",
    })).rejects.toMatchObject({ code: "UNSAFE_CREDENTIAL_RESPONSE" });
  });

  it.each([
    ["PATCH", { key: { id: "provider-key" }, debug: "unexpected" }],
    ["DELETE", { deleted: true, debug: "unexpected" }],
  ])("projects dynamic ProviderKey %s responses to a closed metadata schema", async (method, payload) => {
    vi.mocked(fetch).mockResolvedValue(response(payload));

    await expect(credentialRequest(
      "/api/v1/agent/providers/keys/provider-key",
      {
        organizationId: "org-1",
        projectId: "project-1",
        environmentId: "env-1",
        userId: "user-1",
      },
      { method: method as "PATCH" | "DELETE" },
    )).rejects.toMatchObject({ code: "UNSAFE_CREDENTIAL_RESPONSE" });
  });

  it.each([
    ["create-secret", { provider: "anthropic", label: "Primary", envVarName: "ANTHROPIC_API_KEY", isDefault: "on" }],
    ["rotate-secret", { keyId: "provider-key" }],
  ])("submits BYOK material for %s without echoing it in the action payload", async (intent, fields) => {
    const byokSentinel = `SENTINEL_${intent.toUpperCase().replace("-", "_")}_PROVIDER_SECRET`;
    vi.mocked(fetch).mockResolvedValue(response({
      key: {
        id: "provider-key",
        environmentId: "env-1",
        credentialId: "credential-1",
        provider: "anthropic",
        label: "Primary",
        envVarName: "ANTHROPIC_API_KEY",
        isDefault: true,
        createdBy: "user-1",
        lastUsedAt: null,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    }));
    const form = new URLSearchParams({ intent, ...fields, plaintext: byokSentinel });

    const result = await providerAction({
      request: new Request("http://dashboard/providers", { method: "POST", body: form }),
      params,
      context: {},
    });
    const body = await serialized(result);
    const upstreamBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));

    expect(upstreamBody.plaintext).toBe(byokSentinel);
    expect(body).toContain('"ok":true');
    expect(body).not.toContain(byokSentinel);
  });

  it("fails closed if a BYOK endpoint attempts to echo submitted plaintext", async () => {
    const byokSentinel = "SENTINEL_ECHOED_PROVIDER_SECRET";
    vi.mocked(fetch).mockResolvedValue(response({
      key: { id: "provider-key", plaintext: byokSentinel },
    }));
    const form = new URLSearchParams({
      intent: "rotate-secret",
      keyId: "provider-key",
      plaintext: byokSentinel,
    });

    const result = await providerAction({
      request: new Request("http://dashboard/providers", { method: "POST", body: form }),
      params,
      context: {},
    });
    const body = await serialized(result);

    expect(body).toContain("UNSAFE_CREDENTIAL_RESPONSE");
    expect(body).not.toContain(byokSentinel);
  });
});
