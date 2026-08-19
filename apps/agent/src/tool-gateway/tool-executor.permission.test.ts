import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../auth/scope.guard";
import { ToolExecutorService } from "./tool-executor.service";

const scope: RequestScope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "user-1",
  agentId: "agent-1",
};

function executorWith(options: {
  permissionGateway?: { resolve: ReturnType<typeof vi.fn> };
  approvalsService?: Record<string, unknown>;
  redis?: Record<string, unknown>;
}) {
  const registry = { getScopedTools: vi.fn(() => []) };
  const executor = new ToolExecutorService(
    {} as any,
    registry as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.permissionGateway as any,
    options.approvalsService as any,
    options.redis as any,
    undefined,
    undefined
  );
  const error = vi.fn();
  (executor as any).logger = { error };
  return { executor, registry, error };
}

afterEach(() => {
  delete process.env.PLATOS_TOOL_DISPATCH_PERMISSION_GATE;
});

describe("ToolExecutorService permission failures", () => {
  it("fails closed and does not dispatch when permission resolution throws", async () => {
    process.env.PLATOS_TOOL_DISPATCH_PERMISSION_GATE = "1";
    const secret = "postgres://operator:sentinel-secret@db.internal/control";
    const resolve = vi.fn().mockRejectedValue(new Error(secret));
    const { executor, registry, error } = executorWith({
      permissionGateway: { resolve },
    });

    const result = await executor.execute({ tool: "safe.read", params: {} }, scope);

    expect(result).toMatchObject({
      tool: "safe.read",
      status: "failed",
      error: "Tool dispatch denied because permission policy could not be evaluated.",
    });
    expect(registry.getScopedTools).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(error).toHaveBeenCalledWith("Tool dispatch permission resolution failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });

  it("fails closed when the enabled permission gateway is unavailable", async () => {
    process.env.PLATOS_TOOL_DISPATCH_PERMISSION_GATE = "1";
    const { executor, registry, error } = executorWith({});

    const result = await executor.execute({ tool: "safe.read", params: {} }, scope);

    expect(result.status).toBe("failed");
    expect(registry.getScopedTools).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Tool dispatch permission gateway unavailable");
  });

  it("does not expose approval persistence failures", async () => {
    process.env.PLATOS_TOOL_DISPATCH_PERMISSION_GATE = "1";
    const secret = "ciphertext=sentinel-ciphertext";
    const { executor, registry, error } = executorWith({
      permissionGateway: {
        resolve: vi.fn().mockResolvedValue({
          state: "require_approval",
          tier: 1,
          reason: "platform policy",
        }),
      },
      approvalsService: {
        createMcpApproval: vi.fn().mockRejectedValue(new Error(secret)),
      },
      redis: {},
    });

    const result = await executor.execute({ tool: "safe.write", params: {} }, scope);

    expect(result.error).toBe("Tool approval could not be requested.");
    expect(registry.getScopedTools).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(error).toHaveBeenCalledWith("Tool approval persistence failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });

  it("does not expose approval wait failures", async () => {
    process.env.PLATOS_TOOL_DISPATCH_PERMISSION_GATE = "1";
    const secret = "redis://:sentinel-password@redis.internal";
    const blockClient = {
      blpop: vi.fn().mockRejectedValue(new Error(secret)),
      disconnect: vi.fn(),
    };
    const redis = {
      publish: vi.fn().mockResolvedValue(1),
      duplicate: vi.fn(() => blockClient),
      del: vi.fn().mockResolvedValue(1),
    };
    const { executor, registry, error } = executorWith({
      permissionGateway: {
        resolve: vi.fn().mockResolvedValue({
          state: "require_approval",
          tier: 1,
          reason: "platform policy",
        }),
      },
      approvalsService: {
        createMcpApproval: vi.fn().mockResolvedValue({ approvalId: "approval-1" }),
      },
      redis,
    });

    const result = await executor.execute({ tool: "safe.write", params: {} }, scope);

    expect(result.error).toBe("Tool approval could not be completed.");
    expect(registry.getScopedTools).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(error).toHaveBeenCalledWith("Tool approval wait failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(secret);
  });
});
