import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TurnDispatchService, type TurnDispatchContext } from "./turn-dispatch.service";
import type { RequestScope } from "../auth/scope.guard";
import type { AgentStreamEvent } from "./agent.service";

vi.mock("../shared/external-trigger-config", () => ({
  configureExternalTriggerSdk: vi.fn(() => ({
    status: "configured",
    endpoint: "https://trigger.test",
    accessToken: "test-token",
  })),
}));

/**
 * Unit tests for the durable-vs-direct chokepoint.
 *
 * THE INVARIANT under test: durable-vs-direct is decided ONLY by the agent's
 * executionMode (read once, here), NEVER by the entry path. And now "durable"
 * ALWAYS means Trigger SESSIONS (never the retired durable-turn task). These
 * tests pin the dispatch-decision units the refactor must guarantee:
 *   1. durable → Sessions (streamSession / collectSession)
 *   2. direct  → in-process
 *   3. fail-open on pre-commit session-unavailable → in-process (never dropped)
 *   4. the retired durable-turn TASK dispatch (triggerDurable) is NOT called
 *
 * The Trigger Sessions drive (`driveSession`) is extracted verbatim from the
 * already-working gateway path and depends on the SDK module singleton + Redis,
 * so the decision/ROUTING is tested by stubbing the service's own seams
 * (streamSession / collectSession / streamDirect) rather than the SDK.
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
  let redis: any;
  let svc: TurnDispatchService;

  beforeEach(() => {
    prisma = { agentBinding: { findFirst: vi.fn() } };
    agentTaskService = { executeStreamingTurn: vi.fn() };
    conversationService = { getOrCreateThread: vi.fn() };
    // Routing tests stub driveSession at the primitive seam; the timeout
    // regression below also exercises its best-effort cursor cleanup.
    redis = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue("OK"),
      del: vi.fn().mockResolvedValue(1),
    };
    svc = new TurnDispatchService(prisma, agentTaskService, conversationService, redis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("driveSession — timeout cleanup", () => {
    it("does not await an AsyncIterator return() that never settles after the drive timeout", async () => {
      vi.useFakeTimers();
      vi.stubEnv("PLATOS_CHAT_SESSIONS", "true");
      vi.stubEnv("PLATOS_SESSION_DRIVE_TIMEOUT_MS", "15000");

      const next = vi.fn(() => new Promise<IteratorResult<unknown>>(() => undefined));
      const returnIterator = vi.fn(() => new Promise<IteratorResult<unknown>>(() => undefined));
      const stream = {
        [Symbol.asyncIterator]: () => ({ next, return: returnIterator }),
      };
      const sendMessage = vi.fn().mockResolvedValue(stream);
      class AgentChatStub {
        readonly session = {};
        readonly sendMessage = sendMessage;
      }

      conversationService.getOrCreateThread.mockResolvedValue({ id: "t-timeout" });
      svc = new TurnDispatchService(prisma, agentTaskService, conversationService, redis);
      vi.spyOn(svc as any, "loadAgentChat").mockReturnValue(AgentChatStub);

      const events: Record<string, unknown>[] = [];
      const completed = vi.fn();
      const drive = (svc as any)
        .driveSession("a1", makeCtx(), (event: Record<string, unknown>) => events.push(event))
        .then((result: unknown) => {
          completed();
          return result;
        });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(completed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(drive).resolves.toEqual({
        text: "",
        threadId: "t-timeout",
        costCents: 0,
        messageId: undefined,
      });
      expect(returnIterator).toHaveBeenCalledOnce();
      expect(events).toEqual([
        { type: "meta", thread_id: "t-timeout", threadId: "t-timeout", durable: true, session: true },
        { type: "error", message: "durable session timed out" },
        { type: "done" },
      ]);
    });

    it("carries bounded attachment identities in durable Session client data", async () => {
      vi.stubEnv("PLATOS_CHAT_SESSIONS", "true");
      let constructed: any;
      class AgentChatStub {
        readonly session = {};
        constructor(options: any) {
          constructed = options;
          void options.onTurnComplete({ lastEventId: "cursor-1" });
        }
        async sendMessage() {
          return gen(
            { type: "text-delta", delta: "reply" } as any,
            { type: "data-platos-event", data: { type: "message_persisted", messageId: "message-1" } } as any,
          );
        }
      }

      conversationService.getOrCreateThread.mockResolvedValue({ id: "thread-1" });
      vi.spyOn(svc as any, "loadAgentChat").mockReturnValue(AgentChatStub);
      await expect(svc.collectSession("agent-1", makeCtx({
        threadId: "thread-1",
        attachmentIds: ["attachment-1", "attachment-2"],
      }))).resolves.toMatchObject({ messageId: "message-1", threadId: "thread-1" });
      expect(constructed.clientData.attachmentIds).toEqual(["attachment-1", "attachment-2"]);
    });
  });

  describe("resolveMode — the ONE executionMode read", () => {
    it("returns 'direct' when managed trigger is unconfigured, regardless of executionMode", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(false);
      prisma.agentBinding.findFirst.mockResolvedValue({
        activeAgentVersion: { memoryConfig: { __runtime: { executionMode: "durable" } } },
      });
      expect(await svc.resolveMode("a1", makeScope())).toBe("direct");
      // Short-circuits before the DB read — durable is simply unreachable.
      expect(prisma.agentBinding.findFirst).not.toHaveBeenCalled();
    });

    it("returns 'durable' for a durable agent when trigger IS configured", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.agentBinding.findFirst.mockResolvedValue({
        activeAgentVersion: { memoryConfig: { __runtime: { executionMode: "durable" } } },
      });
      expect(await svc.resolveMode("a1", makeScope())).toBe("durable");
    });

    it("returns 'direct' for a direct agent when trigger IS configured", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.agentBinding.findFirst.mockResolvedValue({
        activeAgentVersion: { memoryConfig: { __runtime: { executionMode: "direct" } } },
      });
      expect(await svc.resolveMode("a1", makeScope())).toBe("direct");
    });

    it("scopes the read to the full (org, project, env, id) tuple", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.agentBinding.findFirst.mockResolvedValue({
        activeAgentVersion: { memoryConfig: { __runtime: { executionMode: "durable" } } },
      });
      await svc.resolveMode("a1", makeScope());
      expect(prisma.agentBinding.findFirst).toHaveBeenCalledWith({
        where: {
          agentId: "a1",
          environmentId: "env1",
          agent: { projectId: "proj1" },
          environment: { project: { id: "proj1", organizationId: "org1" } },
        },
        select: { activeAgentVersion: { select: { memoryConfig: true } } },
      });
    });

    it("fails open to 'direct' when the executionMode lookup throws", async () => {
      vi.spyOn(svc as any, "triggerReady").mockReturnValue(true);
      prisma.agentBinding.findFirst.mockRejectedValue(new Error("db down"));
      expect(await svc.resolveMode("a1", makeScope())).toBe("direct");
    });
  });

  describe("collectTurn — routes on the decision (channel path)", () => {
    it("direct → drains the in-process turn, never touches Sessions", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("direct");
      const session = vi.spyOn(svc, "collectSession");
      const trig = vi.spyOn(svc, "triggerDurable");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t1" } as AgentStreamEvent,
          { type: "token", text: "he" } as AgentStreamEvent,
          { type: "token", text: "llo" } as AgentStreamEvent,
          { type: "message_persisted", messageId: "m1", costCents: 3 } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ),
      );
      const r = await svc.collectTurn("a1", makeCtx());
      // collectDirect also returns the full `events` log — assert the meaningful
      // fields with a subset match.
      expect(r).toMatchObject({ text: "hello", threadId: "t1", costCents: 3, messageId: "m1" });
      expect(session).not.toHaveBeenCalled();
      expect(trig).not.toHaveBeenCalled();
    });

    it("durable → drives a Session and returns its collected reply (NOT the durable-turn task)", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      const trig = vi.spyOn(svc, "triggerDurable");
      const session = vi
        .spyOn(svc, "collectSession")
        .mockResolvedValue({ text: "durable reply", threadId: "t9", costCents: 7, messageId: "m9" });
      const streamDirect = vi.spyOn(svc, "streamDirect");
      const r = await svc.collectTurn("a1", makeCtx({ threadId: "t9" }));
      expect(r).toEqual({ text: "durable reply", threadId: "t9", costCents: 7, messageId: "m9" });
      expect(session).toHaveBeenCalledOnce();
      // The retired durable-turn TASK must NOT be dispatched, and a committed
      // session turn must NOT also run in-process.
      expect(trig).not.toHaveBeenCalled();
      expect(streamDirect).not.toHaveBeenCalled();
    });

    it("fail-open: a session unavailable PRE-COMMIT falls back to the in-process turn (never dropped)", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      // collectSession returns null when the session never dispatched a run.
      vi.spyOn(svc, "collectSession").mockResolvedValue(null);
      const trig = vi.spyOn(svc, "triggerDurable");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t2" } as AgentStreamEvent,
          { type: "token", text: "fallback" } as AgentStreamEvent,
          { type: "message_persisted", messageId: "m2", costCents: 1 } as AgentStreamEvent,
        ),
      );
      const r = await svc.collectTurn("a1", makeCtx());
      expect(r).toMatchObject({ text: "fallback", threadId: "t2", costCents: 1, messageId: "m2" });
      expect(trig).not.toHaveBeenCalled();
    });

    it("rejects a direct error stream instead of treating early Thread metadata as completion", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("direct");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t-error" } as AgentStreamEvent,
          { type: "error", message: "unsafe upstream detail" } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ),
      );

      await expect(svc.collectTurn("a1", makeCtx())).rejects.toMatchObject({
        code: "TURN_NOT_PERSISTED",
        message: "Collected turn did not reach authoritative persistence",
      });
    });

    it("accepts authoritative persistence after a non-fatal error event", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("direct");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t-persisted" } as AgentStreamEvent,
          { type: "error", code: "tool_output_denied", message: "non-fatal" } as unknown as AgentStreamEvent,
          { type: "message_persisted", messageId: "m-persisted", costCents: 1 } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ),
      );

      await expect(svc.collectTurn("a1", makeCtx())).resolves.toMatchObject({
        threadId: "t-persisted",
        messageId: "m-persisted",
      });
    });

    it("rejects a direct meta-only completion without message_persisted", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("direct");
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t-meta" } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ),
      );

      await expect(svc.collectTurn("a1", makeCtx())).rejects.toMatchObject({
        code: "TURN_NOT_PERSISTED",
      });
    });

    it("rejects a committed durable result without persistence and never falls back to direct", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "collectSession").mockResolvedValue({
        text: "",
        threadId: "t-committed",
        costCents: 0,
      });
      const direct = vi.spyOn(svc, "streamDirect");

      await expect(
        svc.collectTurn("a1", makeCtx({ threadId: "t-committed" })),
      ).rejects.toMatchObject({ code: "TURN_NOT_PERSISTED" });
      expect(direct).not.toHaveBeenCalled();
    });

    it("fails closed when durable collection rejects outside its handled pre-commit boundary", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "collectSession").mockRejectedValue(new Error("ambiguous durable failure"));
      const direct = vi.spyOn(svc, "streamDirect");

      await expect(
        svc.collectTurn("a1", makeCtx({ threadId: "t-ambiguous" })),
      ).rejects.toMatchObject({ code: "TURN_NOT_PERSISTED" });
      expect(direct).not.toHaveBeenCalled();
    });

    it("rejects malformed persisted identity", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "collectSession").mockResolvedValue({
        text: "reply",
        threadId: "thread-reserved",
        costCents: 0,
        messageId: "message with spaces",
      });

      await expect(
        svc.collectTurn("a1", makeCtx({
          threadId: "thread-reserved",
          attachmentIds: ["attachment-1"],
        })),
      ).rejects.toMatchObject({ code: "TURN_NOT_PERSISTED" });
    });

    it("rejects a persisted attachment result from a Thread other than its reservation", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      vi.spyOn(svc, "collectSession").mockResolvedValue({
        text: "reply",
        threadId: "thread-other",
        costCents: 0,
        messageId: "message-canonical",
      });

      await expect(
        svc.collectTurn("a1", makeCtx({
          threadId: "thread-reserved",
          attachmentIds: ["attachment-1"],
        })),
      ).rejects.toMatchObject({ code: "TURN_NOT_PERSISTED" });
    });

    it("rejects malformed attachment identities before selecting an execution mode", async () => {
      const resolveMode = vi.spyOn(svc, "resolveMode");

      await expect(
        svc.collectTurn("a1", makeCtx({ attachmentIds: ["attachment with spaces"] })),
      ).rejects.toMatchObject({ code: "ATTACHMENT_IDS_INVALID" });
      expect(resolveMode).not.toHaveBeenCalled();
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
      const session = vi.spyOn(svc, "streamSession");
      const out: AgentStreamEvent[] = [];
      for await (const e of svc.streamTurn("a1", makeCtx())) out.push(e);
      expect(out).toEqual(events);
      expect(session).not.toHaveBeenCalled();
    });

    it("durable → relays the Session .out (meta+token+done), NOT the durable-turn task", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      const trig = vi.spyOn(svc, "triggerDurable");
      vi.spyOn(svc, "streamSession").mockReturnValue(
        gen(
          { type: "meta", thread_id: "t5", threadId: "t5", durable: true, session: true } as unknown as AgentStreamEvent,
          { type: "token", text: "durable stream" } as AgentStreamEvent,
          { type: "done" } as AgentStreamEvent,
        ),
      );
      const out: any[] = [];
      for await (const e of svc.streamTurn("a1", makeCtx({ threadId: "t5" }))) out.push(e);
      expect(out[0]).toMatchObject({ type: "meta", thread_id: "t5", session: true });
      expect(out).toContainEqual({ type: "token", text: "durable stream" });
      expect(out.at(-1)).toEqual({ type: "done" });
      expect(trig).not.toHaveBeenCalled();
    });

    it("session unavailable pre-commit → fails open to the in-process stream", async () => {
      vi.spyOn(svc, "resolveMode").mockResolvedValue("durable");
      // streamSession yields NOTHING when the session is unavailable.
      vi.spyOn(svc, "streamSession").mockReturnValue(gen());
      vi.spyOn(svc, "streamDirect").mockReturnValue(
        gen({ type: "token", text: "direct-fallback" } as AgentStreamEvent),
      );
      const out: AgentStreamEvent[] = [];
      for await (const e of svc.streamTurn("a1", makeCtx())) out.push(e);
      expect(out).toEqual([{ type: "token", text: "direct-fallback" }]);
    });
  });

  describe("triggerDurable — DORMANT (retired durable-turn task dispatch), guards retained", () => {
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
