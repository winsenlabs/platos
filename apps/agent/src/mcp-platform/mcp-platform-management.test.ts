import { describe, expect, it, vi } from "vitest";
import { McpPlatformController } from "./mcp-platform.controller";

const operatorScope = {
  organizationId: "org_1",
  projectId: "project_1",
  environmentId: "env_1",
  userId: "operator_1",
  principal: "operator" as const,
};

function harness() {
  const controller: any = Object.create(McpPlatformController.prototype);
  controller.tokenService = {
    revoke: vi.fn(),
    list: vi.fn(),
  };
  return controller;
}

describe("McpPlatformController management", () => {
  it("rejects end-user token inventory access", async () => {
    const controller = harness();
    await expect(controller.listTokens({ scope: { ...operatorScope, principal: "end-user" } }))
      .rejects.toMatchObject({ status: 403 });
    expect(controller.tokenService.list).not.toHaveBeenCalled();
  });

  it("returns one stable scoped not-found error for revoke", async () => {
    const controller = harness();
    controller.tokenService.revoke.mockResolvedValue(false);

    await expect(controller.revokeToken({ scope: operatorScope }, "foreign-token", undefined))
      .rejects.toMatchObject({
        status: 404,
        response: { code: "MCP_TOKEN_NOT_FOUND", message: "MCP token not found" },
      });
  });
});
