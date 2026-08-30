import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { AgentController } from "../agent-runtime/agent.controller";
import { McpPlatformController } from "../mcp-platform/mcp-platform.controller";
import { McpRouter } from "../mcp-platform/mcp-router";
import { runMcpStdioTransport } from "../mcp-platform/stdio-transport";
import type { VerifiedToken } from "../mcp-platform/token.service";
import { buildMacroToolHandlers, MacroRecordingState } from "../mcp-platform/tools/macros";
import { buildMonitoringToolHandlers } from "../mcp-platform/tools/monitoring";
import {
  ClickhouseCallerAbortError,
  ClickhouseNetworkError,
  attachClickhouseCorrelation,
} from "../shared/clickhouse-deadline";
import { SpansService } from "./spans.service";
import { TraceService } from "./trace.service";

const SCOPE = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
};
const REQUEST_SCOPE = { ...SCOPE, principal: "operator" as const };
const THREAD = {
  id: "thread-1",
  agentId: "agent-1",
  title: "trace",
  status: "ACTIVE",
  createdAt: new Date("2026-08-30T00:00:00.000Z"),
  updatedAt: new Date("2026-08-30T00:00:00.000Z"),
  _count: { turns: 0 },
};

function requestEvents() {
  return {
    req: new EventEmitter() as unknown as Request,
    res: new EventEmitter() as unknown as Response,
  };
}

function tracePrisma() {
  return {
    thread: { findFirst: vi.fn().mockResolvedValue(THREAD) },
    turn: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

async function hangingClickhouse() {
  let resolveRequest!: () => void;
  let resolveClosed!: () => void;
  const requested = new Promise<void>((resolve) => (resolveRequest = resolve));
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  const server = createServer((_request, response) => {
    resolveRequest();
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("partial");
    response.on("close", resolveClosed);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind TCP");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    requested,
    closed,
  };
}

async function closeServer(server: Server) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function liveTraceService(clickhouseUrl: string) {
  const redisRead = vi.fn().mockResolvedValue([]);
  const events: Array<Record<string, unknown>> = [];
  const spans = Object.create(SpansService.prototype) as SpansService;
  Object.assign(spans as unknown as Record<string, unknown>, {
    redis: { lrange: redisRead },
    clickhouseBaseUrl: clickhouseUrl,
    clickhouseAuth: null,
    clickhouseDeadlineMs: 60_000,
    fetchImpl: fetch,
    emitClickhouseEvent: (event: Record<string, unknown>) => events.push(event),
  });
  return {
    trace: new TraceService(tracePrisma() as any, spans, undefined),
    redisRead,
    events,
  };
}

function traceToken(permissions = ["traces.get"]): VerifiedToken {
  return {
    id: "token-1",
    scope: SCOPE,
    permissions,
    mintedByUserId: "user-1",
    expiresAt: null,
    tier: "scope",
  };
}

function traceRouter(trace: TraceService) {
  const router = new McpRouter(
    { buildScope: () => ({ ...REQUEST_SCOPE }) },
    {
      resolve: vi.fn().mockResolvedValue({ state: "auto_allow", tier: 1, reason: "test" }),
    } as any,
  );
  const traceHandler = buildMonitoringToolHandlers({
    traces: trace,
    providerHealth: {} as any,
    prisma: {} as any,
  }).find((handler) => handler.name === "traces.get")!;
  router.register(traceHandler);
  return router;
}

function sharedSseRedis() {
  const values = new Map<string, string>();
  const subscribers: Array<
    EventEmitter & {
      channels: Set<string>;
      closed: boolean;
      subscribe: ReturnType<typeof vi.fn>;
      unsubscribe: ReturnType<typeof vi.fn>;
      quit: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }
  > = [];
  const redis = {
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    }),
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    del: vi.fn(async (key: string) => Number(values.delete(key))),
    duplicate: vi.fn(() => {
      const subscriber = Object.assign(new EventEmitter(), {
        channels: new Set<string>(),
        closed: false,
        subscribe: vi.fn(async (channel: string) => {
          subscriber.channels.add(channel);
          return 1;
        }),
        unsubscribe: vi.fn(async (channel: string) => {
          subscriber.channels.delete(channel);
          return 1;
        }),
        quit: vi.fn(async () => {
          subscriber.closed = true;
          subscriber.channels.clear();
          return "OK";
        }),
        disconnect: vi.fn(() => {
          subscriber.closed = true;
          subscriber.channels.clear();
        }),
      });
      subscribers.push(subscriber);
      return subscriber;
    }),
    publish: vi.fn(async (channel: string, message: string) => {
      for (const subscriber of subscribers) {
        if (!subscriber.closed && subscriber.channels.has(channel)) {
          subscriber.emit("message", channel, message);
        }
      }
      return 1;
    }),
  };
  return { redis, subscribers, values };
}

describe("shipping trace request cancellation", () => {
  it("HTTP controller close aborts ClickHouse socket/work, skips Redis, and removes listeners", async () => {
    const clickhouse = await hangingClickhouse();
    const { trace, redisRead, events } = liveTraceService(clickhouse.url);
    const { req, res } = requestEvents();
    const controller = {
      getScope: () => REQUEST_SCOPE,
      scopeTuple: () => SCOPE,
      conversationService: { getThread: vi.fn().mockResolvedValue(THREAD) },
      traceService: trace,
    };

    try {
      const pending = AgentController.prototype.getThreadTrace.call(
        controller as AgentController,
        req,
        res,
        THREAD.id,
      );
      await clickhouse.requested;
      (res as unknown as EventEmitter).emit("close");
      await expect(pending).rejects.toBeInstanceOf(ClickhouseCallerAbortError);
      await expect(clickhouse.closed).resolves.toBeUndefined();
      expect(redisRead).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        phase: "end",
        failureKind: "caller-abort",
        plannedDecision: "none",
      });
      expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
      expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
      expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
    } finally {
      await closeServer(clickhouse.server);
    }
  }, 10_000);

  it("HTTP controller observes an already-destroyed request after listeners attach", async () => {
    const { req, res } = requestEvents();
    Object.assign(req, { aborted: false, destroyed: true });
    Object.assign(res, { destroyed: false });
    const buildThreadTrace = vi.fn(async (_scope, _threadId, signal: AbortSignal) => {
      expect(signal.aborted).toBe(true);
      return { threadId: THREAD.id };
    });
    const controller = {
      getScope: () => REQUEST_SCOPE,
      scopeTuple: () => SCOPE,
      conversationService: { getThread: vi.fn().mockResolvedValue(THREAD) },
      traceService: { buildThreadTrace },
    };

    await expect(
      AgentController.prototype.getThreadTrace.call(
        controller as unknown as AgentController,
        req,
        res,
        THREAD.id,
      ),
    ).resolves.toEqual({ threadId: THREAD.id });
    expect(buildThreadTrace).toHaveBeenCalledOnce();
    expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
    expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
    expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
  });

  it("MCP HTTP close propagates through router/tool/TraceService to the same socket", async () => {
    const clickhouse = await hangingClickhouse();
    const { trace, redisRead, events } = liveTraceService(clickhouse.url);
    const token: VerifiedToken = {
      id: "token-1",
      scope: SCOPE,
      permissions: ["traces.get"],
      mintedByUserId: "user-1",
      expiresAt: null,
      tier: "scope",
    };
    const router = new McpRouter(
      { buildScope: () => ({ ...REQUEST_SCOPE }) },
      {
        resolve: vi.fn().mockResolvedValue({ state: "auto_allow", tier: 1, reason: "test" }),
      } as any,
    );
    const traceHandler = buildMonitoringToolHandlers({
      traces: trace,
      providerHealth: {} as any,
      prisma: {} as any,
    }).find((handler) => handler.name === "traces.get")!;
    router.register(traceHandler);
    const controller = {
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
      getRouter: () => router,
    };
    const { req, res } = requestEvents();

    try {
      const pending = McpPlatformController.prototype.jsonRpc.call(
        controller as McpPlatformController,
        req,
        res,
        "Bearer token",
        undefined,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "traces.get", arguments: { threadId: THREAD.id } },
        },
      );
      await Promise.race([
        clickhouse.requested,
        pending.then((early) => {
          throw new Error(`MCP trace returned before ClickHouse: ${JSON.stringify(early)}`);
        }),
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`MCP trace did not reach ClickHouse: ${JSON.stringify(events)}`)),
            1_000,
          ),
        ),
      ]);
      (res as unknown as EventEmitter).emit("close");
      const response = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("MCP router did not stop after disconnect")), 1_000),
        ),
      ]);
      expect(response.error).toMatchObject({ code: -32603, message: "internal error" });
      await Promise.race([
        clickhouse.closed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("MCP ClickHouse socket remained open")), 1_000),
        ),
      ]);
      expect(redisRead).not.toHaveBeenCalled();
      expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
      expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
      expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
    } finally {
      await closeServer(clickhouse.server);
    }
  }, 10_000);

  it("direct MCP observes an already-destroyed response after listeners attach", async () => {
    const token = traceToken();
    const { req, res } = requestEvents();
    Object.assign(req, { aborted: false, destroyed: false });
    Object.assign(res, { destroyed: true });
    const handle = vi.fn(async (_body, _token, context) => {
      expect(context.abortSignal.aborted).toBe(true);
      return { jsonrpc: "2.0", id: 7, result: { content: [] } };
    });
    const controller = {
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
      getRouter: () => ({ handle }),
    };

    await expect(
      McpPlatformController.prototype.jsonRpc.call(
        controller as unknown as McpPlatformController,
        req,
        res,
        "Bearer token",
        undefined,
        { jsonrpc: "2.0", id: 7, method: "tools/list" },
      ),
    ).resolves.toEqual({ jsonrpc: "2.0", id: 7, result: { content: [] } });
    expect(handle).toHaveBeenCalledOnce();
    expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
    expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
    expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
  });

  it("MCP SSE disconnect cancels a cross-replica /messages trace dispatch", async () => {
    const clickhouse = await hangingClickhouse();
    const { trace, redisRead, events } = liveTraceService(clickhouse.url);
    const router = traceRouter(trace);
    const token = {
      ...traceToken(),
      credential: { kind: "platform" as const, tokenId: "token-1" },
    };
    const { redis, subscribers } = sharedSseRedis();
    const sseController = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
    };
    const messagesController = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      parseSseCredential: () => token.credential,
      verifySseCredential: vi.fn().mockResolvedValue(token),
      getRouter: () => router,
    };
    const sseReq = new EventEmitter() as unknown as Request;
    const sseRes = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
    }) as unknown as Response;
    const postRes = {
      status: vi.fn(),
      send: vi.fn(),
    } as any;
    postRes.status.mockReturnValue(postRes);

    try {
      await McpPlatformController.prototype.sse.call(
        sseController as unknown as McpPlatformController,
        sseReq,
        sseRes,
        "Bearer token",
      );
      const endpoint = (sseRes.write as any).mock.calls
        .map((call: unknown[]) => String(call[0]))
        .find((frame: string) => frame.startsWith("event: endpoint"));
      const sessionId = /sessionId=([a-f0-9]+)/.exec(endpoint ?? "")?.[1];
      expect(sessionId).toBeTruthy();

      const pending = McpPlatformController.prototype.messages.call(
        messagesController as unknown as McpPlatformController,
        sessionId,
        undefined,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "traces.get", arguments: { threadId: THREAD.id } },
        },
        postRes,
      );
      await clickhouse.requested;
      (sseRes as unknown as EventEmitter).emit("close");
      await expect(pending).resolves.toBeUndefined();
      await expect(clickhouse.closed).resolves.toBeUndefined();
      expect(redisRead).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ failureKind: "caller-abort" });
      expect(sseController.sseSessionAborts.size).toBe(0);
      expect(messagesController.sseSessionAborts.size).toBe(0);
      expect(subscribers).toHaveLength(2);
      expect(subscribers.every((subscriber) => subscriber.closed)).toBe(true);
      expect(subscribers.every((subscriber) => subscriber.listenerCount("message") === 0)).toBe(
        true,
      );
    } finally {
      await closeServer(clickhouse.server);
    }
  }, 10_000);

  it("SSE session deletion closes a missed-publish race when the cancellation marker fails", async () => {
    const { redis, subscribers, values } = sharedSseRedis();
    const baseSet = redis.set;
    redis.set = vi.fn(async (key: string, value: string) => {
      if (key.includes(":sse-cancelled:")) throw new Error("marker unavailable");
      return baseSet(key, value);
    }) as typeof redis.set;

    let releaseDispatchSubscribe!: () => void;
    let dispatchSubscribeStarted!: () => void;
    const dispatchSubscribeGate = new Promise<void>((resolve) => (releaseDispatchSubscribe = resolve));
    const dispatchSubscribing = new Promise<void>((resolve) => (dispatchSubscribeStarted = resolve));
    const baseDuplicate = redis.duplicate;
    let duplicateCount = 0;
    redis.duplicate = vi.fn(() => {
      const subscriber = baseDuplicate();
      duplicateCount += 1;
      if (duplicateCount === 2) {
        const baseSubscribe = subscriber.subscribe;
        subscriber.subscribe = vi.fn(async (channel: string) => {
          dispatchSubscribeStarted();
          await dispatchSubscribeGate;
          return baseSubscribe(channel);
        });
      }
      return subscriber;
    }) as typeof redis.duplicate;

    const token = {
      ...traceToken(),
      credential: { kind: "platform" as const, tokenId: "token-1" },
    };
    const routerHandle = vi.fn(async (_body, _token, context) => {
      expect(context.abortSignal.aborted).toBe(true);
      return { jsonrpc: "2.0", id: 4, result: { content: [] } };
    });
    const sseController = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
    };
    const messagesController = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      parseSseCredential: () => token.credential,
      verifySseCredential: vi.fn().mockResolvedValue(token),
      getRouter: () => ({ handle: routerHandle }),
    };
    const sseReq = new EventEmitter() as unknown as Request;
    const sseRes = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
    }) as unknown as Response;
    const postRes = {
      status: vi.fn(),
      send: vi.fn(),
    } as any;
    postRes.status.mockReturnValue(postRes);

    await McpPlatformController.prototype.sse.call(
      sseController as unknown as McpPlatformController,
      sseReq,
      sseRes,
      "Bearer token",
    );
    const endpoint = (sseRes.write as any).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .find((frame: string) => frame.startsWith("event: endpoint"));
    const sessionId = /sessionId=([a-f0-9]+)/.exec(endpoint ?? "")?.[1];
    expect(sessionId).toBeTruthy();
    const sessionKey = `platos:mcp:platform:session:${sessionId}`;
    const cancelChannel = `platos:mcp:platform:sse-cancel:${sessionId}`;

    const pending = McpPlatformController.prototype.messages.call(
      messagesController as unknown as McpPlatformController,
      sessionId,
      undefined,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      postRes,
    );
    await dispatchSubscribing;
    (sseRes as unknown as EventEmitter).emit("close");
    await vi.waitFor(() => {
      expect(values.has(sessionKey)).toBe(false);
      expect(redis.publish).toHaveBeenCalledWith(cancelChannel, "cancel");
    });
    expect(subscribers[1]?.channels.has(cancelChannel)).toBe(false);

    const markerSetOrder = (redis.set as any).mock.invocationCallOrder.at(-1);
    const sessionDeleteOrder = (redis.del as any).mock.invocationCallOrder.at(-1);
    const cancelPublishOrder = (redis.publish as any).mock.invocationCallOrder.find(
      (_order: number, index: number) => redis.publish.mock.calls[index]?.[0] === cancelChannel,
    );
    expect(markerSetOrder).toBeLessThan(sessionDeleteOrder);
    expect(sessionDeleteOrder).toBeLessThan(cancelPublishOrder);

    releaseDispatchSubscribe();
    await expect(pending).resolves.toBeUndefined();
    expect(routerHandle).toHaveBeenCalledOnce();
    expect(subscribers.every((subscriber) => subscriber.closed)).toBe(true);
  });

  it("MCP stdio EOF cancels an in-flight trace and cleans external abort listeners", async () => {
    const clickhouse = await hangingClickhouse();
    const { trace, redisRead, events } = liveTraceService(clickhouse.url);
    const router = traceRouter(trace);
    const token = traceToken();
    const controller = {
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
      getRouter: () => router,
    };
    const session = await McpPlatformController.prototype.createStdioSession.call(
      controller as unknown as McpPlatformController,
      "token",
    );
    const input = new PassThrough();
    const abort = new AbortController();
    const removeAbortListener = vi.spyOn(abort.signal, "removeEventListener");
    const output: string[] = [];

    try {
      const running = runMcpStdioTransport({
        input,
        session: session!,
        signal: abort.signal,
        writeProtocolLine: (line) => void output.push(line),
      });
      input.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "traces.get", arguments: { threadId: THREAD.id } },
        })}\n`,
      );
      await clickhouse.requested;
      input.end();
      await expect(running).resolves.toBeUndefined();
      await expect(clickhouse.closed).resolves.toBeUndefined();
      expect(redisRead).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ failureKind: "caller-abort" });
      expect(input.destroyed).toBe(true);
      expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      await closeServer(clickhouse.server);
    }
  }, 10_000);

  it("SSE disconnect during session setup leaves no session resources", async () => {
    const { redis, subscribers, values } = sharedSseRedis();
    let releaseInitialSet!: () => void;
    const initialSet = new Promise<void>((resolve) => (releaseInitialSet = resolve));
    const baseSet = redis.set;
    let holdSessionSet = true;
    redis.set = vi.fn(async (key: string, value: string) => {
      if (holdSessionSet && key.includes(":session:")) {
        holdSessionSet = false;
        await initialSet;
      }
      return baseSet(key, value);
    }) as typeof redis.set;
    const token = {
      ...traceToken(),
      credential: { kind: "platform" as const, tokenId: "token-1" },
    };
    const controller = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
    };
    const req = new EventEmitter() as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
    }) as unknown as Response;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      const pending = McpPlatformController.prototype.sse.call(
        controller as unknown as McpPlatformController,
        req,
        res,
        "Bearer token",
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.sseSessionAborts.size).toBe(1);
      const sessionId = controller.sseSessionAborts.keys().next().value as string;
      (res as unknown as EventEmitter).emit("close");
      expect(controller.sseSessionAborts.size).toBe(0);
      expect(subscribers[0]?.closed).toBe(true);
      releaseInitialSet();
      await expect(pending).resolves.toBeUndefined();

      expect(values.has(`platos:mcp:platform:session:${sessionId}`)).toBe(false);
      expect(subscribers[0]?.listenerCount("message")).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
      expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
      expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("SSE disconnect during token verification allocates no session resources", async () => {
    const { redis, subscribers, values } = sharedSseRedis();
    let finishVerification!: (token: VerifiedToken) => void;
    const verification = new Promise<VerifiedToken>((resolve) => (finishVerification = resolve));
    const token = {
      ...traceToken(),
      credential: { kind: "platform" as const, tokenId: "token-1" },
    };
    const controller = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockReturnValue(verification),
    };
    const req = new EventEmitter() as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
    }) as unknown as Response;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      const pending = McpPlatformController.prototype.sse.call(
        controller as unknown as McpPlatformController,
        req,
        res,
        "Bearer token",
      );
      (res as unknown as EventEmitter).emit("close");
      finishVerification(token);
      await expect(pending).resolves.toBeUndefined();

      expect(controller.sseSessionAborts.size).toBe(0);
      expect(subscribers).toHaveLength(0);
      expect(values.size).toBe(0);
      expect(redis.duplicate).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
      expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
      expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("SSE disconnect during subscriber setup removes the persisted session", async () => {
    const { redis, subscribers, values } = sharedSseRedis();
    let releaseSubscribe!: () => void;
    const subscribeGate = new Promise<void>((resolve) => (releaseSubscribe = resolve));
    const baseDuplicate = redis.duplicate;
    redis.duplicate = vi.fn(() => {
      const subscriber = baseDuplicate();
      const baseSubscribe = subscriber.subscribe;
      subscriber.subscribe = vi.fn(async (channel: string) => {
        await subscribeGate;
        return baseSubscribe(channel);
      });
      return subscriber;
    }) as typeof redis.duplicate;
    const token = {
      ...traceToken(),
      credential: { kind: "platform" as const, tokenId: "token-1" },
    };
    const controller = {
      sseSessionAborts: new Map<string, AbortController>(),
      redis,
      extractBearer: () => "token",
      verifyAnyBearer: vi.fn().mockResolvedValue(token),
    };
    const req = new EventEmitter() as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn().mockReturnValue(true),
      end: vi.fn(),
    }) as unknown as Response;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    try {
      const pending = McpPlatformController.prototype.sse.call(
        controller as unknown as McpPlatformController,
        req,
        res,
        "Bearer token",
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(controller.sseSessionAborts.size).toBe(1);
      const sessionId = controller.sseSessionAborts.keys().next().value as string;
      expect(values.has(`platos:mcp:platform:session:${sessionId}`)).toBe(true);

      (req as unknown as EventEmitter).emit("aborted");
      expect(controller.sseSessionAborts.size).toBe(0);
      expect(subscribers[0]?.closed).toBe(true);
      releaseSubscribe();
      await expect(pending).resolves.toBeUndefined();

      expect(values.has(`platos:mcp:platform:session:${sessionId}`)).toBe(false);
      expect(subscribers[0]?.channels.size).toBe(0);
      expect(subscribers[0]?.listenerCount("message")).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();
      expect((req as unknown as EventEmitter).listenerCount("aborted")).toBe(0);
      expect((req as unknown as EventEmitter).listenerCount("close")).toBe(0);
      expect((res as unknown as EventEmitter).listenerCount("close")).toBe(0);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("nested macro replay preserves the caller cancellation signal for traces.get", async () => {
    const clickhouse = await hangingClickhouse();
    const { trace, redisRead, events } = liveTraceService(clickhouse.url);
    const router = traceRouter(trace);
    const token = traceToken(["macros.replay", "traces.get"]);
    const macro = {
      id: "macro-1",
      environmentId: SCOPE.environmentId,
      createdBy: token.mintedByUserId,
      sharedWithOrganization: false,
      steps: [{ tool: "traces.get", params: { threadId: THREAD.id } }],
    };
    const replay = buildMacroToolHandlers({
      state: new MacroRecordingState(),
      prisma: { macro: { findFirst: vi.fn().mockResolvedValue(macro) } } as any,
      getRouter: () => router,
    }).find((handler) => handler.name === "macros.replay")!;
    router.register(replay);
    const abort = new AbortController();

    try {
      const pending = router.handle(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "macros.replay", arguments: { macroId: macro.id } },
        },
        token,
        { abortSignal: abort.signal },
      );
      await clickhouse.requested;
      abort.abort();
      const response = await pending;
      const content = response.result as { content: Array<{ text: string }> };
      expect(JSON.parse(content.content[0]!.text).results[0]).toMatchObject({
        tool: "traces.get",
        ok: false,
        error: { code: -32603, message: "internal error" },
      });
      await expect(clickhouse.closed).resolves.toBeUndefined();
      expect(redisRead).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ failureKind: "caller-abort" });
    } finally {
      await closeServer(clickhouse.server);
    }
  }, 10_000);
});

describe("TraceService fallback handling telemetry", () => {
  it("reports Redis fallback as applied only after the Redis read succeeds", async () => {
    let resolveFallback!: (value: unknown[]) => void;
    const fallback = new Promise<unknown[]>((resolve) => (resolveFallback = resolve));
    const report = vi.fn();
    const failure = attachClickhouseCorrelation(
      new ClickhouseNetworkError("span-read"),
      "corr_fallback",
    );
    const spans = {
      isClickhouseEnabled: () => true,
      getThreadSpansFromClickhouse: vi.fn().mockRejectedValue(failure),
      getThreadSpans: vi.fn(() => fallback),
      reportClickhouseHandling: report,
    };
    const service = new TraceService(tracePrisma() as any, spans as any, undefined);

    const pending = service.buildThreadTrace(SCOPE, THREAD.id);
    await vi.waitFor(() => expect(spans.getThreadSpans).toHaveBeenCalledOnce());
    expect(report).not.toHaveBeenCalled();
    resolveFallback([]);
    await expect(pending).resolves.toBeTruthy();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "corr_fallback",
        decision: "fallback-redis",
        decisionState: "applied",
        callerMapping: "redis-fallback",
      }),
    );
  });

  it("reports failed Redis fallback and propagates the Redis failure", async () => {
    const report = vi.fn();
    const failure = attachClickhouseCorrelation(
      new ClickhouseNetworkError("span-read"),
      "corr_failed_fallback",
    );
    const redisFailure = new Error("redis unavailable");
    const spans = {
      isClickhouseEnabled: () => true,
      getThreadSpansFromClickhouse: vi.fn().mockRejectedValue(failure),
      getThreadSpans: vi.fn().mockRejectedValue(redisFailure),
      reportClickhouseHandling: report,
    };
    const service = new TraceService(tracePrisma() as any, spans as any, undefined);

    await expect(service.buildThreadTrace(SCOPE, THREAD.id)).rejects.toBe(redisFailure);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "corr_failed_fallback",
        decision: "fallback-redis",
        decisionState: "failed",
        callerMapping: "redis-fallback",
      }),
    );
  });
});
