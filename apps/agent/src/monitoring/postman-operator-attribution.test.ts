import { describe, expect, it, vi } from "vitest";
import { SafetyEventService } from "./safety-event.service";
import { ToolAuditService } from "./tool-audit.service";

const scope = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentId: "33333333-3333-4333-8333-333333333333",
  operatorUserId: "44444444-4444-4444-8444-444444444444",
};
const simulatedUserId = "customer-external-42";

describe("Postman operator attribution", () => {
  it("persists and reads ToolCallAudit actor separately from the simulated user", async () => {
    let stored: any;
    const prisma: any = {
      toolCallAudit: {
        create: vi.fn(async ({ data }: any) => {
          stored = data;
          return { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
        }),
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn(async () => [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ...stored,
          toolId: null,
          agentId: null,
          threadId: null,
          traceId: null,
          result: null,
          error: null,
          costCents: null,
          createdAt: new Date("2026-08-24T12:00:00.000Z"),
        }]),
      },
    };
    const service = new ToolAuditService(prisma);

    await service.record({
      scope,
      toolName: "accounts.lookup",
      userId: simulatedUserId,
      actorUserId: scope.operatorUserId,
      args: { accountId: "safe-account" },
      status: "success",
      latencyMs: 12,
    });

    expect(stored.arguments.__platosAudit).toMatchObject({
      userId: simulatedUserId,
      actorUserId: scope.operatorUserId,
    });
    expect(JSON.stringify(stored.arguments.__platosAudit))
      .not.toContain("OVERRIDE_SECRET_SENTINEL");
    const listed = await service.list(scope);
    expect(listed.rows[0]).toMatchObject({
      userId: simulatedUserId,
      actorUserId: scope.operatorUserId,
    });
  });

  it("persists and reads SafetyEvent actor separately from the simulated user", async () => {
    let stored: any;
    const prisma: any = {
      safetyEvent: {
        create: vi.fn(async ({ data }: any) => {
          stored = data;
          return { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
        }),
        count: vi.fn().mockResolvedValue(1),
        findMany: vi.fn(async () => [{
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          ...stored,
          agentId: null,
          threadId: null,
          turnId: null,
          endUserId: null,
          toolName: null,
          toolCallId: null,
          createdAt: new Date("2026-08-24T12:00:00.000Z"),
        }]),
      },
    };
    const service = new SafetyEventService(prisma);

    await service.record(scope, {
      detector: "tool_param",
      action: "warn",
      severity: "medium",
      userId: simulatedUserId,
      meta: { policy: "safe" },
    });

    expect(stored.metadata.__platosSafety).toEqual({
      userId: simulatedUserId,
      actorUserId: scope.operatorUserId,
    });
    expect(JSON.stringify(stored.metadata.__platosSafety))
      .not.toContain("OVERRIDE_SECRET_SENTINEL");
    const listed = await service.list(scope);
    expect(listed.rows[0]).toMatchObject({
      userId: simulatedUserId,
      actorUserId: scope.operatorUserId,
    });
  });
});
