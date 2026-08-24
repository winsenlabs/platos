import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOperatorScope } from "../../../tests/persisted-state-gate/fixture-contract";

const { database, requireEnvironmentScope } = vi.hoisted(() => ({
  database: {
    endUser: { findMany: vi.fn(), count: vi.fn() },
    environmentVariable: { findMany: vi.fn(), upsert: vi.fn() },
  },
  requireEnvironmentScope: vi.fn(),
}));

vi.mock("~/services/database.server", () => ({ database }));
vi.mock("~/services/auth.server", () => ({ requireEnvironmentScope }));
vi.mock("~/env.server", () => ({
  env: {
    PLATOS_AGENT_API_URL: "http://agent.invalid",
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

beforeEach(() => {
  vi.clearAllMocks();
  requireEnvironmentScope.mockImplementation(authorizeFixture);
  database.endUser.findMany.mockResolvedValue([]);
  database.endUser.count.mockResolvedValue(0);
  database.environmentVariable.findMany.mockResolvedValue([]);
  database.environmentVariable.upsert.mockResolvedValue({ id: "variable-1" });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ memories: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })));
});

describe("authenticated direct database route evidence", () => {
  it("pages Organization-owned EndUsers through canonical authenticated IDs", async () => {
    database.endUser.findMany.mockResolvedValueOnce([{
      id: primary.endUserId,
      displayName: "Ada",
      disabledAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      identities: [{ issuer: "oidc", channel: "web", subject: "ada", verifiedAt: null, disabledAt: null }],
    }]);
    database.endUser.count.mockResolvedValueOnce(31);

    const response = await accountsLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts?page=2&pageSize=10&search=Ada&status=active`,
    ));
    const payload = await response.json();

    expect(database.endUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId: primary.organizationId, disabledAt: null }),
      take: 10,
      skip: 10,
    }));
    expect(database.endUser.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ organizationId: primary.organizationId, disabledAt: null }),
    });
    expect(payload.panel.data.total).toBe(31);
    expect(payload.panel.data.pagination.hasNext).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(internalCredential);
  });

  it("redacts Credential-backed Environment values from the complete loader payload", async () => {
    database.environmentVariable.findMany.mockResolvedValueOnce([
      { id: "credential-var", key: "API_KEY", kind: "SECRET", value: "SENTINEL_STORED_CREDENTIAL", credentialId: "credential-1", version: 1, updatedAt: new Date() },
      { id: "plain-var", key: "PUBLIC_NAME", kind: "PLAIN", value: "visible", credentialId: null, version: 1, updatedAt: new Date() },
    ]);

    const response = await variablesLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`,
    ));
    const serialized = JSON.stringify(await response.json());

    expect(database.environmentVariable.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { environmentId: primary.environmentId },
    }));
    expect(serialized).toContain("PUBLIC_NAME");
    expect(serialized).toContain("visible");
    expect(serialized).not.toContain("SENTINEL_STORED_CREDENTIAL");
    expect(serialized).not.toContain(internalCredential);
  });

  it("writes a plain Environment value with exact mutation authorization without echoing it", async () => {
    const response = await newVariableAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables/new`,
      { key: "PUBLIC_NAME", value: submittedValue },
    ));
    const serialized = JSON.stringify(await response.json());

    expect(requireEnvironmentScope).toHaveBeenCalledWith(expect.objectContaining({ access: "secret:mutate" }));
    expect(database.environmentVariable.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { environmentId_key: { environmentId: primary.environmentId, key: "PUBLIC_NAME" } },
      create: expect.objectContaining({ environmentId: primary.environmentId, value: submittedValue, lastUpdatedBy: primary.userId }),
    }));
    expect(response.status).toBe(200);
    expect(serialized).toBe('{"ok":true}');
    expect(serialized).not.toContain(submittedValue);
  });

  it("returns stable non-reflective database failures", async () => {
    database.endUser.findMany.mockRejectedValueOnce(new Error("SENTINEL_DATABASE_DETAILS"));
    await expect(accountsLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts`,
    ))).rejects.toMatchObject({ status: 503 });

    database.environmentVariable.findMany.mockRejectedValueOnce(new Error("SENTINEL_DATABASE_DETAILS"));
    await expect(variablesLoader(loaderArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`,
    ))).rejects.toMatchObject({ status: 503 });

    database.environmentVariable.upsert.mockRejectedValueOnce(new Error("SENTINEL_DATABASE_DETAILS"));
    const response = await newVariableAction(actionArgs(
      `/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables/new`,
      { key: "PUBLIC_NAME", value: submittedValue },
    ));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/SENTINEL_DATABASE_DETAILS|SENTINEL_SUBMITTED_PLAIN_VALUE/);
  });

  it("rejects unauthenticated and mixed scopes before direct database access", async () => {
    const cases = [
      [accountsLoader, loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/agent-accounts`)],
      [variablesLoader, loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`)],
    ] as const;
    for (const [loader, args] of cases) {
      requireEnvironmentScope.mockRejectedValueOnce(new Response(null, { status: 302, headers: { Location: "/login" } }));
      await expect(loader(args)).rejects.toMatchObject({ status: 302 });
    }
    expect(database.endUser.findMany).not.toHaveBeenCalled();
    expect(database.environmentVariable.findMany).not.toHaveBeenCalled();

    for (const [key, value] of [
      ["organizationSlug", secondary.organizationSlug],
      ["projectParam", secondary.projectSlug],
      ["envParam", "foreign-environment"],
    ] as const) {
      const args = loaderArgs(`/orgs/${primary.organizationSlug}/projects/${primary.projectSlug}/env/${primary.environmentSlug}/environment-variables`);
      args.params = { ...args.params, [key]: value };
      await expect(variablesLoader(args)).rejects.toMatchObject({ status: 404 });
    }
    expect(database.environmentVariable.findMany).not.toHaveBeenCalled();
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
