/**
 * WIN-269 (M4.3) — THE LIVE `/tools/sync` SOCKET, AGAINST A REAL PostgreSQL,
 * DRIVEN BY A REAL WebSocket CLIENT, OVER THE FIXTURE THE V1 ROUTE USES.
 *
 * -----------------------------------------------------------------------------
 * WHY IT EXISTS
 *
 * `apps/core-api/src/transports/tools/tool-sync.controller.ts` now serves the
 * three writes this socket makes — the tool declaration, `Entity.connectionStatus`
 * and the heartbeat's `ToolHealth` fold — through published contract methods.
 * Two transports writing the same rows is a strangler, and a strangler nobody
 * joined is two implementations that drift.
 *
 * THE JOIN IS A COMMITTED EXPECTATION, NOT A SHARED TEST. The two suites are in
 * different deployables and neither may import the other: `apps/core-api` may not
 * reach `apps/agent`, and `apps/agent` may not reach a context or an adapter (ADR
 * M0.3 §5.1, decision D8). So both read `ROLLOUT_TOOL_HEARTBEAT` and
 * `ROLLOUT_TOOL_HEALTH_AFTER_HEARTBEAT` out of `@platos/tenancy-database`'s
 * fixture module, send the first and assert the second. One expectation, two
 * transports; a change to either path that moved the row fails the OTHER suite.
 *
 * -----------------------------------------------------------------------------
 * THE ONE PLACE THE FIXTURES DIFFER, AND IT IS A FINDING RATHER THAN A CHOICE
 *
 * The legacy `Entity` is `connectionKind: "mcp"`. THIS SOCKET CANNOT SERVE IT.
 * Its credential lookup filters `entities: { where: { externalId, connectionKind:
 * "wire" } }`, so an `mcp` entity never produces a candidate and the handshake
 * closes 1008 "Invalid service secret or entity not found" — the entity exists,
 * its secret is right, and it is refused for its transport kind.
 *
 * `POST /api/v1/tools/sync` APPLIES NO SUCH FILTER. It authenticates an OPERATOR
 * and reaches `registerTools`, which checks the entity against the grant's
 * project and says nothing about `connectionKind`. So the V1 route serves a
 * strictly WIDER set of entities than the socket it stands beside, and an `mcp`
 * entity that could never have used the socket can use the route. That is
 * recorded here rather than smoothed over, because it is the kind of difference a
 * cutover discovers in production.
 *
 * This suite therefore seeds the fixture's rows with `connectionKind: "wire"`,
 * which is the only shape the socket can be characterized on at all, and
 * `serves only a wire entity` below is the case that pins the reason.
 *
 * -----------------------------------------------------------------------------
 * WHY THE ROWS ARE WRITTEN BY THE CURRENT CLIENT HERE AND BY THE LEGACY ONE THERE
 *
 * The frozen baseline SQL provisions the `public` schema, and this suite — like
 * its two siblings in this directory — runs every migration into a schema of its
 * own so several suites can share one server. Those are incompatible, and the
 * legacy-binary provenance is the CORE-API suite's job: it applies the frozen
 * baseline, writes through the rebuilt old client and migrates forward. What this
 * suite owns is the SOCKET's behaviour over the same VALUES, which is why every
 * value below is imported rather than typed.
 *
 * Run with `PLATOS_POSTGRES_INTEGRATION_DATABASE_URL` (or
 * `TOOL_SYNC_TEST_DATABASE_URL`). A SKIP HAS TO BE VISIBLE: set
 * `TOOL_SYNC_CHARACTERIZATION_REQUIRED=1` and an absent URL is a failure rather
 * than a green.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { ToolRegistryService } from "./tool-registry.service";
import { ToolSyncWsService } from "./tool-sync-ws.service";

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// THE FIXTURE, DEEP-IMPORTED BY MODULE PATH. `upgrade-fixture` is not on the
// package barrel — the barrel is what `apps/webapp` bundles, and this module
// reaches `node:child_process` through `upgrade-baseline-clients`. The rollout
// harness in `packages/adapters/postgres-tenancy` reaches the same modules the
// same way and says the same thing.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const FIXTURE = require("@platos/tenancy-database/dist/upgrade-fixture.js") as {
  readonly ROLLOUT_IDS: Readonly<Record<string, string>>;
  readonly ROLLOUT_TOOL_DECLARATION: {
    readonly name: string;
    readonly description: string;
    readonly paramSchema: Record<string, unknown>;
    readonly category: string;
  };
  readonly ROLLOUT_TOOL_SCHEMA_HASH: string;
  readonly ROLLOUT_TOOL_HEALTH: { readonly lastStatus: string; readonly avgLatencyMs: number };
  readonly ROLLOUT_TOOL_HEARTBEAT: {
    readonly status: string;
    readonly avg_latency_ms: number;
    readonly error_count_1h: number;
  };
  readonly ROLLOUT_TOOL_HEALTH_AFTER_HEARTBEAT: {
    readonly lastStatus: string;
    readonly avgLatencyMs: number;
    readonly failCount: number;
    readonly totalCalls: number;
    readonly totalFailures: number;
    readonly lastCalledAt: null;
  };
};

// NO `DATABASE_URL` FALLBACK, for the reason the two sibling suites in this
// directory give: `apps/agent/test/setup.ts` stamps a fake URL into every worker,
// and a suite that fell back to it would decide it had a database and fail
// `beforeAll` with `role "test" does not exist` on every machine without one —
// turning a SKIP into a RED for the wrong reason.
const baseDatabaseUrl =
  process.env.TOOL_SYNC_TEST_DATABASE_URL ?? process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;

if (process.env.TOOL_SYNC_CHARACTERIZATION_REQUIRED === "1" && !baseDatabaseUrl) {
  throw new Error(
    "TOOL_SYNC_CHARACTERIZATION_REQUIRED=1 but no database URL is set; " +
      "export TOOL_SYNC_TEST_DATABASE_URL or PLATOS_POSTGRES_INTEGRATION_DATABASE_URL",
  );
}

const describeWithDatabase = baseDatabaseUrl ? describe : describe.skip;

const ENTITY_SECRET = "win269-characterization-entity-secret";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describeWithDatabase("the LIVE /tools/sync socket, over the V1 route's own fixture", () => {
  let admin: { query: (sql: string) => Promise<unknown>; end: () => Promise<void> };
  let adminConnected = false;
  let prisma: PrismaClient;
  let schemaName: string;
  let close: (() => Promise<void>) | undefined;
  let port = 0;
  /** The `EnvironmentEntityTool` and `ToolHealth` ids the fixture left behind. */
  let exposureBefore: { id: string; toolId: string };
  let healthIdBefore: string;

  async function start(): Promise<void> {
    const registry = new ToolRegistryService(prisma as never, undefined as never);
    await registry.rebuildIndex();
    // THE REAL SERVICE, over the REAL client. `httpAdapterHost` is the one
    // collaborator that is stubbed, and only because `onApplicationBootstrap`
    // reaches through it for a server this suite supplies itself — the same
    // arrangement `tool-sync-ws.test.ts` uses, and the handshake path under test
    // is entered identically.
    const service = new ToolSyncWsService(prisma as never, registry, {} as never);
    const httpServer = createServer();
    const wss = new WebSocketServer({ noServer: true });
    httpServer.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    });
    wss.on("connection", async (ws, request: IncomingMessage) => {
      await (service as never as { handleConnection: (ws: unknown, r: unknown) => Promise<void> })
        .handleConnection(ws, request);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
    close = async (): Promise<void> => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    };
  }

  /** The entity row as it stood WHILE the socket was open. */
  let whileConnected: { connectionStatus: string; lastConnectedAt: Date | null };

  /** One session: connect, register, heartbeat, close. The whole socket lifecycle. */
  async function session(): Promise<Record<string, unknown>[]> {
    const received: Record<string, unknown>[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/tools/sync?entity=${FIXTURE.ROLLOUT_TOOL_DECLARATION.category}&env=production`,
      { headers: { authorization: `Bearer ${ENTITY_SECRET}` } },
    );
    await new Promise<void>((settle, fail) => {
      const timer = setTimeout(() => fail(new Error("the socket never welcomed the client")), 20_000);
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(frame);
        if (frame["type"] === "welcome") {
          ws.send(
            JSON.stringify({
              type: "tool_register",
              tools: [
                {
                  name: FIXTURE.ROLLOUT_TOOL_DECLARATION.name,
                  description: FIXTURE.ROLLOUT_TOOL_DECLARATION.description,
                  input_schema: FIXTURE.ROLLOUT_TOOL_DECLARATION.paramSchema,
                  annotations: { category: FIXTURE.ROLLOUT_TOOL_DECLARATION.category },
                },
              ],
            }),
          );
        }
        if (frame["type"] === "tools_registered") {
          ws.send(
            JSON.stringify({
              type: "heartbeat",
              tools_health: {
                [FIXTURE.ROLLOUT_TOOL_DECLARATION.name]: FIXTURE.ROLLOUT_TOOL_HEARTBEAT,
              },
            }),
          );
        }
        if (frame["type"] === "heartbeat_ack") {
          clearTimeout(timer);
          settle();
        }
      });
      ws.on("error", (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
    // READ BEFORE THE CLOSE, because the close is the OTHER half of the pair.
    // `handleConnection` writes `{ connectionStatus: "connected", lastConnectedAt }`
    // after the handshake and the `close` listener writes
    // `{ connectionStatus: "disconnected" }` when the entity's LAST environment
    // connection goes; a suite that only looked afterwards would see the second
    // write and conclude the first never happened.
    whileConnected = await prisma.entity.findUniqueOrThrow({
      where: { id: FIXTURE.ROLLOUT_IDS["entity"] as string },
      select: { connectionStatus: true, lastConnectedAt: true },
    });
    ws.close();
    // The close handler writes asynchronously, off the socket's own close event.
    await new Promise<void>((settle) => setTimeout(settle, 400));
    return received;
  }

  beforeAll(async () => {
    schemaName = `toolsync_${String(process.pid)}_${String(Date.now())}`;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require("pg") as { Client: new (options: unknown) => typeof admin };
    admin = new Client({ connectionString: baseDatabaseUrl });
    await (admin as never as { connect: () => Promise<void> }).connect();
    adminConnected = true;

    // EVERY migration, in order, for the reason the sibling suite states:
    // `enforce_domain_ancestry` is redefined by a later one, and a fixture built
    // from the initial migration alone would prove enforcement production no
    // longer runs.
    const migrationsRoot = resolve(
      process.cwd(),
      "../../internal-packages/tenancy-database/prisma/migrations",
    );
    const migrations = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrations.length).toBeGreaterThan(1);
    for (const migration of migrations) {
      const sql = readFileSync(resolve(migrationsRoot, migration, "migration.sql"), "utf8").replaceAll(
        '"public"',
        `"${schemaName}"`,
      );
      await admin.query(sql);
    }

    const url = new URL(baseDatabaseUrl as string);
    url.searchParams.set("schema", schemaName);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });

    const ids = FIXTURE.ROLLOUT_IDS;
    await prisma.organization.create({
      data: { id: ids["organization"], slug: `win269-${schemaName}`, name: "Rollout" },
    });
    await prisma.project.create({
      data: { id: ids["project"], organizationId: ids["organization"] as string, slug: "rollout", name: "Rollout" },
    });
    await prisma.environment.create({
      data: { id: ids["environment"], projectId: ids["project"] as string, slug: "production", name: "Production" },
    });
    await prisma.entity.create({
      data: {
        id: ids["entity"],
        projectId: ids["project"] as string,
        // THE ENTITY'S EXTERNAL ID IS THE DECLARATION'S CATEGORY, and that is not
        // a coincidence to be papered over: `inferEntityToolCategory` falls back
        // to the entity's own external id for a name with no dot, which is how
        // `rollout_tool` came to be categorised `rollout-entity`. Deriving it here
        // rather than retyping it is what keeps the schema hash reachable.
        externalId: FIXTURE.ROLLOUT_TOOL_DECLARATION.category,
        displayName: "Rollout entity",
        connectionStatus: "connected",
        // `wire`, NOT the fixture's `mcp`. See the banner: the socket's credential
        // lookup filters on this column and can serve nothing else.
        connectionKind: "wire",
      },
    });
    await prisma.credential.create({
      data: {
        environmentId: ids["environment"] as string,
        kind: "ENTITY_SECRET",
        name: FIXTURE.ROLLOUT_TOOL_DECLARATION.category,
        secretHash: sha256(ENTITY_SECRET),
      },
    });
    const tool = await prisma.tool.create({
      data: {
        id: ids["tool"],
        name: FIXTURE.ROLLOUT_TOOL_DECLARATION.name,
        description: FIXTURE.ROLLOUT_TOOL_DECLARATION.description,
        kind: "ENTITY",
        paramSchema: FIXTURE.ROLLOUT_TOOL_DECLARATION.paramSchema as never,
        category: FIXTURE.ROLLOUT_TOOL_DECLARATION.category,
        schemaHash: FIXTURE.ROLLOUT_TOOL_SCHEMA_HASH,
      },
    });
    const mapping = await prisma.environmentEntityTool.create({
      data: {
        id: ids["mapping"],
        environmentId: ids["environment"] as string,
        entityId: ids["entity"] as string,
        toolId: tool.id,
      },
    });
    exposureBefore = { id: mapping.id, toolId: mapping.toolId };
    const health = await prisma.toolHealth.create({
      data: {
        id: ids["toolHealth"],
        environmentId: ids["environment"] as string,
        toolId: tool.id,
        entityExternalId: FIXTURE.ROLLOUT_TOOL_DECLARATION.category,
        lastStatus: FIXTURE.ROLLOUT_TOOL_HEALTH.lastStatus,
        avgLatencyMs: FIXTURE.ROLLOUT_TOOL_HEALTH.avgLatencyMs,
      },
    });
    healthIdBefore = health.id;

    await start();
  });

  afterAll(async () => {
    await close?.();
    await prisma?.$disconnect().catch(() => undefined);
    if (adminConnected) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });

  it("welcomes the entity, registers nothing new, and acknowledges the heartbeat", async () => {
    const frames = await session();
    const types = frames.map((frame) => frame["type"]);
    expect(types).toContain("welcome");
    expect(types).toContain("tools_registered");
    expect(types).toContain("heartbeat_ack");
    const registered = frames.find((frame) => frame["type"] === "tools_registered");
    // THE SAME THREE NUMBERS THE V1 ROUTE ANSWERS WITH. `new_tools: 0` is the
    // reconnect claim: the content-addressed lookup found the existing `Tool` row
    // rather than minting a second one.
    expect(registered?.["count"]).toBe(1);
    expect(registered?.["new_tools"]).toBe(0);
    expect(registered?.["pruned"]).toBe(0);
    // `updated: 1` — the exposure row already existed and was re-touched. The V1
    // route answers the same four numbers under the names `registered`,
    // `newTools`, `updated` and `pruned`, and its reconnect suite asserts them.
    expect(registered?.["updated"]).toBe(1);
  });

  it("leaves the exposure's identity untouched", async () => {
    const mappings = await prisma.environmentEntityTool.findMany({
      where: { entityId: FIXTURE.ROLLOUT_IDS["entity"] as string },
      select: { id: true, toolId: true },
    });
    // ONE ROW, THE SAME ROW. A reconnect that minted a tool would leave one row
    // here too — with a different `toolId` — which is why the id is compared and
    // not the count.
    expect(mappings).toEqual([exposureBefore]);
  });

  it("writes BOTH halves of the connection pair, and the disconnect keeps the date", async () => {
    // THE CONNECT HALF, read while the socket was open.
    expect(whileConnected.connectionStatus).toBe("connected");
    expect(whileConnected.lastConnectedAt).not.toBeNull();

    // THE DISCONNECT HALF, after the close. `lastConnectedAt` IS NOT ADVANCED AND
    // NOT CLEARED: the oracle writes `{ connectionStatus: "disconnected" }` and
    // nothing else, so the column keeps meaning "when this entity was last seen to
    // connect" rather than collapsing into "when it last changed state".
    //
    // `TenancyContract.recordEntityConnection` is the published form of exactly
    // this pair, and `apps/core-api/src/composition/tool-sync-writers.integration.test.ts`
    // asserts the same two properties against the real store. The two suites
    // cannot see each other; the SEMANTICS are what they share.
    const after = await prisma.entity.findUniqueOrThrow({
      where: { id: FIXTURE.ROLLOUT_IDS["entity"] as string },
      select: { connectionStatus: true, lastConnectedAt: true },
    });
    expect(after.connectionStatus).toBe("disconnected");
    expect(after.lastConnectedAt).toEqual(whileConnected.lastConnectedAt);
  });

  it("folds the heartbeat into the SAME row the V1 route folds it into", async () => {
    // THE JOIN. `ROLLOUT_TOOL_HEALTH_AFTER_HEARTBEAT` is asserted here against the
    // LIVE socket and in
    // `apps/core-api/src/composition/tool-sync-reconnect.integration.test.ts`
    // against `POST /api/v1/tools/sync`. One committed expectation, two
    // transports, neither suite able to see the other.
    const rows = await prisma.toolHealth.findMany({
      select: {
        id: true,
        lastStatus: true,
        avgLatencyMs: true,
        failCount: true,
        totalCalls: true,
        totalFailures: true,
        lastCalledAt: true,
      },
    });
    expect(rows).toEqual([{ id: healthIdBefore, ...FIXTURE.ROLLOUT_TOOL_HEALTH_AFTER_HEARTBEAT }]);
  });

  it("serves only a `wire` entity, which the V1 route does not restrict", async () => {
    // THE DIFFERENCE BETWEEN THE TWO PATHS, PINNED. Flip the column and the same
    // secret, the same entity and the same environment stop being served: the
    // credential lookup's `connectionKind: "wire"` filter yields no candidate and
    // the handshake closes 1008.
    await prisma.entity.update({
      where: { id: FIXTURE.ROLLOUT_IDS["entity"] as string },
      data: { connectionKind: "mcp" },
    });
    const code = await new Promise<number>((settle) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${String(port)}/tools/sync?entity=${FIXTURE.ROLLOUT_TOOL_DECLARATION.category}&env=production`,
        { headers: { authorization: `Bearer ${ENTITY_SECRET}` } },
      );
      ws.on("close", (closeCode) => settle(closeCode));
      ws.on("error", () => undefined);
    });
    expect(code).toBe(1008);
    await prisma.entity.update({
      where: { id: FIXTURE.ROLLOUT_IDS["entity"] as string },
      data: { connectionKind: "wire" },
    });
  });
});
