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
    async reconcileEntityTools() {
      return { removed: 0 };
    },
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
