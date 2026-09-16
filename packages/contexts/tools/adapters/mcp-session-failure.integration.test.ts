// WHAT A FAILURE MAY AND MAY NOT DO TO A SHARED MCP SESSION.
//
// THE POOL KEY IS SHARED. `createMcpSessionPool` keys sessions on
// `DispatchTarget.sessionKey`, the digest the domain computes from the resolved
// URL and the canonical header set — so ONE session is held by the entity's
// other tools and by every end user whose resolved URL and headers are the same.
// Closing it closes it under all of them.
//
// THE DEFECT THIS FILE EXISTS FOR. Both catch arms in `mcp-dispatch.ts` called
// `evict(sessionKey)` BEFORE classifying the failure. A plain `McpError`
// `RequestTimeout` (-32001) on one slow tool therefore tore down the transport
// every concurrent call on that key was using, and each of them came back
// `MCP error -32000: Connection closed` — a failure with nothing to do with the
// call the caller made. `discover()` did the same on `tools/list`.
//
// It is the identical failure mode the agent-side pool was pulled up on, and
// that pool's own comment used to point AT this adapter as the copy that
// "already evicts on exactly this condition". It did not: it evicted on every
// condition. `failureEndsSession` is now the same reading in both deployables.
//
// A SEPARATE FILE, AND THE BUDGET IS WHY. These cases were written into
// `dispatch.integration.test.ts` and took it from 461 to 571 effective lines,
// past the 500 that ADR M0.3 §6 enforces. `sdk-builds.test-fixture.ts` beside
// this file exists for exactly the same reason one tranche earlier, so the cases
// moved rather than the joins being shortened.
//
// EVERY SIDE IS REAL. The server is the SDK's own `McpServer` over
// `StreamableHTTPServerTransport` on a real loopback socket, the client is the
// adapter's own pooled SDK `Client`, and the handshake count is read off the
// SERVER — the adapter's internal map would be asserting the adapter against
// itself.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { DispatchRequest, DispatchTarget } from "../application/ports/index.js";
import type { McpTransport, ToolName } from "../domain/index.js";
import { createToolDispatchAdapter, type ToolDispatchAdapter } from "./dispatch.js";
import { failureEndsSession } from "./mcp-dispatch.js";
import { ADOPTED } from "./sdk-builds.test-fixture.js";

const servers: Server[] = [];
const adapters: ToolDispatchAdapter[] = [];

function adapter(): ToolDispatchAdapter {
  const built = createToolDispatchAdapter();
  adapters.push(built);
  return built;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

async function stopServers(): Promise<void> {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((built) => built.close()));
  await stopServers();
});

/**
 * One real MCP server over streamable HTTP with TWO tools: a fast one and a slow
 * one.
 *
 * TWO TOOLS AND NOT ONE SLOW SERVER, because the arrangement these cases need is
 * one call timing out WHILE a sibling is still in flight on the same session. A
 * server where every call is slow cannot express that; a server where every call
 * is fast cannot either.
 */
async function mcpServer(slowMs: number): Promise<{ url: string; initializeCount: () => number }> {
  let initializes = 0;
  const url = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      void (async () => {
        const parsed: unknown = body === "" ? undefined : JSON.parse(body);
        if (
          parsed !== undefined &&
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { method?: unknown }).method === "initialize"
        ) {
          initializes += 1;
        }
        const server = new ADOPTED.McpServer({ name: "fixture", version: "1.0.0" });
        server.registerTool(
          "invoices.list",
          { description: "list invoices", inputSchema: { limit: z.number() } },
          async (args: { limit: number }) => ({
            content: [{ type: "text" as const, text: `listed ${String(args.limit)}` }],
          }),
        );
        server.registerTool(
          "invoices.export",
          { description: "export invoices", inputSchema: { limit: z.number() } },
          async () => {
            await new Promise((resolve) => setTimeout(resolve, slowMs));
            return { content: [{ type: "text" as const, text: "exported" }] };
          },
        );
        const transport = new ADOPTED.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => void transport.close());
        await server.connect(transport);
        await transport.handleRequest(request, response, parsed);
      })();
    });
  });
  return { url: `${url}/mcp`, initializeCount: () => initializes };
}

function mcpTarget(url: string, overrides: Partial<DispatchTarget> = {}): DispatchTarget {
  return {
    kind: "mcp",
    transport: "http" as McpTransport,
    externalEntityId: "notion",
    url,
    headers: { authorization: "Bearer resolved-secret" },
    sessionKey: `key-${randomUUID()}`,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function call(target: DispatchTarget, toolName = "invoices.list"): DispatchRequest {
  return { target, toolName: toolName as ToolName, arguments: { limit: 2 }, callId: "call-0001" };
}

describe("a failure on a shared MCP session", () => {
  it("keeps the shared session alive for a SIBLING call when one tool times out", async () => {
    const fixture = await mcpServer(1_500);
    const built = adapter();
    const sessionKey = `shared-${randomUUID()}`;
    const target = (timeoutMs: number) => mcpTarget(fixture.url, { sessionKey, timeoutMs });

    // ONE session, opened before either call races on it, so the case is about
    // what the FAILURE does and not about how the session came to exist.
    await built.dispatch(call(target(5_000)));
    expect(built.liveMcpSessions).toBe(1);

    // BOTH CALLS ARE THE SLOW TOOL, and only their BUDGETS differ. A fast sibling
    // would be a race: on a loopback socket it can finish before the close lands,
    // and the case would pass for a reason that has nothing to do with the fix.
    // The second call cannot finish before 1.5 s and the first gives up at 150 ms,
    // so the sibling is provably still in flight on the shared client when the
    // timeout fires.
    const [slow, sibling] = await Promise.all([
      built.dispatch(call(target(150), "invoices.export")),
      built.dispatch(call(target(5_000), "invoices.export")),
    ]);

    expect(slow.ok && slow.value.kind).toBe("timeout");
    // THE ASSERTION THE DEFECT FAILS. Before the fix the sibling came back
    // `failed` carrying "Connection closed", because the timeout closed the
    // transport both calls were using.
    expect(sibling.ok && sibling.value.kind).toBe("succeeded");
    expect(built.liveMcpSessions).toBe(1);
  });

  it("does NOT re-handshake after a timeout, because the session was never closed", async () => {
    const fixture = await mcpServer(1_000);
    const built = adapter();
    const sessionKey = `kept-${randomUUID()}`;

    await built.dispatch(call(mcpTarget(fixture.url, { sessionKey })));
    const handshakes = fixture.initializeCount();
    expect(handshakes).toBe(1);

    const timedOut = await built.dispatch(
      call(mcpTarget(fixture.url, { sessionKey, timeoutMs: 120 }), "invoices.export"),
    );
    expect(timedOut.ok && timedOut.value.kind).toBe("timeout");

    // COUNTED ON THE SERVER, which is the only place this is observable: a second
    // `initialize` would mean the pool had thrown the session away and rebuilt it.
    await built.dispatch(call(mcpTarget(fixture.url, { sessionKey })));
    expect(fixture.initializeCount()).toBe(handshakes);
    expect(built.liveMcpSessions).toBe(1);
  });

  it("STILL evicts when the transport really died, which is what eviction was for", async () => {
    const fixture = await mcpServer(1_500);
    const built = adapter();
    const sessionKey = `dead-${randomUUID()}`;

    await built.dispatch(call(mcpTarget(fixture.url, { sessionKey })));
    expect(built.liveMcpSessions).toBe(1);

    // The listener goes away under the pooled session. The next call fails with
    // something that is NOT a protocol-layer answer, so the session is dropped —
    // the narrowing must not have turned eviction off.
    await stopServers();

    const outcome = await built.dispatch(call(mcpTarget(fixture.url, { sessionKey })));

    expect(outcome.ok && outcome.value.kind).toBe("failed");
    expect(built.liveMcpSessions).toBe(0);
  });

  it("classifies a protocol-layer answer as leaving the session alive, and anything else as ending it", () => {
    // THE RULE ITSELF, so the three cases above are not the only thing standing
    // between a future edit and a shared session closed under its callers.
    const mcpError = Object.assign(new Error("MCP error -32001: Request timed out"), {
      name: "McpError",
      code: -32001,
    });
    const jsonRpcRefusal = Object.assign(new Error("MCP error -32602: Invalid params"), {
      name: "McpError",
      code: -32602,
    });
    expect(failureEndsSession(mcpError)).toBe(false);
    expect(failureEndsSession(jsonRpcRefusal)).toBe(false);
    // A socket that went away, a 404 on a session id a restarted server forgot, a
    // fetch that threw: none of these came back over a working transport.
    expect(failureEndsSession(new TypeError("fetch failed"))).toBe(true);
    expect(failureEndsSession(Object.assign(new Error("HTTP 404"), { name: "Error", code: 404 }))).toBe(true);
    // A `code` that is not a number is not the SDK's protocol error either.
    expect(failureEndsSession(Object.assign(new Error("x"), { name: "McpError", code: "-32001" }))).toBe(true);
    expect(failureEndsSession(null)).toBe(true);
    expect(failureEndsSession("connection closed")).toBe(true);
  });
});
