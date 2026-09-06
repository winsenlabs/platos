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

import { readProcessEnvironment } from "./config/environment.js";
import { renderStartupFailure } from "./config/load.js";
import { loadPlatformConfiguration } from "./config/platform.js";
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

  // `startCoreApi` takes the CORE section. The other five are validated above and
  // are what the composition root will hand each adapter when it constructs one;
  // today it constructs none, and `app.module.ts` says so where that is decided.
  const configuration = outcome.value.core;
  let running;
  try {
    running = await startCoreApi({ configuration });
  } catch (error) {
    // Startup faults are structured too. A composition fault here means a
    // mis-wired adapter, which is a programming error: report it and stay down.
    const logger = createProcessDefaults(configuration).logger;
    logger.log("error", "process.start_failed", {
      error: error instanceof Error ? error.name : "unknown",
      detail: error instanceof Error ? error.message : String(error),
    });
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

  return await stopped;
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
