import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { PublicGuestTokenController } from "./public-guest-token.controller";

const environmentId = "11111111-1111-4111-8111-111111111111";

function harness() {
  const controller: any = Object.create(PublicGuestTokenController.prototype);
  controller.prisma = { agentBinding: { findMany: vi.fn() } };
  controller.redis = {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
  controller.authService = {
    createPlatformSessionToken: vi.fn().mockResolvedValue("signed-guest-token"),
  };
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
  return { controller, req };
}

describe("PublicGuestTokenController Environment binding", () => {
  it("requires Environment identity before querying bindings", async () => {
    const { controller, req } = harness();

    const error = await controller.mint(req, { agentId: "agent-1" }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(400);
    expect(controller.prisma.agentBinding.findMany).not.toHaveBeenCalled();
  });

  it("mints only from the requested public deployment", async () => {
    const { controller, req } = harness();
    controller.prisma.agentBinding.findMany.mockResolvedValue([{
      environmentId,
      agent: { id: "agent-1", isActive: true },
      environment: {
        projectId: "project-1",
        project: { organizationId: "organization-1" },
      },
      activeAgentVersion: {
        memoryConfig: { __runtime: { visibility: "public-guest" } },
        toolsBlockConfig: {},
      },
    }]);

    const result = await controller.mint(req, { agentId: "agent-1", environmentId });

    expect(controller.prisma.agentBinding.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentId: "agent-1", environmentId },
    }));
    expect(controller.authService.createPlatformSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, projectId: "project-1", organizationId: "organization-1" }),
      expect.any(Number),
    );
    expect(result).toMatchObject({ agentId: "agent-1", environmentId, token: "signed-guest-token" });
  });
});
