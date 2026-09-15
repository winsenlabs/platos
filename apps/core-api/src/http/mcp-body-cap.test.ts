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
//   1. THE AUTH WITNESS. `CoreApiHttpModule.forApplication` over a composed
//      application whose `identity-access` context is a RECORDER, behind the same
//      edge middleware and the same `installMcpBodyLimits` the process calls. Every
//      MCP route here authenticates inside its handler through
//      `authenticateOperator`, whose first act is
//      `identityAccess.describeSessionCookie`. A refused request must leave the
//      recorder empty; the controls send the same routes under the cap and require
//      the recorder to fire, so an instrument that cannot see auth cannot pass. A
//      probe mounted on `/mcp` after the installer, and so ahead of Nest's own
//      parsers, records what the MCP parser left on the request.
//
//   2. THE PROCESS. `startCoreApi` — what `main.ts` starts — answers an over-cap
//      MCP request with the refusal WITHOUT the body ever being sent, and answers a
//      1 MiB MCP body exactly as it answers a 1 KB one. If `lifecycle.ts` stopped
//      installing the cap, or its parser, one of those two turns red.
//
// REQUESTS ARE WRITTEN ONTO A TCP SOCKET BYTE FOR BYTE, so "no Content-Length",
// "chunked" and an absolute-form request target are what the wire says rather than
// what a client library decides.

import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { gzipSync } from "node:zlib";

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
  MCP_BODY_LIMIT_HANDLERS,
  PAYLOAD_TOO_LARGE_ERROR,
  installMcpBodyLimits,
} from "./mcp-body-cap.js";

interface RawReply {
  readonly status: number | "no-response";
  readonly headers: string;
  readonly body: string;
}

/** Write a request onto a fresh socket and read until the server closes it. */
function raw(port: number, head: string, body: string | Buffer = "", waitMs = 2_500): Promise<RawReply> {
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

/** A revoke body of EXACTLY `bytes` bytes, as JSON or as a form. */
function revokeBody(bytes: number, form = false): string {
  const base = form ? "environmentId=env_probe&pad=" : JSON.stringify({ environmentId: "env_probe", pad: "" });
  const pad = "x".repeat(bytes - Buffer.byteLength(base));
  return form ? `${base}${pad}` : JSON.stringify({ environmentId: "env_probe", pad });
}

const CHUNKED_EMPTY = "0\r\n\r\n";
const REVOKE_PATH = "/mcp/platform/tokens/tok_probe/revoke";
const REVOKE_BODY = JSON.stringify({ environmentId: "env_probe" });
const JSON_TYPE = "application/json";

/** Every method the recorder was asked for, in order. */
const authCalls: string[] = [];
/** What the probe behind the MCP parser saw: the raw byte count Nest's rawBody kept. */
const parsed: Array<number | null> = [];
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
  // What `runtime/lifecycle.ts` does, in its order. The process cases below are
  // what prove lifecycle really does it.
  nest.use(createEdgeMiddleware({ requestIdHeader: outcome.value.requestIdHeader, inFlight }));
  installMcpBodyLimits(nest);
  nest.use(MCP_BODY_CAP_PREFIX, function mcpParseProbe(request: { rawBody?: unknown }, _: unknown, next: () => void) {
    parsed.push(Buffer.isBuffer(request.rawBody) ? request.rawBody.length : null);
    next();
  });
  await nest.listen(0, "127.0.0.1");
  witnessPort = (nest.getHttpServer().address() as { port: number }).port;
  witness = nest;
}, 30_000);

afterAll(async () => {
  await witness?.close();
  await running?.stop("test finished");
});

function reset(): void {
  authCalls.length = 0;
  parsed.length = 0;
}

describe("D21 — the MCP body cap mirrors apps/agent", () => {
  it("declares 2 MiB, payload_too_large, the MCP root and the agent's skipped methods", () => {
    expect(MCP_BODY_CAP_BYTES).toBe(2 * 1024 * 1024);
    expect(PAYLOAD_TOO_LARGE_ERROR).toBe("payload_too_large");
    expect(MCP_BODY_CAP_PREFIX).toBe(`/${MCP_ROOT_SEGMENT}`);
    expect(MCP_BODY_CAP_SKIPPED_METHODS).toEqual(["GET", "HEAD", "OPTIONS", "DELETE"]);
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
    expect(agent).toMatch(/if \(!Number\.isFinite\(len\) \|\| len > cap\) \{/u);
    expect(agent).toMatch(/app\.use\(entry\.prefix, unauthBodyCapMiddleware\(entry\.cap\)\)/u);
  });

  it("THE EXPRESS STACK: the cap and the MCP parsers precede Nest's own parsers, which are still installed", () => {
    // Read off the running application, not off the installer: Nest skips its
    // default parser when a handler of the same name is already on the stack, so a
    // mounted parser named `jsonParser` would silently unparse every other route.
    const instance = (witness as { getHttpAdapter(): { getInstance(): unknown } }).getHttpAdapter().getInstance();
    const names = (instance as { router: { stack: Array<{ handle?: { name?: string } }> } }).router.stack.map(
      (layer) => layer.handle?.name ?? "",
    );
    const watched = [...MCP_BODY_LIMIT_HANDLERS, "mcpParseProbe", "jsonParser", "urlencodedParser"];
    expect(names.filter((name) => watched.includes(name))).toEqual(watched);
    expect(names.indexOf("edgeMiddleware")).toBeLessThan(names.indexOf("mcpBodyCap"));
  });
});

describe("D21 — refused before authentication, over a real socket", () => {
  it("CONTROL: an under-cap POST /mcp/platform/tokens/:id/revoke reaches authentication", async () => {
    reset();
    const reply = await raw(
      witnessPort,
      head("POST", REVOKE_PATH, { "Content-Type": JSON_TYPE, "Content-Length": String(Buffer.byteLength(REVOKE_BODY)) }),
      REVOKE_BODY,
    );
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.body).error.code).toBe("UNAUTHENTICATED");
    expect(authCalls).toContain("describeSessionCookie");
  });

  it("an over-cap POST is 413 payload_too_large with no body sent, and authentication is never reached", async () => {
    reset();
    const reply = await raw(
      witnessPort,
      head("POST", REVOKE_PATH, { "Content-Type": JSON_TYPE, "Content-Length": String(MCP_BODY_CAP_BYTES + 1) }),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: MCP_BODY_CAP_BYTES });
    expect(authCalls).toEqual([]);
  });

  it("PUT is inspected too: an over-cap policy upsert never authenticates", async () => {
    reset();
    const reply = await raw(
      witnessPort,
      head("PUT", "/mcp/platform/environments/env_probe/policies", {
        "Content-Type": JSON_TYPE,
        "Content-Length": String(MCP_BODY_CAP_BYTES + 1),
      }),
    );
    expect(reply.status).toBe(413);
    expect(authCalls).toEqual([]);
  });

  it("a CHUNKED body with no Content-Length fails closed, however small", async () => {
    reset();
    const chunked = `${Buffer.byteLength(REVOKE_BODY).toString(16)}\r\n${REVOKE_BODY}\r\n${CHUNKED_EMPTY}`;
    const reply = await raw(
      witnessPort,
      head("POST", REVOKE_PATH, { "Content-Type": JSON_TYPE, "Transfer-Encoding": "chunked" }),
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
      reset();
      const reply = await raw(witnessPort, head(method, path, { "Transfer-Encoding": "chunked" }), CHUNKED_EMPTY);
      expect(reply.status, `${method} ${path}`).toBe(401);
      expect(authCalls, `${method} ${path}`).toContain("describeSessionCookie");
    }
  });

  it("the cap is the MCP root's and no one else's: a chunked POST outside /mcp is not refused by it", async () => {
    reset();
    const reply = await raw(
      witnessPort,
      head("POST", "/does-not-exist", { "Content-Type": JSON_TYPE, "Transfer-Encoding": "chunked" }),
      `2\r\n{}\r\n${CHUNKED_EMPTY}`,
    );
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain("payload_too_large");
  });

  it("every spelling the ROUTER delivers to an MCP route is capped: letter case and absolute-form targets", async () => {
    // CONTROL FIRST: the router really delivers a case variant to the MCP route.
    reset();
    const control = await raw(
      witnessPort,
      head("POST", "/MCP/Platform/tokens/tok_probe/revoke", {
        "Content-Type": JSON_TYPE,
        "Content-Length": String(Buffer.byteLength(REVOKE_BODY)),
      }),
      REVOKE_BODY,
    );
    expect(control.status).toBe(401);
    expect(authCalls).toContain("describeSessionCookie");
    const targets = ["/MCP/platform/tokens/tok_probe/revoke", `http://127.0.0.1:${witnessPort}${REVOKE_PATH}`];
    for (const target of targets) {
      reset();
      const chunked = await raw(
        witnessPort,
        head("POST", target, { "Content-Type": JSON_TYPE, "Transfer-Encoding": "chunked" }),
        `2\r\n{}\r\n${CHUNKED_EMPTY}`,
      );
      expect(chunked.status, `chunked ${target}`).toBe(413);
      const overCap = await raw(
        witnessPort,
        head("POST", target, { "Content-Type": JSON_TYPE, "Content-Length": String(MCP_BODY_CAP_BYTES + 1) }),
      );
      expect(overCap.status, `over-cap ${target}`).toBe(413);
      expect(authCalls, target).toEqual([]);
    }
  });
});

describe("D21 — what the cap admits is parsed, not refused as a fault", () => {
  it("1 MiB of JSON and 1 MiB of form, above Nest's 100 KiB default, reach authentication with every byte kept", async () => {
    for (const [type, body] of [
      [JSON_TYPE, revokeBody(1024 * 1024)],
      ["application/x-www-form-urlencoded", revokeBody(1024 * 1024, true)],
    ] as const) {
      reset();
      const reply = await raw(
        witnessPort,
        head("POST", REVOKE_PATH, { "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)) }),
        body,
      );
      // Nest's default parser alone answered this with 500 TRANSPORT_UNHANDLED_FAULT.
      expect(reply.status, type).toBe(401);
      expect(authCalls, type).toContain("describeSessionCookie");
      expect(parsed, type).toEqual([1024 * 1024]);
    }
  });

  it("CONTROL AT THE BOUNDARY: a body of EXACTLY the cap is admitted, parsed and authenticated", async () => {
    reset();
    const body = revokeBody(MCP_BODY_CAP_BYTES);
    const reply = await raw(
      witnessPort,
      head("POST", REVOKE_PATH, { "Content-Type": JSON_TYPE, "Content-Length": String(MCP_BODY_CAP_BYTES) }),
      body,
    );
    expect(reply.status).toBe(401);
    expect(authCalls).toContain("describeSessionCookie");
    expect(parsed).toEqual([MCP_BODY_CAP_BYTES]);
  });

  it("a compressed body that INFLATES past the cap is the same 413, not a fault, and never authenticates", async () => {
    reset();
    const gzipped = gzipSync(Buffer.from(revokeBody(MCP_BODY_CAP_BYTES + 1024)));
    // The declared (encoded) length is far under the cap, so the cap admits it.
    expect(gzipped.length).toBeLessThan(64 * 1024);
    const reply = await raw(
      witnessPort,
      head("POST", REVOKE_PATH, {
        "Content-Type": JSON_TYPE,
        "Content-Encoding": "gzip",
        "Content-Length": String(gzipped.length),
      }),
      gzipped,
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: MCP_BODY_CAP_BYTES });
    expect(authCalls).toEqual([]);
  });
});

describe("D21 — the running process installs the cap and the MCP parser ahead of the framework's parser", () => {
  beforeAll(async () => {
    const outcome = configuration();
    if (!outcome.ok) throw new Error("harness configuration must be valid");
    running = await startCoreApi({
      configuration: outcome.value,
      logger: createProcessLogger({ minimumLevel: "error", write: () => undefined }),
    });
  }, 30_000);

  it("startCoreApi answers an over-cap MCP mint with payload_too_large before a byte of the body is sent", async () => {
    const reply = await raw(
      (running as RunningCoreApi).port,
      head("POST", "/mcp/platform/tokens", {
        "Content-Type": JSON_TYPE,
        "Idempotency-Key": "d21-body-cap-probe",
        "Content-Length": String(MCP_BODY_CAP_BYTES + 1),
        "X-Request-Id": "req-d21-cap-0001",
      }),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: MCP_BODY_CAP_BYTES });
    // The edge ran first: a refused request still carries its correlation id.
    expect(reply.headers.toLowerCase()).toContain("x-request-id: req-d21-cap-0001");
  });

  it("startCoreApi answers a 1 MiB MCP revoke exactly as it answers a 1 KB one, and neither is a fault", async () => {
    const answers: Array<[number | "no-response", string]> = [];
    for (const bytes of [1024, 1024 * 1024]) {
      const reply = await raw(
        (running as RunningCoreApi).port,
        head("POST", REVOKE_PATH, { "Content-Type": JSON_TYPE, "Content-Length": String(bytes) }),
        revokeBody(bytes),
      );
      answers.push([reply.status, JSON.parse(reply.body).error?.code ?? ""]);
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]?.[0]).not.toBe(500);
    expect(answers[0]?.[1]).not.toBe("TRANSPORT_UNHANDLED_FAULT");
  });
});
