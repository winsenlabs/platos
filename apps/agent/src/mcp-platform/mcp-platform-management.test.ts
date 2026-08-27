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
    verifyById: vi.fn(),
  };
  controller.oauth = { verifyAccessTokenHash: vi.fn() };
  controller.redis = {
    get: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(1),
  };
  controller.router = { handle: vi.fn() };
  return controller;
}

function responseHarness() {
  const response: any = {
    status: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

describe("McpPlatformController management", () => {
  it("rejects end-user token inventory access", async () => {
    const controller = harness();
    await expect(
      controller.listTokens({ scope: { ...operatorScope, principal: "end-user" } })
    ).rejects.toMatchObject({ status: 403 });
    expect(controller.tokenService.list).not.toHaveBeenCalled();
  });

  it("returns one stable scoped not-found error for revoke", async () => {
    const controller = harness();
    controller.tokenService.revoke.mockResolvedValue(false);

    await expect(
      controller.revokeToken({ scope: operatorScope }, "foreign-token", undefined)
    ).rejects.toMatchObject({
      status: 404,
      response: { code: "MCP_TOKEN_NOT_FOUND", message: "MCP token not found" },
    });
  });

  it("rejects a revoked Platform token before dispatching an SSE message", async () => {
    const controller = harness();
    const response = responseHarness();
    controller.redis.get.mockResolvedValue(
      JSON.stringify({
        credential: { kind: "platform", tokenId: "token_1" },
      })
    );
    controller.tokenService.verifyById.mockResolvedValue(null);

    await controller.messages(
      "session_1",
      undefined,
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      response
    );

    expect(controller.tokenService.verifyById).toHaveBeenCalledWith("token_1");
    expect(response.status).toHaveBeenCalledWith(401);
    expect(controller.router.handle).not.toHaveBeenCalled();
    expect(controller.redis.del).toHaveBeenCalledWith("platos:mcp:platform:session:session_1");
  });

  it("routes an SSE response through Redis using freshly revalidated authority", async () => {
    const controller = harness();
    const response = responseHarness();
    const freshToken = {
      id: "token_1",
      scope: operatorScope,
      permissions: ["*"],
      mintedByUserId: operatorScope.userId,
      expiresAt: null,
      tier: "scope",
      credential: { kind: "platform", tokenId: "token_1" },
    };
    const request = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const rpcResponse = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    controller.redis.get.mockResolvedValue(
      JSON.stringify({
        credential: freshToken.credential,
      })
    );
    controller.tokenService.verifyById.mockResolvedValue(freshToken);
    controller.router.handle.mockResolvedValue(rpcResponse);

    await controller.messages("session_1", undefined, request, response);

    expect(response.status).toHaveBeenCalledWith(202);
    expect(controller.router.handle).toHaveBeenCalledWith(
      request,
      freshToken,
      expect.objectContaining({ approvalId: null })
    );
    expect(controller.redis.publish).toHaveBeenCalledWith(
      "platos:mcp:platform:sse:session_1",
      JSON.stringify(rpcResponse)
    );
  });
});
