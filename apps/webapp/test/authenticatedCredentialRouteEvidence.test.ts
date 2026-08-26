import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperatorScope } from "../../../tests/persisted-state-gate/fixture-contract";

const { requireEnvironmentScope } = vi.hoisted(() => ({
  requireEnvironmentScope: vi.fn(),
}));

vi.mock("~/env.server", () => ({
  env: {
    PLATOS_AGENT_API_URL: "http://agent.invalid",
    PLATOS_INTERNAL_AUTH_TOKEN: "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL",
  },
}));
vi.mock("~/services/auth.server", () => ({ requireEnvironmentScope }));

type RouteModule = {
  action?: (args: ActionFunctionArgs) => Promise<Response>;
  loader?: (args: LoaderFunctionArgs) => Promise<Response>;
};

type RestOperation = {
  id: string;
  method: string;
  path: string;
  implementations: Array<{ requiresOperator: boolean }>;
};

type ActionFixture = {
  name: string;
  fields: Record<string, string>;
  expectedMethod: string;
  expectedPath: string;
};

const routeModules = import.meta.glob<RouteModule>("../app/routes/**/route.tsx");
const routeRoot = join(process.cwd(), "app/routes");
const repositoryRoot = join(process.cwd(), "../..");
const matrix = JSON.parse(
  readFileSync(join(repositoryRoot, "docs/audits/win-234-route-capability-parity.json"), "utf8"),
) as {
  capabilities: Array<{ currentRoute: string; capabilityId: string }>;
};
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "../agent/src/control-plane/operation-manifest.generated.json"), "utf8"),
) as {
  tenancyAuthority: string[];
  inventories: { restOperations: RestOperation[] };
};

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const internalCredential = "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL";
const upstreamSecret = "SENTINEL_UPSTREAM_ERROR_DETAILS";
const submittedSecret = "SENTINEL_SUBMITTED_PROVIDER_SECRET";
const requestId = "123e4567-e89b-4d3a-a456-426614174000";
const keyHash = "a".repeat(64);
const keyPrefix = "platos_live_fixture";

function routeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? routeFiles(path) : [path];
  });
}

const capabilityByRoute = new Map(
  matrix.capabilities
    .filter((capability) => /^route-\d+$/.test(capability.capabilityId))
    .map((capability) => [capability.currentRoute, capability.capabilityId]),
);

const actionFixtures = new Map<string, ActionFixture[]>([
  ["route-024", [
    { name: "create-key", fields: { intent: "create-key", provider: "openai", label: "Primary", envVarName: "OPENAI_API_KEY", isDefault: "on" }, expectedMethod: "POST", expectedPath: "/api/v1/agent/providers/keys" },
    { name: "create-secret", fields: { intent: "create-secret", provider: "openai", label: "BYOK", envVarName: "OPENAI_API_KEY", plaintext: submittedSecret }, expectedMethod: "POST", expectedPath: "/api/v1/agent/providers/keys/byok" },
    { name: "rotate-secret", fields: { intent: "rotate-secret", keyId: "key-1", plaintext: submittedSecret }, expectedMethod: "POST", expectedPath: "/api/v1/agent/providers/keys/key-1/rotate-secret" },
    { name: "default-key", fields: { intent: "default-key", keyId: "key-1" }, expectedMethod: "PATCH", expectedPath: "/api/v1/agent/providers/keys/key-1" },
    { name: "delete-key", fields: { intent: "delete-key", keyId: "key-1" }, expectedMethod: "DELETE", expectedPath: "/api/v1/agent/providers/keys/key-1" },
    { name: "probe", fields: { intent: "probe", provider: "openai" }, expectedMethod: "GET", expectedPath: "/api/v1/agent/providers/openai/health" },
    { name: "link", fields: { intent: "link", provider: "openai" }, expectedMethod: "POST", expectedPath: "/api/v1/agent/providers/openai/link" },
    { name: "unlink", fields: { intent: "unlink", provider: "openai" }, expectedMethod: "DELETE", expectedPath: "/api/v1/agent/providers/openai/link" },
    { name: "toggle", fields: { intent: "toggle", provider: "openai", enabled: "true" }, expectedMethod: "PATCH", expectedPath: "/api/v1/agent/providers/openai" },
  ]],
  ["route-042", [
    { name: "rotate", fields: { intent: "rotate", requestId, keyHash, keyPrefix }, expectedMethod: "POST", expectedPath: "/api/v1/agent/access-key" },
    { name: "origins", fields: { intent: "origins", origins: "https://app.example\nhttps://admin.example" }, expectedMethod: "POST", expectedPath: "/api/v1/agent/access-key/origins" },
    { name: "revoke", fields: { intent: "revoke" }, expectedMethod: "DELETE", expectedPath: "/api/v1/agent/access-key" },
  ]],
]);

const contracts = routeFiles(routeRoot)
  .filter((path) => path.endsWith("/route.tsx"))
  .filter((path) => readFileSync(path, "utf8").includes("credentialPanel("))
  .map((path) => {
    const routeRelativePath = relative(routeRoot, path).replaceAll("\\", "/");
    const currentRoute = `apps/webapp/app/routes/${routeRelativePath}`;
    const capabilityId = capabilityByRoute.get(currentRoute);
    if (!capabilityId) throw new Error(`Credential route evidence lacks a matrix contract for ${currentRoute}`);
    const loadModule = routeModules[`../app/routes/${routeRelativePath}`];
    if (!loadModule) throw new Error(`Credential route evidence cannot import ${currentRoute}`);
    const fixtures = actionFixtures.get(capabilityId);
    if (!fixtures) throw new Error(`Credential route evidence lacks actions for ${capabilityId}`);
    return { capabilityId, currentRoute, routeRelativePath, loadModule, fixtures };
  });

const actions = contracts.flatMap((contract) => contract.fixtures.map((fixture) => ({ ...contract, fixture })));

async function authorizeFixture({
  organizationSlug,
  projectSlug,
  environmentSlug,
}: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
}) {
  if (
    organizationSlug !== primary.organizationSlug ||
    projectSlug !== primary.projectSlug ||
    environmentSlug !== primary.environmentSlug
  ) {
    throw new Response("Environment not found", { status: 404 });
  }
  return {
    authorization: { role: "ADMIN", sessionMaterial: internalCredential },
    scope: {
      organizationId: primary.organizationId,
      projectId: primary.projectId,
      environmentId: primary.environmentId,
      userId: primary.userId,
    },
  };
}

function params(scope = primary) {
  return {
    organizationSlug: scope.organizationSlug,
    projectParam: scope.projectSlug,
    envParam: scope.environmentSlug,
  };
}

function deepLink(routeRelativePath: string, scope = primary) {
  const values = params(scope) as Record<string, string>;
  const segments = routeRelativePath
    .replace(/\/route\.tsx$/, "")
    .split(".")
    .filter((segment) => segment !== "_app" && segment !== "_index")
    .map((segment) => segment.startsWith("$") ? values[segment.slice(1)] : segment);
  if (segments.some((segment) => !segment)) {
    throw new Error(`Credential route evidence cannot build a deep link for ${routeRelativePath}`);
  }
  return `/${segments.join("/")}`;
}

function loaderArgs(contract: (typeof contracts)[number]): LoaderFunctionArgs {
  return {
    request: new Request(new URL(deepLink(contract.routeRelativePath), "https://dashboard.example")),
    params: params(),
    context: {},
  };
}

function actionArgs(contract: (typeof actions)[number]): ActionFunctionArgs {
  const body = new URLSearchParams(contract.fixture.fields);
  return {
    request: new Request(new URL(deepLink(contract.routeRelativePath), "https://dashboard.example"), {
      method: "POST",
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    params: params(),
    context: {},
  };
}

function operationFor(method: string, pathname: string): RestOperation | undefined {
  return manifest.inventories.restOperations.find((operation) => {
    if (operation.method !== method) return false;
    const expression = operation.path
      .split("/")
      .map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("/");
    return new RegExp(`^${expression}$`).test(pathname);
  });
}

function safeProviderKey() {
  return {
    id: "key-1",
    environmentId: primary.environmentId,
    credentialId: "credential-1",
    provider: "openai",
    label: "Primary",
    envVarName: "OPENAI_API_KEY",
    isDefault: true,
    createdBy: primary.userId,
    lastUsedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function safeAccessKey() {
  return {
    id: "access-key-1",
    environmentId: primary.environmentId,
    keyPrefix,
    allowedOrigins: ["https://app.example"],
    lastUsedAt: null,
    validUntil: null,
    replacedById: null,
    revokedAt: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function successPayload(method: string, pathname: string) {
  if (pathname === "/api/v1/agent/providers") return { providers: [] };
  if (pathname === "/api/v1/agent/providers/models") return [];
  if (pathname === "/api/v1/agent/providers/keys" && method === "GET") return { keys: [] };
  if (pathname === "/api/v1/agent/providers/keys" && method === "POST") return { key: safeProviderKey() };
  if (pathname === "/api/v1/agent/providers/keys/byok" || pathname.endsWith("/rotate-secret")) return { key: safeProviderKey() };
  if (/\/api\/v1\/agent\/providers\/keys\/[^/]+$/.test(pathname)) {
    return method === "DELETE" ? { deleted: true } : { key: safeProviderKey() };
  }
  if (pathname === "/api/v1/agent/access-key" && method === "GET") return { key: safeAccessKey(), retiringKey: null };
  if (pathname === "/api/v1/agent/access-key" && method === "POST") {
    return { requestId, key: safeAccessKey(), retiringKey: null };
  }
  if (pathname === "/api/v1/agent/access-key" && method === "DELETE") return { ok: true };
  if (pathname === "/api/v1/agent/access-key/origins") {
    return { ok: true, origins: ["https://app.example", "https://admin.example"] };
  }
  return { ok: true };
}

function assertGeneratedTransport() {
  expect(fetch).toHaveBeenCalled();
  for (const [input, init] of vi.mocked(fetch).mock.calls) {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    const operation = operationFor(method, url.pathname);
    expect(operation, `Missing generated operation for ${method} ${url.pathname}`).toBeDefined();
    expect(operation?.implementations.length).toBeGreaterThan(0);
    expect(init?.headers).toMatchObject({
      "X-Platos-Organization-Id": primary.organizationId,
      "X-Platos-Project-Id": primary.projectId,
      "X-Platos-Environment-Id": primary.environmentId,
      "X-Platos-User-Id": primary.userId,
      "X-Platos-Internal-Auth": internalCredential,
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  requireEnvironmentScope.mockImplementation(authorizeFixture);
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    const method = String(init?.method ?? "GET");
    return new Response(JSON.stringify(successPayload(method, pathname)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
});

describe("authenticated credential route evidence harness", () => {
  it("discovers exactly the direct credential routes and canonical tenancy authority", () => {
    expect(contracts.map(({ capabilityId }) => capabilityId).sort()).toEqual(["route-024", "route-042"]);
    expect(actions).toHaveLength(12);
    expect(manifest.tenancyAuthority).toEqual(["organizationId", "projectId", "environmentId", "userId"]);
  });

  it.each(contracts)("$capabilityId executes its authenticated metadata loader", async (contract) => {
    const module = await contract.loadModule();
    if (!module.loader) throw new Error(`Missing credential loader for ${contract.capabilityId}`);
    const response = await module.loader(loaderArgs(contract));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(new URL(loaderArgs(contract).request.url).pathname).toBe(deepLink(contract.routeRelativePath));
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({
      organizationSlug: primary.organizationSlug,
      projectSlug: primary.projectSlug,
      environmentSlug: primary.environmentSlug,
      access: "metadata",
    }));
    assertGeneratedTransport();
    expect(serialized).not.toContain(internalCredential);
    expect(serialized).not.toContain(keyHash);
    expect(serialized).not.toContain(submittedSecret);
  });

  it.each(actions)("$capabilityId $fixture.name executes its authenticated secret mutation", async (contract) => {
    const module = await contract.loadModule();
    if (!module.action) throw new Error(`Missing credential action for ${contract.capabilityId}`);
    const response = await module.action(actionArgs(contract));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({ access: "secret:mutate" }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(new URL(String(input)).pathname).toBe(contract.fixture.expectedPath);
    expect(String(init?.method ?? "GET")).toBe(contract.fixture.expectedMethod);
    assertGeneratedTransport();
    if (contract.fixture.name === "rotate") {
      expect(JSON.parse(String(init?.body))).toEqual({ requestId, keyHash, keyPrefix });
    }
    expect(serialized).not.toContain(internalCredential);
    expect(serialized).not.toContain(keyHash);
    expect(serialized).not.toContain(submittedSecret);
  });

  it.each(contracts)("$capabilityId rejects unauthenticated and mixed-scope loader/action requests before transport", async (contract) => {
    const module = await contract.loadModule();
    if (!module.loader || !module.action) throw new Error(`Missing credential route exports for ${contract.capabilityId}`);
    const fixture = { ...contract, fixture: contract.fixtures[0] };

    requireEnvironmentScope.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/login" } }));
    await expect(module.loader(loaderArgs(contract))).rejects.toMatchObject({ status: 302 });
    expect(fetch).not.toHaveBeenCalled();

    requireEnvironmentScope.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/login" } }));
    await expect(module.action(actionArgs(fixture))).rejects.toMatchObject({ status: 302 });
    expect(fetch).not.toHaveBeenCalled();

    requireEnvironmentScope.mockImplementation(authorizeFixture);
    const foreignValues = {
      organizationSlug: secondary.organizationSlug,
      projectParam: secondary.projectSlug,
      envParam: "foreign-environment",
    } as const;
    for (const dimension of Object.keys(foreignValues) as Array<keyof typeof foreignValues>) {
      const loaderRequest = loaderArgs(contract);
      loaderRequest.params = { ...loaderRequest.params, [dimension]: foreignValues[dimension] };
      await expect(module.loader(loaderRequest)).rejects.toMatchObject({ status: 404 });
      expect(fetch).not.toHaveBeenCalled();

      const actionRequest = actionArgs(fixture);
      actionRequest.params = { ...actionRequest.params, [dimension]: foreignValues[dimension] };
      await expect(module.action(actionRequest)).rejects.toMatchObject({ status: 404 });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(contracts)("$capabilityId serializes stable secret-safe loader and action failures", async (contract) => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      code: "AGENT_UNAVAILABLE",
      message: "The Agent service is unavailable",
      details: { credential: upstreamSecret },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    const module = await contract.loadModule();
    if (!module.loader || !module.action) throw new Error(`Missing credential route exports for ${contract.capabilityId}`);

    const loaderResponse = await module.loader(loaderArgs(contract));
    const loaderSerialized = JSON.stringify(await loaderResponse.json());
    expect(loaderResponse.status).toBe(200);
    expect(loaderSerialized).toContain("AGENT_UNAVAILABLE");
    expect(loaderSerialized).not.toContain(upstreamSecret);
    expect(loaderSerialized).not.toContain(internalCredential);

    const actionResponse = await module.action(actionArgs({ ...contract, fixture: contract.fixtures[0] }));
    const actionSerialized = JSON.stringify(await actionResponse.json());
    expect(actionResponse.status).toBe(400);
    expect(actionSerialized).toContain("AGENT_UNAVAILABLE");
    expect(actionSerialized).not.toContain("The Agent service is unavailable");
    expect(actionSerialized).not.toContain(upstreamSecret);
    expect(actionSerialized).not.toContain(internalCredential);
  });

  it("reads updated AccessKey origins back from the metadata loader", async () => {
    const contract = contracts.find(({ capabilityId }) => capabilityId === "route-042");
    if (!contract) throw new Error("Missing AccessKey route contract");
    const module = await contract.loadModule();
    if (!module.loader || !module.action) throw new Error("Missing AccessKey route exports");
    const fixture = contract.fixtures.find(({ name }) => name === "origins");
    if (!fixture) throw new Error("Missing AccessKey origins fixture");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        origins: ["https://app.example", "https://admin.example"],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        key: { ...safeAccessKey(), allowedOrigins: ["https://app.example", "https://admin.example"] },
        retiringKey: null,
      }), { status: 200 }));

    const actionResponse = await module.action(actionArgs({ ...contract, fixture }));
    expect(await actionResponse.json()).toMatchObject({ ok: true });
    const loaderResponse = await module.loader(loaderArgs(contract));
    expect(await loaderResponse.json()).toMatchObject({
      panel: {
        ok: true,
        data: { key: { allowedOrigins: ["https://app.example", "https://admin.example"] } },
      },
    });
  });

  it("reads AccessKey revocation back as an empty active and overlap lifecycle", async () => {
    const contract = contracts.find(({ capabilityId }) => capabilityId === "route-042");
    if (!contract) throw new Error("Missing AccessKey route contract");
    const module = await contract.loadModule();
    if (!module.loader || !module.action) throw new Error("Missing AccessKey route exports");
    const fixture = contract.fixtures.find(({ name }) => name === "revoke");
    if (!fixture) throw new Error("Missing AccessKey revoke fixture");
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key: null, retiringKey: null }), { status: 200 }));

    const actionResponse = await module.action(actionArgs({ ...contract, fixture }));
    expect(await actionResponse.json()).toMatchObject({ ok: true });
    const loaderResponse = await module.loader(loaderArgs(contract));
    expect(await loaderResponse.json()).toMatchObject({
      panel: { ok: true, data: { key: null, retiringKey: null } },
    });
  });
});
