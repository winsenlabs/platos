import { describe, it, expect, vi, beforeEach } from "vitest";
import { TurnDispatchService, type TurnDispatchContext } from "./turn-dispatch.service";
import type { RequestScope } from "../auth/scope.guard";
import type { AgentStreamEvent } from "./agent.service";

/**
 * Unit tests for the durable-vs-direct chokepoint.
 *
 * THE INVARIANT under test: durable-vs-direct is decided ONLY by the agent's
 * executionMode (read once, here), NEVER by the entry path. These tests pin the
 * four dispatch-decision units the refactor must guarantee:
 *   1. durable → trigger path
 *   2. direct  → in-process
 *   3. fallback-on-trigger-failure (dispatch failure → in-process, never dropped)
 *   4. channel collected-result (durable → await run → final text)
 *
 * The trigger.dev SDK send + run-await are extracted verbatim from the
 * already-working gateway path and depend on the module singleton, so the
 * decision/ROUTING is tested by stubbing the service's own seams rather than
 * the SDK.
 */

function makeScope(): RequestScope {
  return {
    organizationId: "org1",
    projectId: "proj1",
    environmentId: "env1",
    userId: "user1",
  } as RequestScope;
}

function makeCtx(over: Partial<TurnDispatchContext> = {}): TurnDispatchContext {
  return { scope: makeScope(), message: "hello", ...over };
}

async function* gen(...events: AgentStreamEvent[]): AsyncGenerator<AgentStreamEvent> {
  for (const e of events) yield e;
}

describe("TurnDispatchService — the durable-vs-direct chokepoint", () => {
  let prisma: any;
  let agentTaskService: any;
  let conversationService: any;
  let svc: TurnDispatchService;

  beforeEach(() => {
    prisma = { platosAgent: { findFirst: vi.fn() } };
    agentTaskService = { executeStreamingTurn: vi.fn() };
    conversationService = { getOrCreateThread: vi.fn() };
    svc = new TurnDispatchService(prisma, agentTaskService, conversationService);
  });

  describe("resolveMode — the ONE executionMode read", () => {
    it("returns 'direct' when managed trigger is unconfigured, regardless of executionMode", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(false);
      prisma.platosAgent.findFirst.mockResolvedValue({ executionMode: "durable" });
      expect(await svc.resolveMode("a1", makeScope())).toBe("direct");
      // Short-circuits before the DB read — durable is simply unreachable.
      expect(prisma.platosAgent.findFirst).not.toHaveBeenCalled();
    });

    it("returns 'durable' for a durable agent when trigger IS configured", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.platosAgent.findFirst.mockResolvedValue({ executionMode: "durable" });
      expect(await svc.resolveMode("a1", makeScope())).toBe("durable");
    });

    it("returns 'direct' for a direct agent when trigger IS configured", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.platosAgent.findFirst.mockResolvedValue({ executionMode: "direct" });
      expect(await svc.resolveMode("a1", makeScope())).toBe("direct");
    });

    it("scopes the read to the full (org, project, env, id) tuple", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.platosAgent.findFirst.mockResolvedValue({ executionMode: "durable" });
      await svc.resolveMode("a1", makeScope());
      expect(prisma.platosAgent.findFirst).toHaveBeenCalledWith({
        where: { id: "a1", organizationId: "org1", projectId: "proj1", environmentId: "env1" },
        select: { executionMode: true },
      });
    });

    it("fails open to 'direct' when the executionMode lookup throws", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.platosAgent.findFirst.mockRejectedValue(new Error("db down"));
      expect(await svc.resolveMode("a1", makeScope())).toBe("direct");
    });
  });

  describe("collectTurn — routes on the decision (channel path)", () => {
    it("direct → drains the in-process turn, never triggers durable", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("direct");
      const trig = vi.spyOn(svc, "triggerDurable");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t1" } as AgentStreamEvent,
          { type: "token", text: "he" } as AgentStreamEvent,
          { type: "token", text: "llo" } as AgentStreamEvent,
          { type: "message_persisted", messageId: "m1", costCents: 3 } as unknown as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ),
      );
      const r = await svc.collectTurn("a1", makeCtx());
      expect(r).toEqual({ text: "hello", threadId: "t1", costCents: 3, messageId: "m1" });
      expect(trig).not.toHaveBeenCalled();
    });

    it("durable → dispatches to trigger and returns the awaited run's final text", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      const trig = vi.spyOn(svc, "triggerDurable").mockResolvedValue({ runId: "run1", threadId: "t9" });
      vi.spyOn(svc as any, "awaitDurableRun").mockResolvedValue({
        text: "durable reply",
        costCents: 7,
        messageId: "m9",
        status: "COMPLETED",
      });
      const streamDirect = vi.spyOn(svc, "streamDirect");
      const r = await svc.collectTurn("a1", makeCtx({ threadId: "t9" }));
      expect(r).toEqual({ text: "durable reply", threadId: "t9", costCents: 7, messageId: "m9" });
      expect(trig).toHaveBeenCalledOnce();
      // A durable turn must NOT also run in-process.
      expect(streamDirect).not.toHaveBeenCalled();
    });

    it("fail-open: a durable DISPATCH failure falls back to the in-process turn (never dropped)", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "triggerDurable").mockRejectedValue(new Error("trigger unreachable"));
      const awaitRun = vi.spyOn(svc as any, "awaitDurableRun");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t2" } as AgentStreamEvent,
          { type: "token", text: "fallback" } as AgentStreamEvent,
          { type: "message_persisted", messageId: "m2", costCents: 1 } as unknown as AgentStreamEvent,
        ),
      );
      const r = await svc.collectTurn("a1", makeCtx());
      expect(r).toEqual({ text: "fallback", threadId: "t2", costCents: 1, messageId: "m2" });
      // No run ever started → we must not await one.
      expect(awaitRun).not.toHaveBeenCalled();
    });
  });

  describe("streamTurn — routes on the decision (SSE path)", () => {
    it("direct → yields EXACTLY the in-process stream (zero behavior change)", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("direct");
      const events = [
        { type: "meta", thread_id: "t1" },
        { type: "token", text: "hi" },
        { type: "done" },
      ] as AgentStreamEvent[];
      vi.spyOn(svc, "streamDirect").mockReturnValue(gen(...events));
      const out: AgentStreamEvent[] = [];
      for await (const e of svc.streamTurn("a1", makeCtx())) out.push(e);
      expect(out).toEqual(events);
    });

    it("durable → dispatches, then surfaces the run's text as meta+token+done", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "triggerDurable").mockResolvedValue({ runId: "run1", threadId: "t5" });
      vi.spyOn(svc as any, "awaitDurableRun").mockResolvedValue({
        text: "durable stream",
        costCents: 2,
        messageId: "m5",
        status: "COMPLETED",
      });
      const out: any[] = [];
      for await (const e of svc.streamTurn("a1", makeCtx({ threadId: "t5" }))) out.push(e);
      expect(out[0]).toEqual({ type: "meta", thread_id: "t5" });
      expect(out).toContainEqual({ type: "token", text: "durable stream" });
      expect(out.at(-1)).toEqual({ type: "done" });
    });

    it("durable dispatch failure → fails open to the in-process stream", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "triggerDurable").mockRejectedValue(new Error("nope"));
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen({ type: "token", text: "direct-fallback" } as AgentStreamEvent),
      );
      const out: AgentStreamEvent[] = [];
      for await (const e of svc.streamTurn("a1", makeCtx())) out.push(e);
      expect(out).toEqual([{ type: "token", text: "direct-fallback" }]);
    });
  });

  describe("triggerDurable — pre-send guards", () => {
    it("throws when managed trigger is not configured (so callers fail-open)", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(false);
      await expect(svc.triggerDurable("a1", makeCtx())).rejects.toThrow();
      expect(conversationService.getOrCreateThread).not.toHaveBeenCalled();
    });

    it("IDOR-gates the thread and throws (before any SDK send) if it can't resolve one", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      conversationService.getOrCreateThread.mockResolvedValue({ id: undefined });
      await expect(svc.triggerDurable("a1", makeCtx({ threadId: "foreign" }))).rejects.toThrow();
      expect(conversationService.getOrCreateThread).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org1" }),
        "a1",
        "foreign",
      );
    });
  });
});
