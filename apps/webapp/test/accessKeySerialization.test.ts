import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  safeMutationResult,
  sanitizeAccessKeyPayload,
} from "../app/services/platosSecretPayloads.server";
import { generateAccessKey } from "../app/utils/accessKey.client";

const { findEnvironmentById, findProjectBySlug, requireUserId } = vi.hoisted(() => ({
  findEnvironmentById: vi.fn(),
  findProjectBySlug: vi.fn(),
  requireUserId: vi.fn(),
}));

vi.mock("~/models/project.server", () => ({ findProjectBySlug }));
vi.mock("~/models/runtimeEnvironment.server", () => ({ findEnvironmentById }));
vi.mock("~/presenters/v3/ApiKeysPresenter.server", () => ({ ApiKeysPresenter: vi.fn() }));
vi.mock("~/services/session.server", () => ({ requireUserId }));
vi.mock("~/db.server", () => ({ prisma: {} }));
vi.mock("~/env.server", () => ({ env: {} }));

const RAW_ACCESS_KEY = "platos_live_RAW_SENTINEL";
const HASH_SENTINEL = "a".repeat(64);

describe("AccessKey non-serialization", () => {
  it("generates the bearer in the browser contract and submits only its hash and prefix", async () => {
    const generated = await generateAccessKey(webcrypto as unknown as Crypto);
    const submittedPayload = {
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
    };

    expect(generated.rawKey).toMatch(/^platos_live_[A-Za-z0-9_-]+$/);
    expect(generated.keyHash).toBe(createHash("sha256").update(generated.rawKey).digest("hex"));
    expect(generated.keyPrefix).toBe(generated.rawKey.slice(0, 18));
    expect(JSON.stringify(submittedPayload)).not.toContain(generated.rawKey);
    expect(submittedPayload).not.toHaveProperty("rawKey");
  });

  it("posts the allowed-origins request to the agent endpoint contract", async () => {
    requireUserId.mockResolvedValue("user_1");
    findProjectBySlug.mockResolvedValue({ id: "project_1", organizationId: "org_1" });
    findEnvironmentById.mockResolvedValue({ id: "4d73d9dc-9f10-43d3-a9c1-793b139bf5e9", projectId: "project_1" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, origins: ["https://one.example"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    process.env.PLATOS_AGENT_API_URL = "http://agent.internal";

    const form = new FormData();
    form.set("intent", "update-origins");
    form.set("allowedOrigins", " https://one.example \n\nhttps://two.example ");
    const request = new Request("http://webapp.test/api-keys", { method: "POST", body: form });
    const { action } = await import(
      "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route"
    );

    const result = await action({
      request,
      params: {
        organizationSlug: "org",
        projectParam: "project",
        envParam: "4d73d9dc-9f10-43d3-a9c1-793b139bf5e9",
      },
      context: {},
    } as any);

    expect(result).toMatchObject({ ok: true, intent: "update-origins" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://agent.internal/api/v1/agent/access-key/origins");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(
      Object.keys(init.headers as Record<string, string>).filter(
        (header) => header.toLowerCase() === "content-type"
      )
    ).toEqual(["content-type"]);
    expect(JSON.parse(String(init.body))).toEqual({
      origins: ["https://one.example", "https://two.example"],
    });
    expect(String(init.body)).not.toContain("allowedOrigins");

    fetchMock.mockRestore();
  });

  it("posts the browser-generated hash and prefix with one JSON content type", async () => {
    requireUserId.mockResolvedValue("user_1");
    findProjectBySlug.mockResolvedValue({ id: "project_1", organizationId: "org_1" });
    findEnvironmentById.mockResolvedValue({ id: "4d73d9dc-9f10-43d3-a9c1-793b139bf5e9", projectId: "project_1" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          key: {
            id: "key_1",
            keyPrefix: "platos_live_ab12",
            allowedOrigins: [],
            lastUsedAt: null,
            validUntil: null,
            replacedById: null,
            revokedAt: null,
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
          },
          retiringKey: null,
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      )
    );
    process.env.PLATOS_AGENT_API_URL = "http://agent.internal";

    const form = new FormData();
    form.set("intent", "create-or-rotate-platos-key");
    form.set("keyHash", HASH_SENTINEL);
    form.set("keyPrefix", "platos_live_ab12");
    const request = new Request("http://webapp.test/api-keys", { method: "POST", body: form });
    const { action } = await import(
      "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.apikeys/route"
    );

    const result = await action({
      request,
      params: {
        organizationSlug: "org",
        projectParam: "project",
        envParam: "4d73d9dc-9f10-43d3-a9c1-793b139bf5e9",
      },
      context: {},
    } as any);

    expect(result).toMatchObject({ ok: true, intent: "create-or-rotate-platos-key" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://agent.internal/api/v1/agent/access-key");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(
      Object.keys(init.headers as Record<string, string>).filter(
        (header) => header.toLowerCase() === "content-type"
      )
    ).toEqual(["content-type"]);
    expect(JSON.parse(String(init.body))).toEqual({
      keyHash: HASH_SENTINEL,
      keyPrefix: "platos_live_ab12",
    });

    fetchMock.mockRestore();
  });

  it("omits raw keys and hashes from complete loader and action payload serialization and logs", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unsafeAgentPayload = {
      keys: [
        {
          id: "access-key-active",
          environmentId: "environment-1",
          keyPrefix: "platos_live_ab12",
          keyHash: HASH_SENTINEL,
          rawKey: RAW_ACCESS_KEY,
          allowedOrigins: ["https://app.example.com"],
          lastUsedAt: null,
          validUntil: null,
          replacedById: null,
          revokedAt: null,
          createdAt: "2026-08-15T10:00:00.000Z",
          updatedAt: "2026-08-15T10:00:00.000Z",
        },
        {
          id: "access-key-retiring",
          keyPrefix: "platos_live_old1",
          keyHash: "b".repeat(64),
          allowedOrigins: [],
          validUntil: "2026-08-15T10:10:00.000Z",
          replacedById: "access-key-active",
          revokedAt: null,
          lastUsedAt: "2026-08-15T09:59:00.000Z",
          createdAt: "2026-08-14T10:00:00.000Z",
          updatedAt: "2026-08-15T10:00:00.000Z",
        },
      ],
    };

    const loaderPayload = sanitizeAccessKeyPayload(unsafeAgentPayload);
    const actionPayload = safeMutationResult("create-or-rotate-platos-key", unsafeAgentPayload);
    const wholePayload = JSON.stringify({ loaderPayload, actionPayload });
    const serializedLogs = JSON.stringify([...log.mock.calls, ...error.mock.calls]);

    expect(loaderPayload.key?.keyPrefix).toBe("platos_live_ab12");
    expect(loaderPayload.retiringKey?.validUntil).toBe("2026-08-15T10:10:00.000Z");
    expect(actionPayload).not.toHaveProperty("rawKey");
    for (const forbidden of [RAW_ACCESS_KEY, HASH_SENTINEL, "b".repeat(64)]) {
      expect(wholePayload).not.toContain(forbidden);
      expect(serializedLogs).not.toContain(forbidden);
    }

    log.mockRestore();
    error.mockRestore();
  });
});
