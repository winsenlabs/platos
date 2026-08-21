import { describe, expect, it, vi } from "vitest";
import { MonitoringApprovalsService } from "./approvals.service";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
};

function approvalRow() {
  const now = new Date("2026-08-20T12:00:00.000Z");
  return {
    id: "approval-row-a",
    environmentId: scope.environmentId,
    agentId: "agent-a",
    threadId: "thread-a",
    action: "tickets.delete",
    details: null,
    status: "PENDING",
    timeoutSeconds: 300,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    respondedBy: null,
    comment: null,
    toolName: "tickets.delete",
    resolution: null,
    arguments: {
      __platosApproval: {
        approvalId: "approval-a",
        source: "mcp_tool_call",
        requestedBy: "user-a",
        requestHash: "request-hash-a",
        requestedByMcpTokenId: null,
        consumedAt: null,
        editedArgs: null,
        editedByUserId: null,
      },
      value: { ticketId: "ticket-old" },
    },
  };
}

describe("MonitoringApprovalsService resolution", () => {
  it("claims a pending approval once and persists the runtime-consumed edited args", async () => {
    let status = "PENDING";
    const row = approvalRow();
    const updateMany = vi.fn(async ({ data }: any) => {
      if (status !== "PENDING") return { count: 0 };
      status = data.status;
      return { count: 1 };
    });
    const prisma = {
      agentApproval: {
        findFirst: vi.fn(async () => ({ ...row, status })),
        updateMany,
      },
    };
    const service = new MonitoringApprovalsService(prisma as any);
    const input = {
      scope,
      approvalId: "approval-a",
      status: "approved" as const,
      respondedBy: "operator-a",
      editedArgs: { ticketId: "ticket-approved" },
      editedByUserId: "operator-a",
    };

    await expect(service.resolve(input)).resolves.toBe(true);
    await expect(service.resolve(input)).resolves.toBe(false);

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id, status: "PENDING" },
        data: expect.objectContaining({
          status: "APPROVED",
          arguments: expect.objectContaining({
            __platosApproval: expect.objectContaining({
              editedArgs: { ticketId: "ticket-approved" },
              editedByUserId: "operator-a",
            }),
          }),
        }),
      }),
    );
  });

  it("allows exactly one winner when two resolvers race", async () => {
    let status = "PENDING";
    const row = approvalRow();
    const prisma = {
      agentApproval: {
        findFirst: vi.fn(async () => ({ ...row, status })),
        updateMany: vi.fn(async ({ data }: any) => {
          if (status !== "PENDING") return { count: 0 };
          status = data.status;
          return { count: 1 };
        }),
      },
    };
    const service = new MonitoringApprovalsService(prisma as any);

    const results = await Promise.all([
      service.resolve({ scope, approvalId: "approval-a", status: "approved" }),
      service.resolve({ scope, approvalId: "approval-a", status: "rejected" }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(prisma.agentApproval.updateMany).toHaveBeenCalledTimes(2);
  });
});
