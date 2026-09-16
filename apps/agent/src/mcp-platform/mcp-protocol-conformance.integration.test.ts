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
 * those ARE is read from the installed manifests and joined to `pnpm-lock.yaml`.
 *
 * THAT VERSION JOIN IS NOT ENOUGH ON ITS OWN, and this file's first draft claimed
 * it was. Two manifests on disk say nothing about which MODULES this file loaded:
 * repointing the four candidate import specifiers at the adopted SDK leaves both
 * manifests, the lockfile and every version assertion untouched, and the matrix
 * then asks ONE build the same questions twice while the derived evidence still
 * reads "candidate — compatible". So the separation is asserted where it can
 * fail: the two rows of `SDK_BUILDS` must hold DIFFERENT objects, each must be
 * the very object a dynamic `import()` of its own specifier yields, and each
 * specifier must resolve inside the pnpm store directory of its own version.
 * Only with those three does the matrix fail to collapse into one build asked
 * twice.
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
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { Client as AdoptedClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport as AdoptedSseTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport as AdoptedHttpTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EmptyResultSchema as AdoptedEmptyResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Client as CandidateClient } from "@modelcontextprotocol/sdk-candidate/client/index.js";
import { SSEClientTransport as CandidateSseTransport } from "@modelcontextprotocol/sdk-candidate/client/sse.js";
import { StreamableHTTPClientTransport as CandidateHttpTransport } from "@modelcontextprotocol/sdk-candidate/client/streamableHttp.js";
import { EmptyResultSchema as CandidateEmptyResultSchema } from "@modelcontextprotocol/sdk-candidate/types.js";
import { APP_GUARD } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ScopeGuard } from "../auth/scope.guard";
import { PAYLOAD_TOO_LARGE_ERROR, resolveUnauthBodyCaps } from "../http/request-body-limits";
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
  /** Every module specifier the imports above take from this build. */
  readonly specifiers: readonly string[];
  readonly Client: typeof AdoptedClient;
  readonly HttpTransport: typeof AdoptedHttpTransport;
  readonly SseTransport: typeof AdoptedSseTransport;
  readonly EmptyResultSchema: typeof AdoptedEmptyResultSchema;
}

const SDK_BUILDS: readonly SdkBuild[] = [
  {
    label: "adopted",
    packageDirectory: "@modelcontextprotocol/sdk",
    specifiers: [
      "@modelcontextprotocol/sdk/client/index.js",
      "@modelcontextprotocol/sdk/client/sse.js",
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
      "@modelcontextprotocol/sdk/types.js",
    ],
    Client: AdoptedClient,
    HttpTransport: AdoptedHttpTransport,
    SseTransport: AdoptedSseTransport,
    EmptyResultSchema: AdoptedEmptyResultSchema,
  },
  {
    label: "candidate",
    packageDirectory: "@modelcontextprotocol/sdk-candidate",
    specifiers: [
      "@modelcontextprotocol/sdk-candidate/client/index.js",
      "@modelcontextprotocol/sdk-candidate/client/sse.js",
      "@modelcontextprotocol/sdk-candidate/client/streamableHttp.js",
      "@modelcontextprotocol/sdk-candidate/types.js",
    ],
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

// `createRequire` from the agent package root, not from `import.meta.url`: this
// package typechecks as CommonJS, where `import.meta` is an error. Resolution
// starts in `apps/agent`, which is the importer that declares both builds.
const requireFromHere = createRequire(resolve(agentRoot(), "package.json"));

/**
 * The version whose pnpm store directory a specifier actually resolves into.
 * The alias and the adopted name are two `node_modules` entries, but both are
 * links into `.pnpm/@modelcontextprotocol+sdk@<version>_…`, so the store path is
 * the resolver's own answer to "which build is this specifier".
 */
function resolvedStoreVersion(specifier: string): string {
  const resolved = requireFromHere.resolve(specifier);
  const match = /@modelcontextprotocol\+sdk@(\d+\.\d+\.\d+)/u.exec(resolved);
  if (!match) {
    throw new Error(`${specifier} did not resolve inside an @modelcontextprotocol/sdk store directory: ${resolved}`);
  }
  return match[1]!;
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

  it("loads two DIFFERENT SDK MODULE GRAPHS, not two manifests: the classes differ and each is its own specifier's", async () => {
    // WHY THIS IS A SEPARATE CASE FROM THE VERSION JOIN ABOVE. That one reads
    // `node_modules` and `pnpm-lock.yaml` — the tree, not this file. Repointing
    // the four `sdk-candidate` imports at `sdk` keeps it green and quietly turns
    // the matrix into one build asked twice. These three joins cannot be:
    //
    //   1. the resolver's own answer for each specifier this file imports,
    const adoptedVersion = installedVersion(SDK_BUILDS[0]!);
    const candidateVersion = installedVersion(SDK_BUILDS[1]!);
    for (const build of SDK_BUILDS) {
      const expected = build.label === "adopted" ? adoptedVersion : candidateVersion;
      for (const specifier of build.specifiers) {
        expect({ specifier, store: resolvedStoreVersion(specifier) }).toEqual({ specifier, store: expected });
      }
    }
    //   2. the objects the matrix actually constructs are DIFFERENT objects —
    //      one module graph cannot supply both rows,
    expect(SDK_BUILDS[1]!.Client).not.toBe(SDK_BUILDS[0]!.Client);
    expect(SDK_BUILDS[1]!.HttpTransport).not.toBe(SDK_BUILDS[0]!.HttpTransport);
    expect(SDK_BUILDS[1]!.SseTransport).not.toBe(SDK_BUILDS[0]!.SseTransport);
    expect(SDK_BUILDS[1]!.EmptyResultSchema).not.toBe(SDK_BUILDS[0]!.EmptyResultSchema);
    //   3. and each row holds the export of the specifier it CLAIMS, fetched here
    //      by a dynamic import of that literal. A static import edited to point
    //      elsewhere fails here even where both objects still differ.
    const [adoptedClient, adoptedSse, adoptedHttp, adoptedTypes] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/client/sse.js"),
      import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    const [candidateClient, candidateSse, candidateHttp, candidateTypes] = await Promise.all([
      import("@modelcontextprotocol/sdk-candidate/client/index.js"),
      import("@modelcontextprotocol/sdk-candidate/client/sse.js"),
      import("@modelcontextprotocol/sdk-candidate/client/streamableHttp.js"),
      import("@modelcontextprotocol/sdk-candidate/types.js"),
    ]);
    expect(SDK_BUILDS[0]!.Client).toBe(adoptedClient.Client);
    expect(SDK_BUILDS[0]!.SseTransport).toBe(adoptedSse.SSEClientTransport);
    expect(SDK_BUILDS[0]!.HttpTransport).toBe(adoptedHttp.StreamableHTTPClientTransport);
    expect(SDK_BUILDS[0]!.EmptyResultSchema).toBe(adoptedTypes.EmptyResultSchema);
    expect(SDK_BUILDS[1]!.Client).toBe(candidateClient.Client as never);
    expect(SDK_BUILDS[1]!.SseTransport).toBe(candidateSse.SSEClientTransport as never);
    expect(SDK_BUILDS[1]!.HttpTransport).toBe(candidateHttp.StreamableHTTPClientTransport as never);
    expect(SDK_BUILDS[1]!.EmptyResultSchema).toBe(candidateTypes.EmptyResultSchema as never);
  });

  it("configures Redis exactly as the production provider does", () => {
    const provider = readFileSync(resolve(agentRoot(), "src/shared/redis.provider.ts"), "utf8");
    expect(provider).toContain(`keyPrefix: "${REDIS_KEY_PREFIX}"`);
  });

  it("mounts the production ScopeGuard and NOT the two production pieces the harness header names", () => {
    // The harness header claims exactly two omissions from the production
    // request path for `/mcp`. Both halves of each claim are read here — the
    // production source that HAS the piece, and the harness source that does
    // not — so the paragraph cannot quietly become false in either direction.
    const appModule = readFileSync(resolve(agentRoot(), "src/app.module.ts"), "utf8");
    const main = readFileSync(resolve(agentRoot(), "src/main.ts"), "utf8");
    const harness = readFileSync(resolve(agentRoot(), "src/mcp-platform/mcp-conformance.test-fixture.ts"), "utf8");

    // PRODUCTION: two global guards.
    expect(appModule).toContain("{ provide: APP_GUARD, useClass: ScopeGuard },");
    expect(appModule).toContain("{ provide: APP_GUARD, useClass: RateLimitGuard },");
    // HARNESS: the first only, and it is the production class this file imports.
    expect(harness).toContain("{ provide: APP_GUARD, useValue: new ScopeGuard() },");
    expect(harness).toContain('import { ScopeGuard } from "../auth/scope.guard";');
    expect(typeof ScopeGuard.prototype.canActivate).toBe("function");
    expect(APP_GUARD).toBe("APP_GUARD");
    // The header NAMES the rate limiter as the piece it does not mount, so what
    // is asserted absent is the import and any construction of it.
    expect(harness).not.toMatch(/^import .*RateLimitGuard/mu);
    expect(harness).not.toMatch(/new RateLimitGuard\(/u);

    // PRODUCTION: the unauthenticated `/mcp` body cap, ahead of the 15 MB parser.
    //
    // THE CAP MOVED OUT OF `main.ts` ON THE OTHER SIDE OF THIS MERGE. The M4 gates
    // lane extracted the table, the middleware and the 413 into
    // `http/request-body-limits.ts` so they could be driven over a real socket, and
    // `main.ts` now installs what that module composes. Asserting the old literal
    // here would have been asserting where the code used to live, so the claim is
    // read where it is TRUE now — and the cap itself is taken from the function the
    // production path calls rather than from any file's text, so moving it again
    // without moving this case is a red test and not a silently passing one.
    const productionCaps = resolveUnauthBodyCaps({});
    expect(productionCaps.map((entry) => entry.prefix)).toContain("/mcp");
    expect(productionCaps.find((entry) => entry.prefix === "/mcp")?.cap).toBeGreaterThan(0);
    expect(PAYLOAD_TOO_LARGE_ERROR).toBe("payload_too_large");
    // And `main.ts` really installs it: the composed table reaches the running
    // process rather than sitting in a module nothing calls.
    expect(main).toContain("installRequestBodyLimits(");
    expect(main).toContain("resolveUnauthBodyCaps({");
    // HARNESS: the parser, no cap. A 413 the production surface would return is
    // therefore outside every conclusion this file draws.
    expect(harness).toContain('app.useBodyParser("json", { limit: "15mb" });');
    expect(harness).not.toContain("payload_too_large");
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

  it("hands a tool the request's abort signal UNABORTED when the client is still there", async () => {
    // THE DEFECT THIS CASE FOUND. `McpPlatformController.jsonRpc` builds an
    // `AbortController` for the request and pre-checks whether the client has
    // already gone, as `req.aborted || req.destroyed || res.destroyed`. Node
    // destroys an `IncomingMessage` the moment its body has been read to the end,
    // and the JSON parser reads every body BEFORE the handler runs — so
    // `req.destroyed` was true on every request that carried a body, and every
    // dispatch started with an aborted signal. Measured at the handler:
    // `{ aborted: false, destroyed: true, complete: true, socket.destroyed: false }`.
    //
    // Only three platform tools take that signal, and none of the matrix's calls
    // is one of them, so the whole conformance suite was green over a transport on
    // which `macros.replay` could not complete a single step: it checks the signal
    // at the top of each step and throws `MCP macro replay cancelled`, which the
    // router reports as `-32603 "internal error"`.
    //
    // The oracle is the tool's own OUTCOME, not an inspection of the flag: a
    // one-step macro whose step is `platos.whoami`, replayed over Streamable HTTP.
    // With the pre-check as it was, this is a -32603.
    const macro = await schema.prisma.macro.create({
      data: {
        environmentId: tenant.environmentId,
        name: "conformance-abort-signal",
        steps: [{ tool: "platos.whoami", params: {} }] as never,
        createdBy: tenant.userId,
      },
      select: { id: true },
    });
    const answered = await fetch(new URL("/mcp/platform", servers.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tenant.platformToken}`,
        "x-forwarded-for": "198.51.100.200",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "abort-signal",
        method: "tools/call",
        params: { name: "macros.replay", arguments: { macroId: macro.id, params: {} } },
      }),
    });
    expect(answered.status).toBe(200);
    const body = (await answered.json()) as {
      error?: { code?: number; message?: string };
      result?: { content?: Array<{ text?: string }> };
    };
    expect({ error: body.error }).toEqual({ error: undefined });
    const replayed = JSON.parse(body.result!.content![0]!.text!) as {
      stepCount: number;
      results: Array<{ ok: boolean; tool: string }>;
    };
    expect({ stepCount: replayed.stepCount, ok: replayed.results.map((step) => step.ok) }).toEqual({
      stepCount: 1,
      ok: [true],
    });
  });

  it("leaves no entity SSE session behind when the client hangs up during the handshake", async () => {
    // WHAT THIS GUARDS. `McpEntityController.sse` writes its headers, then does
    // three awaited Redis round trips — the session record, the subscriber's
    // READY check (added by this tranche), SUBSCRIBE — and only then registered
    // its `close` listeners. A client that hung up inside that window left the
    // duplicated subscriber connection open, the ping interval running and the
    // session record in Redis with its full one-hour TTL: a per-disconnect leak
    // on a route anything on the internet can open. `McpPlatformController.sse`
    // already re-checked a `cleanedUp` flag after each await; the entity handler
    // now registers its listeners BEFORE the first one and re-checks the same way.
    //
    // THE WINDOW IS NOT GUESSED AT. `res.flushHeaders()` runs BEFORE those awaits,
    // so `fetch` resolves while the handler is still inside them: aborting the
    // moment the response object arrives lands in the window essentially always.
    //
    // THE ORACLE IS REDIS ITSELF — the session records the server wrote, counted
    // on the same connection the server uses.
    const sessionKeys = async (): Promise<string[]> => servers.redis.keys("*mcp:entity:session:*");
    const baseline = (await sessionKeys()).length;

    // NON-VACUITY: a session opened properly DOES write exactly one record, so the
    // pattern above is the right one and a zero below means "cleaned up", not
    // "never looked in the right place".
    const healthy = new AbortController();
    const healthyStream = await fetch(endpoint("entity", "legacy-sse"), {
      headers: { ...bearer("entity"), accept: "text/event-stream" },
      signal: healthy.signal,
    });
    expect(healthyStream.status).toBe(200);
    const reader = healthyStream.body!.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value!);
    expect(firstChunk).toContain("event: endpoint");
    expect((await sessionKeys()).length).toBe(baseline + 1);
    healthy.abort();
    await reader.cancel().catch(() => undefined);
    for (let index = 0; index < 40 && (await sessionKeys()).length > baseline; index += 1) await settle();
    expect((await sessionKeys()).length).toBe(baseline);

    // THE CASE: ten handshakes abandoned the instant the headers arrive.
    for (let index = 0; index < 10; index += 1) {
      const aborting = new AbortController();
      const opened = await fetch(endpoint("entity", "legacy-sse"), {
        headers: { ...bearer("entity"), accept: "text/event-stream" },
        signal: aborting.signal,
      });
      expect(opened.status).toBe(200);
      aborting.abort();
      await opened.body?.cancel().catch(() => undefined);
    }
    for (let index = 0; index < 40 && (await sessionKeys()).length > baseline; index += 1) await settle();
    expect(await sessionKeys()).toHaveLength(baseline);
  }, 60_000);

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
              // SDK reports that once where the stream is opened and once from its caller.
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
