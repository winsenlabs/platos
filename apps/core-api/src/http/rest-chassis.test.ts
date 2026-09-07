// WIN-260 (c), PROVED RATHER THAN ASSERTED — over a real socket.
//
// The claim is "REST errors map consistently", and the state it has been in
// since M2.5 is: 419 canonical codes in `docs/error-taxonomy.json`, a status
// resolved for every one of them by `transports/error-status.ts`, an envelope
// writer in `http/failure.ts` — and SEVEN codes a REST caller could actually be
// shown, because `writeFailure` had exactly one production caller and no
// `ExceptionFilter` existed anywhere in the tree.
//
// SO THE CLOSURE IS A MEASUREMENT, AND BOTH SIDES OF IT ARE MEASURED.
//   * the UNIVERSE is `Object.keys(taxonomy.codes).length`, read out of a file
//     this tranche does not get to decide. `scripts/error-taxonomy.mjs` joins
//     that file to the 944 source files that mint the codes (E1/E2), so the
//     count cannot be lowered by editing the taxonomy — the mint sites in
//     seventeen contexts would have to go with it.
//   * the REACHED SET is what came back OFF THE WIRE. Each code is raised by a
//     handler behind the real middleware chain and counted only if the response
//     body carried that exact `error.code`.
// Neither number is written in this file. `expect(reached.size).toBe(universe)`
// is the whole assertion, and if the filter is removed it reads 0 of 419.
//
// THE PROBE CONTROLLER IS THE TEST'S, AND THE CHASSIS IS PRODUCTION'S. Every
// piece between the socket and the probe is the shipped one: `createEdgeMiddleware`
// as `runtime/lifecycle.ts` calls it, `CoreApiHttpModule.forApplication` with its
// `APP_FILTER`, its `NotFoundController` and its `Idempotency-Key` gate. What the
// probe adds is a way to ASK for a specific failure, which no business route
// would ever offer. The last describe block closes the remaining gap by driving
// `startCoreApi` itself — the process `main.ts` starts — for the paths that need
// no probe.

import { readFileSync } from "node:fs";

import {
  Controller,
  Get,
  HttpException,
  Module,
  Query,
  Res,
  type DynamicModule,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { domainError, type ErrorCategory } from "@platos/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { composeApplication, type AppModule } from "../app.module.js";
import { loadCoreApiConfiguration } from "../config/load.js";
import type { LifecycleState } from "../health/readiness.js";
import { createEdgeMiddleware } from "../runtime/edge-middleware.js";
import { createInFlightRegister } from "../runtime/in-flight.js";
import { startCoreApi, type RunningCoreApi } from "../runtime/lifecycle.js";
import { createProcessLogger, systemClock, ulidGenerator } from "../runtime/process-ports.js";
import {
  CONTRACT_BUILD_ID,
  CONTRACT_VERSION_HEADER,
  TOTAL_COUNT_HEADER,
  collectionEnvelope,
  encodeCursor,
  itemEnvelope,
} from "../transports/rest/envelope.js";
import { raise } from "../transports/rest/fault.js";
import type { PageRequest } from "../transports/rest/page.js";
import { CoreApiHttpModule } from "./http.module.js";
import { PAGE_QUERY_PIPE } from "./validation.pipe.js";

interface TaxonomyEntry {
  readonly category: ErrorCategory;
  readonly status: number;
}
const TAXONOMY = JSON.parse(
  readFileSync(new URL("../../../../docs/error-taxonomy.json", import.meta.url), "utf8"),
) as { readonly codes: Readonly<Record<string, TaxonomyEntry>> };
const CODES = Object.keys(TAXONOMY.codes);

/**
 * Planted in `details` on every raised code.
 *
 * The kernel calls `details` "structured, already-redacted context for logs.
 * Never returned to a client". One case asserts that promise across all 419
 * responses at once, which is a stronger statement than asserting it for the
 * handful of codes somebody thought to list.
 */
const PLANTED = "SECRET-PROBE-MUST-NOT-REACH-A-CALLER";

/** The composed application the probe reads its ports from. */
let composed: AppModule;

@Controller("probe")
class ProbeController {
  /**
   * Raise one canonical code, as a context would.
   *
   * The CATEGORY comes from the taxonomy rather than from this file, so the
   * status assertion downstream is a three-way join — wire, taxonomy,
   * `error-status.ts` — rather than this test agreeing with itself.
   */
  @Get("raise")
  raiseCode(@Query("code") code: string): never {
    const entry = TAXONOMY.codes[code];
    if (entry === undefined) throw new Error(`unknown code ${code}`);
    const retriable = entry.category === "rate_limited" || entry.category === "unavailable";
    raise(
      domainError(code, entry.category, `probe raised ${code}`, {
        details: { planted: PLANTED },
        ...(retriable ? { retryAfterSeconds: 3 } : {}),
      }),
    );
  }

  /** A bare `DomainError` VALUE, which is the shape the kernel actually blesses. */
  @Get("value")
  raiseValue(): never {
    throw domainError("TENANCY_NOT_FOUND", "not_found", "probe raised a value");
  }

  /** A defect. Its text carries something that must never reach a caller. */
  @Get("defect")
  defect(): never {
    throw new TypeError(`connection refused: postgres://platos:${PLANTED}@db/platos`);
  }

  /** A handler that chose its own status and body, as `health.controller.ts` does. */
  @Get("handler-chose")
  handlerChose(): never {
    throw new HttpException({ readiness: "a document a load balancer parses" }, 409);
  }

  /**
   * A handler that throws AFTER the response has gone.
   *
   * The filter cannot un-send bytes, and calling `setHeader` past `end` throws a
   * second error inside the handler for the first one. The only honest answer is
   * a log line, and this is what makes that arm falsifiable.
   */
  @Get("late")
  late(@Res() response: { end(body: string): unknown }): never {
    response.end(JSON.stringify({ written: "before the throw" }));
    throw new TypeError("thrown after the response went");
  }

  @Get("item")
  item(): unknown {
    return itemEnvelope({ id: "agent-1" });
  }

  @Get("collection")
  collection(
    @Query(PAGE_QUERY_PIPE) page: PageRequest,
    @Res({ passthrough: true }) response: { setHeader(name: string, value: string): unknown },
  ): unknown {
    response.setHeader(TOTAL_COUNT_HEADER, "2");
    return collectionEnvelope({
      rows: [{ id: "a" }, { id: "b" }],
      cursor: page.cursor,
      limit: page.limit,
      nextCursor: encodeCursor({ after: "b" }),
      total: 2,
    });
  }

  /**
   * What the kernel `CorrelationSource` on the COMPOSED APPLICATION reports from
   * inside a request. This is the port `packages/adapters/postgres-tenancy` is
   * handed and reads before it writes the identifier into PostgreSQL's session
   * state; asking it here proves the edge's decision is visible at the seam an
   * adapter consumes, with no adapter and no database in the way.
   */
  @Get("correlation")
  correlation(): unknown {
    return itemEnvelope({ requestId: composed.correlation.current()?.requestId ?? null });
  }
}

@Module({})
class ProbeModule {
  static build(app: AppModule, state: LifecycleState): DynamicModule {
    return {
      module: ProbeModule,
      imports: [CoreApiHttpModule.forApplication(app, state)],
      controllers: [ProbeController],
    };
  }
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly body: Record<string, unknown>;
}

function configuration(): ReturnType<typeof loadCoreApiConfiguration> {
  return loadCoreApiConfiguration({ PLATOS_ENVIRONMENT: "test", PLATOS_CORE_API_PORT: "0" });
}

let base = "";
let nest: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
/** Every structured line the application's logger wrote, as objects. */
const written: string[] = [];
function logLines(): readonly Record<string, unknown>[] {
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status, headers: response.headers, text, body };
}

function errorOf(answer: Answer): Record<string, unknown> {
  return (answer.body["error"] ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  const outcome = configuration();
  if (!outcome.ok) throw new Error("harness configuration must be valid");
  const clock = systemClock();
  const inFlight = createInFlightRegister();
  composed = composeApplication({
    configuration: outcome.value,
    clock,
    ids: ulidGenerator(clock),
    logger: createProcessLogger({ minimumLevel: "debug", write: (line) => written.push(line) }),
    inFlight,
  });
  const state: LifecycleState = { phase: "serving" };
  const application = await NestFactory.create(ProbeModule.build(composed, state), {
    logger: false,
    rawBody: true,
  });
  // The SAME call `runtime/lifecycle.ts` makes, with the same arguments. A
  // re-implementation here would prove something about the copy.
  application.use(
    createEdgeMiddleware({ requestIdHeader: outcome.value.requestIdHeader, inFlight }),
  );
  await application.listen(0, "127.0.0.1");
  const address = application.getHttpServer().address() as { port: number };
  base = `http://127.0.0.1:${String(address.port)}`;
  nest = application;
}, 30_000);

afterAll(async () => {
  await nest?.close();
});

describe("WIN-260 (c) — every canonical code is reachable over REST", () => {
  it("answers all 419 taxonomy codes in the M0.4 §2 envelope, at the status the taxonomy records", async () => {
    const reached = new Set<string>();
    const wrongStatus: string[] = [];
    const malformed: string[] = [];
    const leaked: string[] = [];

    // Batched only so the sweep is one second rather than ten; each request is
    // an ordinary one through the same server.
    for (let index = 0; index < CODES.length; index += 25) {
      const batch = CODES.slice(index, index + 25);
      const answers = await Promise.all(
        batch.map(async (code) => ({ code, answer: await get(`/probe/raise?code=${code}`) })),
      );
      for (const { code, answer } of answers) {
        const entry = TAXONOMY.codes[code] as TaxonomyEntry;
        const error = errorOf(answer);
        if (error["code"] !== code) {
          malformed.push(`${code}: body carried ${String(error["code"])}`);
          continue;
        }
        if (answer.status !== entry.status) {
          wrongStatus.push(`${code}: ${String(answer.status)} != ${String(entry.status)}`);
        }
        if (
          typeof error["title"] !== "string" ||
          typeof error["body"] !== "string" ||
          typeof error["errorId"] !== "string" ||
          typeof error["traceRef"] !== "string" ||
          error["version"] !== "1"
        ) {
          malformed.push(`${code}: envelope is missing an M0.4 §2 field`);
          continue;
        }
        if (answer.text.includes(PLANTED)) leaked.push(code);
        reached.add(code);
      }
    }

    expect(malformed.slice(0, 5)).toEqual([]);
    expect(wrongStatus.slice(0, 5)).toEqual([]);
    expect(leaked.slice(0, 5)).toEqual([]);
    // BOTH SIDES MEASURED. The left is what the wire produced; the right is what
    // the committed taxonomy holds. Neither is a literal in this file.
    expect(reached.size).toBe(CODES.length);
  }, 120_000);

  it("puts the category in `title` and never puts `details` on the wire", async () => {
    const answer = await get("/probe/raise?code=AGENTS_AGENT_NOT_FOUND");
    expect(answer.status).toBe(404);
    expect(errorOf(answer)["title"]).toBe("not_found");
    expect(answer.text).not.toContain(PLANTED);
    expect(errorOf(answer)["details"]).toBeUndefined();
  });

  it("sends Retry-After exactly where the domain populated it", async () => {
    const retriable = await get("/probe/raise?code=RATE_LIMITED");
    expect(retriable.status).toBe(429);
    expect(retriable.headers.get("retry-after")).toBe("3");
    expect(errorOf(retriable)["retryAfterSec"]).toBe(3);
    const plain = await get("/probe/raise?code=AGENTS_AGENT_NOT_FOUND");
    expect(plain.headers.get("retry-after")).toBeNull();
  });

  it("routes a bare DomainError value, not only a DomainFault", async () => {
    const answer = await get("/probe/value");
    expect(answer.status).toBe(TAXONOMY.codes["TENANCY_NOT_FOUND"]?.status);
    expect(errorOf(answer)["code"]).toBe("TENANCY_NOT_FOUND");
  });

  it("answers a defect as TRANSPORT_UNHANDLED_FAULT and keeps its text off the wire", async () => {
    const answer = await get("/probe/defect");
    expect(answer.status).toBe(500);
    expect(errorOf(answer)["code"]).toBe("TRANSPORT_UNHANDLED_FAULT");
    expect(answer.text).not.toContain(PLANTED);
    expect(answer.text).not.toContain("postgres://");
  });

  it("logs a fault that arrived after the response, instead of writing a second one", async () => {
    const answer = await get("/probe/late");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ written: "before the throw" });
    // The only observable the filter has left once the bytes are gone. Without
    // the guard it would call `setHeader` past `end` and raise a second error
    // inside the handling of the first.
    expect(logLines().map((line) => line["message"])).toContain("http.fault_after_response");
  });

  it("records the code, the status and the caller's error id against every refusal", async () => {
    const answer = await get("/probe/raise?code=TOOLS_DISPATCH_RATE_LIMITED");
    const line = logLines()
      .filter((entry) => entry["message"] === "http.request_failed")
      .at(-1);
    expect(line).toMatchObject({
      code: "TOOLS_DISPATCH_RATE_LIMITED",
      status: 429,
      errorId: errorOf(answer)["errorId"],
    });
    // `details` is the kernel's log-only channel. It reaches the operator here
    // and the caller nowhere; the sweep above asserts the second half.
    expect(JSON.stringify(line)).toContain(PLANTED);
  });

  it("leaves a handler's own HttpException exactly as the handler chose it", async () => {
    // `health.controller.ts` is the only production thrower of one, and its 503
    // body is the readiness document a load balancer parses.
    const answer = await get("/probe/handler-chose");
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({ readiness: "a document a load balancer parses" });
  });

  it("answers an unrouted path in the envelope, without echoing the path", async () => {
    const answer = await get("/no/such/route/%3Cscript%3E");
    expect(answer.status).toBe(404);
    expect(errorOf(answer)["code"]).toBe("TRANSPORT_ROUTE_NOT_FOUND");
    expect(answer.text).not.toContain("script");
  });

  it("still lets a real route win against the terminal handler", async () => {
    expect((await get("/livez")).status).toBe(200);
    expect((await get("/probe/item")).status).toBe(200);
  });
});

describe("WIN-267 T2 — the success envelopes and the validation pipe, over HTTP", () => {
  it("serves the ITEM envelope and the build stamp on every response", async () => {
    const answer = await get("/probe/item");
    expect(answer.body).toEqual({ data: { id: "agent-1" }, meta: { contractVersion: CONTRACT_BUILD_ID } });
    expect(answer.headers.get(CONTRACT_VERSION_HEADER.toLowerCase())).toBe(CONTRACT_BUILD_ID);
    // Including the failures, which is the half a per-route header would miss.
    expect((await get("/no/such/route")).headers.get(CONTRACT_VERSION_HEADER.toLowerCase())).toBe(
      CONTRACT_BUILD_ID,
    );
  });

  it("serves the COLLECTION envelope with X-Total-Count and the BFF default page size", async () => {
    const answer = await get("/probe/collection");
    expect(answer.headers.get(TOTAL_COUNT_HEADER.toLowerCase())).toBe("2");
    const page = (answer.body["page"] ?? {}) as Record<string, unknown>;
    expect(page["limit"]).toBe(25);
    expect(page["cursor"]).toBeNull();
    expect(page["hasMore"]).toBe(true);
    expect(page["total"]).toBe(2);
    expect(Array.isArray(answer.body["data"])).toBe(true);
  });

  it("refuses bad pagination with fields[] in the envelope, not a Nest 400", async () => {
    const answer = await get("/probe/collection?limit=0&cursor=%25%25%25");
    expect(answer.status).toBe(400);
    const error = errorOf(answer);
    expect(error["code"]).toBe("TRANSPORT_REQUEST_INVALID");
    expect(error["fields"]).toEqual([
      {
        field: "query.limit",
        code: "below_minimum",
        message: "limit must be at least 1.",
      },
      {
        field: "query.cursor",
        code: "malformed",
        message: "cursor is opaque: send back a nextCursor this service issued.",
      },
    ]);
    // Nest's own 400 shape. Its absence is the thing being asserted.
    expect(error["statusCode"]).toBeUndefined();
  });
});

describe("WIN-267 T2 — one correlation identifier, on the wire and at the port", () => {
  it("adopts the caller's id into traceRef, the response header and the kernel port", async () => {
    const id = "req-t2-0001";
    const failure = await get("/probe/raise?code=AGENTS_AGENT_NOT_FOUND", { "x-request-id": id });
    expect(errorOf(failure)["traceRef"]).toBe(id);
    expect(failure.headers.get("x-request-id")).toBe(id);

    const seen = await get("/probe/correlation", { "x-request-id": id });
    const data = (seen.body["data"] ?? {}) as Record<string, unknown>;
    // THE SAME STRING at the seam an adapter reads. `postgres-tenancy`'s
    // `correlation.integration.test.ts` carries the other half — that whatever a
    // `CorrelationSource` reports arrives in PostgreSQL — and needs a container.
    expect(data["requestId"]).toBe(id);
  });

  it("refuses to adopt a hostile id, and still correlates the request it minted", async () => {
    const hostile = `bad\r\ninjected: 1`;
    const answer = await get("/probe/raise?code=AGENTS_AGENT_NOT_FOUND", {
      "x-request-id": encodeURIComponent(hostile),
    });
    const traceRef = errorOf(answer)["traceRef"];
    expect(typeof traceRef).toBe("string");
    expect(traceRef).not.toContain("injected");
    expect(answer.headers.get("x-request-id")).toBe(traceRef);
  });

  it("reports null outside a request, rather than inventing a correlation", () => {
    expect(composed.correlation.current()).toBeNull();
  });
});

describe("WIN-267 T2 — through the process main.ts starts", () => {
  let running: RunningCoreApi | null = null;

  afterAll(async () => {
    await running?.stop("test-teardown");
  });

  it("answers an unrouted path in the envelope, with the stamp and a trace reference", async () => {
    const outcome = loadCoreApiConfiguration({
      PLATOS_ENVIRONMENT: "test",
      PLATOS_CORE_API_PORT: "0",
    });
    if (!outcome.ok) throw new Error("harness configuration must be valid");
    running = await startCoreApi({
      configuration: outcome.value,
      logger: createProcessLogger({ minimumLevel: "error", write: () => undefined }),
    });
    const response = await fetch(`http://${running.host}:${String(running.port)}/does-not-exist`, {
      headers: { "x-request-id": "req-process-0001" },
    });
    const body = (await response.json()) as { readonly error: Record<string, unknown> };
    expect(response.status).toBe(404);
    expect(body.error["code"]).toBe("TRANSPORT_ROUTE_NOT_FOUND");
    expect(body.error["traceRef"]).toBe("req-process-0001");
    expect(response.headers.get(CONTRACT_VERSION_HEADER.toLowerCase())).toBe(CONTRACT_BUILD_ID);
  }, 30_000);
});
