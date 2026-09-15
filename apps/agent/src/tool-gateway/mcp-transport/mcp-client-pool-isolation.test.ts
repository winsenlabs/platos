/**
 * WIN-269 (M4.3) — "EXTERNAL MCP FAILURES ARE ISOLATED", IN THE LIVE AGENT, AGAINST
 * REAL REMOTE MCP SERVERS OVER REAL SOCKETS.
 *
 * SCOPE, BY FOUNDER DECISION D13 (2026-09-15). stdio is EXCLUDED from this clause.
 * The live product has never dispatched stdio — `tool-executor.service.ts` answers
 * "stdio transport dispatch not yet implemented (K.10)", discovery skips it, and
 * `McpConnectionPool.getClient` accepts only `remote-http` and `remote-sse`. The
 * clause is about remote-http / remote-sse pool isolation, and that is exactly
 * what this file measures. Nothing here says anything about stdio.
 *
 * WHAT WAS WRONG. `packages/contexts/tools/adapters/mcp-dispatch.ts` evicts a
 * pooled session when a call on it throws; the live pool did not. Entries left
 * `McpConnectionPool` only on overflow or the idle sweep, and every hit refreshed
 * `lastUsedAt` — so after a remote server restarted and forgot its
 * `Mcp-Session-Id`, the pooled client kept answering 404 for as long as the entity
 * was used at least once every `MCP_POOL_IDLE_MS`. The census found this by reading
 * source; the first case below reproduces it.
 *
 * WHAT IS REAL. `ToolExecutorService.executeBatch` — the entry point a turn uses —
 * with the REAL `McpConnectionPool` and the REAL `McpCredentialService`, dialling
 * servers built from `@modelcontextprotocol/sdk`'s own `Server`,
 * `StreamableHTTPServerTransport` and `SSEServerTransport`, each on its own
 * `node:http` listener. The protocol on the far side is the reference
 * implementation's, not this file's reading of it.
 *
 * WHAT IS REPLACED, AND WHY. Two things only.
 *   * `validatePublicUrl` / `fetchWithValidatedRedirects` refuse loopback, which
 *     is correct in production and makes an in-process server unreachable. They
 *     are replaced for `http://127.0.0.1` URLs ONLY (everything else still goes to
 *     the real guard); the SSRF rules have their own suites, and nothing asserted
 *     here depends on them.
 *   * The executor's persistence (`prisma.entity.findFirst`,
 *     `prisma.toolHealth.upsert`) and the registry's scoped tool list are small
 *     in-memory answers. The subject is the dispatch path after the entity row is
 *     read, and a database would add latency to the timing bounds below without
 *     adding a claim.
 *
 * WHY THE TIMING BOUNDS WOULD FAIL WITHOUT ISOLATION. The hung server holds its
 * call until the client's own `MCP_CALL_TIMEOUT_MS` (set to 2 s here) expires. The
 * healthy server records WHEN its call arrived, measured from the moment the batch
 * started, and the hung entity is listed FIRST — so a batch that ran its calls one
 * after another, or a pool that serialised builds across entities, would deliver
 * the healthy call no earlier than 2 s in. The bound is 1 s.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { ToolExecutorService } from "../tool-executor.service";
import type { OrgToolEntry } from "../tool-registry.service";
import { EntityMcpDiscoveryService } from "./entity-mcp-discovery.service";
import { McpConnectionPool } from "./mcp-client-pool.service";
import { McpCredentialService } from "./mcp-credential.service";

const CALL_TIMEOUT_MS = 2_000;
/** The healthy call must arrive well inside the hung call's timeout. */
const ISOLATION_BOUND_MS = 1_000;
/** A restarted server's 404 for a session it never issued, or the dead socket's reset. */
const STALE_SESSION_FAILURE = /404|Session not found|fetch failed|other side closed|ECONNRESET/u;

vi.hoisted(() => {
  // Read once by the agent's env schema on first access; the minimum it accepts
  // is 1000 ms. Two seconds keeps the hung case short and the bound meaningful.
  process.env.MCP_CALL_TIMEOUT_MS = "2000";
  process.env.MCP_DISCOVERY_TIMEOUT_MS = "2000";
});

vi.mock("../../shared/url-validator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/url-validator")>();
  const inProcess = (raw: string): boolean => {
    const url = new URL(raw);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  };
  return {
    ...actual,
    validatePublicUrl: async (raw: string, options?: { allowHttp?: boolean }) =>
      inProcess(raw) ? { ok: true as const, url: new URL(raw) } : actual.validatePublicUrl(raw, options),
    fetchWithValidatedRedirects: async (raw: string, maxRedirects?: number, init?: RequestInit) =>
      inProcess(raw)
        ? fetch(raw, { ...init, redirect: "manual" })
        : actual.fetchWithValidatedRedirects(raw, maxRedirects, init),
  };
});

type Transport = "remote-http" | "remote-sse";
type Behaviour = "answer" | "hang" | "crash";

/**
 * One remote MCP server on a real listener.
 *
 * STATEFUL on purpose: `remote-http` hands out an `Mcp-Session-Id` and answers an
 * unknown one with 404, which is the SDK's documented server shape and what a
 * restarted server does. `crash` answers `initialize` normally and then, on the
 * first `tools/call`, destroys every socket and stops listening — a process that
 * died mid-call, not a tool that reported an error.
 */
class RemoteMcpServer {
  readonly calls: Array<{ tool: string; atMs: number }> = [];
  initializes = 0;
  port = 0;
  private http: HttpServer | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly sessions = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();

  constructor(
    private readonly transport: Transport,
    private readonly toolName: string,
    private readonly behaviour: Behaviour,
    private readonly answerDelayMs = 0,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}${this.transport === "remote-sse" ? "/sse" : "/mcp"}`;
  }

  async start(port = 0): Promise<void> {
    const http = createServer((request, response) => void this.handle(request, response));
    http.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
    this.port = (http.address() as AddressInfo).port;
    this.http = http;
  }

  /** Stop, forgetting every session — and come back on the SAME port. */
  async restart(): Promise<void> {
    const port = this.port;
    await this.stop();
    this.initializes = 0;
    await this.start(port);
  }

  async stop(): Promise<void> {
    const http = this.http;
    this.http = null;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const socket of this.sockets) socket.destroy();
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private mcpServer(): Server {
    const server = new Server({ name: `fixture-${this.toolName}`, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: this.toolName, inputSchema: { type: "object" as const } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.calls.push({ tool: request.params.name, atMs: Date.now() });
      if (this.behaviour === "hang") return await new Promise<never>(() => undefined);
      if (this.answerDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.answerDelayMs));
      return { content: [{ type: "text" as const, text: `${this.toolName} answered` }] };
    });
    return server;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve) => {
      let text = "";
      request.on("data", (chunk) => (text += String(chunk)));
      request.on("end", () => resolve(text));
    });
    const parsed: unknown = body === "" ? undefined : JSON.parse(body);

    if (this.behaviour === "crash" && (parsed as { method?: unknown } | undefined)?.method === "tools/call") {
      this.calls.push({ tool: this.toolName, atMs: Date.now() });
      // The process dies: no response, every socket reset, nothing listening.
      const http = this.http;
      this.http = null;
      for (const socket of this.sockets) socket.destroy();
      http?.close();
      return;
    }
    if (isInitializeRequest(parsed)) this.initializes += 1;

    if (this.transport === "remote-sse") {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/sse") {
        const session = new SSEServerTransport("/messages", response);
        this.sessions.set(session.sessionId, session);
        await this.mcpServer().connect(session);
        return;
      }
      const session = this.sessions.get(url.searchParams.get("sessionId") ?? "");
      if (request.method === "POST" && url.pathname === "/messages" && session instanceof SSEServerTransport) {
        await session.handlePostMessage(request, response, parsed);
        return;
      }
      response.writeHead(404).end("unknown session");
      return;
    }

    const sessionId = request.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (existing instanceof StreamableHTTPServerTransport) {
      await existing.handleRequest(request, response, parsed);
      return;
    }
    if (sessionId === undefined && isInitializeRequest(parsed)) {
      const session: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => void this.sessions.set(id, session),
      });
      await this.mcpServer().connect(session);
      await session.handleRequest(request, response, parsed);
      return;
    }
    // What a restarted server says to a session it never issued.
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
  }
}

const SCOPE: RequestScope = {
  organizationId: "org-1",
  projectId: "project-1",
  environmentId: "env-1",
  userId: "operator-1",
  agentId: "agent-1",
};

interface Entity {
  readonly pk: string;
  readonly externalId: string;
  readonly toolName: string;
  readonly server: RemoteMcpServer;
  readonly transport: Transport;
}

const servers: RemoteMcpServer[] = [];
const pools: McpConnectionPool[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) pool.onModuleDestroy();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function remote(transport: Transport, toolName: string, behaviour: Behaviour, answerDelayMs = 0): Promise<RemoteMcpServer> {
  const server = new RemoteMcpServer(transport, toolName, behaviour, answerDelayMs);
  await server.start();
  servers.push(server);
  return server;
}

function entry(entity: Entity): OrgToolEntry {
  return {
    toolId: `tool-${entity.pk}`,
    toolName: entity.toolName,
    description: entity.toolName,
    paramSchema: { type: "object" },
    category: "fixture",
    callbackUrl: "",
    sourceEntityId: entity.externalId,
    entityPk: entity.pk,
    environmentId: SCOPE.environmentId,
    enabled: true,
    dispatchable: true,
    connectionKind: "mcp",
    allowedAgentIds: [SCOPE.agentId!],
    entityMcpInjectContext: false,
  };
}

/** The executor a turn uses, over the REAL pool and credential resolver. */
function executorFor(entities: Entity[]): { executor: ToolExecutorService; pool: McpConnectionPool } {
  const refusingScopedEnv = new Proxy(
    {},
    {
      get() {
        throw new Error("these fixtures reference no {{secret}}; the scoped env must not be read");
      },
    },
  );
  const credentials = new McpCredentialService(refusingScopedEnv as never);
  const pool = new McpConnectionPool(credentials);
  pools.push(pool);
  const byPk = new Map(entities.map((entity) => [entity.pk, entity]));
  const prisma = {
    entity: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        const entity = byPk.get(where.id);
        if (!entity) return null;
        return {
          id: entity.pk,
          externalId: entity.externalId,
          projectId: SCOPE.projectId,
          connectionKind: "mcp",
          mcpConfig: null,
          mcpClient: { transport: entity.transport, url: entity.server.url, headersTemplate: {}, credential: null },
        };
      },
    },
    toolHealth: { upsert: async () => ({}) },
  };
  const registry = { getScopedTools: () => entities.map(entry) };
  const executor = new ToolExecutorService(
    prisma,
    registry as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    credentials,
    pool,
  );
  return { executor, pool };
}

function call(entity: Entity) {
  return { tool: entity.toolName, params: {} };
}

describe("WIN-269 — a remote server restarted mid-session recovers on the next call (remote-http)", () => {
  it("the stale session fails ONCE, is evicted, and the next call re-initialises against the restarted server", async () => {
    const server = await remote("remote-http", "notes.search", "answer");
    const entity: Entity = { pk: "entity-notes", externalId: "notes", toolName: "notes.search", server, transport: "remote-http" };
    const { executor } = executorFor([entity]);

    const first = await executor.executeBatch([call(entity)], SCOPE);
    expect(first[0]).toMatchObject({ status: "success" });
    expect(server.initializes).toBe(1);

    // The server process restarts on the same address and forgets every session.
    await server.restart();

    const stale = await executor.executeBatch([call(entity)], SCOPE);
    // The pooled client still carries the old `Mcp-Session-Id`; the restarted
    // server has never heard of it. This one failure is the price of detection.
    // Usually it is the server's 404; when the client's keep-alive socket to the
    // dead process has not yet been noticed as closed, it is that socket's reset
    // instead. Both are the transport dying under a pooled session, and either way
    // the session is still the OLD one — which is what the next call exposes.
    expect(stale[0]).toMatchObject({ status: "failed" });
    expect(String(stale[0]!.error)).toMatch(STALE_SESSION_FAILURE);

    const recovered = await executor.executeBatch([call(entity)], SCOPE);
    // WITHOUT EVICTION this is a second 404, and a third, until the idle sweep.
    expect(recovered[0]).toMatchObject({ status: "success" });
    expect(server.initializes).toBe(1);
    expect(server.calls.at(-1)?.tool).toBe("notes.search");
  }, 30_000);

  it("discovery evicts the same way: a failed tools/list after a restart is followed by a contacted one", async () => {
    const server = await remote("remote-http", "notes.search", "answer");
    const credentials = new McpCredentialService({} as never);
    const pool = new McpConnectionPool(credentials);
    pools.push(pool);
    // The rows around the server round-trip are in-memory answers; the subject is
    // the round-trip and what the pool keeps after it fails.
    const prisma = {
      entity: {
        findFirst: async () => ({
          id: "entity-notes",
          externalId: "notes",
          projectId: SCOPE.projectId,
          connectionKind: "mcp",
          project: { organizationId: SCOPE.organizationId },
          mcpClient: { transport: "remote-http", url: server.url, headersTemplate: {}, credential: null },
        }),
        update: async () => ({}),
      },
      environment: { findMany: async () => [{ id: SCOPE.environmentId }] },
      entityMcpClient: { update: async () => ({}) },
    };
    const registry = {
      registerTools: async (_scope: unknown, tools: unknown[]) => ({
        registered: tools.length,
        updated: 0,
        newTools: 0,
        removed: 0,
      }),
      setEntityDispatchable: () => 0,
    };
    const discovery = new EntityMcpDiscoveryService(prisma, credentials, pool, registry as never);

    expect(await discovery.discover("entity-notes")).toMatchObject({ contacted: 1, failed: 0 });
    await server.restart();
    const stale = await discovery.discover("entity-notes");
    expect(stale).toMatchObject({ contacted: 0, failed: 1 });
    expect(String(stale.error)).toMatch(STALE_SESSION_FAILURE);
    expect(await discovery.discover("entity-notes")).toMatchObject({ contacted: 1, failed: 0 });
    expect(server.initializes).toBe(1);
  }, 30_000);
});

describe.each<Transport>(["remote-http", "remote-sse"])(
  "WIN-269 — one entity's failing server does not delay or fail another entity in the same executeBatch (%s)",
  (transport) => {
    it("a HUNG server times out on its own clock while the healthy entity's call arrives and succeeds inside the bound", async () => {
      const hung: Entity = {
        pk: "entity-hung",
        externalId: "hung",
        toolName: "hung.work",
        server: await remote(transport, "hung.work", "hang"),
        transport,
      };
      const healthy: Entity = {
        pk: "entity-healthy",
        externalId: "healthy",
        toolName: "healthy.work",
        server: await remote(transport, "healthy.work", "answer"),
        transport,
      };
      const { executor } = executorFor([hung, healthy]);

      const startedAt = Date.now();
      // THE HUNG ENTITY IS FIRST, so serial execution would put it in front.
      const results = await executor.executeBatch([call(hung), call(healthy)], SCOPE);
      const batchMs = Date.now() - startedAt;

      expect(results[1]).toMatchObject({ tool: "healthy.work", status: "success" });
      expect(healthy.server.calls).toHaveLength(1);
      const healthyArrivedMs = healthy.server.calls[0]!.atMs - startedAt;
      expect(healthyArrivedMs).toBeLessThan(ISOLATION_BOUND_MS);

      // The hang was real and concurrent: the batch waited out the hung call's
      // own timeout, and the hung call is reported as exactly that.
      expect(hung.server.calls).toHaveLength(1);
      expect(results[0]).toMatchObject({ tool: "hung.work", status: "timeout" });
      expect(batchMs).toBeGreaterThanOrEqual(CALL_TIMEOUT_MS - 100);
    }, 30_000);

    it("a CRASHING server fails its own call while the healthy entity's in-flight call still succeeds", async () => {
      const crashing: Entity = {
        pk: "entity-crashing",
        externalId: "crashing",
        toolName: "crashing.work",
        server: await remote(transport, "crashing.work", "crash"),
        transport,
      };
      // The healthy tool answers AFTER the crash has happened and been handled,
      // so its client is mid-call at the moment the crashing session is evicted.
      const healthy: Entity = {
        pk: "entity-healthy",
        externalId: "healthy",
        toolName: "healthy.work",
        server: await remote(transport, "healthy.work", "answer", 400),
        transport,
      };
      const { executor } = executorFor([crashing, healthy]);

      const startedAt = Date.now();
      const results = await executor.executeBatch([call(crashing), call(healthy)], SCOPE);

      expect(crashing.server.calls).toHaveLength(1);
      // Reached and refused — a reset socket, not a slow tool — so `failed`, not
      // `timeout`, and it did not wait for the call timeout to say so.
      expect(results[0]).toMatchObject({ tool: "crashing.work", status: "failed" });
      expect(results[1]).toMatchObject({ tool: "healthy.work", status: "success" });
      expect(healthy.server.calls[0]!.atMs - startedAt).toBeLessThan(ISOLATION_BOUND_MS);
    }, 30_000);
  },
);

describe("WIN-269 — eviction is exact", () => {
  it("evict drops only the client it is handed, and never a replacement another caller already rebuilt", async () => {
    const server = await remote("remote-http", "exact.work", "answer");
    const credentials = new McpCredentialService({} as never);
    const pool = new McpConnectionPool(credentials);
    pools.push(pool);
    const input = { server: { id: "entity-exact" }, resolvedUrl: server.url, resolvedHeaders: {}, transportKind: "remote-http" };
    const other = { ...input, server: { id: "entity-other" } };

    const first = await pool.getClient(input);
    const neighbour = await pool.getClient(other);
    expect(await pool.getClient(input)).toBe(first);

    expect(pool.evict(first)).toBe(true);
    const rebuilt = await pool.getClient(input);
    expect(rebuilt).not.toBe(first);
    // A late failure on the OLD client must not take the rebuilt one with it.
    expect(pool.evict(first)).toBe(false);
    expect(await pool.getClient(input)).toBe(rebuilt);
    // And the other entity's session was never touched.
    expect(await pool.getClient(other)).toBe(neighbour);
    expect(server.initializes).toBe(3);
  }, 30_000);
});
