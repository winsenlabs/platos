// The process entry point.
//
// This is the ONE file entitled to assume it is a process: to read the ambient
// environment, install signal handlers and choose an exit code. Everything it
// calls is a function over explicit inputs, which is why the same code paths run
// under the test runner without a signal, a port collision or a `process.exit`
// taking the runner down with it.
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

import { loadCoreApiConfiguration, renderStartupFailure } from "./config/load.js";
import { createProcessDefaults, startCoreApi } from "./runtime/lifecycle.js";

export { composeApplication, type AppModule } from "./app.module.js";
export { startCoreApi, type RunningCoreApi } from "./runtime/lifecycle.js";

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
  const outcome = loadCoreApiConfiguration(io.env);
  if (!outcome.ok) {
    // Fail closed: nothing has been constructed, no port has been bound, and the
    // diagnostic carries no secret value (config/load.ts owns that guarantee).
    io.writeError(renderStartupFailure(outcome.diagnostics));
    return EXIT_CONFIGURATION;
  }

  const configuration = outcome.value;
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
    env: process.env,
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
