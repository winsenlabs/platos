/**
 * WIN-268 (M4.2) — MCP PROTOCOL CONFORMANCE OF PLATOS' OWN SERVERS, DRIVEN BY
 * THE OFFICIAL SDK CLIENT, OVER A REAL SOCKET, ON BOTH TRANSPORTS, AT BOTH THE
 * ADOPTED SDK AND THE 1.30.x CANDIDATE.
 *
 * WHY THIS FILE EXISTS. Before it, `@modelcontextprotocol/sdk` was imported by
 * the outbound client pool, the V1 dispatch adapter and that adapter's suite —
 * which is a client of the SDK's server. NOTHING drove `/mcp/platform`,
 * `/mcp/entity/:id` or the docs server with an MCP client, so every property a
 * third-party client depends on was asserted by our own reading of the spec
 * against our own handlers. The oracle here is the SDK itself: the reference
 * implementation of the wire format parses every byte these servers send.
 *
 * THE MATRIX. 3 servers x 2 transports (Streamable HTTP and the retained
 * 2024-11-05 HTTP+SSE) x 2 SDK builds = 12 sessions, each asked the same
 * questions. The builds are the adopted `@modelcontextprotocol/sdk` and the
 * candidate aliased as `@modelcontextprotocol/sdk-candidate`; which versions
 * those ARE is read from the installed manifests and joined to
 * `pnpm-lock.yaml`, and the two are required to differ, so the matrix cannot
 * collapse into one build asked twice.
 *
 * THE WIRE IS TAPPED, NOT TRUSTED. The SDK client is lenient where the
 * specification is not: it ignores a body on a notification's reply and routes
 * an unparseable frame to `onerror` without failing. So every transport is given
 * a `fetch` that records each exchange — method, status, content type, body —
 * and tees every event stream into a raw frame log. The assertions that found
 * the two defects this suite fixed are assertions on that log, not on what the
 * SDK chose to surface:
 *
 *   1. `notifications/initialized` was answered `201 {"id":null,"result":{}}`
 *      on Streamable HTTP and PUBLISHED as an `event: message` frame on the
 *      legacy stream, where the SDK rejects it on every handshake;
 *   2. `POST /mcp/platform` and `POST /mcp/entity/:id` answered 201, because
 *      Nest's `@Post()` default was never overridden.
 *
 * Two more fell out of running the matrix: all three servers advertise
 * `capabilities.logging` and answered `logging/setLevel` with -32601, and the
 * docs server answered the transport's optional `GET` stream with its 200 JSON
 * probe, which the SDK reads as an empty event stream and reconnects to forever.
 *
 * WHAT IS RECORDED RATHER THAN FIXED is pinned as observed, so a change in
 * either direction is a visible diff: see `RECORDED_NON_CONFORMANCE` below.
 *
 * GATED. Needs a PostgreSQL with pgvector (every canonical migration is applied
 * into a private schema) and a Redis. `MCP_CONFORMANCE_REQUIRED=1` turns an
 * absent service into a failure, and the CI job that runs this sets it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Client as AdoptedClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport as AdoptedSseTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport as AdoptedHttpTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EmptyResultSchema as AdoptedEmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client as CandidateClient } from "@modelcontextprotocol/sdk-candidate/client/index.js";
import { SSEClientTransport as CandidateSseTransport } from "@modelcontextprotocol/sdk-candidate/client/sse.js";
import { StreamableHTTPClientTransport as CandidateHttpTransport } from "@modelcontextprotocol/sdk-candidate/client/streamableHttp.js";
import { EmptyResultSchema as CandidateEmptyResultSchema } from "@modelcontextprotocol/sdk-candidate/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DOCS_MCP_SERVER_NAME,
  MCP_PROTOCOL_VERSION,
  PLATFORM_MCP_SERVER_NAME,
  entityMcpServerName,
} from "../http/mcp-surface";
import {
  REDIS_KEY_PREFIX,
  WireTap,
  agentRoot,
  openPrivateSchema,
  seedTenant,
  startMcpServers,
  type PrivateSchema,
  type RunningMcpServers,
  type SeededTenant,
} from "./mcp-conformance.test-fixture";

// NO `DATABASE_URL` / `REDIS_URL` FALLBACK: `apps/agent/test/setup.ts` stamps
// fake values into every worker, and a suite that read them would turn a skip
// into a red on every machine without the services.
const baseDatabaseUrl =
  process.env.MCP_CONFORMANCE_TEST_DATABASE_URL ?? process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;
const redisUrl = process.env.MCP_CONFORMANCE_TEST_REDIS_URL ?? process.env.PLATOS_TEST_REDIS_URL;

if (process.env.MCP_CONFORMANCE_REQUIRED === "1" && (!baseDatabaseUrl || !redisUrl)) {
  throw new Error(
    "MCP_CONFORMANCE_REQUIRED=1 but PLATOS_POSTGRES_INTEGRATION_DATABASE_URL and PLATOS_TEST_REDIS_URL are not both set",
  );
}

const describeWithServices = baseDatabaseUrl && redisUrl ? describe : describe.skip;

// ---------------------------------------------------------------------------
// THE TWO SDK BUILDS

interface SdkBuild {
  readonly label: "adopted" | "candidate";
  readonly packageDirectory: string;
  readonly Client: typeof AdoptedClient;
  readonly HttpTransport: typeof AdoptedHttpTransport;
  readonly SseTransport: typeof AdoptedSseTransport;
  readonly EmptyResultSchema: typeof AdoptedEmptyResultSchema;
}

const SDK_BUILDS: readonly SdkBuild[] = [
  {
    label: "adopted",
    packageDirectory: "@modelcontextprotocol/sdk",
    Client: AdoptedClient,
    HttpTransport: AdoptedHttpTransport,
    SseTransport: AdoptedSseTransport,
    EmptyResultSchema: AdoptedEmptyResultSchema,
  },
  {
    label: "candidate",
    packageDirectory: "@modelcontextprotocol/sdk-candidate",
    Client: CandidateClient as unknown as typeof AdoptedClient,
    HttpTransport: CandidateHttpTransport as unknown as typeof AdoptedHttpTransport,
    SseTransport: CandidateSseTransport as unknown as typeof AdoptedSseTransport,
    EmptyResultSchema: CandidateEmptyResultSchema as unknown as typeof AdoptedEmptyResultSchema,
  },
];

function installedVersion(build: SdkBuild): string {
  const manifest = JSON.parse(
    readFileSync(resolve(agentRoot(), "node_modules", build.packageDirectory, "package.json"), "utf8"),
  ) as { name: string; version: string };
  // An alias installs the REAL package under another directory name; the
  // manifest inside it must still be the SDK's, or the alias points elsewhere.
  expect(manifest.name).toBe("@modelcontextprotocol/sdk");
  return manifest.version;
}

// ---------------------------------------------------------------------------
// SESSIONS

type ServerName = "platform" | "entity" | "docs";
type TransportName = "streamable-http" | "legacy-sse";

const SERVERS: readonly ServerName[] = ["platform", "entity", "docs"];
const TRANSPORTS: readonly TransportName[] = ["streamable-http", "legacy-sse"];

interface Session {
  readonly client: InstanceType<typeof AdoptedClient>;
  readonly tap: WireTap;
  close(): Promise<void>;
}

let forwardedForCounter = 0;

describeWithServices("MCP protocol conformance of the Platos servers", () => {
  let schema: PrivateSchema;
  let servers: RunningMcpServers;
  let tenant: SeededTenant;

  beforeAll(async () => {
    schema = await openPrivateSchema(baseDatabaseUrl!, "mcpconf");
    tenant = await seedTenant(schema.prisma, `mcpconf-${String(process.pid)}`);
    servers = await startMcpServers({ prisma: schema.prisma, redisUrl: redisUrl! });
  }, 240_000);

  afterAll(async () => {
    await servers?.close();
    await schema?.drop();
  });

  function endpoint(server: ServerName, transport: TransportName): URL {
    const base =
      server === "platform"
        ? "/mcp/platform"
        : server === "entity"
          ? `/mcp/entity/${tenant.entity.entityId}`
          : "/mcp/docs";
    return new URL(`${servers.baseUrl}${base}${transport === "legacy-sse" ? "/sse" : ""}`);
  }

  function bearer(server: ServerName): Record<string, string> {
    if (server === "platform") return { authorization: `Bearer ${tenant.platformToken}` };
    if (server === "entity") return { authorization: `Bearer ${tenant.entity.pat}` };
    return {};
  }

  async function open(build: SdkBuild, server: ServerName, transport: TransportName): Promise<Session> {
    forwardedForCounter += 1;
    const tap = new WireTap(`198.51.100.${String(forwardedForCounter)}`);
    const requestInit = { headers: bearer(server) };
    const client = new build.Client({ name: `platos-conformance-${build.label}`, version: "0.0.0" }, { capabilities: {} });
    client.onerror = (error: Error) => {
      tap.errors.push(error.message);
    };
    const wire =
      transport === "streamable-http"
        ? new build.HttpTransport(endpoint(server, transport), { requestInit, fetch: tap.fetch })
        : new build.SseTransport(endpoint(server, transport), {
            requestInit,
            fetch: tap.fetch,
            eventSourceInit: { fetch: tap.fetch } as never,
          });
    // A handshake that never completes fails in seconds and says so, rather than
    // spending the test timeout: a lost `initialize` frame is exactly how the
    // subscriber-readiness defect presented.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.connect(wire as never),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${build.label} SDK: initialize with the ${server} server over ${transport} did not complete in 5s`)),
            5_000,
          );
        }),
      ]);
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return {
      client: client as InstanceType<typeof AdoptedClient>,
      tap,
      async close() {
        await client.close().catch(() => undefined);
      },
    };
  }

  /** Wait until the server has had time to write anything it was going to. */
  async function settle(): Promise<void> {
    await new Promise((resolveSettled) => setTimeout(resolveSettled, 150));
  }

  // -------------------------------------------------------------------------
  // THE JOINS THE MATRIX DEPENDS ON

  it("runs two DIFFERENT SDK builds: the adopted pin and a 1.30.x candidate, both as the lockfile resolves them", () => {
    const lockfile = readFileSync(resolve(agentRoot(), "../../pnpm-lock.yaml"), "utf8");
    const adopted = installedVersion(SDK_BUILDS[0]!);
    const candidate = installedVersion(SDK_BUILDS[1]!);
    expect(candidate).toMatch(/^1\.30\.\d+$/u);
    expect(adopted).not.toBe(candidate);
    // apps/agent's importer, as pnpm recorded it: the caret range held at the
    // adopted version, and the alias at the candidate.
    const importer = lockfile.slice(lockfile.indexOf("\n  apps/agent:\n"), lockfile.indexOf("\n  apps/core-api:\n"));
    expect(importer).toContain(`'@modelcontextprotocol/sdk':\n        specifier: ^1.26.0\n        version: ${adopted}(`);
    expect(importer).toContain(
      `'@modelcontextprotocol/sdk-candidate':\n        specifier: npm:@modelcontextprotocol/sdk@${candidate}\n        version: '@modelcontextprotocol/sdk@${candidate}(`,
    );
  });

  it("configures Redis exactly as the production provider does", () => {
    const provider = readFileSync(resolve(agentRoot(), "src/shared/redis.provider.ts"), "utf8");
    expect(provider).toContain(`keyPrefix: "${REDIS_KEY_PREFIX}"`);
  });

  it("binds every controller constructor parameter to a token read from its source", () => {
    expect(servers.boundTokens.McpPlatformController).toHaveLength(40);
    expect(servers.boundTokens.McpPlatformController?.slice(-4)).toEqual([
      "PRISMA_TOKEN",
      "PLATOS_SECRET_STORE_TOKEN",
      "REDIS_TOKEN",
      "ModuleRef",
    ]);
    expect(servers.boundTokens.McpEntityController).toHaveLength(9);
    expect(servers.boundTokens.DocsMcpController).toEqual(["DocsMcpService"]);
  });

  // -------------------------------------------------------------------------
  // THE MATRIX

  for (const build of SDK_BUILDS) {
    for (const server of SERVERS) {
      for (const transport of TRANSPORTS) {
        describe(`${build.label} SDK -> ${server} server over ${transport}`, () => {
          it("completes initialize with this server's identity, the Platos wire revision and its capabilities", async () => {
            const session = await open(build, server, transport);
            try {
              const info = session.client.getServerVersion();
              const expectedName =
                server === "platform"
                  ? PLATFORM_MCP_SERVER_NAME
                  : server === "entity"
                    ? entityMcpServerName(tenant.entity.entityId)
                    : DOCS_MCP_SERVER_NAME;
              expect(info?.name).toBe(expectedName);
              const capabilities = session.client.getServerCapabilities();
              expect(capabilities?.tools).toBeDefined();
              expect(capabilities?.logging).toBeDefined();
              if (server === "docs") expect(capabilities?.resources).toBeDefined();
              else expect(capabilities?.resources).toBeUndefined();

              // The initialize RESULT as the server wrote it.
              await settle();
              const initialize =
                transport === "streamable-http"
                  ? JSON.parse(session.tap.postsFor("initialize")[0]?.responseText ?? "null")
                  : session.tap.messageFrames().find((frame) => (frame["result"] as { protocolVersion?: unknown } | undefined)?.protocolVersion);
              expect(initialize?.result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
              // The transport's optional server-to-client stream is asked for
              // exactly once and refused. Anything else — a 200 the SDK reads as
              // an event stream, for instance — shows up as a status here or as
              // the reconnect loop that answer causes.
              if (transport === "streamable-http") {
                const streams = session.tap.exchanges.filter((exchange) => exchange.method === "GET");
                expect(streams.map((exchange) => exchange.status)).toEqual([server === "docs" ? 405 : 404]);
              }
              // The one error a session may raise, and only where it is pinned in
              // RECORDED_NON_CONFORMANCE: the optional GET stream answered 404. The
              // SDK reports that once from the attempt and once from its caller.
              if (transport === "streamable-http" && server !== "docs") {
                expect(session.tap.errors.length).toBeGreaterThan(0);
                for (const message of session.tap.errors) {
                  expect(message).toMatch(/Failed to open SSE stream: Not Found/u);
                }
              } else {
                expect(session.tap.errors).toEqual([]);
              }
            } finally {
              await session.close();
            }
          });

          it("answers requests 200 or 202-on-the-stream, and NEVER answers a notification", async () => {
            const session = await open(build, server, transport);
            try {
              await session.client.ping();
              await session.client.notification({
                method: "notifications/cancelled",
                params: { requestId: 424242, reason: "conformance: cancellation of a request that is not in flight" },
              });
              await session.client.ping();
              await settle();

              const initialized = session.tap.postsFor("notifications/initialized");
              const cancelled = session.tap.postsFor("notifications/cancelled");
              expect(initialized).toHaveLength(1);
              expect(cancelled).toHaveLength(1);
              for (const exchange of [...initialized, ...cancelled]) {
                // Streamable HTTP: "202 Accepted with no body". Legacy SSE: every
                // POST is a 202 and the answer, if any, rides the stream.
                expect(exchange.status).toBe(202);
                expect(exchange.responseText).toBe("");
              }
              for (const exchange of session.tap.postsFor("ping")) {
                expect(exchange.status).toBe(transport === "streamable-http" ? 200 : 202);
                if (transport === "streamable-http") expect(exchange.contentType).toMatch(/^application\/json/u);
              }
              // THE DEFECT, READ OFF THE RAW STREAM: nothing the server wrote may
              // lack an id unless it is a server notification, and nothing may
              // carry `id: null`.
              for (const frame of session.tap.messageFrames()) {
                if ("method" in frame) continue;
                expect(frame["id"]).not.toBeNull();
                expect(frame["id"]).toBeDefined();
              }
              if (transport === "legacy-sse") {
                // initialize + ping + ping, and not one frame more.
                expect(session.tap.messageFrames().filter((frame) => !("method" in frame))).toHaveLength(3);
              }
              expect(session.tap.errors.filter((message) => !/Failed to open SSE stream/u.test(message))).toEqual([]);
            } finally {
              await session.close();
            }
          });

          it("honours the logging capability it advertises, and refuses an unknown severity with -32602", async () => {
            const session = await open(build, server, transport);
            try {
              await expect(session.client.setLoggingLevel("warning")).resolves.toEqual({});
              await expect(
                session.client.request(
                  { method: "logging/setLevel", params: { level: "verbose" } } as never,
                  build.EmptyResultSchema,
                ),
              ).rejects.toMatchObject({ code: -32602 });
            } finally {
              await session.close();
            }
          });

          it("lists tools the SDK's own schema accepts, with no pagination cursor", async () => {
            const session = await open(build, server, transport);
            try {
              const listed = await session.client.listTools();
              expect(listed.nextCursor).toBeUndefined();
              const names = listed.tools.map((tool) => tool.name);
              if (server === "platform") {
                expect(names).toContain("platos.whoami");
                expect(names.length).toBeGreaterThan(100);
                for (const tool of listed.tools) expect(tool.inputSchema.type).toBe("object");
              } else if (server === "entity") {
                // Exposure is the environment-owned ACL row: the exposed tool and
                // NOT its registered sibling.
                expect(names).toEqual([tenant.entity.exposedTool]);
              } else {
                expect(names).toEqual(["search_docs"]);
              }
            } finally {
              await session.close();
            }
          });

          it("calls a tool and returns the MCP content envelope", async () => {
            const session = await open(build, server, transport);
            try {
              if (server === "platform") {
                let progressNotifications = 0;
                const result = await session.client.callTool(
                  { name: "platos.whoami", arguments: {} },
                  undefined,
                  { onprogress: () => (progressNotifications += 1) },
                );
                expect(result.isError).toBeFalsy();
                const body = JSON.parse((result.content as Array<{ type: string; text: string }>)[0]!.text);
                expect(body.scope).toEqual({
                  organizationId: tenant.organizationId,
                  projectId: tenant.projectId,
                  environmentId: tenant.environmentId,
                });
                // A progress token was offered and no progress is produced: the
                // server declares no progress support and emits none.
                expect(progressNotifications).toBe(0);
                const call = transport === "streamable-http" ? session.tap.postsFor("tools/call")[0] : undefined;
                if (call) {
                  expect((call.requestBody as { params: { _meta?: { progressToken?: unknown } } }).params._meta?.progressToken).toBeDefined();
                }
              } else if (server === "docs") {
                const result = await session.client.callTool({ name: "search_docs", arguments: { query: "agent" } });
                expect(result.isError).toBeFalsy();
                expect((result.content as Array<{ type: string }>)[0]?.type).toBe("text");
                expect(Array.isArray((result.structuredContent as { results?: unknown }).results)).toBe(true);
              } else {
                // THE ENTITY DISPATCH IS REFUSED BY DESIGN (no signing credential
                // is seeded). What a client receives is pinned in
                // RECORDED_NON_CONFORMANCE — a protocol error, where the
                // specification reports a tool that ran and failed as `isError`.
                await expect(
                  session.client.callTool({ name: tenant.entity.exposedTool, arguments: { limit: 2 } }),
                ).rejects.toMatchObject({ code: -32603 });
              }
            } finally {
              await session.close();
            }
          });

          it("returns JSON-RPC error codes the SDK surfaces as McpError", async () => {
            const session = await open(build, server, transport);
            try {
              await expect(
                session.client.request({ method: "conformance/no-such-method" } as never, build.EmptyResultSchema),
              ).rejects.toMatchObject({ code: -32601 });
              if (server === "platform") {
                await expect(
                  session.client.callTool({ name: "platos.whoami", arguments: { unexpected: true } }),
                ).rejects.toMatchObject({ code: -32602 });
                await expect(session.client.callTool({ name: "no.such.tool", arguments: {} })).rejects.toMatchObject({
                  code: -32601,
                });
              } else if (server === "entity") {
                await expect(
                  session.client.callTool({ name: tenant.entity.hiddenTool, arguments: {} }),
                ).rejects.toMatchObject({ code: -32001 });
              } else {
                await expect(session.client.callTool({ name: "search_docs", arguments: {} })).rejects.toMatchObject({
                  code: -32602,
                });
              }
            } finally {
              await session.close();
            }
          });

          it("serves resources only where it declares them", async () => {
            const session = await open(build, server, transport);
            try {
              if (server === "docs") {
                const listed = await session.client.listResources();
                expect(listed.resources.length).toBeGreaterThan(0);
                const first = listed.resources[0]!;
                const read = await session.client.readResource({ uri: first.uri });
                expect(read.contents[0]?.uri).toBe(first.uri);
                expect(String((read.contents[0] as { text?: unknown }).text ?? "").length).toBeGreaterThan(0);
                await expect(session.client.readResource({ uri: "docs://conformance/no-such-page" })).rejects.toMatchObject({
                  code: -32601,
                });
              } else {
                await expect(session.client.listResources()).rejects.toMatchObject({ code: -32601 });
              }
            } finally {
              await session.close();
            }
          });
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // RECORDED, NOT FIXED — each pinned as observed.

  describe("RECORDED_NON_CONFORMANCE", () => {
    it("platform and entity answer the transport's optional GET stream 404, where the specification requires 405", async () => {
      // Fixing it adds a GET route per server, which moves the generated
      // operation manifest, the OpenAPI document and ScopeGuard's exact
      // public-transport matcher. The SDK treats any non-405 as a non-fatal
      // `onerror` and keeps the session, which the matrix above pins.
      for (const server of ["platform", "entity"] as const) {
        const response = await fetch(endpoint(server, "streamable-http"), {
          headers: { accept: "text/event-stream", ...bearer(server) },
        });
        expect(response.status).toBe(404);
      }
      const docs = await fetch(endpoint("docs", "streamable-http"), {
        headers: { accept: "text/event-stream", "x-forwarded-for": "203.0.113.7" },
      });
      expect(docs.status).toBe(405);
      expect(docs.headers.get("allow")).toBe("POST");
      const probe = await fetch(endpoint("docs", "streamable-http"), { headers: { "x-forwarded-for": "203.0.113.7" } });
      expect(probe.status).toBe(200);
    });

    it("an entity tool whose dispatch fails is a -32603 protocol error, not an isError result", async () => {
      const response = await fetch(endpoint("entity", "streamable-http"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...bearer("entity") },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: { name: tenant.entity.exposedTool, arguments: { limit: 2 } },
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        result?: unknown;
        error?: { code: number; message: string; data?: { status?: string } };
      };
      // The executor ran, resolved the route and REFUSED the dispatch (this
      // harness seeds no entity signing credential), returning a structured
      // `failed`. The server turns that into a JSON-RPC error carrying the
      // executor's message, where MCP's tools error handling says a tool that
      // ran and failed is a RESULT with `isError: true`. Changing it changes what
      // every existing entity MCP client receives, so it is recorded here and
      // named in the lane report rather than changed in a conformance tranche.
      expect(body.result).toBeUndefined();
      expect(body.error?.code).toBe(-32603);
      expect(body.error?.message).toBe(`Entity ${tenant.entity.entityId} signing credential is unavailable`);
      expect(body.error?.data?.status).toBe("failed");
    });

    it("a body that is not a JSON-RPC request is an HTTP 400 from the framework, not a JSON-RPC -32600", async () => {
      const response = await fetch(endpoint("platform", "streamable-http"), {
        method: "POST",
        headers: { "content-type": "application/json", ...bearer("platform") },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { statusCode?: number; jsonrpc?: string };
      expect(body.statusCode).toBe(400);
      expect(body.jsonrpc).toBeUndefined();
    });
  });
});
