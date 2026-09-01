import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { McpPlatformController } from "./mcp-platform.controller";
import { McpRouter, RPC_ERRORS } from "./mcp-router";
import { closeStdioOwnedResources, withCleanupDeadline } from "./stdio-lifecycle";
import { runMcpStdioTransport } from "./stdio-transport";
import type { VerifiedToken } from "./token.service";

function verifiedToken(): VerifiedToken {
  return {
    id: "token-1",
    scope: {
      organizationId: "org-a",
      projectId: "project-a",
      environmentId: "env-a",
    },
    permissions: ["*"],
    mintedByUserId: "user-a",
    expiresAt: null,
    tier: "scope",
  };
}

describe("Platform MCP stdio transport", () => {
  it("re-verifies the raw bearer for every request and applies changed ancestry", async () => {
    const router = new McpRouter(
      {
        buildScope: (token) => ({
          ...token.scope,
          userId: token.mintedByUserId,
        }),
      },
      { resolve: async () => ({ state: "auto_allow", tier: 4, reason: "test" }) } as any
    );
    router.register({
      name: "platos.scope_probe",
      description: "probe",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_params, scope) {
        return scope;
      },
    });

    const controller = Object.create(McpPlatformController.prototype) as any;
    const changed = {
      ...verifiedToken(),
      scope: {
        organizationId: "org-b",
        projectId: "project-b",
        environmentId: "env-b",
      },
      mintedByUserId: "user-b",
    } satisfies VerifiedToken;
    controller.verifyAnyBearer = vi
      .fn()
      .mockResolvedValueOnce(verifiedToken())
      .mockResolvedValueOnce(changed);
    controller.getRouter = vi.fn(() => router);

    const session = await controller.createStdioSession("plt_mcp_secret");
    expect(controller.verifyAnyBearer).toHaveBeenCalledTimes(1);
    expect(controller.getRouter).toHaveBeenCalledTimes(1);
    expect(session).not.toBeNull();

    const response = await session!.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "platos.scope_probe", arguments: {} },
    });
    expect(response.error).toBeUndefined();
    expect(controller.verifyAnyBearer).toHaveBeenCalledTimes(2);
    expect(controller.verifyAnyBearer).toHaveBeenLastCalledWith("plt_mcp_secret");
    expect(JSON.stringify(response.result)).toContain("org-b");
    expect(JSON.stringify(response.result)).toContain("project-b");
    expect(JSON.stringify(response.result)).toContain("env-b");
    expect(JSON.stringify(response.result)).toContain("user-b");
  });

  it.each(["revoked", "expired"])("fails closed after a token becomes %s", async () => {
    const controller = Object.create(McpPlatformController.prototype) as any;
    controller.verifyAnyBearer = vi
      .fn()
      .mockResolvedValueOnce(verifiedToken())
      .mockResolvedValueOnce(null);
    controller.getRouter = vi.fn(() => ({ handle: vi.fn() }));

    const session = await controller.createStdioSession("plt_mcp_secret");
    const response = await session!.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: RPC_ERRORS.PERMISSION_DENIED,
        message: "invalid or expired Platform MCP token",
      },
    });
    expect(controller.getRouter().handle).not.toHaveBeenCalled();
  });

  it("applies persisted permission and tier changes on subsequent requests", async () => {
    const router = new McpRouter(
      {
        buildScope: (token) => ({ ...token.scope, userId: token.mintedByUserId }),
      },
      { resolve: async () => ({ state: "auto_allow", tier: 4, reason: "test" }) } as any
    );
    router.register({
      name: "admin.probe",
      description: "probe",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiresAdminTier: true,
      async execute() {
        return { ok: true };
      },
    });

    const controller = Object.create(McpPlatformController.prototype) as any;
    controller.verifyAnyBearer = vi
      .fn()
      .mockResolvedValueOnce(verifiedToken())
      .mockResolvedValueOnce({ ...verifiedToken(), tier: "admin" })
      .mockResolvedValueOnce({ ...verifiedToken(), tier: "scope" })
      .mockResolvedValueOnce({ ...verifiedToken(), tier: "admin", permissions: [] });
    controller.getRouter = vi.fn(() => router);
    const session = await controller.createStdioSession("plt_mcp_secret");

    const adminList = await session!.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.stringify(adminList.result)).toContain("admin.probe");

    const scopeList = await session!.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(JSON.stringify(scopeList.result)).not.toContain("admin.probe");

    const denied = await session!.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "admin.probe", arguments: {} },
    });
    expect(denied.error?.code).toBe(RPC_ERRORS.PERMISSION_DENIED);
  });

  it("extracts stdio approval metadata and strips it before router dispatch", async () => {
    const handle = vi.fn(async () => ({ jsonrpc: "2.0", id: 4, result: {} }));
    const controller = Object.create(McpPlatformController.prototype) as any;
    controller.verifyAnyBearer = vi.fn(async () => verifiedToken());
    controller.getRouter = vi.fn(() => ({ handle }));
    const session = await controller.createStdioSession("plt_mcp_secret");

    await session!.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "platos.scope_probe",
        arguments: { value: true },
        _meta: { platosApprovalId: "approval-1", ignored: "not-authority" },
      },
    });

    expect(handle).toHaveBeenCalledWith(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "platos.scope_probe", arguments: { value: true } },
      },
      verifiedToken(),
      expect.objectContaining({ approvalId: "approval-1" })
    );
  });

  it("advertises stdio retry metadata and completes an approved call idempotently", async () => {
    const row: any = {
      approvalId: "approval-1",
      toolName: "platos.approval_probe",
      status: "pending",
      expired: false,
      deadlineAt: new Date("2026-08-19T02:00:00.000Z"),
      consumedAt: null,
      resolution: null,
      editedArgs: null,
    };
    const gate = {
      get: vi.fn(async () => row),
      create: vi.fn(async () => row),
      markConsumed: vi.fn(async (_scope: unknown, _id: string, resolution: unknown) => {
        row.consumedAt = new Date();
        row.resolution = resolution;
      }),
      hash: vi.fn(() => "request-hash"),
    };
    const router = new McpRouter(
      { buildScope: (token) => ({ ...token.scope, userId: token.mintedByUserId }) },
      { resolve: async () => ({ state: "require_approval", tier: 1, reason: "test" }) } as any
    );
    router.setApprovalGate(gate as any);
    const execute = vi.fn(async () => ({ delivered: true }));
    router.register({
      name: "platos.approval_probe",
      description: "probe",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute,
    });
    const controller = Object.create(McpPlatformController.prototype) as any;
    controller.verifyAnyBearer = vi.fn(async () => verifiedToken());
    controller.getRouter = vi.fn(() => router);
    const session = await controller.createStdioSession("plt_mcp_secret");
    const call = (withApproval: boolean) =>
      session!.handle({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "platos.approval_probe",
          arguments: {},
          ...(withApproval ? { _meta: { platosApprovalId: "approval-1" } } : {}),
        },
      });

    const pending = await call(false);
    expect((pending.error?.data as any).retryMeta).toEqual({ platosApprovalId: "approval-1" });
    row.status = "approved";
    const delivered = await call(true);
    const replayed = await call(true);
    const content = delivered.result as { content: Array<{ text: string }> };
    expect(JSON.parse(content.content[0]!.text)).toEqual({ delivered: true });
    expect(replayed.result).toEqual(delivered.result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(gate.markConsumed).toHaveBeenCalledTimes(1);
  });

  it("frames line-delimited JSON-RPC and never responds to notifications", async () => {
    const input = new PassThrough();
    const output: string[] = [];
    const handle = vi.fn(async (request: any) => ({
      jsonrpc: "2.0" as const,
      id: request.id ?? null,
      result: { method: request.method },
    }));

    const running = runMcpStdioTransport({
      input,
      session: { handle },
      writeProtocolLine(line) {
        output.push(line);
      },
    });
    input.end(
      [
        "not-json",
        JSON.stringify({ nope: true }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
        "",
      ].join("\n")
    );
    await running;

    expect(handle).toHaveBeenCalledTimes(2);
    expect(output).toHaveLength(3);
    expect(output.every((line) => line.endsWith("\n"))).toBe(true);
    expect(JSON.parse(output[0]!).error.code).toBe(-32700);
    expect(JSON.parse(output[1]!).error.code).toBe(-32600);
    expect(JSON.parse(output[2]!)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { method: "tools/list" },
    });
  });

  it("aborts readline and destroys the input stream", async () => {
    const input = new PassThrough();
    const abortController = new AbortController();
    const running = runMcpStdioTransport({
      input,
      signal: abortController.signal,
      session: { handle: vi.fn() },
      writeProtocolLine: vi.fn(),
    });

    abortController.abort();
    await running;
    expect(input.destroyed).toBe(true);
  });

  it("aborts an in-flight session request when stdin reaches EOF", async () => {
    const input = new PassThrough();
    let started!: (signal: AbortSignal) => void;
    const requestStarted = new Promise<AbortSignal>((resolve) => (started = resolve));
    const running = runMcpStdioTransport({
      input,
      session: {
        async handle(request, signal) {
          started(signal!);
          await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve()));
          return { jsonrpc: "2.0", id: request.id ?? null, result: {} };
        },
      },
      writeProtocolLine: vi.fn(),
    });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" })}\n`);
    const signal = await requestStarted;

    input.end();
    await expect(running).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
  });

  it("closes the app before disconnecting owned Prisma and Redis resources", async () => {
    const order: string[] = [];
    const resources = {
      abortController: new AbortController(),
      app: { close: vi.fn(async () => void order.push("app")) },
      prisma: { $disconnect: vi.fn(async () => void order.push("prisma")) },
      redis: {
        status: "ready",
        quit: vi.fn(async () => void order.push("redis")),
        disconnect: vi.fn(),
      },
    } as any;

    await closeStdioOwnedResources(resources);
    expect(resources.abortController.signal.aborted).toBe(true);
    expect(order[0]).toBe("app");
    expect(new Set(order.slice(1))).toEqual(new Set(["prisma", "redis"]));
  });

  it("bounds hung cleanup", async () => {
    await expect(withCleanupDeadline(new Promise(() => undefined), 5)).resolves.toBe("timed_out");
  });

  it("fails closed when bearer verification fails", async () => {
    const controller = Object.create(McpPlatformController.prototype) as any;
    controller.verifyAnyBearer = vi.fn(async () => null);
    controller.getRouter = vi.fn();

    await expect(controller.createStdioSession("invalid")).resolves.toBeNull();
    expect(controller.getRouter).not.toHaveBeenCalled();
  });
});
