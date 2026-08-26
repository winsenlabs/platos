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
  loader?: (args: LoaderFunctionArgs) => Promise<Response>;
  action?: (args: ActionFunctionArgs) => Promise<Response>;
};

type RestOperation = {
  method: string;
  path: string;
  implementations: Array<{ requiresOperator: boolean }>;
};

const routeModules = import.meta.glob<RouteModule>("../app/routes/**/route.tsx");
const repositoryRoot = join(process.cwd(), "../..");
const routeRoot = join(process.cwd(), "app/routes");
const matrix = JSON.parse(
  readFileSync(join(repositoryRoot, "docs/audits/win-234-route-capability-parity.json"), "utf8"),
) as {
  capabilities: Array<{ currentRoute: string; capabilityId: string }>;
};
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), "../agent/src/control-plane/operation-manifest.generated.json"), "utf8"),
) as { inventories: { restOperations: RestOperation[] } };

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const internalCredential = "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL";
const upstreamSecret = "SENTINEL_UPSTREAM_ERROR_DETAILS";
const authenticatedIds = ["route-007", "route-008", "route-029", "route-036"];
const redirectIds = ["route-031", "route-038", "route-062", "route-064", "route-065", "route-072"];

function contract(capabilityId: string) {
  const capability = matrix.capabilities.find((row) => row.capabilityId === capabilityId);
  if (!capability) throw new Error(`Missing matrix capability ${capabilityId}`);
  const routeRelativePath = relative(routeRoot, join(repositoryRoot, capability.currentRoute)).replaceAll("\\", "/");
  const loadModule = routeModules[`../app/routes/${routeRelativePath}`];
  if (!loadModule) throw new Error(`Cannot import ${capability.currentRoute}`);
  return { ...capability, routeRelativePath, loadModule };
}

const authenticatedRoutes = authenticatedIds.map(contract);
const redirectRoutes = redirectIds.map(contract);

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
    workspace: {
      organization: { id: primary.organizationId, slug: primary.organizationSlug },
      project: { id: primary.projectId, slug: primary.projectSlug },
      environment: { id: primary.environmentId, slug: primary.environmentSlug },
    },
    scope: {
      organizationId: primary.organizationId,
      projectId: primary.projectId,
      environmentId: primary.environmentId,
      userId: primary.userId,
    },
  };
}

function params() {
  return {
    organizationSlug: primary.organizationSlug,
    projectParam: primary.projectSlug,
    envParam: primary.environmentSlug,
    agentId: primary.agentId,
    threadId: primary.threadId,
  };
}

function deepLink(routeRelativePath: string) {
  const values = params() as Record<string, string>;
  const routeId = routeRelativePath.replace(/\/route\.tsx$/, "");
  return `/${routeId
    .split(".")
    .filter((segment) => segment !== "_app" && segment !== "_index")
    .map((segment) => segment.startsWith("$") ? values[segment.slice(1)] : segment.replace(/_$/, ""))
    .join("/")}`;
}

function loaderArgs(routeRelativePath: string): LoaderFunctionArgs {
  return {
    request: new Request(new URL(deepLink(routeRelativePath), "https://dashboard.example")),
    params: params(),
    context: {},
  };
}

function operationFor(method: string, pathname: string) {
  return manifest.inventories.restOperations.find((operation) => {
    if (operation.method !== method) return false;
    const expression = operation.path
      .split("/")
      .map((segment) => segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("/");
    return new RegExp(`^${expression}$`).test(pathname);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireEnvironmentScope.mockImplementation(authorizeFixture);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0 }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
});

describe("authenticated custom route evidence", () => {
  it("pins the reviewed custom and compatibility route inventory", () => {
    expect(authenticatedRoutes.map((row) => row.capabilityId)).toEqual(authenticatedIds);
    expect(redirectRoutes.map((row) => row.capabilityId)).toEqual(redirectIds);
  });

  it.each(authenticatedRoutes)("$capabilityId authorizes its canonical deep link before scoped data access", async (route) => {
    const module = await route.loadModule();
    if (!module.loader) throw new Error(`${route.capabilityId} lacks a loader`);

    const args = loaderArgs(route.routeRelativePath);
    const response = await module.loader(args);
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(new URL(args.request.url).pathname).toBe(deepLink(route.routeRelativePath));
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({
      organizationSlug: primary.organizationSlug,
      projectSlug: primary.projectSlug,
      environmentSlug: primary.environmentSlug,
      ...(route.capabilityId === "route-036" ? { access: "metadata" } : {}),
    }));
    expect(serialized).not.toContain(internalCredential);

    if (route.capabilityId === "route-007") {
      expect(fetch).not.toHaveBeenCalled();
      return;
    }
    expect(fetch).toHaveBeenCalled();
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      const url = new URL(String(input));
      const operation = operationFor(String(init?.method ?? "GET"), url.pathname);
      expect(operation, `${route.capabilityId}: ${init?.method ?? "GET"} ${url.pathname}`).toBeDefined();
      expect(operation?.implementations.length).toBeGreaterThan(0);
      expect(init?.headers).toMatchObject({
        "X-Platos-Organization-Id": primary.organizationId,
        "X-Platos-Project-Id": primary.projectId,
        "X-Platos-Environment-Id": primary.environmentId,
        "X-Platos-User-Id": primary.userId,
        "X-Platos-Internal-Auth": internalCredential,
      });
    }
  });

  it.each(authenticatedRoutes)("$capabilityId rejects unauthenticated and mixed scopes before data access", async (route) => {
    const module = await route.loadModule();
    if (!module.loader) throw new Error(`${route.capabilityId} lacks a loader`);

    requireEnvironmentScope.mockRejectedValueOnce(
      new Response(null, { status: 302, headers: { Location: "/login" } }),
    );
    await expect(module.loader(loaderArgs(route.routeRelativePath))).rejects.toMatchObject({ status: 302 });
    expect(fetch).not.toHaveBeenCalled();

    for (const [key, value] of [
      ["organizationSlug", secondary.organizationSlug],
      ["projectParam", secondary.projectSlug],
      ["envParam", "foreign-environment"],
    ] as const) {
      const args = loaderArgs(route.routeRelativePath);
      args.params = { ...args.params, [key]: value };
      await expect(module.loader(args)).rejects.toMatchObject({ status: 404 });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(authenticatedRoutes.filter((row) => row.capabilityId !== "route-007"))(
    "$capabilityId serializes stable Agent failures without upstream details",
    async (route) => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
        code: "AGENT_UNAVAILABLE",
        message: "The Agent service is unavailable",
        details: { credential: upstreamSecret },
      }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }));
      const module = await route.loadModule();
      if (!module.loader) throw new Error(`${route.capabilityId} lacks a loader`);

      const response = await module.loader(loaderArgs(route.routeRelativePath));
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(200);
      expect(serialized).toContain("AGENT_UNAVAILABLE");
      expect(serialized).toContain("The Agent service is unavailable");
      expect(serialized).not.toContain(upstreamSecret);
      expect(serialized).not.toContain(internalCredential);
    },
  );

  it("route-036 authorizes mutation access and preserves a stable secret-safe action failure", async () => {
    const route = authenticatedRoutes.find((row) => row.capabilityId === "route-036");
    if (!route) throw new Error("Missing route-036");
    const module = await route.loadModule();
    if (!module.action) throw new Error("route-036 lacks an action");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({
      code: "AGENT_UNAVAILABLE",
      message: upstreamSecret,
      details: { credential: upstreamSecret },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));
    const request = new Request(new URL(deepLink(route.routeRelativePath), "https://dashboard.example"), {
      method: "POST",
      body: new URLSearchParams({ skillId: "skill-1", enabled: "true" }),
    });

    const response = await module.action({ request, params: params(), context: {} });
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({ access: "secret:mutate" }));
    expect(serialized).toContain("AGENT_UNAVAILABLE");
    expect(serialized).toContain("Skill update failed");
    expect(serialized).not.toContain(upstreamSecret);
    const [input, init] = vi.mocked(fetch).mock.calls[0];
    expect(operationFor(String(init?.method), new URL(String(input)).pathname)).toBeDefined();
  });
});

describe("compatibility route link evidence", () => {
  const expected = new Map([
    ["route-031", `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/threads/${primary.threadId}`],
    ["route-038", `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/threads/${primary.threadId}/trace`],
    ["route-062", `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/settings/general`],
    ["route-064", `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/mcps`],
    ["route-065", `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/mcps`],
    ["route-072", `/orgs/${primary.organizationSlug}/settings/team`],
  ]);

  it.each(redirectRoutes)("$capabilityId redirects to its canonical owned route without backend access", async (route) => {
    const module = await route.loadModule();
    if (!module.loader) throw new Error(`${route.capabilityId} lacks a loader`);
    const args = loaderArgs(route.routeRelativePath);

    let response: Response;
    try {
      response = await module.loader(args);
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      response = error;
    }

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(expected.get(route.capabilityId));
    expect(requireEnvironmentScope).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(redirectRoutes)("$capabilityId rejects a missing required path identifier", async (route) => {
    const module = await route.loadModule();
    if (!module.loader) throw new Error(`${route.capabilityId} lacks a loader`);
    const args = loaderArgs(route.routeRelativePath);
    args.params = {};

    await expect(module.loader(args)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
