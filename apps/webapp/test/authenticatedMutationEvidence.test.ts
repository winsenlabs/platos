import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { readFileSync } from "node:fs";
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
  fields: Record<string, string>;
  access?: "secret:mutate";
  redirect?: boolean;
};

const routeModules = {
  ...import.meta.glob<RouteModule>("../app/routes/**/route.tsx"),
  ...import.meta.glob<RouteModule>("../app/routes/*.ts"),
};
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
  inventories: { restOperations: RestOperation[] };
};

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const internalCredential = "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL";
const upstreamSecret = "SENTINEL_UPSTREAM_ERROR_DETAILS";

const agentConfig = {
  model: "claude-test",
  maxSteps: "10",
  contextLimit: "100",
  historyMode: "rolling",
  compactThreshold: "50",
  executionMode: "direct",
  visibility: "private",
  toolMode: "direct",
  toolExposure: "direct",
  modelRoutes: JSON.stringify([{ label: "primary", model: "claude-test", isDefault: true }]),
  promptBlocks: "[]",
};

const fixtures = new Map<string, ActionFixture>([
  ["route-010", { fields: { limitCents: "1000" }, access: "secret:mutate" }],
  ["route-011", { fields: {}, access: "secret:mutate" }],
  ["route-012", { fields: { name: "Primary", slug: "primary" }, access: "secret:mutate" }],
  ["route-013", { fields: { agentId: primary.agentId }, access: "secret:mutate" }],
  ["route-014", { fields: { provider: "slack", agentId: primary.agentId }, access: "secret:mutate" }],
  ["route-015", { fields: {}, access: "secret:mutate" }],
  ["route-016", { fields: {}, access: "secret:mutate" }],
  ["route-017", { fields: {}, access: "secret:mutate" }],
  ["route-019", { fields: { entityId: primary.entityId, displayName: "Fixture Entity" }, access: "secret:mutate" }],
  ["route-020", { fields: { agentId: primary.agentId, threadId: primary.threadId, criterionId: "criterion-1" }, access: "secret:mutate" }],
  ["route-027", { fields: agentConfig, access: "secret:mutate" }],
  ["route-034", { fields: { name: "Fixture", simulateUserId: primary.endUserId }, access: "secret:mutate" }],
  ["route-035", { fields: { visibility: "public-guest" }, access: "secret:mutate" }],
  ["route-039", { fields: { versionId: "version-1" }, access: "secret:mutate" }],
  ["route-041", { fields: { ...agentConfig, name: "Fixture Agent" }, access: "secret:mutate" }],
  ["route-043", { fields: { decision: "reject" }, access: "secret:mutate" }],
  ["route-049", { fields: { name: "Quality", judgePrompt: "Score the response" }, access: "secret:mutate" }],
  ["route-054", { fields: {}, access: "secret:mutate" }],
  ["route-055", { fields: { intent: "revoke", tokenId: "token-1" }, access: "secret:mutate" }],
  ["route-056", { fields: { userId: primary.endUserId, agentId: primary.agentId, content: "Fixture memory" }, access: "secret:mutate" }],
  ["route-058", { fields: { userId: primary.endUserId, agentId: primary.agentId, fromEntityKey: "person:ada", toEntityKey: "company:platos", relationshipType: "works_at" }, access: "secret:mutate" }],
  ["route-059", { fields: { intent: "dispatch" }, access: "secret:mutate" }],
  ["route-060", { fields: { jobId: primary.jobId }, access: "secret:mutate" }],
  ["route-061", { fields: { jobId: primary.jobId, displayName: "Fixture Job", handler: "export default async () => ({ ok: true })" }, access: "secret:mutate" }],
  ["route-067", { fields: { url: "https://example.test/SKILL.md" }, access: "secret:mutate" }],
  ["route-068", { fields: { intent: "fork", upToMessageId: "turn-1", title: "Forked fixture" }, redirect: true }],
]);

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
    agentId: scope.agentId,
    entityId: scope.entityId,
    clusterId: scope.clusterId,
    threadId: scope.threadId,
    approvalId: scope.approvalId,
    jobId: scope.jobId,
    userId: scope.endUserId,
  };
}

function deepLink(routeRelativePath: string, scope = primary) {
  const values = params(scope) as Record<string, string>;
  const routeId = routeRelativePath
    .replace(/\/route\.tsx$/, "")
    .replace(/\.(?:ts|tsx)$/, "");
  const segments = routeId
    .split(".")
    .filter((segment) => segment !== "_app" && segment !== "_index")
    .map((segment) => segment.startsWith("$") ? values[segment.slice(1)] : segment.replace(/_$/, ""));
  if (segments.some((segment) => !segment)) {
    throw new Error(`Authenticated mutation evidence cannot build a deep link for ${routeRelativePath}`);
  }
  return `/${segments.join("/")}`;
}

const contracts = matrix.capabilities
  .filter((capability) => /^route-\d+$/.test(capability.capabilityId))
  .flatMap((capability) => {
    const absolutePath = join(repositoryRoot, capability.currentRoute);
    const source = readFileSync(absolutePath, "utf8");
    const sharedMutation = source.includes("m4Mutation(") || source.includes("mutateAgentConfig(");
    if (!sharedMutation && capability.capabilityId !== "route-068") return [];
    const routeRelativePath = relative(routeRoot, absolutePath).replaceAll("\\", "/");
    const moduleKey = `../app/routes/${routeRelativePath}`;
    const loadModule = routeModules[moduleKey];
    if (!loadModule) throw new Error(`Authenticated mutation evidence cannot import ${capability.currentRoute}`);
    const fixture = fixtures.get(capability.capabilityId);
    if (!fixture) throw new Error(`Authenticated mutation evidence lacks form fields for ${capability.capabilityId}`);
    return [{ ...capability, routeRelativePath, loadModule, fixture }];
  });

function requestArgs(contract: (typeof contracts)[number], overrides: Record<string, string> = {}): ActionFunctionArgs {
  const url = new URL(deepLink(contract.routeRelativePath), "https://dashboard.example");
  const body = new URLSearchParams({ ...contract.fixture.fields, ...overrides });
  return {
    request: new Request(url, {
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

async function invoke(contract: (typeof contracts)[number]) {
  const module = await contract.loadModule();
  if (!module.action) throw new Error(`Authenticated mutation evidence lacks an action for ${contract.currentRoute}`);
  return module.action(requestArgs(contract));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireEnvironmentScope.mockImplementation(authorizeFixture);
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const pathname = new URL(String(input)).pathname;
    const payload = pathname.endsWith("/fork")
      ? { id: "thread-child", parentThreadId: primary.threadId }
      : pathname.endsWith("/threads/thread-child")
        ? { id: "thread-child", parentThreadId: primary.threadId }
        : { id: "mutated-resource", ok: true };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
});

describe("authenticated mutation evidence harness", () => {
  it("discovers the complete shared mutation tranche", () => {
    expect(contracts).toHaveLength(26);
    expect(new Set(contracts.map((contract) => contract.capabilityId)).size).toBe(26);
    expect([...fixtures.keys()].sort()).toEqual(contracts.map((contract) => contract.capabilityId).sort());
  });

  it.each(contracts)("$capabilityId executes a valid scoped form through generated operation contracts", async (contract) => {
    const response = await invoke(contract);
    const serialized = contract.fixture.redirect ? "" : JSON.stringify(await response.json());

    expect(response.status).toBe(contract.fixture.redirect ? 302 : 200);
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({
      organizationSlug: primary.organizationSlug,
      projectSlug: primary.projectSlug,
      environmentSlug: primary.environmentSlug,
      ...(contract.fixture.access ? { access: contract.fixture.access } : {}),
    }));
    expect(new URL(requestArgs(contract).request.url).pathname).toBe(deepLink(contract.routeRelativePath));
    expect(fetch, `${contract.capabilityId} did not execute a mutation`).toHaveBeenCalled();
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      const url = new URL(String(input));
      const method = String(init?.method ?? "GET");
      const operation = operationFor(method, url.pathname);
      expect(operation, `${contract.capabilityId} lacks a generated contract for ${method} ${url.pathname}`).toBeDefined();
      expect(operation?.implementations.length).toBeGreaterThan(0);
      expect(init?.headers).toMatchObject({
        "X-Platos-Organization-Id": primary.organizationId,
        "X-Platos-Project-Id": primary.projectId,
        "X-Platos-Environment-Id": primary.environmentId,
        "X-Platos-User-Id": primary.userId,
        "X-Platos-Internal-Auth": internalCredential,
      });
      expect(String(init?.body ?? "")).not.toContain(internalCredential);
    }
    expect(serialized).not.toContain(internalCredential);
  });

  it.each(contracts)("$capabilityId rejects unauthenticated and mixed-tenant mutations before transport", async (contract) => {
    const module = await contract.loadModule();
    if (!module.action) throw new Error(`Authenticated mutation evidence lacks an action for ${contract.currentRoute}`);
    requireEnvironmentScope.mockRejectedValueOnce(
      new Response(null, { status: 302, headers: { Location: "/login" } }),
    );
    await expect(module.action(requestArgs(contract))).rejects.toMatchObject({ status: 302 });
    expect(fetch).not.toHaveBeenCalled();

    requireEnvironmentScope.mockImplementation(authorizeFixture);
    const foreignValues = {
      organizationSlug: secondary.organizationSlug,
      projectParam: secondary.projectSlug,
      envParam: "foreign-environment",
    } as const;
    for (const dimension of Object.keys(foreignValues) as Array<keyof typeof foreignValues>) {
      const mixed = requestArgs(contract);
      mixed.params = { ...mixed.params, [dimension]: foreignValues[dimension] };
      await expect(module.action(mixed)).rejects.toMatchObject({ status: 404 });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(contracts)("$capabilityId preserves stable secret-safe mutation failures", async (contract) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: "AGENT_UNAVAILABLE",
      message: "The Agent service is unavailable",
      details: { credential: upstreamSecret },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await invoke(contract);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).not.toContain(upstreamSecret);
    expect(serialized).not.toContain(internalCredential);
  });

  it("requires destructive confirmation before replacing scoped Memory", async () => {
    const contract = contracts.find(({ capabilityId }) => capabilityId === "route-056");
    if (!contract) throw new Error("Missing Memory mutation contract");
    const module = await contract.loadModule();
    if (!module.action) throw new Error("Missing Memory action");

    const rejected = await module.action(requestArgs(contract, {
      intent: "memory-import",
      mode: "replace",
      bundle: "{}",
    }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Replace import requires explicit destructive confirmation",
      },
    });
    expect(fetch).not.toHaveBeenCalled();

    const accepted = await module.action(requestArgs(contract, {
      intent: "memory-import",
      mode: "replace",
      confirmReplace: "true",
      bundle: "{}",
    }));
    expect(accepted.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads back a fork before redirecting to the persisted child Thread", async () => {
    const contract = contracts.find(({ capabilityId }) => capabilityId === "route-068");
    if (!contract) throw new Error("Missing Thread fork contract");

    const response = await invoke(contract);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/threads/thread-child`,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(vi.mocked(fetch).mock.calls[0]?.[0])).pathname).toBe(`/api/v1/agent/threads/${primary.threadId}/fork`);
    expect(new URL(String(vi.mocked(fetch).mock.calls[1]?.[0])).pathname).toBe("/api/v1/agent/threads/thread-child");
  });

  it("keeps MCP credsSecretKey as a bare same-Environment reference", async () => {
    const contract = contracts.find(({ capabilityId }) => capabilityId === "route-019");
    if (!contract) throw new Error("Missing Entity registration contract");
    const module = await contract.loadModule();
    if (!module.action) throw new Error("Missing Entity registration action");

    const response = await module.action(requestArgs(contract, {
      connectionKind: "mcp",
      transport: "hosted-composio",
      credsSecretKey: "COMPOSIO_API_KEY",
      headersTemplate: "{}",
    }));

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      connectionKind: "mcp",
      mcpClient: {
        transport: "hosted-composio",
        credsSecretKey: "COMPOSIO_API_KEY",
        headersTemplate: {},
      },
    });
    expect(String(init?.body)).not.toContain("SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL");

    const registry = readFileSync(
      join(process.cwd(), "app/components/platos/surfaces/RegistrySurfaces.tsx"),
      "utf8"
    );
    expect(registry).toContain('"Credential reference"');
    expect(registry).toContain("asRecord(entity.mcpClient).credsSecretKey");
  });

  it("preserves bounded Postman pagination and complete upstream totals", async () => {
    const contract = contracts.find(({ capabilityId }) => capabilityId === "route-034");
    if (!contract) throw new Error("Missing Postman route contract");
    const module = await contract.loadModule();
    if (!module.loader) throw new Error("Missing Postman loader");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      templates: [{ id: "template-11" }],
      items: [{ id: "template-11" }],
      total: 42,
      limit: 10,
      offset: 10,
      hasMore: true,
      pagination: { page: 2, pageSize: 10, total: 42, totalPages: 5, hasNext: true, hasPrevious: true },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const url = new URL(deepLink(contract.routeRelativePath), "https://dashboard.example");
    url.searchParams.set("page", "2");
    url.searchParams.set("pageSize", "10");
    url.searchParams.set("search", "fixture");

    const response = await module.loader({ request: new Request(url), params: params(), context: {} });
    const payload = await response.json();

    const outbound = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(`${outbound.pathname}${outbound.search}`).toBe(
      `/api/v1/agent/postman-templates?agentId=${primary.agentId}&limit=10&offset=10&search=fixture`,
    );
    expect(payload.collection).toMatchObject({ page: 2, pageSize: 10, offset: 10, search: "fixture" });
    expect(payload.panel.data).toMatchObject({ total: 42, limit: 10, offset: 10, hasMore: true });
    expect(payload.panel.data.pagination).toMatchObject({ total: 42, totalPages: 5, hasNext: true });
  });
});
