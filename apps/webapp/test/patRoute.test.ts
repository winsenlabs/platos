import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateRequestWithPAT,
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
    authenticateRequestWithPAT: vi.fn(),
    prisma,
  };
});

vi.mock("~/db.server", () => ({ prisma }));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateRequestWithPAT,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { action as patAction } from "~/routes/api.v1.user.pat";

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
