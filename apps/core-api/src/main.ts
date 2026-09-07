// The process entry point.
//
// This is the ONE file entitled to assume it is a process: to install signal
// handlers and choose an exit code. Everything it calls is a function over
// explicit inputs, which is why the same code paths run under the test runner
// without a signal, a port collision or a `process.exit` taking the runner down
// with it.
//
// IT NO LONGER READS THE ENVIRONMENT ITSELF (WIN-260). It used to, and the
// banner used to say so; `config/environment.ts` now holds the one environment
// read in V1 feature code, and `scripts/arch/env-access.mjs` fails the build on
// any other. The read moved to the configuration contract's edge because that is
// where the schema saying what a valid environment looks like already lives, and
// because a gate whose single documented exception is a configuration module is
// a gate a reader can check. `main()` calls it and passes the snapshot onward.
//
// EXIT CODES ARE PART OF THE CONTRACT. An orchestrator distinguishes "this will
// never work, stop restarting me" from "something broke, try again", and a
// process that answers 1 to everything makes a crash-loop indistinguishable from
// a typo in a variable name.
//
//   0  clean shutdown, all in-flight work drained
//   1  a fault while running, or shutdown gave up with work still in flight
//  78  configuration is invalid or incomplete — EX_CONFIG, restarting will not
//      help, and the diagnostic on stderr says exactly which variables

import "reflect-metadata";

import { pathToFileURL } from "node:url";

import { constructAdapters } from "./composition/adapter-bindings.js";
import { assembleContextPorts } from "./composition/context-ports.js";
import { readProcessEnvironment } from "./config/environment.js";
import { renderStartupFailure } from "./config/load.js";
import { loadPlatformConfiguration } from "./config/platform.js";
import { correlationSource } from "./runtime/correlation.js";
import { createProcessDefaults, startCoreApi } from "./runtime/lifecycle.js";

export { composeApplication, type AppModule } from "./app.module.js";
export { startCoreApi, type RunningCoreApi } from "./runtime/lifecycle.js";
export { loadPlatformConfiguration, type PlatformConfiguration } from "./config/platform.js";

export const EXIT_OK = 0;
export const EXIT_FAULT = 1;
export const EXIT_CONFIGURATION = 78;

/** The signals an orchestrator uses to ask for a graceful stop. */
const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface MainIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly writeError: (text: string) => void;
}

export async function runProcess(io: MainIo): Promise<number> {
  // ALL SIX SECTIONS, BEFORE ANYTHING IS CONSTRUCTED. WIN-260 widened this from
  // the core section to the whole platform contract, so a malformed store URL or
  // a durable endpoint with no key is refused here rather than at first use. The
  // diagnostic names every bad variable across every section in one pass.
  const outcome = loadPlatformConfiguration(io.env);
  if (!outcome.ok) {
    // Fail closed: nothing has been constructed, no port has been bound, and the
    // diagnostic carries no secret value (config/load.ts owns that guarantee).
    io.writeError(renderStartupFailure(outcome.diagnostics));
    return EXIT_CONFIGURATION;
  }

  // WIN-267 T3. THE OTHER FIVE SECTIONS ARE NO LONGER DROPPED ON THE FLOOR.
  //
  // This block used to be one line — `startCoreApi({ configuration })` — with a
  // comment saying the other five sections "are what the composition root will
  // hand each adapter when it constructs one; today it constructs none". That
  // was the reason `/readyz` answered 0/49 in every configuration: not a
  // misconfiguration anywhere, just a validated `stores.postgres` that nothing
  // read. `constructAdapters` reads them now.
  //
  // THE PROCESS DEFAULTS ARE BUILT ONCE, HERE, and handed onward rather than
  // left to `startCoreApi` to mint again. The outbox stamps every event's time
  // from a clock, and a process whose adapters ran on one clock while its
  // request path ran on another would be a process whose event order and whose
  // logs could disagree for no reason a reader could ever find.
  const platform = outcome.value;
  const configuration = platform.core;
  const defaults = createProcessDefaults(configuration);

  const construction = constructAdapters({
    stores: platform.stores,
    security: platform.security,
    providers: platform.providers,
    clock: defaults.clock,
    // The seam WIN-260 built and nothing had wired. `correlationSource` reads
    // the async-local frame the edge middleware opens, so a write issued while
    // serving a request carries that request's id into PostgreSQL's own session
    // state and onto every domain event the transaction appends.
    correlation: correlationSource,
  });

  if (construction.faults.length > 0) {
    // EX_CONFIG, NOT A FAULT. A key ring that will not parse, a pool setting the
    // client refuses — the value was SUPPLIED and is unusable, so restarting
    // reaches the same answer. This is the same verdict the section loader gives
    // a malformed variable, reached one layer later because only the adapter
    // knows what a usable key ring looks like.
    io.writeError(
      `core-api cannot construct its adapters:\n${construction.faults.map((fault) => `  ${fault}\n`).join("")}`,
    );
    await construction.release();
    return EXIT_CONFIGURATION;
  }

  const assembly = assembleContextPorts(construction.adapters, defaults);

  let running;
  try {
    running = await startCoreApi({
      configuration,
      adapters: construction.adapters,
      ports: assembly.ports,
      unwired: construction.unwired,
      clock: defaults.clock,
      ids: defaults.ids,
      logger: defaults.logger,
    });
  } catch (error) {
    // Startup faults are structured too. A composition fault here means a
    // mis-wired adapter, which is a programming error: report it and stay down.
    defaults.logger.log("error", "process.start_failed", {
      error: error instanceof Error ? error.name : "unknown",
      detail: error instanceof Error ? error.message : String(error),
    });
    // THE POOL IS ALREADY OPEN BY THIS POINT. Returning without releasing it
    // would leave a PostgreSQL pool and a Redis socket held by a process that
    // has decided to die, and `main()` calls `process.exit` — so the sockets go
    // when the kernel reaps them rather than when this code says so.
    await construction.release();
    return EXIT_FAULT;
  }

  const stopped = new Promise<number>((resolve) => {
    for (const signal of SHUTDOWN_SIGNALS) {
      process.on(signal, () => {
        void running
          .stop(signal)
          .then((result) => resolve(result.drained ? EXIT_OK : EXIT_FAULT))
          .catch(() => resolve(EXIT_FAULT));
      });
    }
  });

  const code = await stopped;
  // AFTER the drain and after the framework closed, never before. A pool
  // released while a request is still finishing turns the last work of a
  // graceful shutdown into a connection error — which is the exact failure the
  // drain sequence in `lifecycle.ts` exists to prevent, reintroduced one layer
  // out. This call is what makes `PostgresTenancyAdapter.close`'s own comment —
  // "the composition root owns this adapter's lifetime" — a true sentence.
  await construction.release();
  return code;
}

async function main(): Promise<void> {
  const code = await runProcess({
    env: readProcessEnvironment(),
    writeError: (text) => process.stderr.write(text),
  });
  // Explicit rather than letting the loop empty: a stray unref'd timer or an
  // adapter's open socket must not turn a clean shutdown into a hang, and the
  // exit code is evidence the executable start/stop test reads.
  process.exit(code);
}

// Only when executed directly. `@platos/core-api`'s package entry point is this
// module, so importing the package — which the tests and any future embedding
// host do — must not start a server as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
