import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { buildReflectionToolHandlers } from "./reflection";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
  principal: "operator",
};

describe("platos.explain_turn canonical budget events", () => {
  it("filters canonical detector/action values and projects compatibility kinds", async () => {
    const safetyFindMany = vi.fn().mockResolvedValue([
      {
        action: "block",
        detail: "Daily budget exhausted",
        createdAt: new Date("2026-08-19T12:00:00.000Z"),
      },
      {
        action: "warn",
        detail: "Approaching daily budget",
        createdAt: new Date("2026-08-19T11:00:00.000Z"),
      },
    ]);
    const handlers = buildReflectionToolHandlers({
      agentCrud: {} as any,
      conversation: {
        getThread: vi.fn().mockResolvedValue({
          id: "thread-a",
          agentId: "agent-a",
          status: "ACTIVE",
        }),
      } as any,
      spans: { getThreadSpans: vi.fn().mockResolvedValue([]) } as any,
      toolAudit: {
        list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
      } as any,
      approvals: {
        list: vi.fn().mockResolvedValue({ rows: [], total: 0, pendingCount: 0 }),
      } as any,
      prisma: {
        turn: {
          findFirst: vi.fn().mockResolvedValue({
            id: "turn-a",
            output: null,
            costCents: null,
            steps: [],
            createdAt: new Date("2026-08-19T12:00:00.000Z"),
            status: "SUCCEEDED",
          }),
        },
        environmentEntityTool: { findMany: vi.fn().mockResolvedValue([]) },
        entity: { findMany: vi.fn().mockResolvedValue([]) },
        safetyEvent: { findMany: safetyFindMany },
      } as any,
    });
    const handler = handlers.find((candidate) => candidate.name === "platos.explain_turn")!;

    const result: any = await handler.execute(
      { threadId: "thread-a", messageId: "turn-a" },
      scope,
      {} as any,
    );

    expect(safetyFindMany).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        threadId: "thread-a",
        detector: "budget",
        action: { in: ["block", "warn"] },
      },
      orderBy: { createdAt: "desc" },
      select: { action: true, detail: true, createdAt: true },
      take: 50,
    });
    expect(result.budgetBlocks).toEqual([
      {
        kind: "budget_block",
        reason: "Daily budget exhausted",
        createdAt: "2026-08-19T12:00:00.000Z",
      },
      {
        kind: "budget_warning",
        reason: "Approaching daily budget",
        createdAt: "2026-08-19T11:00:00.000Z",
      },
    ]);
  });
});
