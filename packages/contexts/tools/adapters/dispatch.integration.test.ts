// `ToolDispatch`, exercised against REAL SERVERS over REAL SOCKETS.
//
// WHY NOT A MOCKED `fetch`. This adapter's whole job is to turn what a backend
// actually did into one of four outcomes, and a stubbed `fetch` lets the suite
// decide what "actually did" means — so a wrong status mapping, a missed
// `Retry-After`, a redirect followed by accident or a session opened twice would
// all pass. Every case below binds a `node:http` listener on port 0 and talks to
// it, and the MCP cases put the SDK'S OWN SERVER on the far side, so the protocol
// is exercised by the implementation that defines it rather than by our reading
// of it.
//
// THE MCP SERVER IS THE JOIN THIS FILE COULD NOT MAKE ITSELF. `McpServer` plus
// `StreamableHTTPServerTransport` come from `@modelcontextprotocol/sdk` — the
// same package the adapter uses on the client side, and the reference
// implementation of the wire format. A hand-rolled JSON-RPC responder would be
// this tranche's reading of the specification checked against this tranche's
// reading of the specification.
//
// WHAT IS ASSERTED ABOUT THE REFUSALS IS THAT NOTHING WAS SENT. A refusal that
// returned the right code after opening a socket would still have leaked a
// credential to a backend, so the `stdio` case counts requests on a listener that
// is up and never touched. That is the same assertion shape
// `InMemoryToolDispatch` makes for the resolver ("assert the array is EMPTY, not
// merely that the result was an error").

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { DispatchRequest, DispatchTarget } from "../application/ports/index.js";
import type { McpTransport, ToolName } from "../domain/index.js";
import { createToolDispatchAdapter, type ToolDispatchAdapter } from "./dispatch.js";

// ---------------------------------------------------------------------------
// FIXTURES

const adapters: ToolDispatchAdapter[] = [];
const servers: Server[] = [];

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

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((built) => built.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

function wireTarget(url: string, overrides: Partial<DispatchTarget> = {}): DispatchTarget {
  return {
    kind: "wire",
    transport: null,
    externalEntityId: "billing-backend",
    url,
    headers: {},
    sessionKey: "wire-has-no-session",
    timeoutMs: 5_000,
    ...overrides,
  };
}

function mcpTarget(
  url: string | null,
  transport: McpTransport | null,
  overrides: Partial<DispatchTarget> = {},
): DispatchTarget {
  return {
    kind: "mcp",
    transport,
    externalEntityId: "notion",
    url,
    headers: { authorization: "Bearer resolved-secret" },
    sessionKey: `key-${randomUUID()}`,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function call(target: DispatchTarget, toolName = "invoices.list"): DispatchRequest {
  return {
    target,
    toolName: toolName as ToolName,
    arguments: { limit: 2 },
    callId: "call-0001",
  };
}

// ---------------------------------------------------------------------------
// THE WIRE TRANSPORT

describe("the wire transport, against a real HTTP listener", () => {
  it("POSTs the tool, the arguments and the call id, and returns the parsed body", async () => {
    const seen: { method: string; body: string; contentType: string | undefined }[] = [];
    const url = await listen((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        seen.push({
          method: request.method ?? "",
          body,
          contentType: request.headers["content-type"],
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ invoices: ["a", "b"] }));
      });
    });

    const outcome = await adapter().dispatch(call(wireTarget(url)));

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toEqual({
      kind: "succeeded",
      result: { invoices: ["a", "b"] },
      latencyMs: expect.any(Number),
    });
    // THE BODY SHAPE IS THE CONTRACT WITH EVERY ENTITY BACKEND IN THE FIELD.
    // `{ tool, args, callId }` is what the legacy executor has always sent, and a
    // renamed field here would break third-party handlers silently.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.contentType).toBe("application/json");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      tool: "invoices.list",
      args: { limit: 2 },
      callId: "call-0001",
    });
  });

  it("carries the already-resolved headers and never lets one displace the content type", async () => {
    const seen: IncomingMessage["headers"][] = [];
    const url = await listen((request, response) => {
      seen.push(request.headers);
      response.writeHead(204).end();
    });

    // A TEMPLATE THAT RESOLVED TO A CONTENT TYPE IS THE HAZARD. The adapter
    // serialised JSON; a header that said otherwise would make the backend parse
    // the wrong thing, and the port hands headers over as data the adapter must
    // not simply trust for its OWN framing.
    await adapter().dispatch(
      call(wireTarget(url, { headers: { "x-entity-key": "k-1", "content-type": "text/plain" } })),
    );

    expect(seen[0]?.["x-entity-key"]).toBe("k-1");
    expect(seen[0]?.["content-type"]).toBe("application/json");
  });

  it("reads 429 as rateLimited and honours the backend's own Retry-After", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(429, { "retry-after": "17" }).end();
    });

    const outcome = await adapter().dispatch(call(wireTarget(url)));

    expect(outcome.ok && outcome.value.kind).toBe("rateLimited");
    expect(outcome.ok && outcome.value.kind === "rateLimited" && outcome.value.retryAfterSeconds).toBe(17);
  });

  it("falls back to 30 seconds when Retry-After is an HTTP-date rather than a count", async () => {
    // RFC 9110 §10.2.3 permits a date, and honouring one means comparing against
    // the SERVER'S clock — so a skewed caller computes a negative or enormous
    // wait from a header that was correct. The legacy path draws the line here too.
    const url = await listen((_request, response) => {
      response.writeHead(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }).end();
    });

    const outcome = await adapter().dispatch(call(wireTarget(url)));

    expect(outcome.ok && outcome.value.kind === "rateLimited" && outcome.value.retryAfterSeconds).toBe(30);
  });

  it("reads any other non-2xx as failed, carrying the status and NOT the body", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(503, { "content-type": "text/html" });
      response.end("<html>internal hostname db-7.corp.internal is down</html>");
    });

    const outcome = await adapter().dispatch(call(wireTarget(url)));

    expect(outcome.ok && outcome.value).toEqual({
      kind: "failed",
      reason: "http_503",
      latencyMs: expect.any(Number),
    });
    // The backend's error page named an internal host. `reason` reaches an audit
    // row an MCP client may be shown, so it must not.
    expect(JSON.stringify(outcome)).not.toContain("db-7.corp.internal");
  });

  it("does NOT follow a redirect, which is the destination screen this port does not have", async () => {
    let redirectTargetHits = 0;
    const secret = await listen((_request, response) => {
      redirectTargetHits += 1;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    const url = await listen((_request, response) => {
      response.writeHead(302, { location: secret }).end();
    });

    const outcome = await adapter().dispatch(call(wireTarget(url)));

    // A followed redirect defeats any screen applied to the original URL, so
    // `redirect: "manual"` turns a 3xx into an ordinary non-2xx refusal.
    expect(outcome.ok && outcome.value.kind).toBe("failed");
    expect(redirectTargetHits).toBe(0);
  });

  it("reads a timeout as timeout and not as failed, decided by our clock", async () => {
    const url = await listen(() => {
      /* accept the socket and never answer */
    });

    const outcome = await adapter().dispatch(call(wireTarget(url, { timeoutMs: 120 })));

    // The two are not interchangeable: `timeout` says the budget expired and
    // `failed` says the backend refused, and only one of them is the caller's
    // fault to widen.
    expect(outcome.ok && outcome.value.kind).toBe("timeout");
  });

  it("reads a refused connection as failed with the machine code and no address", async () => {
    // A PORT THAT WAS BOUND AND IS NOW CLOSED, rather than a literal like
    // `127.0.0.1:1`. Undici refuses a request to a port on its BAD-PORT list
    // before it ever connects, so a literal low port produces "bad port" and not
    // `ECONNREFUSED` — measured, after that shortcut made this case pass for the
    // wrong reason.
    const closed = await listen((_request, response) => response.writeHead(200).end());
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));

    const outcome = await adapter().dispatch(call(wireTarget(closed)));

    expect(outcome.ok && outcome.value.kind).toBe("failed");
    expect(outcome.ok && outcome.value.kind === "failed" && outcome.value.reason).toBe(
      "transport_econnrefused",
    );
    // The message Node produced named the resolved address and port. Neither
    // reaches the reason an audit row records.
    expect(JSON.stringify(outcome)).not.toContain("127.0.0.1");
  });

  it("keeps a non-JSON 200 as a success, because `result` is unknown on the port", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" }).end("OK");
    });

    const outcome = await adapter().dispatch(call(wireTarget(url)));

    // Several entity backends in the field answer `OK`. A parse error here would
    // turn a successful call into a failed one.
    expect(outcome.ok && outcome.value.kind).toBe("succeeded");
    expect(outcome.ok && outcome.value.kind === "succeeded" && outcome.value.result).toBe("OK");
  });

  it("refuses to DISCOVER a wire entity, and does not answer with an empty tool list", async () => {
    let hits = 0;
    const url = await listen((_request, response) => {
      hits += 1;
      response.writeHead(200).end("{}");
    });

    const refused = await adapter().discover({ target: wireTarget(url) });

    // `ok({ tools: [] })` would be the dangerous answer: `registerTools` performs
    // an idempotent replace INCLUDING A PRUNE, so an empty discovery of a wire
    // entity would delete every tool it had ever registered.
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe("TOOLS_MCP_DISABLED");
    expect(hits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE MCP TRANSPORT, AGAINST THE SDK'S OWN SERVER

/** One real MCP server over streamable HTTP, stateless, on a real socket. */
async function mcpServer(options: { failing?: boolean; slowMs?: number } = {}): Promise<{
  url: string;
  requestCount: () => number;
  initializeCount: () => number;
}> {
  let requests = 0;
  let initializes = 0;

  const url = await listen((request, response) => {
    requests += 1;
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
        // A FRESH SERVER PER REQUEST is the SDK's own documented stateless mode
        // (`sessionIdGenerator: undefined`). It is the shape that lets this suite
        // count HTTP requests as the observable, which is what the pooling cases
        // below assert on.
        const server = new McpServer({ name: "fixture", version: "1.0.0" });
        server.registerTool(
          "invoices.list",
          {
            description: "list invoices",
            inputSchema: { limit: z.number() },
          },
          async (args: { limit: number }) => {
            if (options.slowMs !== undefined) {
              await new Promise((resolve) => setTimeout(resolve, options.slowMs));
            }
            if (options.failing === true) {
              return { isError: true, content: [{ type: "text" as const, text: "upstream refused" }] };
            }
            return { content: [{ type: "text" as const, text: `listed ${String(args.limit)}` }] };
          },
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => void transport.close());
        await server.connect(transport);
        await transport.handleRequest(request, response, parsed);
      })();
    });
  });

  return { url: `${url}/mcp`, requestCount: () => requests, initializeCount: () => initializes };
}

describe("the MCP transport, against the SDK's own server over a real socket", () => {
  it("completes the handshake, calls the tool, and returns what the server answered", async () => {
    const fixture = await mcpServer();

    const outcome = await adapter().dispatch(call(mcpTarget(fixture.url, "http")));

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.kind).toBe("succeeded");
    // The server's answer travels VERBATIM. The port's `result` is `unknown`, and
    // the MCP content envelope is what a caller of `executeTool` receives.
    const result = outcome.ok && outcome.value.kind === "succeeded" ? outcome.value.result : null;
    expect(JSON.stringify(result)).toContain("listed 2");
    expect(fixture.initializeCount()).toBe(1);
  });

  it("carries the resolved credential to the server on the initialize request", async () => {
    const authorizations: (string | undefined)[] = [];
    const url = await listen((request, response) => {
      authorizations.push(request.headers.authorization);
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        void (async () => {
          const server = new McpServer({ name: "fixture", version: "1.0.0" });
          server.registerTool("invoices.list", { inputSchema: {} }, async () => ({
            content: [{ type: "text" as const, text: "ok" }],
          }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          response.on("close", () => void transport.close());
          await server.connect(transport);
          await transport.handleRequest(request, response, body === "" ? undefined : JSON.parse(body));
        })();
      });
    });

    await adapter().dispatch(call(mcpTarget(`${url}/mcp`, "http")));

    // `requestInit.headers` is merged by the transport into EVERY request it
    // makes, which is the property that lets the adapter resolve a credential
    // once per session instead of per call.
    expect(authorizations.filter((value) => value === "Bearer resolved-secret").length).toBeGreaterThan(0);
  });

  it("enumerates the server's tools into the port's UNADMITTED intake shape", async () => {
    const fixture = await mcpServer();

    const discovered = await adapter().discover({ target: mcpTarget(fixture.url, "http") });

    expect(discovered.ok).toBe(true);
    const tools = discovered.ok ? discovered.value.tools : [];
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("invoices.list");
    expect(tools[0]?.description).toBe("list invoices");
    // ADMISSION IS A DOMAIN RULE AND HAS NOT RUN. No `category` is invented — MCP
    // has no such field, and inventing one from `annotations.title` would be an
    // adapter deciding a domain default. `admitDeclaration` supplies it.
    expect(tools[0]).not.toHaveProperty("category");
    expect(tools[0]?.paramSchema).toMatchObject({ type: "object" });
  });

  it("reads the protocol's own isError as failed, not as a success carrying an error", async () => {
    const fixture = await mcpServer({ failing: true });

    const outcome = await adapter().dispatch(call(mcpTarget(fixture.url, "http")));

    // The server ANSWERED and the answer says the tool failed. Folding that into
    // `succeeded` would report a broken tool as working; raising it as an `err`
    // would say nothing was dispatched.
    expect(outcome.ok && outcome.value).toEqual({
      kind: "failed",
      reason: "tool_reported_error",
      latencyMs: expect.any(Number),
    });
  });

  it("reads a slow tool as timeout, using the target's own budget", async () => {
    const fixture = await mcpServer({ slowMs: 1_500 });

    const outcome = await adapter().dispatch(
      call(mcpTarget(fixture.url, "http", { timeoutMs: 150 })),
    );

    expect(outcome.ok && outcome.value.kind).toBe("timeout");
  });

  it("reads a server that refuses the handshake as failed, since it WAS reached", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" }).end("{}");
    });

    const outcome = await adapter().dispatch(call(mcpTarget(`${url}/mcp`, "http")));

    // `failed` and not `err`: the port reserves an `err` for a call that was never
    // tried, and this one was.
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.kind).toBe("failed");
  });

  it("reads a failed enumeration as an err, so discovery prunes nothing", async () => {
    const url = await listen((_request, response) => {
      response.writeHead(500).end("{}");
    });

    const discovered = await adapter().discover({ target: mcpTarget(`${url}/mcp`, "http") });

    // The asymmetry with `dispatch` above is `discover-entity-tools.ts`'s, not the
    // adapter's: it records a failed discovery and registers nothing, and only an
    // `err` reaches that branch.
    expect(discovered.ok).toBe(false);
    expect(!discovered.ok && discovered.error.code).toBe("TOOLS_DISPATCH_FAILED");
  });
});

// ---------------------------------------------------------------------------
// THE POOL, WHOSE KEY IS THE DOMAIN'S

describe("the session pool, keyed on the value the domain computed", () => {
  it("shares ONE session between two calls carrying the same pool key", async () => {
    const fixture = await mcpServer();
    const built = adapter();
    const target = mcpTarget(fixture.url, "http");

    await built.dispatch(call(target));
    const before = fixture.initializeCount();
    await built.dispatch(call(target));

    expect(built.liveMcpSessions).toBe(1);
    // ONE handshake for two calls. Counted on the SERVER, which is the only place
    // this is observable — the adapter's own map would be asserting the adapter
    // against itself.
    expect(fixture.initializeCount()).toBe(before);
  });

  it("opens a SECOND session for a different pool key, even on the same URL", async () => {
    const fixture = await mcpServer();
    const built = adapter();

    await built.dispatch(call(mcpTarget(fixture.url, "http", { sessionKey: "credential-a" })));
    await built.dispatch(call(mcpTarget(fixture.url, "http", { sessionKey: "credential-b" })));

    // THIS IS THE INVARIANT THE KEY EXISTS FOR. The pool key is the digest of the
    // canonical resolved header set, so two credentials against one server MUST
    // NOT share a session. An adapter that keyed on the URL — the obvious
    // shortcut — would answer 1 here and would be a cross-tenant leak.
    expect(built.liveMcpSessions).toBe(2);
  });

  it("does not open two sessions when two calls on one key race", async () => {
    const fixture = await mcpServer();
    const built = adapter();
    const target = mcpTarget(fixture.url, "http");

    await Promise.all([built.dispatch(call(target)), built.dispatch(call(target))]);

    // Without the in-flight map each call opens a session and the second replaces
    // the first in the map, leaking a live socket the pool can no longer close.
    expect(built.liveMcpSessions).toBe(1);
    expect(fixture.initializeCount()).toBe(1);
  });

  it("closes every live session on close()", async () => {
    const fixture = await mcpServer();
    const built = createToolDispatchAdapter();

    await built.dispatch(call(mcpTarget(fixture.url, "http", { sessionKey: "a" })));
    await built.dispatch(call(mcpTarget(fixture.url, "http", { sessionKey: "b" })));
    expect(built.liveMcpSessions).toBe(2);

    await built.close();

    expect(built.liveMcpSessions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE ONE TRANSPORT THIS ADAPTER REFUSES

describe("stdio, which this deployable has no client for", () => {
  it("refuses under its OWN code and never reports the call as failed", async () => {
    const outcome = await adapter().dispatch(call(mcpTarget(null, "stdio")));

    // THE WHOLE POINT OF THE SEPARATE CODE. `DispatchOutcome.failed` means the
    // backend was reached and refused; a caller reading it retries, folds a health
    // sample in, and tells its user the tool is broken. None of that is true when
    // nothing left the process.
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe("TOOLS_MCP_TRANSPORT_UNIMPLEMENTED");
    expect(!outcome.ok && outcome.error.category).toBe("unavailable");
    // No retry hint: retrying cannot help, and a hint on a permanent gap is worse
    // than none. `repositoryUnavailable`, the other `unavailable` in this
    // catalogue, DOES carry one — so this is a decision and not a default.
    expect(!outcome.ok && outcome.error.retryAfterSeconds).toBeNull();
  });

  it("is a DIFFERENT code from an unrecognised transport, which an operator can fix", async () => {
    // `admitTransport` refuses a value that is not one of the three, so reaching
    // the adapter with a null transport means the resolver was bypassed — a defect,
    // not a supplier gap. Two guards returning one code could not be told apart.
    const bypassed = await adapter().dispatch(call(mcpTarget("http://127.0.0.1:1/mcp", null)));

    expect(!bypassed.ok && bypassed.error.code).toBe("TOOLS_MCP_TRANSPORT_INVALID");
    const stdio = await adapter().dispatch(call(mcpTarget(null, "stdio")));
    expect(!stdio.ok && stdio.error.code).not.toBe(
      !bypassed.ok ? bypassed.error.code : "unreachable",
    );
  });

  it("sends ZERO BYTES: a listener that is up is never touched", async () => {
    let hits = 0;
    const url = await listen((_request, response) => {
      hits += 1;
      response.writeHead(200).end("{}");
    });

    // The refusal has to happen BEFORE a socket, not after. A refusal that opened
    // one would already have shown the resolved credential to a backend.
    const refused = await adapter().dispatch(
      call(mcpTarget(`${url}/mcp`, "stdio", { headers: { authorization: "Bearer leak-me" } })),
    );

    expect(refused.ok).toBe(false);
    expect(hits).toBe(0);
  });

  it("refuses discovery on stdio under the same code, so no tool list is pruned", async () => {
    const refused = await adapter().discover({ target: mcpTarget(null, "stdio") });

    expect(!refused.ok && refused.error.code).toBe("TOOLS_MCP_TRANSPORT_UNIMPLEMENTED");
  });

  it("names the transport in details, and puts the supplier decision in the reason", async () => {
    const refused = await adapter().dispatch(call(mcpTarget(null, "stdio")));

    expect(!refused.ok && refused.error.details).toMatchObject({ transport: "stdio" });
    // An operator reading this must be able to tell that no configuration of
    // theirs closes it.
    expect(!refused.ok && JSON.stringify(refused.error.details)).toContain("durable-runtime");
  });
});
