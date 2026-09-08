import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AgentBindingDirectory } from "../agent-runtime/agent-binding.directory";
import { PublicGuestTokenController } from "./public-guest-token.controller";

const environmentId = "11111111-1111-4111-8111-111111111111";

/**
 * WIN-258 T6. The harness now drives the REAL `AgentBindingDirectory` over a
 * fake client instead of stubbing the controller's own field.
 *
 * That matters for exactly the reason this programme's fourth lesson records:
 * a double that stands in for the code under test asserts nothing about it. The
 * previous version assigned `controller.prisma` and asserted on
 * `agentBinding.findMany` — so it would have passed unchanged if the visibility
 * rule, the `isActive` check or the scope projection had been deleted outright,
 * because the controller was the only thing between the fake and the assertion.
 * Injecting the directory puts the query shape, the `isActive` filter and both
 * spellings of the public-guest rule INSIDE the system under test.
 */
function harness() {
  const findMany = vi.fn();
  const directory = new AgentBindingDirectory({ agentBinding: { findMany } } as never);
  const controller: any = Object.create(PublicGuestTokenController.prototype);
  controller.agentBindings = directory;
  controller.redis = {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
  controller.authService = {
    createPlatformSessionToken: vi.fn().mockResolvedValue("signed-guest-token"),
  };
  const req = { headers: {}, socket: { remoteAddress: "127.0.0.1" } } as any;
  return { controller, req, findMany };
}

function binding(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

describe("PublicGuestTokenController Environment binding", () => {
  it("requires Environment identity before querying bindings", async () => {
    const { controller, req, findMany } = harness();

    const error = await controller.mint(req, { agentId: "agent-1" }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("mints only from the requested public deployment", async () => {
    const { controller, req, findMany } = harness();
    findMany.mockResolvedValue([binding()]);

    const result = await controller.mint(req, { agentId: "agent-1", environmentId });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { agentId: "agent-1", environmentId },
    }));
    expect(controller.authService.createPlatformSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, projectId: "project-1", organizationId: "organization-1" }),
      expect.any(Number),
    );
    expect(result).toMatchObject({ agentId: "agent-1", environmentId, token: "signed-guest-token" });
  });

  // --- the rules the previous harness could not reach ------------------------
  //
  // Each of these three fails if the corresponding line in the directory is
  // removed. Under the old harness all three passed vacuously, because the
  // filtering happened in the double.

  it("refuses an inactive agent even when the deployment is public-guest", async () => {
    const { controller, req, findMany } = harness();
    findMany.mockResolvedValue([binding({ agent: { id: "agent-1", isActive: false } })]);

    const error = await controller
      .mint(req, { agentId: "agent-1", environmentId })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
  });

  it("refuses a private deployment rather than distinguishing it from a missing one", async () => {
    const { controller, req, findMany } = harness();
    findMany.mockResolvedValue([
      binding({
        activeAgentVersion: {
          memoryConfig: { __runtime: { visibility: "private" } },
          toolsBlockConfig: {},
        },
      }),
    ]);

    const error = await controller
      .mint(req, { agentId: "agent-1", environmentId })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(404);
  });

  it("accepts the toolsBlockConfig spelling of the visibility rule", async () => {
    const { controller, req, findMany } = harness();
    findMany.mockResolvedValue([
      binding({
        activeAgentVersion: {
          memoryConfig: {},
          toolsBlockConfig: { visibility: "public-guest" },
        },
      }),
    ]);

    const result = await controller.mint(req, { agentId: "agent-1", environmentId });

    expect(result).toMatchObject({ agentId: "agent-1", token: "signed-guest-token" });
  });
});
