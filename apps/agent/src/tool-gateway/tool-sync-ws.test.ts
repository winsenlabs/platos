import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { ToolSyncWsService } from "./tool-sync-ws.service";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeDatabase(options: {
  secret?: string;
  lookupDelayMs?: number;
} = {}) {
  const delay = options.lookupDelayMs ?? 0;
  const entity = {
    id: "entity-pk",
    externalId: "main",
    projectId: "project-1",
    connectionKind: "wire",
    project: {
      organizationId: "org-1",
      environments: [{ id: "env-1", slug: "development" }],
    },
  };
  return {
    entity: {
      update: async () => entity,
    },
    credential: {
      findMany: async ({ where }: any) => {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (
          !options.secret ||
          !where.secretHash.in.includes(sha256(options.secret))
        ) {
          return [];
        }
        return [
          {
            id: "credential-1",
            environment: {
              id: "env-1",
              slug: "development",
              project: {
                id: "project-1",
                organizationId: "org-1",
                entities: [
                  {
                    id: "entity-pk",
                    externalId: "main",
                    projectId: "project-1",
                    connectionKind: "wire",
                  },
                ],
              },
            },
          },
        ];
      },
    },
    toolHealth: { upsert: async () => ({}) },
  } as any;
}

function makeRegistry() {
  const registered: any[] = [];
  return {
    registered,
    dispatchability: [] as Array<{ entityPk: string; value: boolean }>,
    async registerTools(_scope: unknown, tools: any[]) {
      registered.push(...tools);
      return { registered: tools.length, updated: 0, newTools: tools.length, removed: 0 };
    },
    // `reconcileEntityTools` is DELIBERATELY ABSENT. It was the only reference
    // to that method left in the tree — a stub on a double for a call the
    // subject never made — and a double that answers a method the real service
    // does not have is how a deleted method looks alive to a reader.
    setEntityDispatchable(entityPk: string, value: boolean) {
      this.dispatchability.push({ entityPk, value });
      return 0;
    },
    getScopedTools() {
      return [];
    },
  };
}

async function startRawServer(service: ToolSyncWsService) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });
  wss.on("connection", async (ws, request: IncomingMessage) => {
    await (service as any).handleConnection(ws, request);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe("ToolSyncWsService clean credential handshake", () => {
  let closeServer: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it("rejects a missing bearer before database authentication", async () => {
    const service = new ToolSyncWsService(
      makeDatabase(),
      makeRegistry() as any,
      {} as any,
    );
    const server = await startRawServer(service);
    closeServer = server.close;
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/tools/sync?entity=main&env=env-1`,
      );
      ws.on("close", resolve);
      ws.on("error", () => undefined);
    });
    expect(code).toBe(1008);
  });

  it("rejects a missing entity id on its own terms, without blaming the secret", async () => {
    // Regression: a client connecting without ?entity= was told "Invalid
    // service secret or entity not found", which sent operators hunting a
    // hash mismatch that did not exist. test.platos logged 590 of these in
    // ten minutes from a client whose secret was perfectly valid.
    const database = makeDatabase({ secret: "correct-secret" });
    let lookups = 0;
    const findMany = database.credential.findMany;
    database.credential.findMany = async (args: any) => {
      lookups += 1;
      return findMany(args);
    };
    const service = new ToolSyncWsService(
      database,
      makeRegistry() as any,
      {} as any,
    );
    const server = await startRawServer(service);
    closeServer = server.close;

    const { code, error } = await new Promise<{
      code: number;
      error?: string;
    }>((resolve) => {
      // Valid secret, but no ?entity=, no ?source=, no header.
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/tools/sync?env=env-1`,
        { headers: { authorization: "Bearer correct-secret" } },
      );
      let seen: string | undefined;
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "error") seen = message.error;
      });
      ws.on("close", (closeCode) => resolve({ code: closeCode, error: seen }));
      ws.on("error", () => undefined);
    });

    expect(code).toBe(1008);
    expect(error).toMatch(/entity id/i);
    expect(error).not.toMatch(/invalid service secret/i);
    // The secret was never checked — a missing id is not a hash failure.
    expect(lookups).toBe(0);
  });

  it("verifies the Environment ENTITY_SECRET hash and emits canonical scope", async () => {
    const service = new ToolSyncWsService(
      makeDatabase({ secret: "correct-secret" }),
      makeRegistry() as any,
      {} as any,
    );
    const server = await startRawServer(service);
    closeServer = server.close;

    const welcome = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/tools/sync?entity=main&env=env-1`,
        { headers: { authorization: "Bearer correct-secret" } },
      );
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "welcome") {
          resolve(message);
          ws.close();
        }
      });
      ws.on("error", reject);
    });

    expect(welcome).toMatchObject({
      type: "welcome",
      entity_id: "main",
      environment_id: "env-1",
      organization_id: "org-1",
      project_id: "project-1",
    });
  });

  it("buffers and replays tool_register sent before async auth completes", async () => {
    const registry = makeRegistry();
    const service = new ToolSyncWsService(
      makeDatabase({ secret: "correct-secret", lookupDelayMs: 50 }),
      registry as any,
      {} as any,
    );
    const server = await startRawServer(service);
    closeServer = server.close;

    const registered = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.port}/tools/sync?entity=main&env=env-1`,
        { headers: { authorization: "Bearer correct-secret" } },
      );
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "tool_register",
            tools: [
              {
                name: "search_people",
                description: "Find a person",
                input_schema: { type: "object" },
              },
            ],
          }),
        );
      });
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "tools_registered") {
          resolve(message);
          ws.close();
        }
      });
      ws.on("error", reject);
    });

    expect(registered).toMatchObject({ type: "tools_registered", count: 1 });
    expect(registry.registered.map((tool) => tool.name)).toEqual([
      "search_people",
    ]);
  });
});

/**
 * WIN-272 (M4.6) — "No duplicate tool-result or trailing invalid frames", THE
 * TOOL-RESULT HALF.
 *
 * WHAT THE RULE IS. `handleMessage` settles an in-flight call on the FIRST
 * `tool_result` or `tool_error` for its `call_id` and consumes the pending entry
 * (`this.pending.delete(callId)`), so a second frame for the same id finds nothing
 * and is dropped. No test asserted it: the only duplicate protection was one line
 * and nothing would have gone red without it.
 *
 * WHY THE WITNESS IS THE SETTLEMENT AND NOT THE PROMISE. A JavaScript promise
 * ignores every settle after the first, so `await dispatchToolCall(...)` reads the
 * same value whether the service settled once or three times — a case built on the
 * promise alone could never fail. The witness is therefore the settle functions the
 * service itself stores in its pending map, wrapped at the moment the service
 * stores them, counting every call the SERVICE makes. The frames still travel over
 * a real WebSocket from a real client, after a real credential handshake.
 *
 * WHY THE SENTINEL. Frames are handled in arrival order, so a `heartbeat` sent
 * after the duplicates is answered with `heartbeat_ack` only once the service has
 * processed everything before it. Asserting before that ack would assert against
 * frames still in flight.
 *
 * SINGLE PROCESS. The multi-instance version of this rule — a duplicate arriving at
 * a DIFFERENT agent replica — depends on the WebSocket fan-out design decision and
 * is not claimed here.
 */
describe("ToolSyncWsService duplicate tool frames", () => {
  let closeServer: (() => Promise<void>) | undefined;
  let client: WebSocket | undefined;
  afterEach(async () => {
    client?.terminate();
    client = undefined;
    await closeServer?.();
    closeServer = undefined;
  });

  type Settlement = { callId: string; kind: "resolve" | "reject"; value: unknown };

  /** Count every settle the service performs on a pending call. */
  function recordSettlements(service: ToolSyncWsService): Settlement[] {
    const settlements: Settlement[] = [];
    const pending = (service as any).pending as Map<string, any>;
    const store = pending.set.bind(pending);
    pending.set = (callId: string, entry: any) =>
      store(callId, {
        ...entry,
        resolve: (value: unknown) => {
          settlements.push({ callId, kind: "resolve", value });
          entry.resolve(value);
        },
        reject: (error: Error) => {
          settlements.push({ callId, kind: "reject", value: error.message });
          entry.reject(error);
        },
      });
    return settlements;
  }

  /**
   * Connect an authenticated SDK client whose reply to every `tool_call` is
   * `frames(callId)`, followed by a heartbeat sentinel. Resolves once welcomed.
   */
  async function connectResponder(
    port: number,
    frames: (callId: string) => Array<Record<string, unknown>>,
  ): Promise<{ ws: WebSocket; drained: Promise<void> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tools/sync?entity=main&env=env-1`, {
      headers: { authorization: "Bearer correct-secret" },
    });
    client = ws;
    let markDrained!: () => void;
    const drained = new Promise<void>((resolve) => (markDrained = resolve));
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "welcome") resolve();
        if (message.type === "tool_call") {
          for (const frame of frames(message.call_id)) ws.send(JSON.stringify(frame));
          ws.send(JSON.stringify({ type: "heartbeat", tools_health: {} }));
        }
        if (message.type === "heartbeat_ack") markDrained();
      });
      ws.on("error", reject);
    });
    return { ws, drained };
  }

  it("a second tool_result for a consumed callId produces no second resolution", async () => {
    const service = new ToolSyncWsService(
      makeDatabase({ secret: "correct-secret" }),
      makeRegistry() as any,
      {} as any,
    );
    const settlements = recordSettlements(service);
    const server = await startRawServer(service);
    closeServer = server.close;
    const { drained } = await connectResponder(server.port, (callId) => [
      { type: "tool_result", call_id: callId, result: { answer: "first" }, latency_ms: 3 },
      { type: "tool_result", call_id: callId, result: { answer: "second" }, latency_ms: 4 },
      { type: "tool_error", call_id: callId, error: "late error for a settled call" },
    ]);

    const outcome = await service.dispatchToolCall(
      "main",
      "env-1",
      "search_people",
      { query: "ada" },
      5_000,
      "call-duplicate-result",
    );
    await drained;

    expect(outcome).toEqual({ status: "success", result: { answer: "first" }, latencyMs: 3 });
    // THE RULE: one settlement, the first frame's, and nothing for the two after it.
    expect(settlements).toEqual([
      { callId: "call-duplicate-result", kind: "resolve", value: outcome },
    ]);
    expect((service as any).pending.size).toBe(0);
  });

  it("a second tool_error, and a late tool_result, for a consumed callId produce no second settlement", async () => {
    const service = new ToolSyncWsService(
      makeDatabase({ secret: "correct-secret" }),
      makeRegistry() as any,
      {} as any,
    );
    const settlements = recordSettlements(service);
    const server = await startRawServer(service);
    closeServer = server.close;
    const { drained } = await connectResponder(server.port, (callId) => [
      { type: "tool_error", call_id: callId, error: "connector refused" },
      { type: "tool_error", call_id: callId, error: "connector refused again" },
      { type: "tool_result", call_id: callId, result: { answer: "too late" } },
    ]);

    await expect(
      service.dispatchToolCall("main", "env-1", "search_people", {}, 5_000, "call-duplicate-error"),
    ).rejects.toThrow("connector refused");
    await drained;

    expect(settlements).toEqual([
      { callId: "call-duplicate-error", kind: "reject", value: "connector refused" },
    ]);
    expect((service as any).pending.size).toBe(0);
  });

  it("CONTROL: the recorder sees every settle the service makes, one per call across two calls", async () => {
    // Without this, a recorder that failed to wrap anything would report an empty
    // or single list and the two cases above would pass on a service that settled
    // every frame it received.
    const service = new ToolSyncWsService(
      makeDatabase({ secret: "correct-secret" }),
      makeRegistry() as any,
      {} as any,
    );
    const settlements = recordSettlements(service);
    const server = await startRawServer(service);
    closeServer = server.close;
    await connectResponder(server.port, (callId) => [
      { type: "tool_result", call_id: callId, result: { echo: callId } },
    ]);

    await service.dispatchToolCall("main", "env-1", "search_people", {}, 5_000, "call-a");
    await service.dispatchToolCall("main", "env-1", "search_people", {}, 5_000, "call-b");

    expect(settlements.map((s) => `${s.kind}:${s.callId}`)).toEqual(["resolve:call-a", "resolve:call-b"]);
  });
});
