import "reflect-metadata";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { Module, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import manifest from "../control-plane/operation-manifest.generated.json";
import {
  isPublicChannelCallback,
  isPublicDocsMcpTransport,
  isPublicMcpTransport,
  isPublicOAuthRoute,
  isPublicTokenMintRoute,
} from "../auth/scope.guard";
import { McpEntityController } from "../mcp-platform/mcp-entity.controller";
import { McpPlatformController } from "../mcp-platform/mcp-platform.controller";
import { OAuthController } from "../oauth/oauth.controller";
import { applyApiSurface } from "./api-surface";
import {
  BODY_CAP_SKIPPED_METHODS,
  DEFAULT_MCP_BODY_CAP_BYTES,
  PAYLOAD_TOO_LARGE_ERROR,
  PUBLIC_BODY_CAP_BYTES,
  capFor,
  installRequestBodyLimits,
  resolveUnauthBodyCaps,
} from "./request-body-limits";

/**
 * WIN-268 (M4.2) — THE BODY-LIMIT HALF OF "auth/isolation/body-limit regression
 * suite passes", READ BACK OFF A REAL SOCKET.
 *
 * WHAT WAS MISSING. The cap on the unauthenticated bypass surface was an inline
 * `app.use` in `main.ts` with no test anywhere in the tree, and the clause was
 * recorded as met on the strength of a request-line fix in a different
 * controller. The cap is only worth anything if it fires BEFORE authentication —
 * a 413 that arrives after the body was buffered and the bearer was checked is
 * the amplification vector it exists to close, dressed as a refusal.
 *
 * WHAT IS REAL HERE. A real Nest application on a real `node:http` listener,
 * with the REAL `applyApiSurface` and the REAL `installRequestBodyLimits` that
 * `main.ts` calls, in front of the REAL `McpPlatformController`,
 * `McpEntityController` and `OAuthController` route tables. Requests are written
 * byte-for-byte onto a TCP socket, so "no Content-Length" and "chunked" mean what
 * the wire means rather than what a client library decides.
 *
 * HOW "AUTH WAS NOT REACHED" IS OBSERVED, TWICE. Auth on these prefixes lives in
 * two places, so both are watched. (1) A global guard, installed the way
 * `AppModule` installs `ScopeGuard` (`APP_GUARD`), records every request that
 * entered Nest's guard pipeline. (2) Every constructor dependency of every
 * controller is replaced by a recorder, so the in-controller bearer check
 * (`tokenService.verify`), the OAuth client lookup (`oauth.findClient`) and
 * anything else a handler touches leaves a trace. A refused request must leave
 * NEITHER. The controls below send the same requests under the cap and require
 * BOTH traces, so an instrument that could not see auth cannot pass the refusals.
 *
 * WHY THE OVER-CAP REQUESTS SEND NO BODY. Only the headers go out. A server whose
 * cap ran after the parser would sit waiting for 2 MB that never comes, and the
 * case reads that as "no response" — so the ORDER (cap before parser before auth)
 * is what these cases measure, not merely the status code.
 *
 * DI METADATA IS STRIPPED for the reason `api-surface.test.ts` gives: esbuild
 * emits no `design:paramtypes`, so Nest cannot resolve constructor arguments.
 * Route metadata is untouched; the controllers are constructed with nothing and
 * their dependency fields are filled with recorders after boot.
 */

const CONTROLLERS = [McpPlatformController, McpEntityController, OAuthController] as const;

for (const controller of CONTROLLERS) {
  Reflect.defineMetadata("design:paramtypes", [], controller);
  Reflect.defineMetadata("self:paramtypes", [], controller);
  Reflect.defineMetadata("self:properties_metadata", [], controller);
}

/** A callable, infinitely deep recorder: any call anywhere under it is logged. */
function recorder(label: string, calls: string[]): unknown {
  const target = function recorded() {};
  return new Proxy(target, {
    get(_target, property) {
      if (typeof property === "symbol" || property === "then") return undefined;
      return recorder(`${label}.${property}`, calls);
    },
    apply() {
      calls.push(label);
      return Promise.resolve(null);
    },
  });
}

interface Harness {
  readonly port: number;
  /** `METHOD /path` for every request that entered the guard pipeline. */
  readonly pipeline: string[];
  /** Every dependency call any controller made. */
  readonly dependencyCalls: string[];
  readonly app: INestApplication;
}

async function boot(): Promise<Harness> {
  const pipeline: string[] = [];
  const dependencyCalls: string[] = [];
  const pipelineProbe: CanActivate = {
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
      pipeline.push(`${request.method} ${request.url.split("?")[0]}`);
      return true;
    },
  };

  @Module({
    controllers: [...CONTROLLERS],
    providers: [{ provide: APP_GUARD, useValue: pipelineProbe }],
  })
  class BodyLimitProbeModule {}

  // The same factory options `main.ts` passes: Nest's own parser OFF, raw body ON.
  const app = await NestFactory.create<NestExpressApplication>(BodyLimitProbeModule, {
    bodyParser: false,
    rawBody: true,
    logger: false,
    abortOnError: false,
  });
  applyApiSurface(app);
  installRequestBodyLimits(app, resolveUnauthBodyCaps({}));
  await app.listen(0, "127.0.0.1");

  for (const controller of CONTROLLERS) {
    const instance = app.get(controller) as unknown as Record<string, unknown>;
    const fields = Object.keys(instance).filter((key) => instance[key] === undefined);
    // NON-VACUITY: a controller with no empty dependency field would mean the
    // recorders below watch nothing, and every "not reached" would be free.
    expect(fields.length, `${controller.name} exposed no dependency fields`).toBeGreaterThan(0);
    for (const field of fields) instance[field] = recorder(`${controller.name}.${field}`, dependencyCalls);
  }

  const address = app.getHttpServer().address() as { port: number };
  return { port: address.port, pipeline, dependencyCalls, app };
}

interface RawReply {
  readonly status: number | "no-response";
  readonly body: string;
}

/**
 * Write `head` (and `body`, if any) onto a fresh TCP connection and read until
 * the server closes it or `waitMs` passes. `Connection: close` is always sent so
 * the end of the reply is the end of the stream.
 */
function raw(port: number, head: string, body: string | Buffer = "", waitMs = 2_500): Promise<RawReply> {
  return new Promise((resolveReply) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      const text = Buffer.concat(chunks).toString("utf8");
      const match = /^HTTP\/1\.1 (\d{3})/u.exec(text);
      if (!match) {
        resolveReply({ status: "no-response", body: text });
        return;
      }
      const separator = text.indexOf("\r\n\r\n");
      resolveReply({ status: Number(match[1]), body: separator === -1 ? "" : text.slice(separator + 4) });
    };
    const timer = setTimeout(finish, waitMs);
    socket.on("data", (chunk) => chunks.push(chunk));
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

/** A syntactically valid JSON object of EXACTLY `bytes` bytes. */
function jsonOfLength(bytes: number, fields: Record<string, string>): string {
  const base = JSON.stringify({ ...fields, pad: "" });
  return JSON.stringify({ ...fields, pad: "x".repeat(bytes - Buffer.byteLength(base)) });
}

let harness: Harness;

beforeAll(async () => {
  harness = await boot();
}, 60_000);

afterAll(async () => {
  await harness?.app.close();
});

function reset(): void {
  harness.pipeline.length = 0;
  harness.dependencyCalls.length = 0;
}

describe("WIN-268 body limit — refused before authentication, over a real socket", () => {
  it("declares the D21 figures: /mcp at 2 MiB, /oauth at 256 KiB, refusal token payload_too_large", () => {
    // D21 (founder decision, 2026-09-15) fixes 2 MB and `413 payload_too_large`
    // for MCP in BOTH deployables; `apps/core-api/src/http/mcp-body-cap.test.ts`
    // pins the same three values against its own module.
    expect(DEFAULT_MCP_BODY_CAP_BYTES).toBe(2 * 1024 * 1024);
    expect(PAYLOAD_TOO_LARGE_ERROR).toBe("payload_too_large");
    const caps = resolveUnauthBodyCaps({});
    expect(capFor(caps, "/mcp/platform")?.cap).toBe(2 * 1024 * 1024);
    expect(capFor(caps, "/oauth/token")?.cap).toBe(256 * 1024);
    // The override keeps the historical `Number(x) || default` rule: garbage and
    // zero fall back to the default, never to "no cap".
    expect(capFor(resolveUnauthBodyCaps({ PLATOS_MCP_BODY_CAP_BYTES: "4096" }), "/mcp")?.cap).toBe(4096);
    expect(capFor(resolveUnauthBodyCaps({ PLATOS_MCP_BODY_CAP_BYTES: "0" }), "/mcp")?.cap).toBe(2 * 1024 * 1024);
    expect(capFor(resolveUnauthBodyCaps({ PLATOS_MCP_BODY_CAP_BYTES: "lots" }), "/mcp")?.cap).toBe(2 * 1024 * 1024);
    // A prefix owns a path only on a segment boundary.
    expect(capFor(caps, "/mcpx/platform")).toBeUndefined();
    // No prefix owns another, so the one cap `capFor` names is the only cap the
    // router mounts over a request, and the manifest join below asks the right one.
    for (const outer of caps) {
      for (const inner of caps) {
        if (inner !== outer) expect(capFor([outer], inner.prefix), `${outer.prefix} owns ${inner.prefix}`).toBeUndefined();
      }
    }
  });

  it("CONTROL: an under-cap POST /mcp/platform enters the guard pipeline AND reaches the controller's bearer check", async () => {
    reset();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const reply = await raw(
      harness.port,
      head("POST", "/mcp/platform", {
        Authorization: "Bearer plt_mcp_probe",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      }),
      body,
    );
    expect(reply.status).toBe(401);
    expect(harness.pipeline).toEqual(["POST /mcp/platform"]);
    expect(harness.dependencyCalls).toContain("McpPlatformController.tokenService.verify");
  });

  it("an over-cap POST /mcp/platform is 413 payload_too_large with no body sent, and auth is never reached", async () => {
    reset();
    const reply = await raw(
      harness.port,
      head("POST", "/mcp/platform", {
        Authorization: "Bearer plt_mcp_probe",
        "Content-Type": "application/json",
        "Content-Length": String(DEFAULT_MCP_BODY_CAP_BYTES + 1),
      }),
    );
    // "no-response" here is the ORDER failing: the parser ran first and is still
    // waiting for the 2 MiB this request declared and never sent.
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: DEFAULT_MCP_BODY_CAP_BYTES });
    expect(harness.pipeline).toEqual([]);
    expect(harness.dependencyCalls).toEqual([]);
  });

  it("the per-entity MCP transport is capped the same way: POST /mcp/entity/:entityId over 2 MiB never authenticates", async () => {
    reset();
    const reply = await raw(
      harness.port,
      head("POST", "/mcp/entity/acme", {
        Authorization: "Bearer plt_oa_probe",
        "Content-Type": "application/json",
        "Content-Length": String(DEFAULT_MCP_BODY_CAP_BYTES + 1),
      }),
    );
    expect(reply.status).toBe(413);
    expect(harness.pipeline).toEqual([]);
    expect(harness.dependencyCalls).toEqual([]);
  });

  it("CONTROL: POST /oauth/token at EXACTLY the cap is admitted and reaches the client lookup", async () => {
    reset();
    // The boundary is `>`, not `>=`: a body of exactly 256 KiB is legal.
    const body = jsonOfLength(PUBLIC_BODY_CAP_BYTES, { client_id: "probe-client" });
    expect(Buffer.byteLength(body)).toBe(PUBLIC_BODY_CAP_BYTES);
    const reply = await raw(
      harness.port,
      head("POST", "/oauth/token", {
        "Content-Type": "application/json",
        "Content-Length": String(PUBLIC_BODY_CAP_BYTES),
      }),
      body,
    );
    expect(reply.status).toBe(401);
    expect(harness.pipeline).toEqual(["POST /oauth/token"]);
    expect(harness.dependencyCalls).toContain("OAuthController.oauth.findClient");
  });

  it("an over-cap POST /oauth/token is 413 with no body sent, and the client lookup is never reached", async () => {
    reset();
    const reply = await raw(
      harness.port,
      head("POST", "/oauth/token", {
        "Content-Type": "application/json",
        "Content-Length": String(PUBLIC_BODY_CAP_BYTES + 1),
      }),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "payload_too_large", limit: PUBLIC_BODY_CAP_BYTES });
    expect(harness.pipeline).toEqual([]);
    expect(harness.dependencyCalls).toEqual([]);
  });

  it("a CHUNKED body with no Content-Length fails closed on /mcp and on /oauth, however small it is", async () => {
    for (const path of ["/mcp/platform", "/oauth/token"]) {
      reset();
      const payload = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
      const chunked = `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
      const reply = await raw(
        harness.port,
        head("POST", path, {
          Authorization: "Bearer plt_mcp_probe",
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        }),
        chunked,
      );
      expect(reply.status, path).toBe(413);
      expect(JSON.parse(reply.body).error, path).toBe("payload_too_large");
      expect(harness.pipeline, path).toEqual([]);
      expect(harness.dependencyCalls, path).toEqual([]);
    }
  });

  it("GET and DELETE are SKIPPED: the same chunked framing the POSTs were refused for passes through to auth", async () => {
    // Each of these would be a 413 if its method were inspected, because a
    // chunked request declares no length. Reaching the pipeline is the proof the
    // method check let it through; the 401 is the route's own auth answering.
    const cases: Array<[string, string]> = [
      ["GET", "/mcp/platform/sse"],
      ["DELETE", "/mcp/entity/acme/tokens/tok_probe"],
    ];
    for (const [method, path] of cases) {
      reset();
      const reply = await raw(
        harness.port,
        head(method, path, { "Transfer-Encoding": "chunked" }),
        "0\r\n\r\n",
      );
      expect(reply.status, `${method} ${path}`).toBe(401);
      expect(harness.pipeline, `${method} ${path}`).toEqual([`${method} ${path}`]);
    }
    expect(BODY_CAP_SKIPPED_METHODS).toEqual(["GET", "HEAD", "OPTIONS", "DELETE"]);
  });

  it("every spelling the ROUTER delivers to a capped controller is capped: letter case and absolute-form targets included", async () => {
    // Express matches routes case-insensitively and reads the pathname out of an
    // absolute-form request target (`POST http://host/mcp/platform`), so these
    // reach the same controllers the canonical paths do. A cap that compared the
    // raw `req.url` against `/mcp` let every one of them through uncapped.
    //
    // CONTROL FIRST: the router really delivers a case variant. Without this, a
    // variant that merely 404ed would pass every assertion below for free.
    reset();
    const small = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const control = await raw(
      harness.port,
      head("POST", "/MCP/platform", {
        Authorization: "Bearer plt_mcp_probe",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(small)),
      }),
      small,
    );
    expect(control.status).toBe(401);
    expect(harness.dependencyCalls).toContain("McpPlatformController.tokenService.verify");

    const routed: Array<[string, number]> = [
      ["/MCP/platform", DEFAULT_MCP_BODY_CAP_BYTES],
      ["/Mcp/entity/acme", DEFAULT_MCP_BODY_CAP_BYTES],
      ["/mcp/platform/", DEFAULT_MCP_BODY_CAP_BYTES],
      ["/mcp/platform?probe=1", DEFAULT_MCP_BODY_CAP_BYTES],
      [`http://127.0.0.1:${harness.port}/mcp/platform`, DEFAULT_MCP_BODY_CAP_BYTES],
      ["/OAUTH/token", PUBLIC_BODY_CAP_BYTES],
      [`http://127.0.0.1:${harness.port}/OAuth/token`, PUBLIC_BODY_CAP_BYTES],
    ];
    for (const [target, cap] of routed) {
      reset();
      const chunked = await raw(
        harness.port,
        head("POST", target, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }),
        `2\r\n{}\r\n0\r\n\r\n`,
      );
      expect(chunked.status, `chunked ${target}`).toBe(413);
      const overCap = await raw(
        harness.port,
        head("POST", target, { "Content-Type": "application/json", "Content-Length": String(cap + 1) }),
      );
      expect(overCap.status, `over-cap ${target}`).toBe(413);
      expect(JSON.parse(overCap.body), target).toEqual({ error: "payload_too_large", limit: cap });
      expect(harness.pipeline, target).toEqual([]);
      expect(harness.dependencyCalls, target).toEqual([]);
    }

    // Spellings the router does NOT deliver may be refused or 404ed; what they
    // must never do is reach a controller with an uncapped body.
    for (const target of ["/%6Dcp/platform", "//mcp/platform", "/mcp//platform", "/mcpx/platform"]) {
      reset();
      await raw(
        harness.port,
        head("POST", target, { "Content-Type": "application/json", "Transfer-Encoding": "chunked" }),
        `2\r\n{}\r\n0\r\n\r\n`,
      );
      expect(harness.pipeline, target).toEqual([]);
      expect(harness.dependencyCalls, target).toEqual([]);
    }
  });
});

/**
 * THE TABLE, JOINED TO THE GENERATED MANIFEST AND TO SCOPEGUARD'S OWN PREDICATES.
 *
 * A cap table is a list somebody writes, so asserting that it contains the
 * entries it contains proves nothing. The two sides here are both read from
 * something this file does not own: the route inventory
 * `generate-control-plane.mjs` AST-walks out of the controllers, and the
 * exported predicates ScopeGuard uses to let a request through WITHOUT a scope.
 * Its first run found `POST /api/v1/entities/:entityId/session-tokens`, a public
 * mint with no cap.
 */
describe("WIN-268 body limit — every public body-bearing route is capped, and no skipped method is public", () => {
  const PUBLIC_PREDICATES = [
    isPublicMcpTransport,
    isPublicDocsMcpTransport,
    isPublicTokenMintRoute,
    isPublicChannelCallback,
    isPublicOAuthRoute,
  ];
  const agentOperations = (
    manifest.inventories.restOperations as ReadonlyArray<{
      method: string;
      path: string;
      implementations: ReadonlyArray<{ source: string }>;
    }>
  ).filter((operation) =>
    operation.implementations.some((implementation) => implementation.source.startsWith("apps/agent/src")),
  );
  const isPublic = (method: string, path: string) =>
    PUBLIC_PREDICATES.some((predicate) => predicate(method, path));

  it("every body-bearing operation ScopeGuard admits without a scope sits under a cap", () => {
    const caps = resolveUnauthBodyCaps({});
    const publicBodyRoutes = agentOperations.filter(
      (operation) => !BODY_CAP_SKIPPED_METHODS.includes(operation.method) && isPublic(operation.method, operation.path),
    );
    // Non-vacuity: the MCP, OAuth, guest, session and channel mints are all here.
    expect(publicBodyRoutes.length).toBeGreaterThanOrEqual(15);
    const uncapped = publicBodyRoutes
      .filter((operation) => capFor(caps, operation.path) === undefined)
      .map((operation) => `${operation.method} ${operation.path}`);
    expect(uncapped).toEqual([]);
  });

  it("no operation under a capped prefix is BOTH a skipped method and public, so the skip never exempts an unauthenticated body", () => {
    const caps = resolveUnauthBodyCaps({});
    const skippedPublicDeletes = agentOperations
      .filter((operation) => operation.method === "DELETE" && capFor(caps, operation.path) !== undefined)
      .filter((operation) => isPublic(operation.method, operation.path))
      .map((operation) => `${operation.method} ${operation.path}`);
    expect(skippedPublicDeletes).toEqual([]);
    // Non-vacuity: at least one DELETE really lives under a capped prefix.
    expect(
      agentOperations.some((operation) => operation.method === "DELETE" && capFor(caps, operation.path) !== undefined),
    ).toBe(true);
  });
});

describe("WIN-268 body limit — the composition root installs it, and nothing else parses a body", () => {
  it("main.ts calls installRequestBodyLimits and no other source file calls useBodyParser", () => {
    const srcDir = [resolve("src"), resolve("apps/agent/src")].find((dir) => existsSync(join(dir, "main.ts")));
    expect(srcDir, `agent src not found from ${process.cwd()}`).toBeDefined();
    const main = readFileSync(join(srcDir as string, "main.ts"), "utf8");
    expect(main).toContain('from "./http/request-body-limits"');
    expect(main).toMatch(/^\s*installRequestBodyLimits\(\s*$/mu);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "dist") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts") || path.endsWith(".test.ts")) continue;
        if (path === join(srcDir as string, "http", "request-body-limits.ts")) continue;
        if (/\.useBodyParser\(/u.test(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(srcDir as string);
    // A second parser registered anywhere else could run ahead of the cap.
    expect(offenders).toEqual([]);
  });
});
