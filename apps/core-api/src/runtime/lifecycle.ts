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
//   3. stop accepting new connections and release idle keep-alive sockets — a
//      keep-alive idler holds `server.close()` open indefinitely, which is the
//      usual reason a "graceful" shutdown hangs until the deploy times out;
//   4. wait for in-flight work to finish, bounded by `shutdownTimeoutMs`;
//   5. release every socket still open, then close the framework.
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

export interface StartOptions {
  readonly configuration: CoreApiConfiguration;
  readonly adapters?: SuppliedAdapters;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  readonly logger?: Logger;
  readonly inFlight?: InFlightRegister;
}

export interface StopOutcome {
  readonly drained: boolean;
  readonly remaining: number;
  readonly waitedMs: number;
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

      server.close();
      server.closeIdleConnections?.();

      const outcome = await inFlight.drain(configuration.shutdownTimeoutMs, () => clock.now().getTime());

      // RELEASE EVERY REMAINING SOCKET BEFORE HANDING OVER TO THE FRAMEWORK.
      //
      // `nest.close()` is `new Promise(resolve => httpServer.close(resolve))`
      // with no guard, and Node emits `close` only once the CONNECTION count
      // reaches zero. Connections and in-flight work are different sets, which
      // is the trap: `closeIdleConnections()` skips a socket whose request
      // headers are partially received, because the parser has begun a message
      // — while the middleware never registered any work for it, because it was
      // never routed. Such a socket is invisible to the drain and fatal to the
      // close, and the process hangs until the orchestrator SIGKILLs it,
      // truncating exactly the work the drain existed to protect.
      //
      // Destroying what is left is safe, and only here. The middleware registers
      // EVERY routed request, so `drain` reaching zero means no promised work is
      // outstanding; a socket still open past this line is an idle keep-alive or
      // a request whose headers never arrived. When the drain gave up instead,
      // abandoning the socket is the decision already taken.
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

      logger.log(outcome.drained ? "info" : "warn", "process.stopped", {
        reason,
        drained: outcome.drained,
        remaining: outcome.remaining,
        waitedMs: outcome.waitedMs,
      });
      return outcome;
    })();
    return await stopping;
  };

  return { app, state, logger, port, host: configuration.host, stop };
}
