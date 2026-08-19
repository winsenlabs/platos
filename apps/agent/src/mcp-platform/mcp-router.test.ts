import { describe, expect, it, vi } from "vitest";
import { McpRouter, RPC_ERRORS } from "./mcp-router";
import type { VerifiedToken } from "./token.service";

const token: VerifiedToken = {
  id: "token-1",
  scope: {
    organizationId: "org-1",
    projectId: "project-1",
    environmentId: "env-1",
  },
  permissions: ["harmless.*"],
  mintedByUserId: "user-1",
  expiresAt: null,
  tier: "scope",
};

function router() {
  return new McpRouter(
    {
      buildScope: (verified) => ({
        ...verified.scope,
        userId: verified.mintedByUserId,
      }),
    },
    {
      resolve: vi.fn().mockResolvedValue({
        state: "auto_allow",
        tier: 1,
        reason: "platform policy",
      }),
    } as any
  );
}

describe("McpRouter tools/call", () => {
  it("executes a harmless registered tool", async () => {
    const instance = router();
    const execute = vi.fn().mockResolvedValue({ ok: true });
    instance.register({
      name: "harmless.ping",
      description: "A harmless test tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute,
    });

    const response = await instance.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "harmless.ping", arguments: {} },
      },
      token
    );

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns a stable generic internal error without logging exception details", async () => {
    const instance = router();
    const secret = "Prisma P2022 ciphertext=sentinel-ciphertext";
    instance.register({
      name: "harmless.failure",
      description: "A failing test tool",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        throw new Error(secret);
      },
    });
    const error = vi.fn();
    (instance as any).logger = { error };

    const response = await instance.handle(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "harmless.failure", arguments: {} },
      },
      token
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: RPC_ERRORS.INTERNAL_ERROR, message: "internal error" },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(error).toHaveBeenCalledWith("Platform MCP request failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});
