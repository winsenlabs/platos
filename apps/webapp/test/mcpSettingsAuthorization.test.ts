import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn(),
  findProjectBySlug: vi.fn(),
  findEnvironmentById: vi.fn(),
  verifyProjectAccess: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("~/services/session.server", () => ({ requireUserId: mocks.requireUserId }));
vi.mock("~/models/project.server", () => ({ findProjectBySlug: mocks.findProjectBySlug }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentById: mocks.findEnvironmentById,
}));
vi.mock("~/services/platos/scopeVerify.server", () => ({
  verifyProjectAccess: mocks.verifyProjectAccess,
}));
vi.mock("~/db.server", () => ({
  prisma: { organizationMembership: { findFirst: vi.fn() } },
}));
vi.mock("~/utils/pathBuilder", () => ({
  EnvironmentParamSchema: { parse: (params: unknown) => params },
}));

import {
  action,
  loader,
} from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.integrations.mcp/route";

const params = {
  organizationSlug: "org",
  projectParam: "project-a",
  envParam: "env_1",
};

describe("MCP settings project authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.requireUserId.mockResolvedValue("user_1");
    mocks.findProjectBySlug.mockResolvedValue({ id: "project_a", organizationId: "org_1" });
    mocks.findEnvironmentById.mockResolvedValue({ id: "env_1" });
    mocks.verifyProjectAccess.mockResolvedValue(false);
  });

  it("denies a cross-project organization member before loader proxying", async () => {
    await expect(loader({
      params,
      request: new Request("https://platos.example/settings"),
      context: {},
    } as any)).rejects.toMatchObject({ status: 403 });
    expect(mocks.verifyProjectAccess).toHaveBeenCalledWith(
      { organizationId: "org_1", projectId: "project_a" },
      "user_1",
      "read",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("denies a cross-project organization member before action proxying", async () => {
    await expect(action({
      params,
      request: new Request("https://platos.example/settings", {
        method: "POST",
        body: new URLSearchParams({ intent: "mint" }),
      }),
      context: {},
    } as any)).rejects.toMatchObject({ status: 403 });
    expect(mocks.verifyProjectAccess).toHaveBeenCalledWith(
      { organizationId: "org_1", projectId: "project_a" },
      "user_1",
      "mutate",
    );
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
