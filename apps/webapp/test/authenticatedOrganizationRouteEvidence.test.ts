// WIN-257 T8 — THE ORGANIZATION AND PROJECT ROUTES, AFTER THE CUTOVER.
//
// WHAT THIS SUITE USED TO BE, AND WHY IT COULD NOT STAY. It held a hand-built
// `database` object — `organizationMembership.findFirst`, `organization.create`,
// a `$transaction` that invoked its callback with two more fakes — and asserted
// that each loader called Prisma with an exact `where`/`select` tree. Every one
// of those assertions was a test double lying about a database: the shape was
// never executed, so a `select` that named a column Prisma would have rejected
// passed here, and the ONLY thing being compared was this file against itself.
//
// The seam moved, so the double moves with it. These routes now dispatch NAMED
// V1 OPERATIONS through `app/services/coreApi.server.ts`, and what is worth
// asserting is which operation, with which method, at which path, carrying which
// body — because that table IS the cutover. So the double is `fetch`, one level
// below the client: nothing in the client is mocked, the operation table really
// resolves the path, the `Cookie` header really travels, and a route that reached
// for an operation the table does not carry would throw before a request existed.
//
// THE ROUTE IDS ARE THE ONES THE REFERENCE MANIFEST USES (route-002, -004, -005,
// -006, -073, -074, -075), so the evidence these cases produce stays addressable.

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperatorScope } from "../../../tests/persisted-state-gate/fixture-contract";

const { requireOperator } = vi.hoisted(() => ({ requireOperator: vi.fn() }));

vi.mock("~/env.server", () => ({
  env: {
    NODE_ENV: "test",
    PLATOS_CORE_API_URL: "http://core.invalid",
    PLATOS_AGENT_API_URL: "http://agent.invalid",
    PLATOS_INTERNAL_AUTH_TOKEN: "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL",
  },
}));
vi.mock("~/services/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/services/auth.server")>()),
  requireOperator,
}));

import { loader as homeLoader } from "../app/routes/_app._index/route";
import { loader as organizationLoader } from "../app/routes/_app.orgs.$organizationSlug._index/route";
import { action as invitationAction } from "../app/routes/_app.orgs.$organizationSlug.invite/route";
import { loader as projectLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam/route";
import {
  action as teamAction,
  loader as teamLoader,
} from "../app/routes/_app.orgs.$organizationSlug.settings.team/route";
import {
  action as newProjectAction,
  loader as newProjectLoader,
} from "../app/routes/_app.orgs.$organizationSlug_.projects.new/route";
import { action as newOrganizationAction } from "../app/routes/_app.orgs.new/route";

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
/** A value core-api could return in a fault body. It must never reach a page. */
const upstreamSecret = "SENTINEL_CORE_API_FAULT_DETAIL";
const authSecret = "SENTINEL_INVITATION_OR_SESSION_MATERIAL";
const targetMembershipId = "organization-membership-target";
const AT = "2026-01-01T00:00:00.000Z";

type Call = { method: string; url: URL; body: unknown; cookie: string | null; idempotencyKey: string | null };
let calls: Call[] = [];
/** method + pathname -> [status, body]. The route table under test resolves the path. */
let routes: Map<string, [number, unknown]>;

function item(data: unknown): unknown {
  return { data, meta: { contractVersion: "M0.1" } };
}
function collection(rows: readonly unknown[]): unknown {
  return { data: rows, page: { cursor: null, nextCursor: null, limit: rows.length, hasMore: false, total: rows.length } };
}
function fault(code: string): unknown {
  return { error: { code, title: "forbidden", body: upstreamSecret, errorId: "e", traceRef: "t", version: "1" } };
}

function organization(scope: typeof primary, overrides: Record<string, unknown> = {}) {
  return {
    id: scope.organizationId,
    slug: scope.organizationSlug,
    name: `${scope.organizationSlug} Organization`,
    archivedAt: null,
    createdAt: AT,
    membership: { id: `m-${scope.organizationSlug}`, role: "OWNER", deactivatedAt: null },
    ...overrides,
  };
}

function project(scope: typeof primary, overrides: Record<string, unknown> = {}) {
  return {
    id: scope.projectId,
    organizationId: scope.organizationId,
    slug: scope.projectSlug,
    name: `${scope.projectSlug} Project`,
    archivedAt: null,
    createdAt: AT,
    through: "organization-admin",
    environments: [
      { id: scope.environmentId, slug: scope.environmentSlug, name: "Production", createdAt: AT },
    ],
    ...overrides,
  };
}

function serve(method: string, pathname: string, status: number, body: unknown) {
  routes.set(`${method} ${pathname}`, [status, body]);
}

function params() {
  return { organizationSlug: primary.organizationSlug, projectParam: primary.projectSlug };
}

function loaderArgs(path: string, routeParams = params()): LoaderFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`, {
      headers: { Cookie: "platos_operator_session=Im9wZXJhdG9yLXRva2VuIg" },
    }),
    params: routeParams,
    context: {},
  };
}

function actionArgs(path: string, body: URLSearchParams, routeParams = params()): ActionFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`, {
      method: "POST",
      body,
      headers: { Cookie: "platos_operator_session=Im9wZXJhdG9yLXRva2VuIg" },
    }),
    params: routeParams,
    context: {},
  };
}

async function thrownResponse(operation: () => Promise<unknown>) {
  try {
    const result = await operation();
    if (result instanceof Response) return result;
    throw new Error("Expected route handler to return or throw a Response");
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

function dispatched(method: string, pathname: string): Call | undefined {
  return calls.find((call) => call.method === method && call.url.pathname === pathname);
}

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  routes = new Map();
  requireOperator.mockResolvedValue({
    session: { effectiveUserId: primary.userId, actorUserId: primary.userId, email: "operator@example.test" },
    userId: primary.userId,
    actorUserId: primary.userId,
    email: "operator@example.test",
  });
  serve("GET", "/api/v1/organizations", 200, collection([organization(primary)]));
  serve("GET", "/api/v1/projects", 200, collection([project(primary)]));
  serve("POST", "/api/v1/organizations", 201, item(organization(primary)));
  serve("POST", "/api/v1/projects", 201, item({
    project: project(primary),
    environment: { id: primary.environmentId, slug: primary.environmentSlug, name: "Production", createdAt: AT },
    membership: { id: "project-membership-alpha", role: "ADMIN" },
  }));
  serve("GET", `/api/v1/organizations/${primary.organizationId}/members`, 200, collection([
    { membershipId: targetMembershipId, userId: primary.userId, role: "MEMBER", createdAt: AT, email: "member@example.test", displayName: "Member", accountDisabledAt: null },
  ]));
  serve("PATCH", `/api/v1/organizations/${primary.organizationId}/members/${targetMembershipId}`, 200, item({ changed: true }));
  serve("POST", `/api/v1/organizations/${primary.organizationId}/invitations`, 201, item({
    invitationId: "invitation-safe-id",
    expiresAt: AT,
    supersededCount: 0,
  }));

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      cookie: headers["Cookie"] ?? null,
      idempotencyKey: headers["Idempotency-Key"] ?? null,
    });
    const served = routes.get(`${method} ${url.pathname}`);
    if (served === undefined) return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify(served[1]), {
      status: served[0],
      headers: { "Content-Type": "application/json" },
    });
  }));
});

describe("authenticated Organization and Project route evidence", () => {
  it.each([
    ["route-002", () => homeLoader(loaderArgs("/"))],
    ["route-004", () => organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`))],
    ["route-005", () => invitationAction(actionArgs(`/orgs/${primary.organizationSlug}/invite`, new URLSearchParams({ email: "member@example.test" })))],
    ["route-006", () => projectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}`))],
    ["route-073", () => teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`))],
    ["route-074", () => newProjectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/new`))],
    ["route-075", () => newOrganizationAction(actionArgs("/orgs/new", new URLSearchParams({ name: "Alpha Organization" })))],
  ] as const)("%s rejects an unauthenticated operator before any core-api call", async (_routeId, operation) => {
    requireOperator.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/login" } }));
    const response = await thrownResponse(operation);
    expect(response.status).toBe(302);
    expect(calls, "an unauthenticated request must reach core-api not at all").toEqual([]);
  });

  it("every dispatched call carries the operator's own cookie and no service credential", async () => {
    await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.origin).toBe("http://core.invalid");
      expect(call.cookie).toBe("platos_operator_session=Im9wZXJhdG9yLXRva2VuIg");
      expect(JSON.stringify(call)).not.toContain("SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL");
    }
  });

  it("route-002 lands on the oldest visible Organization, Project and Environment", async () => {
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    );
    expect(dispatched("GET", "/api/v1/organizations")).toBeDefined();
    expect(dispatched("GET", "/api/v1/projects")).toBeDefined();
  });

  it("route-002 skips an Organization with no landable Project", async () => {
    serve("GET", "/api/v1/organizations", 200, collection([organization(secondary), organization(primary)]));
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(response.headers.get("Location")).toContain(`/orgs/${primary.organizationSlug}/`);
  });

  it("route-002 sends an operator with no complete active ancestry to Organization creation", async () => {
    serve("GET", "/api/v1/projects", 200, collection([]));
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/orgs/new");
  });

  it("route-002 skips a Project whose Environments are all archived", async () => {
    serve("GET", "/api/v1/projects", 200, collection([project(primary, { environments: [] })]));
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(response.headers.get("Location")).toBe("/orgs/new");
  });

  it("route-004 renders only the visible Projects of the addressed Organization", async () => {
    serve("GET", "/api/v1/projects", 200, collection([
      project(primary),
      project(secondary, { organizationId: secondary.organizationId }),
    ]));
    const response = await organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`));
    const serialized = JSON.stringify(await response.json());
    expect(response.status).toBe(200);
    expect(serialized).toContain(primary.projectId);
    expect(serialized).toContain(primary.environmentId);
    expect(serialized).not.toContain(secondary.projectId);
    expect(serialized).not.toContain(authSecret);
  });

  it("route-004 hides an Organization the operator cannot reach behind a stable 404", async () => {
    const response = await thrownResponse(() => organizationLoader(loaderArgs(
      `/orgs/${secondary.organizationSlug}`,
      { ...params(), organizationSlug: secondary.organizationSlug },
    )));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  it("route-005 issues a normalized MEMBER invitation against the resolved Organization", async () => {
    const response = await invitationAction(actionArgs(
      `/orgs/${primary.organizationSlug}/invite`,
      new URLSearchParams({ email: "  MEMBER@Example.Test " }),
    ));
    const serialized = JSON.stringify(await response.json());
    expect(dispatched("POST", `/api/v1/organizations/${primary.organizationId}/invitations`)?.body).toEqual({
      email: "member@example.test",
      role: "MEMBER",
    });
    expect(serialized).toBe(JSON.stringify({ ok: true, invitationId: "invitation-safe-id" }));
    expect(serialized).not.toContain(authSecret);
  });

  it("route-005 answers 403 for an Organization the operator cannot reach, without issuing", async () => {
    const response = await thrownResponse(() => invitationAction(actionArgs(
      `/orgs/${secondary.organizationSlug}/invite`,
      new URLSearchParams({ email: "member@example.test" }),
      { ...params(), organizationSlug: secondary.organizationSlug },
    )));
    expect(response.status).toBe(403);
    expect(calls.some((call) => call.url.pathname.endsWith("/invitations"))).toBe(false);
  });

  it("route-005 carries D1's own refusal through as 403", async () => {
    serve("POST", `/api/v1/organizations/${primary.organizationId}/invitations`, 403, fault("TENANCY_INVITATION_FORBIDDEN"));
    const response = await thrownResponse(() => invitationAction(actionArgs(
      `/orgs/${primary.organizationSlug}/invite`,
      new URLSearchParams({ email: "member@example.test" }),
    )));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(upstreamSecret);
  });

  it("route-005 rejects a malformed invitation form before dispatching", async () => {
    const response = await thrownResponse(() => invitationAction(actionArgs(
      `/orgs/${primary.organizationSlug}/invite`,
      new URLSearchParams({ email: "not-an-email" }),
    )));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Valid email is required");
    expect(calls.some((call) => call.url.pathname.endsWith("/invitations"))).toBe(false);
  });

  it("route-006 resolves a visible Project to its first Environment", async () => {
    const response = await thrownResponse(() => projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}`,
    )));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    );
  });

  it("route-006 hides a Project the operator cannot see, and does not authorize nested paths twice", async () => {
    const foreign = await thrownResponse(() => projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${secondary.projectSlug}`,
      { ...params(), projectParam: secondary.projectSlug },
    )));
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).toBe("Project not found");

    calls = [];
    const nested = await projectLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    ));
    expect(nested).toBeNull();
    expect(requireOperator).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("route-073 lists members through the contract's own OWNER/ADMIN gate", async () => {
    const response = await teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`));
    const serialized = JSON.stringify(await response.json());
    expect(dispatched("GET", `/api/v1/organizations/${primary.organizationId}/members`)).toBeDefined();
    expect(serialized).toContain("member@example.test");
    expect(serialized).not.toContain(authSecret);
  });

  it("route-073 answers 403 when the member listing refuses, and reflects nothing", async () => {
    serve("GET", `/api/v1/organizations/${primary.organizationId}/members`, 403, fault("TENANCY_MEMBER_LIST_FORBIDDEN"));
    const response = await thrownResponse(() => teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`)));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  it("route-073 applies a validated Organization membership role change", async () => {
    const response = await teamAction(actionArgs(
      `/orgs/${primary.organizationSlug}/settings/team`,
      new URLSearchParams({ membershipId: targetMembershipId, role: "ADMIN" }),
    ));
    expect(response.status).toBe(200);
    const call = dispatched("PATCH", `/api/v1/organizations/${primary.organizationId}/members/${targetMembershipId}`);
    expect(call?.body).toEqual({ role: "ADMIN" });
  });

  it.each([
    ["missing membership", { role: "ADMIN" }, "Membership is required"],
    ["invalid role", { membershipId: targetMembershipId, role: "ROOT" }, "Invalid role"],
  ])("route-073 rejects a %s form before dispatching a role change", async (_case, values, message) => {
    const response = await thrownResponse(() => teamAction(actionArgs(
      `/orgs/${primary.organizationSlug}/settings/team`,
      new URLSearchParams(values),
    )));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(message);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("route-074 creates a Project in one call and lands on its first Environment", async () => {
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/new`,
      new URLSearchParams({ name: "Alpha Project", environment: "Production" }),
    )));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agents`,
    );
    // ONE CALL, NOT A TRANSACTION THIS PROCESS DRIVES. The project, its first
    // environment and the creator's ADMIN membership are one unit of work on the
    // other side; this route sends five fields and knows nothing about the three
    // rows.
    expect(dispatched("POST", "/api/v1/projects")?.body).toEqual({
      organizationId: primary.organizationId,
      name: "Alpha Project",
      slug: "alpha-project",
      environmentName: "Production",
      environmentSlug: "production",
    });
  });

  it.each([
    ["empty Project name", { name: "", environment: "Production" }, "Project name and slug are required"],
    ["empty Environment name", { name: "Alpha", environment: "" }, "Environment name is required"],
    ["invalid explicit slug", { name: "Alpha", slug: "!!!", environment: "Production" }, "Project name and slug are required"],
  ])("route-074 rejects %s before dispatching a create", async (_case, values, message) => {
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/new`,
      new URLSearchParams(values),
    )));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe(message);
    expect(calls.some((call) => call.method === "POST" && call.url.pathname === "/api/v1/projects")).toBe(false);
  });

  it("route-074 rejects a foreign Organization before creating state", async () => {
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${secondary.organizationSlug}/projects/new`,
      new URLSearchParams({ name: "Foreign", environment: "Production" }),
      { ...params(), organizationSlug: secondary.organizationSlug },
    )));
    expect(response.status).toBe(403);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("route-074 keeps the use case's own 403 rather than reporting a broken service", async () => {
    serve("POST", "/api/v1/projects", 403, fault("TENANCY_PROJECT_CREATION_FORBIDDEN"));
    const response = await thrownResponse(() => newProjectAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/new`,
      new URLSearchParams({ name: "Alpha Project", environment: "Production" }),
    )));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(upstreamSecret);
  });

  it("route-075 founds an Organization and sends the operator on to create a Project", async () => {
    const response = await thrownResponse(() => newOrganizationAction(actionArgs(
      "/orgs/new",
      new URLSearchParams({ name: "Alpha Organization" }),
    )));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/orgs/${primary.organizationSlug}/projects/new`);
    // THE OWNER ROLE IS NOT ON THE WIRE. `createOrganization` decides who founded
    // the organization; a body that carried a role would let a caller choose.
    expect(dispatched("POST", "/api/v1/organizations")?.body).toEqual({
      name: "Alpha Organization",
      slug: "alpha-organization",
    });
  });

  it.each([
    ["route-002", () => homeLoader(loaderArgs("/")), () => serve("GET", "/api/v1/organizations", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Organizations unavailable"],
    ["route-004", () => organizationLoader(loaderArgs(`/orgs/${primary.organizationSlug}`)), () => serve("GET", "/api/v1/projects", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Organization unavailable"],
    ["route-005", () => invitationAction(actionArgs(`/orgs/${primary.organizationSlug}/invite`, new URLSearchParams({ email: "member@example.test" }))), () => serve("GET", "/api/v1/organizations", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Invitation service is unavailable"],
    ["route-005 mint", () => invitationAction(actionArgs(`/orgs/${primary.organizationSlug}/invite`, new URLSearchParams({ email: "member@example.test" }))), () => serve("POST", `/api/v1/organizations/${primary.organizationId}/invitations`, 503, fault("TENANCY_STORE_UNAVAILABLE")), "Invitation service is unavailable"],
    ["route-006", () => projectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}`)), () => serve("GET", "/api/v1/projects", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Project unavailable"],
    ["route-073", () => teamLoader(loaderArgs(`/orgs/${primary.organizationSlug}/settings/team`)), () => serve("GET", `/api/v1/organizations/${primary.organizationId}/members`, 503, fault("TENANCY_STORE_UNAVAILABLE")), "Team unavailable"],
    ["route-073 change", () => teamAction(actionArgs(`/orgs/${primary.organizationSlug}/settings/team`, new URLSearchParams({ membershipId: targetMembershipId, role: "ADMIN" }))), () => serve("PATCH", `/api/v1/organizations/${primary.organizationId}/members/${targetMembershipId}`, 503, fault("TENANCY_STORE_UNAVAILABLE")), "Membership update failed"],
    ["route-074 membership", () => newProjectLoader(loaderArgs(`/orgs/${primary.organizationSlug}/projects/new`)), () => serve("GET", "/api/v1/organizations", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Project creation unavailable"],
    ["route-074 create", () => newProjectAction(actionArgs(`/orgs/${primary.organizationSlug}/projects/new`, new URLSearchParams({ name: "Alpha Project", environment: "Production" }))), () => serve("POST", "/api/v1/projects", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Project creation failed"],
    ["route-075", () => newOrganizationAction(actionArgs("/orgs/new", new URLSearchParams({ name: "Alpha Organization" }))), () => serve("POST", "/api/v1/organizations", 503, fault("TENANCY_STORE_UNAVAILABLE")), "Organization creation failed"],
  ] as const)("%s serializes a stable failure without core-api fault detail", async (_case, operation, fail, stableMessage) => {
    fail();
    const response = await thrownResponse(operation);
    const serialized = await response.text();
    expect(response.status).toBeGreaterThanOrEqual(403);
    expect(serialized).toBe(stableMessage);
    expect(serialized).not.toContain(upstreamSecret);
    expect(serialized).not.toContain(authSecret);
  });

  it("a core-api that cannot be reached at all is a 503, not a crash", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error(upstreamSecret));
    const response = await thrownResponse(() => homeLoader(loaderArgs("/")));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(upstreamSecret);
  });
});
