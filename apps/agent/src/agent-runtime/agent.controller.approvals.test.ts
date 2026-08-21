import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "environment-a",
  userId: "operator-a",
  principal: "operator" as const,
};

function controllerHarness(initial: Record<string, unknown>) {
  const rpush = vi.fn().mockResolvedValue(1);
  const expire = vi.fn().mockResolvedValue(1);
  const publish = vi.fn().mockResolvedValue(1);
  const getById = vi.fn().mockResolvedValue(initial);
  const resolve = vi.fn().mockResolvedValue(true);
  const controller: any = Object.create(AgentController.prototype);
  controller.approvalsService = { getById, resolve };
  controller.agentService = { redis: { rpush, expire, publish } };
  return {
    controller,
    req: { scope } as any,
    approvals: { getById, resolve },
    redis: { rpush, expire, publish },
  };
}

describe("AgentController approval resolution", () => {
  it("persists before waking Redis and sends the actual edited args", async () => {
    const harness = controllerHarness({
      approvalId: "approval-a",
      status: "pending",
      requestedBy: "user-a",
      editedArgs: null,
    });

    const result = await harness.controller.resolveApproval(harness.req, "approval-a", {
      approved: true,
      comment: "Use the corrected ticket",
      editedArgs: { ticketId: "ticket-approved" },
    });

    expect(result).toEqual({
      resolved: true,
      approvalId: "approval-a",
      approved: true,
      editedArgsApplied: true,
    });
    expect(harness.approvals.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-a",
        status: "approved",
        editedArgs: { ticketId: "ticket-approved" },
      }),
    );
    expect(harness.approvals.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      harness.redis.rpush.mock.invocationCallOrder[0],
    );
    const payload = JSON.parse(harness.redis.rpush.mock.calls[0][1]);
    expect(payload).toMatchObject({
      approved: true,
      editedArgsApplied: true,
      editedArgs: { ticketId: "ticket-approved" },
    });
  });

  it("returns a persisted outcome without replaying Redis side effects", async () => {
    const harness = controllerHarness({
      approvalId: "approval-a",
      status: "approved",
      requestedBy: "user-a",
      editedArgs: { ticketId: "ticket-approved" },
    });

    const result = await harness.controller.resolveApproval(harness.req, "approval-a", {
      approved: false,
    });

    expect(result).toMatchObject({
      resolved: true,
      approvalId: "approval-a",
      approved: true,
      status: "approved",
      persisted: true,
      editedArgsApplied: true,
    });
    expect(harness.approvals.resolve).not.toHaveBeenCalled();
    expect(harness.redis.rpush).not.toHaveBeenCalled();
    expect(harness.redis.publish).not.toHaveBeenCalled();
  });

  it("returns the winner's persisted decision when the atomic claim loses", async () => {
    const harness = controllerHarness({
      approvalId: "approval-a",
      status: "pending",
      requestedBy: "user-a",
      editedArgs: null,
    });
    harness.approvals.resolve.mockResolvedValue(false);
    harness.approvals.getById
      .mockResolvedValueOnce({
        approvalId: "approval-a",
        status: "pending",
        requestedBy: "user-a",
      })
      .mockResolvedValueOnce({
        approvalId: "approval-a",
        status: "rejected",
        requestedBy: "user-a",
      });

    const result = await harness.controller.resolveApproval(harness.req, "approval-a", {
      approved: true,
    });

    expect(result).toMatchObject({
      resolved: true,
      approvalId: "approval-a",
      approved: false,
      status: "rejected",
      persisted: true,
    });
    expect(harness.redis.rpush).not.toHaveBeenCalled();
  });

  it("does not wake Redis when persistence cannot be confirmed", async () => {
    const harness = controllerHarness({
      approvalId: "approval-a",
      status: "pending",
      requestedBy: "user-a",
    });
    harness.approvals.resolve.mockResolvedValue(false);

    const error = await harness.controller
      .resolveApproval(harness.req, "approval-a", { approved: true })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(harness.redis.rpush).not.toHaveBeenCalled();
    expect(harness.redis.publish).not.toHaveBeenCalled();
  });
});
