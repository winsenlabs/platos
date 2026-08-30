import { describe, expect, it, vi } from "vitest";
import { McpRouter, RPC_ERRORS } from "./mcp-router";
import type { VerifiedToken } from "./token.service";
import { buildMacroToolHandlers, MacroRecordingState } from "./tools/macros";

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
  it("never records or persists arguments for a non-recordable secret mutation", async () => {
    const instance = router();
    const state = new MacroRecordingState();
    instance.setMacroRecorder(state);
    instance.register({
      name: "harmless.secret",
      description: "Secret mutation",
      macroRecordable: false,
      inputSchema: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
      async execute() {
        return { ok: true };
      },
    });
    const recording = state.start(token);
    await instance.handle(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "harmless.secret", arguments: { value: "sentinel-macro-secret" } },
      },
      token,
    );
    expect(state.get(token)?.steps).toEqual([]);

    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: "macro-1",
      sharedWithOrganization: false,
      ...data,
    }));
    const stop = buildMacroToolHandlers({
      state,
      prisma: { macro: { create } } as any,
      getRouter: () => instance,
    }).find((handler) => handler.name === "macros.record_stop")!;
    await stop.execute(
      { recordingId: recording.recordingId, name: "safe macro" },
      { ...token.scope, userId: token.mintedByUserId },
      token,
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ steps: [] }),
    });
    expect(JSON.stringify(create.mock.calls)).not.toContain("sentinel-macro-secret");
  });

  it("passes cancellation separately while keeping legacy short-arity handlers compatible", async () => {
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

    const abort = new AbortController();
    const response = await instance.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "harmless.ping", arguments: {} },
      },
      token,
      { abortSignal: abort.signal },
    );

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[3]).toBe(abort.signal);
    expect(Object.keys(execute.mock.calls[0]?.[1] ?? {})).not.toContain("abortSignal");
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

  it("preserves the stable Memory 404 contract without exposing persistence details", async () => {
    const instance = router();
    instance.register({
      name: "harmless.memory_not_found",
      description: "Missing memory fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const error = new Error("private persistence detail");
        (error as any).code = "MEMORY_NOT_FOUND";
        (error as any).status = 404;
        throw error;
      },
    });

    const response = await instance.handle(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "harmless.memory_not_found", arguments: {} },
      },
      token,
    );

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: 404,
        message: "memory not found",
        data: { code: "MEMORY_NOT_FOUND", status: 404 },
      },
    });
    expect(JSON.stringify(response)).not.toContain("private persistence detail");
  });
});
