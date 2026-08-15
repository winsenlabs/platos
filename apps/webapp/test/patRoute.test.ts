import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateRequest,
  authenticateRequestWithPAT,
  createProject,
  makeSetMultipleFlags,
  prisma,
} = vi.hoisted(() => {
  const prisma: any = {
    organization: { findFirst: vi.fn() },
    platosCredentialAudit: { create: vi.fn() },
    platosPAT: {
      create: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    project: { findFirst: vi.fn() },
    runtimeEnvironment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    user: { findFirst: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));

  return {
    authenticateRequest: vi.fn(),
    authenticateRequestWithPAT: vi.fn(),
    createProject: vi.fn(),
    makeSetMultipleFlags: vi.fn(),
    prisma,
  };
});

vi.mock("~/db.server", () => ({ prisma }));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateRequest,
  authenticateRequestWithPAT,
}));
vi.mock("~/models/project.server", () => ({ createProject }));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/upsertBranch.server", () => ({
  UpsertBranchService: vi.fn(),
}));
vi.mock("~/v3/featureFlags.server", () => ({ makeSetMultipleFlags }));

import { action as adminFeatureFlagsAction } from "~/routes/admin.api.v1.feature-flags";
import { action as projectWriteAction } from "~/routes/api.v1.orgs.$orgParam.projects";
import { action as scopedProjectAction } from "~/routes/api.v1.projects.$projectRef.branches";
import { action as patAction } from "~/routes/api.v1.user.pat";

const READ_PAT = "plt_pat_read_route";
const WRITE_PAT = "plt_pat_write_route";

function seedPAT(
  raw: string,
  role: "read" | "write" | "admin",
  scope: {
    organizationId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  } = {}
) {
  prisma.platosPAT.findFirst.mockResolvedValue({
    id: `pat_${role}`,
    tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
    userId: "user_1",
    organizationId: scope.organizationId ?? null,
    projectId: scope.projectId ?? null,
    environmentId: scope.environmentId ?? null,
    role,
    expiresAt: null,
    revokedAt: null,
  });
}

function bearerRequest(url: string, method: string, token: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("PAT mint route delegation policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
      callback(prisma)
    );
    prisma.platosPAT.updateMany.mockResolvedValue({ count: 1 });
    authenticateRequestWithPAT.mockResolvedValue({
      userId: "user_1",
      pat: {
        id: "parent_pat",
        userId: "user_1",
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: "env_1",
        role: "read",
        expiresAt: null,
      },
    });
  });

  it.each([
    {
      name: "role escalation",
      body: { name: "admin child", role: "admin" },
    },
    {
      name: "scope broadening",
      body: { name: "broad child", role: "read", scope: { orgId: null } },
    },
  ])("prohibits PAT-authenticated child minting for $name", async ({ body }) => {
    const response = await patAction({
      request: new Request("https://platos.example/api/v1/user/pat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    } as any);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "PAT-authenticated requests cannot mint child PATs",
    });
    expect(prisma.platosPAT.create).not.toHaveBeenCalled();
  });
});

describe("PAT route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
      callback(prisma)
    );
    prisma.platosPAT.updateMany.mockResolvedValue({ count: 1 });
  });

  it("denies a project write authenticated by a read PAT", async () => {
    seedPAT(READ_PAT, "read", { organizationId: "org_1" });

    const response = await projectWriteAction({
      request: bearerRequest(
        "https://platos.example/api/v1/orgs/org-one/projects",
        "POST",
        READ_PAT,
        { name: "Denied project" }
      ),
      params: { orgParam: "org-one" },
    } as any);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid or Missing Access Token" });
    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("denies a project mutation outside the PAT scope", async () => {
    authenticateRequest.mockResolvedValue({
      type: "personalAccessToken",
      result: {
        id: "pat_write",
        userId: "user_1",
        organizationId: "org_1",
        projectId: "project_1",
        environmentId: null,
        role: "write",
        expiresAt: null,
      },
    });
    prisma.project.findFirst.mockResolvedValue({
      id: "project_2",
      organizationId: "org_1",
    });

    const response = await scopedProjectAction({
      request: bearerRequest(
        "https://platos.example/api/v1/projects/proj_other/branches",
        "POST",
        WRITE_PAT,
        { branch: "feature/denied" }
      ),
      params: { projectRef: "proj_other" },
    } as any);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Personal access token scope does not permit this project",
    });
    expect(prisma.runtimeEnvironment.findFirst).not.toHaveBeenCalled();
  });

  it("denies an admin mutation without the admin PAT capability", async () => {
    seedPAT(WRITE_PAT, "write", { organizationId: "org_1" });

    const response = await adminFeatureFlagsAction({
      request: bearerRequest(
        "https://platos.example/admin/api/v1/feature-flags",
        "POST",
        WRITE_PAT,
        {}
      ),
      params: {},
    } as any);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid or Missing API key" });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(makeSetMultipleFlags).not.toHaveBeenCalled();
  });
});
