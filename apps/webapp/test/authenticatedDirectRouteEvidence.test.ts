import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperatorScope } from "../../../tests/persisted-state-gate/fixture-contract";

// WIN-257 T8 — THESE ROUTES NO LONGER REACH A DATABASE, SO NEITHER DOES THIS
// SUITE. The `database` double with its `endUser` and `environmentVariable`
// delegates is gone: the end-user page is now `GET /environments/:id/end-users`
// and the two variable screens are the V1 secrets routes, all dispatched through
// `app/services/coreApi.server.ts`. The double is `fetch`, one level below the
// client, so the operation table really resolves each path and the assertions
// are about what went on the wire rather than about a `where` tree nothing
// executed.

const { requireEnvironmentScope } = vi.hoisted(() => ({ requireEnvironmentScope: vi.fn() }));

vi.mock("~/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("~/env.server", () => ({
  env: {
    NODE_ENV: "test",
    PLATOS_AGENT_API_URL: "http://agent.invalid",
    PLATOS_CORE_API_URL: "http://core.invalid",
    PLATOS_INTERNAL_AUTH_TOKEN: "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL",
  },
}));

import { loader as accountsLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-accounts._index/route";
import { loader as variablesLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables/route";
import { action as newVariableAction } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.environment-variables.new/route";
import { loader as memoryExportLoader } from "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.memories.export/route";

const primary = canonicalOperatorScope("alpha");
const secondary = canonicalOperatorScope("beta");
const internalCredential = "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL";
const submittedValue = "SENTINEL_SUBMITTED_PLAIN_VALUE";
/** A value core-api could put in a fault body. It must never reach a page. */
const upstreamSecret = "SENTINEL_CORE_API_FAULT_DETAIL";

function params() {
  return {
    organizationSlug: primary.organizationSlug,
    projectParam: primary.projectSlug,
    envParam: primary.environmentSlug,
  };
}

async function authorizeFixture({ organizationSlug, projectSlug, environmentSlug, access }: {
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
  access?: "metadata" | "secret:mutate";
}) {
  if (
    organizationSlug !== primary.organizationSlug ||
    projectSlug !== primary.projectSlug ||
    environmentSlug !== primary.environmentSlug
  ) throw new Response("Environment not found", { status: 404 });
  return {
    authorization: { role: "ADMIN", access, sessionMaterial: internalCredential },
    operator: { userId: primary.userId },
    scope: {
      organizationId: primary.organizationId,
      projectId: primary.projectId,
      environmentId: primary.environmentId,
      userId: primary.userId,
    },
  };
}

function loaderArgs(path: string): LoaderFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`),
    params: params(),
    context: {},
  };
}

function actionArgs(path: string, fields: Record<string, string>): ActionFunctionArgs {
  return {
    request: new Request(`https://dashboard.example${path}`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: params(),
    context: {},
  };
}

type Call = { method: string; url: URL; body: unknown; cookie: string | null };
let calls: Call[] = [];
let routes: Map<string, [number, unknown]>;

function collection(rows: readonly unknown[], total = rows.length): unknown {
  return { data: rows, page: { cursor: null, nextCursor: null, limit: rows.length, hasMore: false, total } };
}
function item(data: unknown): unknown {
  return { data, meta: { contractVersion: "M0.1" } };
}
function fault(code: string): unknown {
  return { error: { code, title: "unavailable", body: upstreamSecret, errorId: "e", traceRef: "t", version: "1" } };
}
function serve(method: string, pathname: string, status: number, payload: unknown) {
  routes.set(`${method} ${pathname}`, [status, payload]);
}
function dispatched(method: string, pathname: string): Call | undefined {
  return calls.find((call) => call.method === method && call.url.pathname === pathname);
}

const endUsersPath = `/api/v1/environments/${primary.environmentId}/end-users`;
const variablesPath = `/api/v1/environments/${primary.environmentId}/variables`;

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  routes = new Map();
  requireEnvironmentScope.mockImplementation(authorizeFixture);
  serve("GET", endUsersPath, 200, collection([]));
  serve("GET", variablesPath, 200, collection([]));
  serve("PUT", `${variablesPath}/PUBLIC_NAME`, 200, item({
    id: "variable-1",
    key: "PUBLIC_NAME",
    kind: "PLAIN",
    value: submittedValue,
    hasSecret: false,
    version: 1,
    lastUpdatedBy: primary.userId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.origin === "http://core.invalid") {
      calls.push({
        method,
        url,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        cookie: headers["Cookie"] ?? null,
      });
      const served = routes.get(`${method} ${url.pathname}`);
      if (served === undefined) return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify(served[1]), { status: served[0], headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ memories: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

describe("authenticated V1-served route evidence", () => {
  it("pages Organization-owned EndUsers through the V1 end-user route", async () => {
    serve("GET", endUsersPath, 200, collection([{
      endUserId: primary.endUserId,
      displayName: "Ada",
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      identities: [{ issuer: "oidc", channel: "web", subject: "ada", verifiedAt: null, disabledAt: null }],
    }], 31));

    const response = await accountsLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts?page=2&pageSize=10&search=Ada&status=active`,
    ));
    const payload = await response.json();

    // THE SCOPE ON THE WIRE IS THE ONE THE AUTHORIZATION RESOLVED, never a slug
    // from the URL: the environment id is in the path and the page controls are
    // the screen's own.
    const call = dispatched("GET", endUsersPath);
    expect(call).toBeDefined();
    expect(Object.fromEntries(call!.url.searchParams)).toEqual({
      limit: "10",
      offset: "10",
      status: "active",
      search: "Ada",
    });
    expect(payload.panel.data.total).toBe(31);
    expect(payload.panel.data.pagination.hasNext).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(internalCredential);
  });

  it("refuses a malformed status filter before dispatching", async () => {
    await expect(accountsLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts?status=banana`,
    ))).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });

  it("renders the secrets context's own redaction rather than deciding one here", async () => {
    // `value: null` with `hasSecret: true` is what a credential-backed row looks
    // like on the V1 wire. The loader used to compute that from `credentialId`
    // one line away from the raw column; now it renders what it is given.
    serve("GET", variablesPath, 200, collection([
      { id: "credential-var", key: "API_KEY", kind: "SECRET", value: null, hasSecret: true, version: 1, lastUpdatedBy: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "plain-var", key: "PUBLIC_NAME", kind: "PLAIN", value: "visible", hasSecret: false, version: 1, lastUpdatedBy: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ]));

    const response = await variablesLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`,
    ));
    const serialized = JSON.stringify(await response.json());

    expect(dispatched("GET", variablesPath)).toBeDefined();
    expect(serialized).toContain("PUBLIC_NAME");
    expect(serialized).toContain("visible");
    expect(serialized).toContain('"present":true');
    expect(serialized).not.toContain(internalCredential);
  });

  it("writes a plain Environment value at the mutation access level without echoing it", async () => {
    const response = await newVariableAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables/new`,
      { key: "PUBLIC_NAME", value: submittedValue },
    ));
    const serialized = JSON.stringify(await response.json());

    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({ access: "secret:mutate" }));
    const call = dispatched("PUT", `${variablesPath}/PUBLIC_NAME`);
    expect(call?.body).toEqual({ value: submittedValue, secret: false });
    expect(response.status).toBe(200);
    // THE RESPONSE IS NOT THE RESOURCE. The V1 route answers with the row, which
    // carries the plaintext back for a PLAIN value; echoing it into a form
    // response would put the value in history, proxy logs and any screenshot.
    expect(serialized).toBe('{"ok":true}');
    expect(serialized).not.toContain(submittedValue);
  });

  it("returns stable non-reflective failures when core-api refuses", async () => {
    serve("GET", endUsersPath, 503, fault("IDENTITY_STORE_UNAVAILABLE"));
    await expect(accountsLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts`,
    ))).rejects.toMatchObject({ status: 503 });

    serve("GET", variablesPath, 503, fault("SECRETS_STORE_UNAVAILABLE"));
    await expect(variablesLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`,
    ))).rejects.toMatchObject({ status: 503 });

    serve("PUT", `${variablesPath}/PUBLIC_NAME`, 503, fault("SECRETS_STORE_UNAVAILABLE"));
    const response = await newVariableAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables/new`,
      { key: "PUBLIC_NAME", value: submittedValue },
    ));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(
      new RegExp(`${upstreamSecret}|SENTINEL_SUBMITTED_PLAIN_VALUE`),
    );
  });

  it("rejects unauthenticated and mixed scopes before reaching core-api", async () => {
    const cases = [
      [accountsLoader, loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts`)],
      [variablesLoader, loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`)],
    ] as const;
    for (const [loader, args] of cases) {
      requireEnvironmentScope.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/login" } }));
      await expect(loader(args)).rejects.toMatchObject({ status: 302 });
    }
    expect(calls).toEqual([]);

    for (const [key, value] of [
      ["organizationSlug", secondary.organizationSlug],
      ["projectParam", secondary.projectSlug],
      ["envParam", "foreign-environment"],
    ] as const) {
      const args = loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`);
      args.params = { ...args.params, [key]: value };
      await expect(variablesLoader(args)).rejects.toMatchObject({ status: 404 });
    }
    expect(calls).toEqual([]);
  });
});

describe("authenticated memory export route evidence", () => {
  it("propagates exact Environment, EndUser, and Agent identity through the canonical download link", async () => {
    const path = `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/memories/export?userId=${primary.endUserId}&agentId=${primary.agentId}`;
    const response = await memoryExportLoader(loaderArgs(path));

    expect(fetch).toHaveBeenCalledWith(
      `http://agent.invalid/api/v1/memory/export?userId=${primary.endUserId}`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Platos-Organization-Id": primary.organizationId,
          "X-Platos-Project-Id": primary.projectId,
          "X-Platos-Environment-Id": primary.environmentId,
          "X-Platos-Agent-Id": primary.agentId,
          "X-Platos-Internal-Auth": internalCredential,
        }),
      }),
    );
    expect(await response.text()).not.toContain(internalCredential);
  });

  it("returns a stable export failure without reflecting upstream details", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("SENTINEL_UPSTREAM_EXPORT_DETAILS", { status: 503 }));
    const path = `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/memories/export?userId=${primary.endUserId}&agentId=${primary.agentId}`;

    await expect(memoryExportLoader(loaderArgs(path))).rejects.toMatchObject({
      status: 503,
      statusText: "",
    });
  });
});
