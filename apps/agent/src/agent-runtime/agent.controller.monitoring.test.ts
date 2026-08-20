import { NotFoundException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentController } from "./agent.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
  principal: "operator" as const,
};

function harness() {
  const threadCount = vi.fn();
  const toolHealthFindMany = vi.fn();
  const controller: any = Object.create(AgentController.prototype);
  controller.agentService = {
    prisma: {
      thread: { count: threadCount },
      toolHealth: { findMany: toolHealthFindMany },
    },
  };
  controller.agentCrud = {
    findById: vi.fn(),
  };
  controller.conversationService = {
    createThread: vi.fn(),
  };
  controller.toolRegistry = {
    getScopedTools: vi.fn(),
  };
  controller.costService = {
    getScopeCostRange: vi.fn(),
  };
  return {
    controller,
    threadCount,
    toolHealthFindMany,
    req: { scope } as any,
  };
}

describe("AgentController clean monitoring and scoped 404 regressions", () => {
  it("builds the monitoring summary from canonically scoped Thread and ToolHealth queries", async () => {
    const h = harness();
    h.threadCount.mockResolvedValueOnce(12).mockResolvedValueOnce(3);
    h.toolHealthFindMany.mockResolvedValue([
      { totalCalls: 4, lastCalledAt: new Date("2026-08-15T10:00:00.000Z") },
      { totalCalls: 1, lastCalledAt: new Date("2026-08-15T11:00:00.000Z") },
    ]);
    h.controller.costService.getScopeCostRange.mockResolvedValue({
      inputTokens: 100,
      outputTokens: 25,
      costCents: 2.5,
      // WIN-134 — three completed turns across nine model calls. The summary
      // must report the turns.
      tasks: 3,
      byLane: { inference: 2.1, embedding: 0.3, extraction: 0.1, judge: 0, skill: 0 },
      perDay: [{ date: "2026-08-15", costCents: 2.5 }],
    });

    const result = await h.controller.monitoringSummary(h.req);

    const ancestry = {
      project: { id: "project-a", organizationId: "org-a" },
    };
    expect(h.threadCount).toHaveBeenNthCalledWith(1, {
      where: { environmentId: "env-a", environment: ancestry },
    });
    expect(h.threadCount).toHaveBeenNthCalledWith(2, {
      where: {
        environmentId: "env-a",
        environment: ancestry,
        createdAt: { gte: expect.any(Date) },
      },
    });
    expect(h.toolHealthFindMany).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        environment: ancestry,
        lastCalledAt: { gte: expect.any(Date) },
      },
      select: { totalCalls: true, lastCalledAt: true },
    });
    expect(h.controller.costService.getScopeCostRange).toHaveBeenCalledWith(
      {
        organizationId: "org-a",
        projectId: "project-a",
        environmentId: "env-a",
      },
      7,
    );
    expect(result.cards).toEqual([
      expect.objectContaining({ id: "threads_all", value: 12 }),
      expect.objectContaining({ id: "threads_24h", value: 3 }),
      expect.objectContaining({
        id: "cost_7d",
        value: 2.5,
        details: { inputTokens: 100, outputTokens: 25 },
      }),
      expect.objectContaining({ id: "tasks_7d", value: 3, unit: "tasks" }),
      expect.objectContaining({ id: "tools_active_7d", value: 2 }),
    ]);
    // The lane split is passed through untouched — it already sums to the
    // spend card by construction and must not be re-derived here.
    expect(result.costByLane).toEqual({
      inference: 2.1,
      embedding: 0.3,
      extraction: 0.1,
      judge: 0,
      skill: 0,
    });
    expect(result.costSeries).toEqual([
      { date: "2026-08-15", costCents: 2.5 },
    ]);
  });

  it("returns a real 404 before creating a Thread for a foreign agent", async () => {
    const h = harness();
    h.controller.agentCrud.findById.mockResolvedValue(null);

    const error = await h.controller
      .createThread(h.req, { agentId: "foreign-agent", title: "Probe" })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect(h.controller.agentCrud.findById).toHaveBeenCalledWith(
      "foreign-agent",
      scope,
    );
    expect(h.controller.conversationService.createThread).not.toHaveBeenCalled();
  });

  it("returns a real 404 before exposing tool metadata for a foreign agent", async () => {
    const h = harness();
    h.controller.agentCrud.findById.mockResolvedValue(null);

    const error = await h.controller
      .getAgentToolMappings(h.req, "foreign-agent")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getStatus()).toBe(404);
    expect(h.controller.agentCrud.findById).toHaveBeenCalledWith(
      "foreign-agent",
      scope,
    );
    expect(h.controller.toolRegistry.getScopedTools).not.toHaveBeenCalled();
    expect(h.toolHealthFindMany).not.toHaveBeenCalled();
  });
});

describe("the observability queue is reportable", () => {
  const TOKEN = "internal-token";

  const previousToken = process.env.PLATOS_INTERNAL_AUTH_TOKEN;
  afterEach(() => {
    if (previousToken === undefined) delete process.env.PLATOS_INTERNAL_AUTH_TOKEN;
    else process.env.PLATOS_INTERNAL_AUTH_TOKEN = previousToken;
  });

  function drainHarness(observability: Record<string, unknown>) {
    const controller: any = Object.create(AgentController.prototype);
    controller.spansService = { drainDlq: vi.fn(async () => ({ retried: 0, dead: 0 })) };
    controller.costService = {};
    controller.observability = observability;
    process.env.PLATOS_INTERNAL_AUTH_TOKEN = TOKEN;
    return {
      controller,
      req: { headers: { "x-platos-internal-auth": TOKEN } } as any,
    };
  }

  it("reports a thrown drain as degraded rather than as a skipped pass", async () => {
    // `skipped` is the honest answer for an absent or unreachable sink, and the
    // only consumer logs every value of it at warn under "not an error". A
    // thrown drain folded into that field — settle() failing against Postgres
    // mid-loop, aborting the pass and leaving every claimed row untouched —
    // was indistinguishable from "no observability sink configured" and left
    // the scheduled run green.
    const h = drainHarness({
      drain: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    });

    const result = await h.controller.drainDlq(h.req, { maxBatch: 100 });
    expect(result.status).toBe("degraded");
    expect(result.observability.failure).toContain("drain threw");
    expect(result.observability.skipped).toBeUndefined();
  });

  it("still reports ok when the drain merely skipped", async () => {
    const h = drainHarness({
      drain: vi.fn(async () => ({
        claimed: 0,
        delivered: 0,
        retried: 0,
        parked: 0,
        pruned: 0,
        discarded: 0,
        passes: 0,
        skipped: "no observability sink configured",
      })),
    });

    const result = await h.controller.drainDlq(h.req, {});
    expect(result.status).toBe("ok");
    expect(result.observability.skipped).toBe("no observability sink configured");
  });

  it("exposes sink health, queue depth and the owned tables", async () => {
    // agent-runtime.module.ts has always asserted that "the diagnostics
    // endpoint reports its sink health". There was no such endpoint: `status()`
    // had no caller outside its own test and `tables()` had none at all, so a
    // durable parked backlog was invisible between the pass that made it and
    // the human who went looking in Postgres.
    const status = vi.fn(async () => ({
      sink: { configured: true, available: true, status: "ready", detail: "ready" },
      queue: { pending: 12, failed: 3 },
    }));
    const h = drainHarness({ status, tables: () => ["turns_v1"] });

    const result = await h.controller.observabilityStatus(h.req);
    expect(status).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "ok",
      sink: { status: "ready" },
      queue: { pending: 12, failed: 3 },
      tables: ["turns_v1"],
    });
  });

  it("refuses an unauthenticated status read", async () => {
    const h = drainHarness({ status: vi.fn(), tables: () => [] });
    const result = await h.controller.observabilityStatus({ headers: {} } as any);
    expect(result).toEqual({ status: "forbidden" });
    expect(h.controller.observability.status).not.toHaveBeenCalled();
  });
});
