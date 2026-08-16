import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const findFirst = vi.fn();
  const disconnect = vi.fn();
  const prisma = {
    job: {
      findFirst,
      updateMany: vi.fn(),
    },
    $disconnect: disconnect,
  };
  const PrismaClient = vi.fn(function (this: unknown) {
    return prisma;
  });
  return {
    findFirst,
    disconnect,
    prisma,
    PrismaClient,
    metadataSet: vi.fn(),
  };
});

vi.mock("@platos/tenancy-database", () => ({
  PrismaClient: mocks.PrismaClient,
}));

vi.mock("@trigger.dev/sdk", () => ({
  task: (definition: unknown) => definition,
  metadata: { set: mocks.metadataSet },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { platosCustomTask } from "./platos-custom-task";

describe("platos custom task Job lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue(null);
    mocks.disconnect.mockResolvedValue(undefined);
    mocks.metadataSet.mockResolvedValue(undefined);
  });

  it("fails closed unless the Job row id is active in the supplied canonical scope", async () => {
    const result = await (platosCustomTask as any).run({
      taskRowId: "job-row-a",
      payload: {},
      scope: {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
        userId: "user-a",
      },
      invokedBy: "agent",
      agentId: "agent-a",
    });

    expect(mocks.PrismaClient).toHaveBeenCalledWith({
      datasourceUrl: expect.any(String),
    });
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        id: "job-row-a",
        environmentId: "env-a",
        environment: {
          projectId: "project-a",
          project: { organizationId: "org-a" },
        },
        status: "ACTIVE",
      },
      select: {
        handler: true,
        externalId: true,
        timeoutSeconds: true,
        displayName: true,
      },
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "Task not found or inactive",
    });
    expect(mocks.disconnect).toHaveBeenCalledOnce();
  });
});
