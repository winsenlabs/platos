// Starting and stopping the process.
//
// Everything here is a FUNCTION over injected inputs, and nothing reads
// `process.env`, installs a signal handler or calls `process.exit`. Those belong
// to `main.ts`, which is the only file that may assume it IS the process. The
// split is what lets `lifecycle.test.ts` start and stop a real HTTP server,
// several times, inside one test runner — and it is why the drain evidence can
// hold a real request open instead of asserting about a mock.
//
// SHUTDOWN ORDER, AND WHY IT IS THIS ORDER.
//   1. flip readiness to `draining`, so /readyz answers 503 while the listener
//      is still up and can still finish — and still ACCEPT — what arrives;
//   2. keep serving for `drainGraceMs`, so a load balancer polling /readyz has a
//      chance to observe (1) and stop routing here;
//   3. CLOSE ADMISSION: every request that arrives from here on is REFUSED with
//      503 and a `Retry-After`, not begun and later truncated;
//   4. stop accepting new connections and release idle keep-alive sockets — a
//      keep-alive idler holds `server.close()` open indefinitely, which is the
//      usual reason a "graceful" shutdown hangs until the release times out;
//   5. wait for in-flight work to finish, bounded by `shutdownTimeoutMs`;
//   6. drain deferred work — the outbox first — out of what is LEFT of that same
//      budget, never a second full copy of it;
//   7. release every socket still open, then close the framework.
//
// STEPS 3 AND 6 ARE WIN-260 (M2.5). Step 3 exists because `server.close()`
// refuses new CONNECTIONS and says nothing about a keep-alive connection an
// upstream proxy already holds: such a connection could deliver a request after
// the drain counted zero, have it routed, and have the socket destroyed under it
// at step 7 — work accepted and silently dropped, which is strictly worse than
// work refused. Step 6 exists because the outbox row is written inside the
// transaction and emitted LATER, so the rows the requests just drained wrote are
// sitting in the table with nobody holding them; the flush that empties them is
// `@platos/adapter-outbox`'s `src/flush.ts`, and it is there rather than here
// because rule (C1) allows one importer of an adapter package and because its
// paging contract is outbox knowledge.
// Their arithmetic is in shutdown-drain.ts, and it is arithmetic rather than two
// `await`s because handing each drain the full `shutdownTimeoutMs` spends the
// budget twice and guarantees the second one is SIGKILLed mid-flush.
//
// STEPS 2 AND 5 BOTH EXIST BECAUSE A TEST CAUGHT THEIR ABSENCE.
//
// Step 2: the first version did (1) and (3) in the same tick and claimed in a
// comment that the listener stayed up for the balancer. `lifecycle.test.ts`
// asked for /readyz immediately after `stop()` and got ECONNREFUSED — the
// `draining` phase existed, was returned by the readiness evaluator, and was
// unreachable over HTTP by anyone not already connected. The grace period makes
// the flip observable rather than merely true. It defaults to 0; see the field
// comment in config/schema.ts for why that default is right.
//
// Step 5: the second version went straight from the drain to `nest.close()`.
// A socket holding a half-sent request hung the process forever, because the
// drain counts WORK and the close waits on CONNECTIONS, and that socket was in
// neither the in-flight register nor the idle set. Both are now pinned by tests
// that hang for 18 seconds and fail when this step is removed.

import { NestFactory } from "@nestjs/core";

import type { Clock, IdGenerator, Logger } from "@platos/kernel";

import { composeApplication, type AppModule } from "../app.module.js";
import type { SuppliedAdapters } from "../composition/adapter-bindings.js";
import { describeAdapterSupply } from "../composition/registry.js";
import type { CoreApiConfiguration } from "../config/schema.js";
import type { LifecycleState } from "../health/readiness.js";
import { CoreApiHttpModule } from "../http/http.module.js";
import { resolveCorrelation, withCorrelation } from "./correlation.js";
import { createInFlightRegister, type InFlightRegister } from "./in-flight.js";
import { createProcessLogger, systemClock, ulidGenerator } from "./process-ports.js";
import { drainAll, type Drainable, type ShutdownDrainReport } from "./shutdown-drain.js";

export interface StartOptions {
  readonly configuration: CoreApiConfiguration;
  readonly adapters?: SuppliedAdapters;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  readonly inFlight?: InFlightRegister;
  /**
   * Subsystems holding work that outlives a request — the outbox first among
   * them. Drained in the order given, AFTER in-flight requests, out of what is
   * left of the one shutdown budget. See `shutdown-drain.ts` for why the budget
   * is divided rather than handed to each in full.
   *
   * Empty at M2.5 in every install this repository composes: the outbox flush is
   * built and proven in `@platos/adapter-outbox` (`src/flush.ts`) and has no
   * production handler to hand pages to until M4 wires the projection and
   * notification drains. An absent handler is stated as an absent drainable
   * rather than as a drain that reads pages and drops them.
   */
  readonly drainables?: readonly Drainable[];
}

export interface StopOutcome {
  readonly drained: boolean;
  readonly remaining: number;
  readonly waitedMs: number;
  /** Requests refused after admission closed. They were never begun. */
  readonly refused: number;
  /** One row per drainable. Empty when none was supplied. */
  readonly deferred: ShutdownDrainReport;
}

export interface RunningCoreApi {
  readonly app: AppModule;
  readonly state: LifecycleState;
  readonly logger: Logger;
  /** The port actually bound. Differs from configuration when it asked for 0. */
  readonly port: number;
  readonly host: string;
  stop(reason: string): Promise<StopOutcome>;
}

/** Only the parts of a Node HTTP server this module touches. */
interface ClosableServer {
  address(): { port: number } | string | null;
  close(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

/** Only the parts of an inbound request/response pair the edge middleware touches. */
interface EdgeRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method?: string;
  readonly url?: string;
}
interface EdgeResponse {
  setHeader(name: string, value: string): unknown;
  on(event: string, listener: () => void): unknown;
  /** Written only on the refusal path; see the admission gate in the middleware. */
  statusCode?: number;
  end(body?: string): unknown;
}

export function createProcessDefaults(configuration: CoreApiConfiguration): {
  clock: Clock;
  ids: IdGenerator;
  logger: Logger;
} {
  const clock = systemClock();
  return {
    clock,
    ids: ulidGenerator(clock),
    logger: createProcessLogger({
      minimumLevel: configuration.logLevel,
      clock,
      write: (line) => process.stdout.write(line),
      base: { service: "core-api", environment: configuration.environment },
    }),
  };
}

export async function startCoreApi(options: StartOptions): Promise<RunningCoreApi> {
  const { configuration } = options;
  const defaults = createProcessDefaults(configuration);
  const clock = options.clock ?? defaults.clock;
  const ids = options.ids ?? defaults.ids;
  const logger = options.logger ?? defaults.logger;
  const inFlight = options.inFlight ?? createInFlightRegister();
  const drainables = options.drainables ?? [];

  const app = composeApplication({
    configuration,
    clock,
    ids,
    logger,
    adapters: options.adapters,
    inFlight,
  });

  const state: LifecycleState = { phase: "starting" };
  logger.log("info", "process.starting", {
    environment: configuration.environment,
    bindings: describeAdapterSupply(app.bindings),
  });

  const nest = await NestFactory.create(CoreApiHttpModule.forApplication(app, state), {
    // Nest's own logger writes unstructured lines to stdout, which would sit
    // beside this process's JSON and break any parser reading the stream.
    logger: false,
  });

  // Correlation is installed BEFORE the in-flight register so that the register's
  // own log lines, and everything a request does, already carry the identifier.
  nest.use((request: EdgeRequest, response: EdgeResponse, next: () => void) => {
    const correlation = resolveCorrelation(request.headers[configuration.requestIdHeader]);
    response.setHeader(configuration.requestIdHeader, correlation.requestId);
    withCorrelation(correlation, () => {
      const registration = inFlight.begin(`${request.method ?? "?"} ${request.url ?? "?"}`);
      if (!registration.admitted) {
        // REFUSED, NOT DROPPED. Admission closed while this connection was still
        // open — a keep-alive socket an upstream proxy holds for minutes can
        // deliver a request after the drain has counted zero, and a few lines
        // later shutdown destroys every remaining socket. Without this the
        // client sees a reset in the middle of a write it cannot safely repeat.
        // 503 with `Connection: close` and a `Retry-After` is the same event
        // told truthfully, and it is retriable.
        response.statusCode = 503;
        response.setHeader("connection", "close");
        response.setHeader("retry-after", "1");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: { code: registration.refusal } }));
        return;
      }
      // Both events fire in practice — `finish` on a normal response, `close` on
      // an aborted one, and sometimes both. `settle` is idempotent for exactly
      // this reason; see in-flight.ts.
      response.on("finish", registration.settle);
      response.on("close", registration.settle);
      next();
    });
  });

  await nest.listen(configuration.port, configuration.host);
  const server = nest.getHttpServer() as ClosableServer;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : configuration.port;

  state.phase = "serving";
  logger.log("info", "process.started", {
    host: configuration.host,
    port,
    bindings: describeAdapterSupply(app.bindings),
    unsatisfied: app.bindings.unsatisfied.length,
  });

  let stopping: Promise<StopOutcome> | null = null;

  const stop = async (reason: string): Promise<StopOutcome> => {
    // Two signals in quick succession are normal (an impatient operator, or an
    // orchestrator that sends SIGTERM then SIGINT). The second must join the
    // first shutdown, not start a competing one that closes the server twice.
    if (stopping !== null) return await stopping;
    stopping = (async (): Promise<StopOutcome> => {
      state.phase = "draining";
      logger.log("info", "process.draining", {
        reason,
        inFlight: inFlight.count,
        work: [...inFlight.labels()],
        graceMs: configuration.drainGraceMs,
        timeoutMs: configuration.shutdownTimeoutMs,
      });

      if (configuration.drainGraceMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, configuration.drainGraceMs));
      }

      // ADMISSION CLOSES ONE LINE BEFORE THE LISTENER DOES, and the two are not
      // the same act. `server.close()` refuses new CONNECTIONS; a keep-alive
      // connection an upstream proxy already holds can still deliver a request
      // after the drain below has counted zero, and that request would be routed
      // and then destroyed by the socket release further down. Closing admission
      // turns that into a 503 the client can act on. See in-flight.ts.
      inFlight.closeAdmission();

      server.close();
      server.closeIdleConnections?.();

      // ONE BUDGET, DIVIDED. `shutdownTimeoutMs` is what the orchestrator gives
      // this process before SIGKILL, so the in-flight drain and every deferred
      // drain share it — measured on the injected clock, so a suite can spend it
      // without spending real seconds. Handing the full timeout to each would
      // spend the budget twice and guarantee the outbox flush is killed
      // mid-page; shutdown-drain.ts states that failure and its arithmetic.
      const budgetStartedAt = clock.now().getTime();
      const outcome = await inFlight.drain(configuration.shutdownTimeoutMs, () => clock.now().getTime());
      const leftOverMs = Math.max(
        configuration.shutdownTimeoutMs - (clock.now().getTime() - budgetStartedAt),
        0,
      );
      const deferred = await drainAll(drainables, leftOverMs, () => clock.now().getTime());

      // RELEASE EVERY REMAINING SOCKET BEFORE HANDING OVER TO THE FRAMEWORK.
      //
      // `nest.close()` is `new Promise(resolve => httpServer.close(resolve))`
      // with no guard, and Node emits `close` only once the CONNECTION count
      // reaches zero. Connections and in-flight work are different sets, which
      // is the trap: `closeIdleConnections()` skips a socket whose request
      // headers are only partially received, because the parser has begun a
      // message — while the middleware never registered any work for it, because
      // it was never routed. Such a socket is invisible to the drain and fatal
      // to the close, and the process then hangs until the orchestrator SIGKILLs
      // it, truncating exactly the work the drain existed to protect.
      //
      // Destroying what is left is safe, and only here. The middleware registers
      // EVERY routed request, so `drain` reaching zero means no promised work is
      // outstanding; a socket still open past this line is an idle keep-alive or
      // a request whose headers never arrived. When the drain gave up instead,
      // abandoning the socket is the decision already taken and logged.
      server.closeIdleConnections?.();
      server.closeAllConnections?.();

      await nest.close();
      state.phase = "stopped";

      // ONE VERDICT OVER BOTH HALVES. A process that drained every request and
      // abandoned a full outbox has not shut down cleanly, and reporting only
      // the request half would have said it had — which is how the exit code in
      // main.ts would have answered 0 to a lossy stop.
      const drained = outcome.drained && deferred.drained;
      logger.log(drained ? "info" : "warn", "process.stopped", {
        reason,
        drained,
        remaining: outcome.remaining,
        waitedMs: outcome.waitedMs,
        refused: inFlight.refused,
        deferred: deferred.steps.map((step) => ({
          name: step.name,
          drained: step.outcome.drained,
          handled: step.outcome.handled,
          waitedMs: step.waitedMs,
          stoppedBecause: step.outcome.stoppedBecause,
        })),
      });
      return {
        drained,
        remaining: outcome.remaining,
        waitedMs: outcome.waitedMs,
        refused: inFlight.refused,
        deferred,
      };
    })();
    return await stopping;
  };

  return { app, state, logger, port, host: configuration.host, stop };
}
