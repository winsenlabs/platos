// D21 — THE MCP BODY CAP IN CORE-API, READ BACK OFF A REAL SOCKET.
//
// WIN-268 (M4.2)'s "auth/isolation/body-limit regression suite passes" was
// recorded against `apps/agent` alone, and the census row for it named the gap
// here in one sentence: the MCP token and policy routes this process already
// serves "rely on the Nest default parser, with no explicit cap or test there".
// Founder decision D21 closed the design question — mirror the agent: 2 MB,
// `413 payload_too_large`, enforced before authentication — and this file is the
// evidence that the mirror holds on the wire.
//
// TWO APPLICATIONS, FOR TWO DIFFERENT CLAIMS.
//
//   1. THE PROCESS. `startCoreApi` — what `main.ts` starts — answers an over-cap
//      MCP request with the refusal WITHOUT the body ever being sent. Nest's own
//      parser registers inside `init()`, so if `lifecycle.ts` stopped installing
//      the cap, or installed it after `listen()`, the parser would answer instead
//      and the refusal token would be gone. This is the case that ties the
//      middleware to the running process rather than to a copy of its wiring.
//
//   2. THE AUTH WITNESS. `CoreApiHttpModule.forApplication` over a composed
//      application whose `identity-access` context is a RECORDER, behind the same
//      edge middleware and the same cap factory. Every MCP route here authenticates
//      inside its handler through `authenticateOperator`, whose first act is
//      `identityAccess.describeSessionCookie`. A refused request must leave the
//      recorder empty; the controls send the same routes under the cap and require
//      the recorder to fire, so an instrument that cannot see auth cannot pass.
//
// REQUESTS ARE WRITTEN ONTO A TCP SOCKET BYTE FOR BYTE, so "no Content-Length" and
// "chunked" are what the wire says rather than what a client library decides.

import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { NestFactory } from "@nestjs/core";
import { domainError, err } from "@platos/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeApplication, type AppModule } from "../app.module.js";
import { loadCoreApiConfiguration } from "../config/load.js";
import type { LifecycleState } from "../health/readiness.js";
import { createEdgeMiddleware } from "../runtime/edge-middleware.js";
import { createInFlightRegister } from "../runtime/in-flight.js";
import { startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { createProcessLogger, systemClock, ulidGenerator } from "../runtime/process-ports.js";
import { MCP_ROOT_SEGMENT } from "../transports/mcp/mcp-surface.js";
import { CoreApiHttpModule } from "./http.module.js";
import {
  MCP_BODY_CAP_BYTES,
  MCP_BODY_CAP_PREFIX,
  MCP_BODY_CAP_SKIPPED_METHODS,
  PAYLOAD_TOO_LARGE_ERROR,
  createMcpBodyCap,
  isUnderMcpRoot,
} from "./mcp-body-cap.js";

interface RawReply {
  readonly status: number | "no-response";
  readonly headers: string;
  readonly body: string;
}

/** Write a request onto a fresh socket and read until the server closes it. */
function raw(port: number, head: string, body = "", waitMs = 2_500): Promise<RawReply> {
  return new Promise((resolveReply) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const text = Buffer.concat(chunks).toString("utf8");
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(text);
      const separator = text.indexOf("\r\n\r\n");
      resolveReply({
        status: match ? Number(match[1]) : "no-response",
        headers: separator === -1 ? text : text.slice(0, separator),
        body: separator === -1 ? "" : text.slice(separator + 4),
      });
    };
    const timer = setTimeout(finish, waitMs);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", finish);
    socket.on("connect", () => {
      socket.write(head);
      if (body.length > 0) socket.write(body);
    });
  });
}

function head(method: string, path: string, headers: Record<string, string>): string {
  const lines = [`${method} ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close"];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function configuration(): ReturnType<typeof loadCoreApiConfiguration> {
  return loadCoreApiConfiguration({ PLATOS_ENVIRONMENT: "test", PLATOS_CORE_API_PORT: "0" });
}

const CHUNKED_EMPTY = "0\r\n\r\n";
const REVOKE_BODY = JSON.stringify({ environmentId: "env_probe" });

/** Every method the recorder was asked for, in order. */
const authCalls: string[] = [];
let witnessPort = 0;
let witness: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
let running: RunningCoreApi | null = null;

beforeAll(async () => {
  const outcome = configuration();
  if (!outcome.ok) throw new Error("harness configuration must be valid");
  const clock = systemClock();
  const inFlight = createInFlightRegister();
  const composed = composeApplication({
    configuration: outcome.value,
    clock,
    ids: ulidGenerator(clock),
    logger: createProcessLogger({ minimumLevel: "error", write: () => undefined }),
    inFlight,
  });
  // THE RECORDER. Any member of `identity-access` a handler reaches is logged and
  // answers `UNAUTHENTICATED`, the context's own refusal for a caller it cannot
  // identify — so a request that reaches authentication ends at a 401 the filter
  // renders from the taxonomy, and one that does not leaves this list empty.
  const identityAccess = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property === "symbol" || property === "then") return undefined;
        return (): unknown => {
          authCalls.push(String(property));
          const refusal = err(domainError("UNAUTHENTICATED", "unauthenticated", "body-cap probe"));
          return property === "describeSessionCookie" ? refusal : Promise.resolve(refusal);
        };
      },
    },
  );
  const application = Object.freeze({
    ...composed,
    contexts: Object.freeze({ ...composed.contexts, identityAccess }),
  }) as unknown as AppModule;
  const state: LifecycleState = { phase: "serving" };
  const nest = await NestFactory.create(CoreApiHttpModule.forApplication(application, state), {
    logger: false,
    rawBody: true,
  });
  // The two `nest.use` calls `runtime/lifecycle.ts` makes, in its order. The
  // process case below is what proves lifecycle really makes them.
  nest.use(createEdgeMiddleware({ requestIdHeader: outcome.value.requestIdHeader, inFlight }));
  nest.use(createMcpBodyCap());
  await nest.listen(0, "127.0.0.1");
  witnessPort = (nest.getHttpServer().address() as { port: number }).port;
  witness = nest;
}, 30_000);

afterAll(async () => {
  await witness?.close();
  await running?.stop("test finished");
});

function resetAuth(): void {
  authCalls.length = 0;
}

describe("D21 — the MCP body cap mirrors apps/agent", () => {
  it("declares 2 MiB, payload_too_large, the MCP root and the agent's skipped methods", () => {
    expect(MCP_BODY_CAP_BYTES).toBe(2 * 1024 * 1024);
    expect(PAYLOAD_TOO_LARGE_ERROR).toBe("payload_too_large");
    expect(MCP_BODY_CAP_PREFIX).toBe(`/${MCP_ROOT_SEGMENT}`);
    expect(MCP_BODY_CAP_SKIPPED_METHODS).toEqual(["GET", "HEAD", "OPTIONS", "DELETE"]);
    expect(isUnderMcpRoot("/mcp")).toBe(true);
    expect(isUnderMcpRoot("/mcp/platform/tokens")).toBe(true);
    expect(isUnderMcpRoot("/mcpx/platform")).toBe(false);
    expect(isUnderMcpRoot("/api/v1/organizations")).toBe(false);
  });

  it("THE MIRROR IS JOINED, NOT RESTATED: apps/agent declares the same cap, token and skipped methods", () => {
    // D21 says "mirror apps/agent", so the other deployable's source is the
    // oracle. Read as text because core-api may not import apps/agent; a change on
    // either side that the other did not make turns this red.
    const agent = readFileSync(
      new URL("../../../agent/src/http/request-body-limits.ts", import.meta.url),
      "utf8",
    );
    expect(agent).toMatch(/export const DEFAULT_MCP_BODY_CAP_BYTES = 2 \* 1024 \* 1024;/u);
    expect(agent).toMatch(/export const PAYLOAD_TOO_LARGE_ERROR = "payload_too_large";/u);
    expect(agent).toMatch(/\{ prefix: "\/mcp", cap: mcpCap \}/u);
    expect(agent).toMatch(/"GET",\s*"HEAD",\s*"OPTIONS",\s*"DELETE",\s*\]\);/u);
    expect(agent).toMatch(/if \(!Number\.isFinite\(len\) \|\| len > match\.cap\) \{/u);
  });
});

describe("D21 — refused before authentication, over a real socket", () => {
  it("CONTROL: an under-cap POST /mcp/platform/tokens/:id/revoke reaches authentication", async () => {
    resetAuth();
    const reply = await raw(
      witnessPort,
      head("POST", "/mcp/platform/tokens/tok_probe/revoke", {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(REVOKE_BODY)),
      }),
      REVOKE_BODY,
    );
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.body).error.code).toBe("UNAUTHENTICATED");
    expect(authCalls).toContain("describeSessionCookie");
  });

  it("an over-cap POST is 413 payload_too_large with no body sent, and authentication is never reached", async () => {
    resetAuth();
    const reply = await raw(
      witnessPort,
      head("POST", "/mcp/platform/tokens/tok_probe/revoke", {
        "Content-Type": "application/json",
        "Content-Length": String(MCP_BODY_CAP_BYTES + 1),
      }),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: MCP_BODY_CAP_BYTES });
    expect(authCalls).toEqual([]);
  });

  it("PUT is inspected too: an over-cap policy upsert never authenticates", async () => {
    resetAuth();
    const reply = await raw(
      witnessPort,
      head("PUT", "/mcp/platform/environments/env_probe/policies", {
        "Content-Type": "application/json",
        "Content-Length": String(MCP_BODY_CAP_BYTES + 1),
      }),
    );
    expect(reply.status).toBe(413);
    expect(authCalls).toEqual([]);
  });

  it("a CHUNKED body with no Content-Length fails closed, however small", async () => {
    resetAuth();
    const chunked = `${Buffer.byteLength(REVOKE_BODY).toString(16)}\r\n${REVOKE_BODY}\r\n${CHUNKED_EMPTY}`;
    const reply = await raw(
      witnessPort,
      head("POST", "/mcp/platform/tokens/tok_probe/revoke", {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
      }),
      chunked,
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body).error).toBe("payload_too_large");
    expect(authCalls).toEqual([]);
  });

  it("GET and DELETE are SKIPPED: the chunked framing the POST was refused for reaches authentication", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "/mcp/platform/tokens?environmentId=env_probe"],
      ["DELETE", "/mcp/platform/environments/env_probe/policies/pol_probe"],
    ];
    for (const [method, path] of cases) {
      resetAuth();
      const reply = await raw(witnessPort, head(method, path, { "Transfer-Encoding": "chunked" }), CHUNKED_EMPTY);
      expect(reply.status, `${method} ${path}`).toBe(401);
      expect(authCalls, `${method} ${path}`).toContain("describeSessionCookie");
    }
  });

  it("the cap is the MCP root's and no one else's: a chunked POST outside /mcp is not refused by it", async () => {
    resetAuth();
    const reply = await raw(
      witnessPort,
      head("POST", "/does-not-exist", { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }),
      `2\r\n{}\r\n${CHUNKED_EMPTY}`,
    );
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain("payload_too_large");
  });
});

describe("D21 — the running process installs the cap ahead of the framework's parser", () => {
  it("startCoreApi answers an over-cap MCP mint with payload_too_large before a byte of the body is sent", async () => {
    const outcome = configuration();
    if (!outcome.ok) throw new Error("harness configuration must be valid");
    running = await startCoreApi({
      configuration: outcome.value,
      logger: createProcessLogger({ minimumLevel: "error", write: () => undefined }),
    });
    const reply = await raw(
      running.port,
      head("POST", "/mcp/platform/tokens", {
        "Content-Type": "application/json",
        "Idempotency-Key": "d21-body-cap-probe",
        "Content-Length": String(MCP_BODY_CAP_BYTES + 1),
        "X-Request-Id": "req-d21-cap-0001",
      }),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: MCP_BODY_CAP_BYTES });
    // The edge ran first: a refused request still carries its correlation id.
    expect(reply.headers.toLowerCase()).toContain("x-request-id: req-d21-cap-0001");
  }, 30_000);
});
