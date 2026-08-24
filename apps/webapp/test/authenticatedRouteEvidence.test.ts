import type { LoaderFunctionArgs } from "@remix-run/node";
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
  loader?: (args: LoaderFunctionArgs) => Promise<Response>;
};

type RestOperation = {
  id: string;
  method: string;
  path: string;
  implementations: Array<{ requiresOperator: boolean }>;
};

const routeModules = import.meta.glob<RouteModule>("../app/routes/**/route.tsx");
const routeRoot = join(process.cwd(), "app/routes");
const repositoryRoot = join(process.cwd(), "../..");
const matrix = JSON.parse(
  readFileSync(join(repositoryRoot, "docs/audits/win-234-route-capability-parity.json"), "utf8")
) as {
  capabilities: Array<{ currentRoute: string; capabilityId: string }>;
};
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "../agent/src/control-plane/operation-manifest.generated.json"), "utf8")
) as {
  tenancyAuthority: string[];
  inventories: { restOperations: RestOperation[] };
};

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const internalCredential = "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL";
const upstreamSecret = "SENTINEL_UPSTREAM_ERROR_DETAILS";

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

function routeFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? routeFiles(path) : [path];
  });
}

const capabilityByRoute = new Map(
  matrix.capabilities
    .filter((capability) => /^route-\d+$/.test(capability.capabilityId))
    .map((capability) => [capability.currentRoute, capability.capabilityId])
);

const contracts = routeFiles(routeRoot)
  .filter((path) => path.endsWith("/route.tsx"))
  .filter((path) => readFileSync(path, "utf8").includes("loadSurface("))
  .map((path) => {
    const routeRelativePath = relative(routeRoot, path).replaceAll("\\", "/");
    const repositoryPath = `apps/webapp/app/routes/${routeRelativePath}`;
    const capabilityId = capabilityByRoute.get(repositoryPath);
    if (!capabilityId) throw new Error(`Authenticated route evidence lacks a matrix contract for ${repositoryPath}`);
    const moduleKey = `../app/routes/${routeRelativePath}`;
    const loadModule = routeModules[moduleKey];
    if (!loadModule) throw new Error(`Authenticated route evidence cannot import ${repositoryPath}`);
    return { capabilityId, repositoryPath, routeRelativePath, loadModule };
  });

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
  const routeId = routeRelativePath.replace(/\/route\.tsx$/, "");
  const segments = routeId
    .split(".")
    .filter((segment) => segment !== "_app" && segment !== "_index")
    .map((segment) => segment.startsWith("$") ? values[segment.slice(1)] : segment);
  if (segments.some((segment) => !segment)) {
    throw new Error(`Authenticated route evidence cannot build a deep link for ${routeRelativePath}`);
  }
  return `/${segments.join("/")}`;
}

function requestArgs(contract: (typeof contracts)[number], scope = primary): LoaderFunctionArgs {
  const url = new URL(deepLink(contract.routeRelativePath, scope), "https://dashboard.example");
  url.searchParams.set("agentId", scope.agentId);
  url.searchParams.set("userId", scope.endUserId);
  return { request: new Request(url), params: params(scope), context: {} };
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

async function invoke(contract: (typeof contracts)[number], scope = primary) {
  const module = await contract.loadModule();
  if (!module.loader) throw new Error(`Authenticated route evidence lacks a loader for ${contract.repositoryPath}`);
  return module.loader(requestArgs(contract, scope));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireEnvironmentScope.mockImplementation(authorizeFixture);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
});

describe("authenticated route evidence harness", () => {
  it("discovers the complete shared loadSurface tranche and canonical tenancy contract", () => {
    expect(contracts).toHaveLength(44);
    expect(new Set(contracts.map((contract) => contract.capabilityId)).size).toBe(44);
    expect(manifest.tenancyAuthority).toEqual([
      "organizationId",
      "projectId",
      "environmentId",
      "userId",
    ]);
  });

  it.each(contracts)("$capabilityId executes its authenticated deep link and generated Agent operations", async (contract) => {
    const response = await invoke(contract);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({
      organizationSlug: primary.organizationSlug,
      projectSlug: primary.projectSlug,
      environmentSlug: primary.environmentSlug,
    }));
    expect(new URL(requestArgs(contract).request.url).pathname).toBe(deepLink(contract.routeRelativePath));
    expect(fetch, `${contract.capabilityId} did not execute an Agent operation`).toHaveBeenCalled();
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      const url = new URL(String(input));
      const operation = operationFor(String(init?.method ?? "GET"), url.pathname);
      expect(operation, `${contract.capabilityId} lacks a generated contract for ${init?.method ?? "GET"} ${url.pathname}`).toBeDefined();
      expect(operation?.implementations.length).toBeGreaterThan(0);
      expect(init?.headers).toMatchObject({
        "X-Platos-Organization-Id": primary.organizationId,
        "X-Platos-Project-Id": primary.projectId,
        "X-Platos-Environment-Id": primary.environmentId,
        "X-Platos-User-Id": primary.userId,
        "X-Platos-Internal-Auth": internalCredential,
      });
    }
    expect(serialized).not.toContain(internalCredential);
  });

  it.each(contracts)("$capabilityId rejects unauthenticated and mixed-tenant scopes before transport", async (contract) => {
    const module = await contract.loadModule();
    if (!module.loader) throw new Error(`Authenticated route evidence lacks a loader for ${contract.repositoryPath}`);
    requireEnvironmentScope.mockRejectedValueOnce(
      new Response(null, { status: 302, headers: { Location: "/login" } })
    );
    await expect(module.loader(requestArgs(contract))).rejects.toMatchObject({ status: 302 });
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
      await expect(module.loader(mixed)).rejects.toMatchObject({ status: 404 });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(contracts)("$capabilityId preserves stable secret-safe failure serialization", async (contract) => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: "AGENT_UNAVAILABLE",
      message: "The Agent service is unavailable",
      details: { credential: upstreamSecret },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));

    const response = await invoke(contract);
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).toContain("The Agent service is unavailable");
    expect(serialized).not.toContain(upstreamSecret);
    expect(serialized).not.toContain(internalCredential);
  });
});
