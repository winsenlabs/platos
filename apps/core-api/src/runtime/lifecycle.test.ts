// Start and stop a REAL HTTP server, repeatedly, in-process.
//
// Nothing here is mocked: `startCoreApi` builds the same Nest application
// `main.ts` builds, binds a real socket on an operating-system-chosen port, and
// is torn down through the same shutdown path a SIGTERM takes. The separate
// spawned-binary evidence in `process.test.ts` covers what this cannot — signals,
// exit codes and the packaged `dist/` artifact.

import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { SuppliedAdapters } from "../composition/adapter-bindings.js";
import { loadCoreApiConfiguration } from "../config/load.js";
import { createInFlightRegister, type InFlightRegister } from "./in-flight.js";
import { createProcessLogger } from "./process-ports.js";
import { startCoreApi, type RunningCoreApi } from "./lifecycle.js";
import { WORK_REFUSED_SHUTTING_DOWN } from "./in-flight.js";
import {
  SHUTDOWN_DRAIN_BUDGET_SPENT,
  type Drainable,
  type DrainableOutcome,
} from "./shutdown-drain.js";

const ADMIN_TOKEN = "readiness-admin-token-0001";

let running: RunningCoreApi | null = null;

afterEach(async () => {
  if (running !== null) await running.stop("test-teardown");
  running = null;
});

interface Harness {
  readonly api: RunningCoreApi;
  readonly lines: () => readonly Record<string, unknown>[];
  readonly url: (path: string) => string;
}

async function start(
  env: Record<string, string> = {},
  adapters?: SuppliedAdapters,
  inFlight?: InFlightRegister,
  drainables?: readonly Drainable[],
): Promise<Harness> {
  const outcome = loadCoreApiConfiguration({
    PLATOS_ENVIRONMENT: "test",
    // Port 0 asks the kernel for a free port, so parallel test files cannot
    // collide and decide whether CI is green.
    PLATOS_CORE_API_PORT: "0",
    PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS: "2000",
    ...env,
  });
  if (!outcome.ok) throw new Error("harness configuration must be valid");

  const written: string[] = [];
  const api = await startCoreApi({
    configuration: outcome.value,
    adapters,
    inFlight,
    drainables,
    logger: createProcessLogger({ minimumLevel: "debug", write: (line) => written.push(line) }),
  });
  running = api;
  return {
    api,
    lines: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
    url: (path) => `http://${api.host}:${api.port}${path}`,
  };
}

function adapterDouble(name: string): unknown {
  return { adapterName: name };
}

/** Every declared adapter, supplied — the state WIN-258/259 and siblings reach. */
function fullySupplied(): SuppliedAdapters {
  const names = [
    "postgres-tenancy", "outbox", "durable-runtime", "clickhouse-observability",
    "objectstore-minio", "redis-ratelimit", "redis-cache", "redis-streams",
    "model-router-providers", "channel-slack", "notifier-email", "notifier-webhook",
  ];
  return Object.fromEntries(names.map((name) => [name, adapterDouble(name)])) as SuppliedAdapters;
}

describe("the process starts and serves", () => {
  it("binds a port and reports it", async () => {
    const harness = await start();
    expect(harness.api.port).toBeGreaterThan(0);
    expect(harness.api.state.phase).toBe("serving");
  });

  it("answers liveness unconditionally, even with nothing wired", async () => {
    const harness = await start();
    const response = await fetch(harness.url("/livez"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "alive", phase: "serving" });
  });

  it("answers /healthz identically, for orchestrators that use that name", async () => {
    const harness = await start();
    expect((await fetch(harness.url("/healthz"))).status).toBe(200);
  });

  it("emits structured startup lifecycle events", async () => {
    const harness = await start();
    const messages = harness.lines().map((line) => line["message"]);
    expect(messages).toContain("process.starting");
    expect(messages).toContain("process.started");
    const started = harness.lines().find((line) => line["message"] === "process.started");
    expect(started).toMatchObject({ bindings: "0/44 adapter bindings satisfied", unsatisfied: 44 });
  });
});

describe("readiness tells the truth about what is wired", () => {
  it("is 503 while adapter bindings are unsatisfied", async () => {
    const harness = await start();
    const response = await fetch(harness.url("/readyz"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", phase: "serving" });
  });

  it("becomes 200 once every declared binding is supplied", async () => {
    // The control that stops the 503 above being vacuous: readiness is not
    // hard-wired red, it is red for a stated and removable reason.
    const harness = await start({}, fullySupplied());
    const response = await fetch(harness.url("/readyz"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", phase: "serving" });
  });

  it("keeps the unsatisfied-binding inventory out of the public body", async () => {
    const harness = await start({ PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: ADMIN_TOKEN });
    const body = (await (await fetch(harness.url("/readyz"))).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty("detail");
    expect(body).not.toHaveProperty("reason");
  });

  it("returns the inventory to a caller holding the admin token", async () => {
    const harness = await start({ PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: ADMIN_TOKEN });
    const response = await fetch(harness.url("/readyz"), {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await response.json()) as { detail: { unsatisfiedBindings: string[]; declaredBindings: number } };
    expect(body.detail.declaredBindings).toBe(44);
    // Named per BINDING (ADR M0.3 §15), so an operator reading a 503 learns
    // WHICH port is unserved rather than only which package is absent.
    expect(body.detail.unsatisfiedBindings).toContain("postgres-tenancy:TenancyRepository");
    expect(body.detail.unsatisfiedBindings).toContain(
      "postgres-tenancy:IdentityAccessRepository",
    );
  });

  it("refuses a wrong token, a near-miss token, and an unset token", async () => {
    const harness = await start({ PLATOS_CORE_API_ADMIN_HEALTH_TOKEN: ADMIN_TOKEN });
    for (const presented of ["Bearer wrong-token-entirely-1234", `Bearer ${ADMIN_TOKEN}x`, "Basic abcdef"]) {
      const body = await (await fetch(harness.url("/readyz"), { headers: { authorization: presented } })).json();
      expect(body, presented).not.toHaveProperty("detail");
    }
  });

  it("gives no detail to anyone when no token is configured", async () => {
    const harness = await start();
    const body = await (await fetch(harness.url("/readyz"), { headers: { authorization: "Bearer " } })).json();
    expect(body).not.toHaveProperty("detail");
  });
});

describe("correlation at the process edge", () => {
  it("mints an identifier and echoes it when none arrives", async () => {
    const harness = await start();
    const response = await fetch(harness.url("/livez"));
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("adopts a well-formed upstream identifier", async () => {
    const harness = await start();
    const response = await fetch(harness.url("/livez"), { headers: { "x-request-id": "upstream-trace-42" } });
    expect(response.headers.get("x-request-id")).toBe("upstream-trace-42");
  });

  it("replaces a hostile identifier instead of echoing it", async () => {
    const harness = await start();
    const response = await fetch(harness.url("/livez"), { headers: { "x-request-id": "a".repeat(400) } });
    const echoed = response.headers.get("x-request-id") ?? "";
    expect(echoed).not.toContain("aaaaaaaaaa");
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("honours a configured header name", async () => {
    const harness = await start({ PLATOS_CORE_API_REQUEST_ID_HEADER: "x-correlation-id" });
    const response = await fetch(harness.url("/livez"), { headers: { "x-correlation-id": "corr-9" } });
    expect(response.headers.get("x-correlation-id")).toBe("corr-9");
  });

  it("stamps the id on the log lines the request produces", async () => {
    const harness = await start();
    await fetch(harness.url("/livez"), { headers: { "x-request-id": "traced-request" } });
    // Startup lines are outside any request and must NOT carry an id.
    const startup = harness.lines().find((line) => line["message"] === "process.started");
    expect(startup).not.toHaveProperty("requestId");
  });
});

describe("a real HTTP request passes through the in-flight register", () => {
  it("is counted while it runs and released when it completes", async () => {
    // Observes the PRODUCTION middleware: the register is the real one, wrapped
    // only to record its peak, so this fails if the middleware stops enlisting.
    const real = createInFlightRegister();
    let peak = 0;
    const observed: InFlightRegister = {
      begin: (label) => {
        const registration = real.begin(label);
        peak = Math.max(peak, real.count);
        return registration;
      },
      get count() {
        return real.count;
      },
      get admitting() {
        return real.admitting;
      },
      get refused() {
        return real.refused;
      },
      closeAdmission: () => real.closeAdmission(),
      labels: () => real.labels(),
      drain: (timeoutMs, now) => real.drain(timeoutMs, now),
    };

    const harness = await start({}, undefined, observed);
    await fetch(harness.url("/livez"));
    expect(peak).toBeGreaterThanOrEqual(1);
    expect(observed.count).toBe(0);
  });
});

describe("graceful shutdown", () => {
  it("serves a 503 draining readiness over HTTP during the grace period", async () => {
    // THE REGRESSION THIS TEST CREATED. Without `drainGraceMs`, `stop()` closed
    // the listener in the same tick as the readiness flip, and this request got
    // ECONNREFUSED — the `draining` phase was true and unobservable. A load
    // balancer cannot act on a state it can never see.
    const harness = await start({ PLATOS_CORE_API_DRAIN_GRACE_MS: "400" }, fullySupplied());
    expect((await fetch(harness.url("/readyz"))).status).toBe(200);

    const stopping = harness.api.stop("SIGTERM");
    const response = await fetch(harness.url("/readyz"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "not-ready", phase: "draining" });

    expect((await stopping).drained).toBe(true);
    running = null;
  });

  it("keeps ACCEPTING new connections during the grace period, not just answering old ones", async () => {
    // A fresh connection, not a keep-alive reuse: the point of the grace period
    // is that a request the balancer has not yet stopped routing still lands.
    const harness = await start({ PLATOS_CORE_API_DRAIN_GRACE_MS: "400" });
    const stopping = harness.api.stop("SIGTERM");
    const response = await fetch(harness.url("/livez"), { headers: { connection: "close" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "alive", phase: "draining" });
    await stopping;
    running = null;
  });

  it("stops accepting immediately when the grace period is the default zero", async () => {
    // The control for the two tests above: the grace period is doing the work,
    // not some incidental delay elsewhere in shutdown.
    const harness = await start();
    expect(harness.api.app.configuration.drainGraceMs).toBe(0);
    const work = harness.api.app.inFlight.begin("outbox-flush");
    const stopping = harness.api.stop("SIGTERM");
    await expect(fetch(harness.url("/livez"))).rejects.toThrow();
    work.settle();
    expect((await stopping).drained).toBe(true);
    running = null;
  });

  it("WAITS for outstanding work rather than truncating it", async () => {
    const harness = await start();
    const work = harness.api.app.inFlight.begin("in-flight-turn");

    let finished = false;
    const stopping = harness.api.stop("SIGTERM").then((outcome) => {
      finished = true;
      return outcome;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(finished).toBe(false);
    expect(harness.api.state.phase).toBe("draining");

    work.settle();
    const outcome = await stopping;
    expect(outcome).toMatchObject({ drained: true, remaining: 0 });
    expect(harness.api.state.phase).toBe("stopped");
    running = null;
  });

  it("gives up at the deadline and reports what it abandoned", async () => {
    const harness = await start({ PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS: "60" });
    harness.api.app.inFlight.begin("wedged-forever");
    const outcome = await harness.api.stop("SIGTERM");
    expect(outcome).toMatchObject({ drained: false, remaining: 1 });
    const stopped = harness.lines().find((line) => line["message"] === "process.stopped");
    // Warn, not info: an abandoned unit of work is an operational event.
    expect(stopped).toMatchObject({ level: "warn", drained: false, remaining: 1 });
    running = null;
  });

  it("emits draining and stopped events naming the work and the reason", async () => {
    const harness = await start();
    harness.api.app.inFlight.begin("GET /slow").settle();
    await harness.api.stop("SIGTERM");
    const draining = harness.lines().find((line) => line["message"] === "process.draining");
    expect(draining).toMatchObject({ reason: "SIGTERM", inFlight: 0 });
    expect(harness.lines().find((line) => line["message"] === "process.stopped")).toMatchObject({
      reason: "SIGTERM",
      drained: true,
    });
    running = null;
  });

  it("closes the listener, so the port really is released", async () => {
    const harness = await start();
    const url = harness.url("/livez");
    expect((await fetch(url)).status).toBe(200);
    await harness.api.stop("SIGTERM");
    running = null;
    await expect(fetch(url)).rejects.toThrow();
  });

  it("joins a second stop to the first instead of closing twice", async () => {
    // Two signals in quick succession are normal. A competing shutdown would
    // close the server twice and could resolve before the first drain finished.
    const harness = await start();
    const [first, second] = await Promise.all([harness.api.stop("SIGTERM"), harness.api.stop("SIGINT")]);
    expect(first).toEqual(second);
    running = null;
  });

  it("does not hang on a connection that is open but has sent no complete request", async () => {
    // `nest.close()` is `new Promise(resolve => httpServer.close(resolve))` with
    // no guard, and Node emits `close` only once the connection count reaches
    // zero. A socket the shutdown path forgets to release therefore hangs the
    // await forever — the process never exits and the orchestrator eventually
    // SIGKILLs it, truncating exactly the work the drain existed to protect.
    const harness = await start();
    const socket = connect(harness.api.port, harness.api.host);
    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    socket.write("GET /livez HTTP/1.1\r\nHost: probe\r\n");

    const outcome = await Promise.race([
      harness.api.stop("SIGTERM"),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("shutdown hung")), 8000)),
    ]);
    expect(outcome).toMatchObject({ drained: true });
    socket.destroy();
    running = null;
  }, 20_000);

  it("abandons a wedged connection once the deadline passes", async () => {
    const harness = await start({ PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS: "60" });
    const socket = connect(harness.api.port, harness.api.host);
    await new Promise((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("error", reject);
    });
    socket.write("GET /livez HTTP/1.1\r\nHost: probe\r\n");
    harness.api.app.inFlight.begin("wedged-forever");

    const outcome = await Promise.race([
      harness.api.stop("SIGTERM"),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("shutdown hung")), 8000)),
    ]);
    expect(outcome).toMatchObject({ drained: false, remaining: 1 });
    socket.destroy();
    running = null;
  }, 20_000);

  it("can be started and stopped repeatedly without leaking a listener", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const harness = await start();
      expect((await fetch(harness.url("/livez"))).status).toBe(200);
      await harness.api.stop("cycle");
      running = null;
    }
  });
});

describe("shutdown REFUSES late work instead of dropping it", () => {
  // WHAT THE GATE IS FOR, AND WHAT THESE CASES ACTUALLY DRIVE.
  //
  // The scenario is a keep-alive connection an upstream proxy already holds
  // delivering a request AFTER `server.close()` — routed, begun, and then
  // destroyed by the socket release at the end of `stop()`. Reproducing that
  // timing from a test means winning a race against Node's own connection
  // bookkeeping, and a case that has to win a race is a case that will one day
  // lose one in CI and be deleted.
  //
  // So the two halves are driven separately and each is deterministic: the
  // middleware's refusal is exercised over REAL HTTP against a real server with
  // admission closed, and the ORDERING — that shutdown closes admission before
  // it drains anything — is read from inside a drainable, which by construction
  // runs after that point in `stop()`.

  it("answers 503 with the refusal code once admission is closed", async () => {
    const register = createInFlightRegister();
    const harness = await start({}, undefined, register);
    register.closeAdmission();

    const response = await fetch(harness.url("/livez"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: WORK_REFUSED_SHUTTING_DOWN } });
  });

  it("tells the caller to come back, rather than merely closing on them", async () => {
    const register = createInFlightRegister();
    const harness = await start({}, undefined, register);
    register.closeAdmission();

    const response = await fetch(harness.url("/livez"));

    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("connection")).toBe("close");
  });

  it("does not BEGIN the refused request, so the drain's zero still means zero", async () => {
    const register = createInFlightRegister();
    const harness = await start({}, undefined, register);
    register.closeAdmission();
    await fetch(harness.url("/livez"));

    expect(register.count).toBe(0);
    expect(register.refused).toBe(1);
    expect((await register.drain(50)).drained).toBe(true);
  });

  it("still carries the correlation identifier on the refusal", async () => {
    // A REFUSAL IS STILL A TRACE. The header is set before the gate is
    // consulted; a 503 with no request id is a 503 nobody can follow up.
    const register = createInFlightRegister();
    const harness = await start({}, undefined, register);
    register.closeAdmission();

    const response = await fetch(harness.url("/livez"), { headers: { "x-request-id": "upstream-9" } });

    expect(response.headers.get("x-request-id")).toBe("upstream-9");
  });

  it("admits normally while the process is still serving", async () => {
    // The control that stops the cases above being vacuous: the gate is not
    // wired shut, it closes at a stated moment.
    const harness = await start();
    expect((await fetch(harness.url("/livez"))).status).toBe(200);
    expect(harness.api.app.inFlight.admitting).toBe(true);
  });

  it("keeps admitting through the whole grace period, then closes", async () => {
    // THE GATE MUST NOT CLOSE TOO EARLY. `drainGraceMs` exists so a load
    // balancer polling /readyz can observe the flip and stop routing here; a
    // gate that closed at the top of `stop()` would 503 every request in that
    // window, which is the opposite of the grace period's purpose.
    const harness = await start({ PLATOS_CORE_API_DRAIN_GRACE_MS: "300" });
    const stopping = harness.api.stop("SIGTERM");

    const duringGrace = await fetch(harness.url("/livez"));
    expect(duringGrace.status).toBe(200);

    const outcome = await stopping;
    running = null;
    expect(harness.api.app.inFlight.admitting).toBe(false);
    expect(outcome.refused).toBe(0);
  }, 20_000);

  it("has closed admission by the time deferred work is drained", async () => {
    // THE ORDERING, read from the one place in `stop()` that runs after the
    // gate closes. If `closeAdmission()` moved below the deferred drain — or
    // vanished — this reads true and goes red.
    const seen: boolean[] = [];
    const probe: Drainable = {
      name: "probe",
      drain: () => {
        seen.push(harness.api.app.inFlight.admitting);
        return Promise.resolve({ drained: true, handled: 0, remaining: 0, stoppedBecause: null });
      },
    };
    const harness = await start({}, undefined, undefined, [probe]);
    await harness.api.stop("SIGTERM");
    running = null;
    expect(seen).toEqual([false]);
  });
});

describe("shutdown drains deferred work out of the SAME budget", () => {
  it("runs a supplied drainable and reports it", async () => {
    const handled: string[] = [];
    const drainable: Drainable = {
      name: "outbox",
      drain: () => {
        handled.push("drained");
        return Promise.resolve({ drained: true, handled: 4, remaining: 0, stoppedBecause: null });
      },
    };
    const harness = await start({}, undefined, undefined, [drainable]);
    const outcome = await harness.api.stop("SIGTERM");
    running = null;

    expect(handled).toEqual(["drained"]);
    expect(outcome.deferred.steps).toHaveLength(1);
    expect(outcome.deferred.steps[0]).toMatchObject({ name: "outbox" });
    expect(outcome.deferred.steps[0]?.outcome.handled).toBe(4);
  });

  it("names every drainable in the process.stopped line", async () => {
    const drainable: Drainable = {
      name: "outbox",
      drain: () => Promise.resolve({ drained: true, handled: 2, remaining: 0, stoppedBecause: null }),
    };
    const harness = await start({}, undefined, undefined, [drainable]);
    await harness.api.stop("SIGTERM");
    running = null;
    const stopped = harness.lines().find((line) => line["message"] === "process.stopped");
    expect(stopped?.["deferred"]).toEqual([
      { name: "outbox", drained: true, handled: 2, waitedMs: expect.any(Number), stoppedBecause: null },
    ]);
  });

  it("reports NOT drained overall when a drainable did not drain", async () => {
    // ONE VERDICT OVER BOTH HALVES. A process that drained every request and
    // abandoned a full outbox has not shut down cleanly, and `main.ts` turns
    // this flag into the exit code an orchestrator reads.
    const drainable: Drainable = {
      name: "outbox",
      drain: () =>
        Promise.resolve({
          drained: false,
          handled: 1,
          remaining: 9,
          stoppedBecause: "core-api.shutdown.outbox_budget_spent",
        }),
    };
    const harness = await start({}, undefined, undefined, [drainable]);
    const outcome = await harness.api.stop("SIGTERM");
    running = null;
    expect(outcome.drained).toBe(false);
    // And the request half really did drain, so the false above is the deferred
    // half's doing and not a coincidence.
    expect(outcome.remaining).toBe(0);
  });

  it("does NOT hand the deferred drain a second full budget", async () => {
    // The bug this exists to prevent: a process given 60ms spends 60ms on
    // requests and then another 60ms on the outbox, and is SIGKILLed mid-flush.
    // Here the in-flight drain burns the whole budget on a unit that never
    // settles, so the drainable's turn arrives with nothing left and it is NOT
    // CALLED — reported, not silently skipped.
    const called: string[] = [];
    const drainable: Drainable = {
      name: "outbox",
      drain: () => {
        called.push("outbox");
        return Promise.resolve({ drained: true, handled: 0, remaining: 0, stoppedBecause: null });
      },
    };
    const harness = await start(
      { PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS: "60" },
      undefined,
      undefined,
      [drainable],
    );
    harness.api.app.inFlight.begin("never-settles");

    const outcome = await harness.api.stop("SIGTERM");
    running = null;

    expect(called).toEqual([]);
    expect(outcome.deferred.steps[0]?.outcome.stoppedBecause).toBe(SHUTDOWN_DRAIN_BUDGET_SPENT);
    expect(outcome.deferred.budgetMs).toBe(0);
  }, 20_000);

  it("drains nothing, cleanly, when no drainable is supplied", async () => {
    // M2.5 ships with an EMPTY list in every install this repository composes:
    // the outbox flush is built and proven, and has no production handler until
    // M4 wires the projection and notification drains. That absence must read as
    // a clean stop rather than as a failed drain.
    const harness = await start();
    const outcome = await harness.api.stop("SIGTERM");
    running = null;
    expect(outcome.deferred.steps).toEqual([]);
    expect(outcome.drained).toBe(true);
  });
});
