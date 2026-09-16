/**
 * WIN-268 (M4.2) — THE LEGACY SSE TRANSPORT ACROSS TWO AGENT PROCESSES.
 *
 * THE CLAIM UNDER TEST is the one `McpPlatformController` and
 * `McpEntityController` make in their session comments: the session record and
 * the response channel live in Redis "so multi-replica agent pods can route the
 * client's POST /messages correctly". Before this suite the only test of that
 * path was `mcp-platform-management.test.ts`, whose Redis is a `vi.fn()` — a
 * double that delivers every publish to every subscriber by construction, so it
 * could not have noticed a frame that never arrived. The only two-instance test
 * in the tree was the stream lane's, which is a different transport.
 *
 * THE SHAPE. Two child processes (`mcp-sse-node.test-fixture.ts`), each a full
 * Nest application over the SAME migrated PostgreSQL schema and ONE real Redis.
 * The official SDK client opens `GET …/sse` on node A. Its POSTs go through a
 * `fetch` that plays load balancer: the handshake and a first phase of requests
 * to A, then — switched at a point this suite chooses — a concurrent burst to B.
 *
 * WHAT IS PINNED, AND WHY EACH HALF. A conservation check ("every response
 * arrived") is satisfied by a run in which A did everything and B nothing, or
 * the reverse, so it is not enough on its own:
 *
 *   EXACTLY ONCE — every request id the client sent appears as exactly one
 *   frame on A's stream, and no frame appears for an id it did not send.
 *
 *   THE SPLIT POINT — each node reports every PUBLISH it sends. A published
 *   exactly the handshake and phase-one ids, B exactly the phase-two ids, and
 *   neither published anything of the other's. So the frames that arrived on A
 *   for phase two were carried across the process boundary by Redis and were
 *   not dispatched by A at all.
 *
 *   IN ORDER — the phase-one frames arrive in A's publish order, the phase-two
 *   frames in B's publish order, and every phase-one frame precedes every
 *   phase-two frame. The burst is concurrent, so B's publish order is NOT the
 *   request order; it is the order the transport is obliged to preserve, and
 *   only B's own log can say what it was.
 *
 * AND CANCELLATION ACROSS THE SAME SPLIT. `McpPlatformController` carries a
 * second Redis pair for the legacy transport: closing the stream sets
 * `platos:mcp:platform:sse-cancelled:<id>` and publishes `cancel` on
 * `platos:mcp:platform:sse-cancel:<id>`, which `messages()` subscribes to before
 * dispatching so a request running on ANOTHER node is aborted when its client
 * hangs up. This tranche changed that subscriber (it now waits for READY before
 * SUBSCRIBE) and nothing exercised it: the only test of the controller used a
 * `vi.fn()` Redis. The last case below runs a long `macros.replay` posted to B
 * and closes the stream on A while it is still running, twice — once WITHOUT the
 * close, which answers with the replay result, and once with it, which answers
 * with an error instead. Two nodes, one Redis, the same call: only the close
 * differs.
 *
 * GATED on the same services as the conformance suite, under its own flag.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { Client as AdoptedClient } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport as AdoptedSseTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client as CandidateClient } from "@modelcontextprotocol/sdk-candidate/client/index.js";
import { SSEClientTransport as CandidateSseTransport } from "@modelcontextprotocol/sdk-candidate/client/sse.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  NODE_LINE_PREFIX,
  WireTap,
  agentRoot,
  openPrivateSchema,
  seedTenant,
  viteNodeEntry,
  type PrivateSchema,
  type SeededTenant,
} from "./mcp-conformance.test-fixture";

const baseDatabaseUrl =
  process.env.MCP_MULTI_NODE_TEST_DATABASE_URL ?? process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL;
const redisUrl = process.env.MCP_MULTI_NODE_TEST_REDIS_URL ?? process.env.PLATOS_TEST_REDIS_URL;

if (process.env.MCP_MULTI_NODE_REQUIRED === "1" && (!baseDatabaseUrl || !redisUrl)) {
  throw new Error(
    "MCP_MULTI_NODE_REQUIRED=1 but PLATOS_POSTGRES_INTEGRATION_DATABASE_URL and PLATOS_TEST_REDIS_URL are not both set",
  );
}

const describeWithServices = baseDatabaseUrl && redisUrl ? describe : describe.skip;

interface NodeRecord {
  readonly node: string;
  readonly event: "ready" | "publish";
  readonly channel?: string;
  readonly id?: unknown;
  /** The JSON-RPC error code the published frame carried, or null. */
  readonly errorCode?: unknown;
  readonly baseUrl?: string;
  readonly pid?: number;
}

interface AgentNode {
  readonly label: string;
  readonly baseUrl: string;
  readonly pid: number;
  readonly records: NodeRecord[];
  stop(): Promise<void>;
}

async function startNode(label: string, databaseUrl: string): Promise<AgentNode> {
  const records: NodeRecord[] = [];
  const stderr: string[] = [];
  const child: ChildProcess = spawn(
    process.execPath,
    [viteNodeEntry(), resolve(agentRoot(), "src/mcp-platform/mcp-sse-node.test-fixture.ts")],
    {
      cwd: agentRoot(),
      env: {
        ...process.env,
        MCP_NODE_LABEL: label,
        MCP_NODE_DATABASE_URL: databaseUrl,
        MCP_NODE_REDIS_URL: redisUrl!,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let buffered = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.startsWith(NODE_LINE_PREFIX)) records.push(JSON.parse(line.slice(NODE_LINE_PREFIX.length)) as NodeRecord);
      newline = buffered.indexOf("\n");
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

  const ready = await new Promise<NodeRecord>((resolveReady, rejectReady) => {
    const deadline = setTimeout(
      () => rejectReady(new Error(`node ${label} did not become ready in 120s:\n${stderr.join("").slice(-4000)}`)),
      120_000,
    );
    const poll = setInterval(() => {
      const found = records.find((record) => record.event === "ready");
      if (found) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolveReady(found);
      }
    }, 50);
    child.once("exit", (code) => {
      clearInterval(poll);
      clearTimeout(deadline);
      rejectReady(new Error(`node ${label} exited ${String(code)} before ready:\n${stderr.join("").slice(-4000)}`));
    });
  });

  return {
    label,
    baseUrl: ready.baseUrl!,
    pid: ready.pid!,
    records,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      const forced = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(forced);
    },
  };
}

const SDK_BUILDS = [
  { label: "adopted", Client: AdoptedClient, SseTransport: AdoptedSseTransport },
  {
    label: "candidate",
    Client: CandidateClient as unknown as typeof AdoptedClient,
    SseTransport: CandidateSseTransport as unknown as typeof AdoptedSseTransport,
  },
] as const;

/** Wait until `predicate` holds, or fail naming what was being waited for. */
async function until(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 25));
  }
}

describeWithServices("legacy MCP SSE across two agent processes sharing one Redis", () => {
  let schema: PrivateSchema;
  let tenant: SeededTenant;
  let nodeA: AgentNode;
  let nodeB: AgentNode;

  beforeAll(async () => {
    schema = await openPrivateSchema(baseDatabaseUrl!, "mcpnodes");
    tenant = await seedTenant(schema.prisma, `mcpnodes-${String(process.pid)}`);
    [nodeA, nodeB] = await Promise.all([startNode("A", schema.url), startNode("B", schema.url)]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all([nodeA?.stop(), nodeB?.stop()]);
    await schema?.drop();
  }, 60_000);

  it("runs two distinct operating-system processes on two distinct ports", () => {
    expect(nodeA.pid).not.toBe(nodeB.pid);
    expect(nodeA.pid).not.toBe(process.pid);
    expect(new URL(nodeA.baseUrl).port).not.toBe(new URL(nodeB.baseUrl).port);
  });

  const SERVERS = [
    {
      name: "platform",
      path: () => "/mcp/platform",
      authorization: () => `Bearer ${tenant.platformToken}`,
      channel: "platos:mcp:platform:sse:",
      call: { name: "platos.whoami", arguments: {} },
    },
    {
      name: "entity",
      path: () => `/mcp/entity/${tenant.entity.entityId}`,
      authorization: () => `Bearer ${tenant.entity.pat}`,
      channel: "platos:mcp:entity:sse:",
      call: null,
    },
  ] as const;

  const PHASE_ONE = 4;
  const PHASE_TWO = 12;

  for (const build of SDK_BUILDS) {
    for (const server of SERVERS) {
      it(`${build.label} SDK, ${server.name} server: the stream on A carries B's responses exactly once, in B's order, split where the balancer switched`, async () => {
        let postsTo: AgentNode = nodeA;
        const tap = new WireTap(`192.0.2.${build.label === "adopted" ? "10" : "20"}`);
        const balancer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          if ((init?.method ?? "GET").toUpperCase() === "POST") {
            return tap.fetch(new URL(`${url.pathname}${url.search}`, postsTo.baseUrl), init);
          }
          return tap.fetch(url, init);
        };
        const client = new build.Client({ name: "platos-multi-node", version: "0.0.0" }, { capabilities: {} });
        const clientErrors: string[] = [];
        client.onerror = (error: Error) => clientErrors.push(error.message);
        const publishedBefore = { A: nodeA.records.length, B: nodeB.records.length };
        const transport = new build.SseTransport(new URL(`${server.path()}/sse`, nodeA.baseUrl), {
          requestInit: { headers: { authorization: server.authorization() } },
          fetch: balancer,
          eventSourceInit: { fetch: balancer } as never,
        });
        await client.connect(transport as never);
        try {
          // PHASE ONE, to A, strictly sequential.
          for (let index = 0; index < PHASE_ONE; index += 1) await client.ping();

          // THE SWITCH. Everything from here is POSTed to B, concurrently.
          postsTo = nodeB;
          const firstPhaseTwoExchange = tap.exchanges.length;
          const burst = await Promise.all(
            Array.from({ length: PHASE_TWO }, (_unused, index) =>
              server.call && index % 2 === 0 ? client.callTool(server.call) : client.ping(),
            ),
          );
          expect(burst).toHaveLength(PHASE_TWO);

          // A JSON-RPC id is a string or a number; a notification carries none.
          // Narrowing here rather than only dropping `undefined` is what lets the
          // published ids below be compared to the sent ids at all — both sides
          // read `id` off parsed JSON, so both start out `unknown` — and an id of
          // any other shape now fails the length assertions loudly instead of
          // being compared as `unknown`.
          const isJsonRpcId = (id: unknown): id is string | number =>
            typeof id === "string" || typeof id === "number";
          const sentIds = (exchanges: typeof tap.exchanges) =>
            exchanges
              .filter((exchange) => exchange.method === "POST")
              .map((exchange) => (exchange.requestBody as { id?: unknown }).id)
              .filter(isJsonRpcId);
          const phaseOneIds = sentIds(tap.exchanges.slice(0, firstPhaseTwoExchange));
          const phaseTwoIds = sentIds(tap.exchanges.slice(firstPhaseTwoExchange));
          // initialize + the phase-one pings; the burst.
          expect(phaseOneIds).toHaveLength(1 + PHASE_ONE);
          expect(phaseTwoIds).toHaveLength(PHASE_TWO);
          expect(
            tap.exchanges
              .slice(firstPhaseTwoExchange)
              .filter((exchange) => exchange.method === "POST")
              .every((exchange) => exchange.status === 202),
          ).toBe(true);

          const responseFrames = () =>
            tap.messageFrames().filter((frame) => !("method" in frame));
          await until("every response frame on node A's stream", () => responseFrames().length >= 1 + PHASE_ONE + PHASE_TWO);
          // Let anything that was going to arrive twice arrive.
          await new Promise((resolveQuiet) => setTimeout(resolveQuiet, 400));
          const frameIds = responseFrames().map((frame) => frame["id"]);

          // EXACTLY ONCE.
          expect([...frameIds].sort()).toEqual([...phaseOneIds, ...phaseTwoIds].sort());
          expect(new Set(frameIds).size).toBe(frameIds.length);

          // THE SPLIT POINT, from each node's own publish log for this session.
          const sessionPublishes = (agent: AgentNode, from: number) =>
            agent.records
              .slice(from)
              .filter((record) => record.event === "publish" && record.channel?.startsWith(server.channel))
              .map((record) => record.id)
              .filter(isJsonRpcId);
          const publishedByA = sessionPublishes(nodeA, publishedBefore.A);
          const publishedByB = sessionPublishes(nodeB, publishedBefore.B);
          expect(publishedByA).toEqual(phaseOneIds);
          expect([...publishedByB].sort()).toEqual([...phaseTwoIds].sort());
          expect(publishedByA.some((id) => phaseTwoIds.includes(id))).toBe(false);
          expect(publishedByB.some((id) => phaseOneIds.includes(id))).toBe(false);

          // IN ORDER: A's frames in A's publish order, then B's in B's.
          expect(frameIds.slice(0, phaseOneIds.length)).toEqual(publishedByA);
          expect(frameIds.slice(phaseOneIds.length)).toEqual(publishedByB);

          expect(clientErrors).toEqual([]);
        } finally {
          await client.close().catch(() => undefined);
        }
      }, 60_000);
    }
  }

  it("platform server: closing the stream on A aborts a dispatch already running on B", async () => {
    // THE CLAIM. `McpPlatformController.sse` publishes `cancel` on this session's
    // cancel channel as it cleans up; `messages()` on the OTHER node subscribes to
    // that channel before it dispatches, and aborts the request when it arrives.
    // Nothing exercised it before this case — the controller's only other test
    // gives it a `vi.fn()` Redis, where a publish reaches every subscriber by
    // construction and a subscriber that was never ready is indistinguishable
    // from one that was. This tranche changed exactly that subscriber.
    //
    // THE TOOL HAS TO BE ABORTABLE AND LONG. `macros.replay` is the platform
    // tool that takes the router's `abortSignal`: it re-runs each recorded step
    // through the router and checks the signal between steps. How long a step
    // takes is a property of the machine, so the step count is CALIBRATED here
    // rather than guessed — a fixed number is either flaky on a fast runner or
    // slow on a loaded one.
    const authorization = `Bearer ${tenant.platformToken}`;
    const post = (node: AgentNode, path: string, body: unknown) =>
      fetch(new URL(path, node.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization, "x-forwarded-for": "192.0.2.40" },
        body: JSON.stringify(body),
      });
    const replayCall = (id: string, macroId: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "macros.replay", arguments: { macroId, params: {} } },
    });
    const macroOf = async (steps: number, name: string): Promise<string> => {
      const row = await schema.prisma.macro.create({
        data: {
          environmentId: tenant.environmentId,
          name,
          steps: Array.from({ length: steps }, () => ({ tool: "platos.whoami", params: {} })) as never,
          createdBy: tenant.userId,
        },
        select: { id: true },
      });
      return row.id;
    };

    // CALIBRATION, over Streamable HTTP on A: 20 steps, timed, and required to
    // SUCCEED — which is also how a macro this token may not replay would be
    // caught here rather than being read as a cancellation later.
    const calibrationSteps = 20;
    const calibrationMacro = await macroOf(calibrationSteps, "cancel-calibration");
    const calibrationStart = Date.now();
    const calibrated = await post(nodeA, "/mcp/platform", replayCall("calibrate", calibrationMacro));
    const calibrationMs = Date.now() - calibrationStart;
    expect(calibrated.status).toBe(200);
    const calibratedBody = (await calibrated.json()) as {
      error?: unknown;
      result?: { content?: Array<{ text?: string }> };
    };
    expect({ id: "calibrate", error: calibratedBody.error }).toEqual({ id: "calibrate", error: undefined });
    expect(calibratedBody.result?.content?.[0]?.text).toContain(`"stepCount":${String(calibrationSteps)}`);

    // Enough steps for ~3s of replay on THIS machine, bounded both ways so a
    // pathological measurement cannot make the suite take minutes.
    const perStepMs = Math.max(calibrationMs / calibrationSteps, 0.25);
    const steps = Math.min(6_000, Math.max(200, Math.ceil(3_000 / perStepMs)));
    const probeMacro = await macroOf(steps, "cancel-probe");

    // The stream on A, opened WITHOUT the SDK: the SDK's transport owns its
    // fetch, and this case needs to destroy the socket at a moment it chooses.
    const streamAbort = new AbortController();
    const streamed = await fetch(new URL("/mcp/platform/sse", nodeA.baseUrl), {
      headers: { authorization, accept: "text/event-stream", "x-forwarded-for": "192.0.2.40" },
      signal: streamAbort.signal,
    });
    expect(streamed.status).toBe(200);
    const frames: Array<{ event: string; data: string }> = [];
    const decoder = new TextDecoder();
    const reader = streamed.body!.getReader();
    const pump = (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
            }
            if (data.length > 0) frames.push({ event, data: data.join("\n") });
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // the abort below destroys this socket, which is the point of the case
      }
    })();
    try {
      await until("the endpoint frame from node A", () => frames.some((frame) => frame.event === "endpoint"));
      const endpointPath = frames.find((frame) => frame.event === "endpoint")!.data;
      const sessionId = new URL(endpointPath, nodeA.baseUrl).searchParams.get("sessionId")!;
      expect(sessionId).toMatch(/^[0-9a-f]{32}$/u);

      // THE CONTROL — the same replay, posted to B, with the stream left open.
      // It answers on A's stream with the replay's own result.
      const controlStart = Date.now();
      const control = await post(nodeB, endpointPath, replayCall("replay-control", probeMacro));
      expect(control.status).toBe(202);
      await until(
        "node B's answer to the uncancelled replay",
        () => frames.some((frame) => frame.event === "message" && frame.data.includes('"replay-control"')),
        180_000,
      );
      const controlMs = Date.now() - controlStart;
      // THE PROBE'S PRECONDITION, MEASURED RATHER THAN ASSUMED. The cancel below
      // is sent 300ms after the POST, so the replay has to still be running then.
      // The calibration sizes the macro for ~3s; if it lands under a second the
      // calibration is wrong for this machine and the probe would be racing —
      // which must be a loud failure here, not a flake there.
      expect({
        longEnough: controlMs > 800,
        remedy: "raise the replay target in this case; the calibrated macro is too short",
      }).toEqual({
        longEnough: true,
        remedy: "raise the replay target in this case; the calibrated macro is too short",
      });
      const controlFrame = JSON.parse(
        frames.find((frame) => frame.event === "message" && frame.data.includes('"replay-control"'))!.data,
      ) as { error?: unknown; result?: { content?: Array<{ text?: string }> } };
      expect({ id: "replay-control", error: controlFrame.error }).toEqual({ id: "replay-control", error: undefined });
      expect(controlFrame.result?.content?.[0]?.text).toContain(`"stepCount":${String(steps)}`);

      // THE PROBE — the same call again, and this time the client hangs up while
      // B is still replaying.
      const before = { A: nodeA.records.length, B: nodeB.records.length };
      const probe = await post(nodeB, endpointPath, replayCall("replay-cancelled", probeMacro));
      expect(probe.status).toBe(202);
      // B acks with 202 BEFORE it subscribes to the cancel channel, so a close
      // sent instantly would be testing that race instead of the cancel. A beat
      // here makes the case about the cancel; the replay runs for seconds.
      await new Promise((resolveBeat) => setTimeout(resolveBeat, 300));
      streamAbort.abort();
      await pump;

      const publishes = (agent: AgentNode, from: number) =>
        agent.records.slice(from).filter((record) => record.event === "publish");
      // A, cleaning up the stream, publishes the cancel for THIS session.
      await until(
        "node A's cancel publish",
        () =>
          publishes(nodeA, before.A).some(
            (record) => record.channel === `platos:mcp:platform:sse-cancel:${sessionId}`,
          ),
        30_000,
      );
      // B answers the replay it was running — with an error, where the identical
      // call thirty lines up answered with the result. The frame is read off B's
      // own publish log because the stream it was written to no longer exists.
      await until(
        "node B's answer to the cancelled replay",
        () => publishes(nodeB, before.B).some((record) => record.id === "replay-cancelled"),
        180_000,
      );
      const cancelledAnswer = publishes(nodeB, before.B).find((record) => record.id === "replay-cancelled")!;
      expect({ channel: cancelledAnswer.channel, errorCode: cancelledAnswer.errorCode }).toEqual({
        channel: `platos:mcp:platform:sse:${sessionId}`,
        errorCode: -32603,
      });
      // …and B published it ONCE: an abort that raced the normal answer would
      // put two frames on the channel for one id.
      expect(publishes(nodeB, before.B).filter((record) => record.id === "replay-cancelled")).toHaveLength(1);
    } finally {
      streamAbort.abort();
      await pump;
    }
  }, 300_000);

  it("RECORDED: the docs server's SSE sessions are process-local, so a POST to the other node is 404", async () => {
    // `DocsMcpController` keeps its sessions in a module-level Map. It is
    // unauthenticated and read-only, so it was never routed through Redis; a
    // install with more than one agent replica behind a balancer that does
    // not pin the session's POSTs to the node holding its stream cannot serve it.
    const tap = new WireTap("192.0.2.30");
    const stream = await tap.fetch(new URL("/mcp/docs/sse", nodeA.baseUrl), {
      headers: { accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    await until("the docs endpoint frame", () => tap.frames.some((frame) => frame.event === "endpoint"));
    const endpoint = tap.frames.find((frame) => frame.event === "endpoint")!.data;
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const onB = await fetch(new URL(endpoint, nodeB.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.30" },
      body,
    });
    expect(onB.status).toBe(404);
    const onA = await fetch(new URL(endpoint, nodeA.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.30" },
      body,
    });
    expect(onA.status).toBe(202);
    // Not awaited: a tee branch's cancel settles only once BOTH branches are
    // cancelled, and the tap's branch ends when the node closes the socket.
    void stream.body?.cancel();
  }, 30_000);
});
