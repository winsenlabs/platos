// The stdio entry point.
//
// ADR M0.3 §4: "thin stdio bin → reuses contexts/tools transport". Thin here
// means it owns no business logic, not that it owns no lifecycle: it validates
// its configuration fail-closed, loads the runtime its host supplies, reads
// frames until stdin ends or it is signalled, drains what is in flight, and
// exits with a code that says which of those happened.
//
// See `runtime.ts` for the recorded finding on why the runtime is host-supplied
// rather than composed here.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import type { ToolsContract } from "@platos/context-tools";

import { readProcessEnvironment } from "./environment.js";
import {
  EXIT_CONFIGURATION,
  EXIT_FAULT,
  EXIT_OK,
  createStdioSession,
  loadStdioConfiguration,
  loadToolsRuntime,
  renderStdioFailure,
  type StdioIo,
} from "./runtime.js";

export {
  createStdioSession,
  loadStdioConfiguration,
  loadToolsRuntime,
  renderStdioFailure,
  type StdioIo,
  type ToolsRuntimeFactory,
} from "./runtime.js";

/**
 * Retained from the generated skeleton so a placeholder consumer still compiles.
 * It is now what it always claimed to be: the shape of booting this binary.
 */
export type StdioBootstrap = () => Promise<ToolsContract>;

export interface RunStdioOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: StdioIo;
  readonly input: NodeJS.ReadableStream;
  /** Injected by the test; production passes nothing and the module is loaded. */
  readonly loadRuntime?: (specifier: string) => Promise<ToolsContract>;
}

export async function runStdio(options: RunStdioOptions): Promise<number> {
  const outcome = loadStdioConfiguration(options.env);
  if (!outcome.ok) {
    options.io.writeError(renderStdioFailure(outcome.diagnostics));
    return EXIT_CONFIGURATION;
  }

  const load = options.loadRuntime ?? loadToolsRuntime;
  let tools: ToolsContract;
  try {
    tools = await load(outcome.value.runtimeModule);
  } catch (error) {
    // The specifier itself is NOT echoed: a module path can carry a token.
    options.io.writeError(
      `mcp-stdio refused to start: the host runtime module could not be loaded (${
        error instanceof Error ? error.message : "unknown error"
      }).\n`,
    );
    return EXIT_CONFIGURATION;
  }

  let stopping = false;
  const reader = createInterface({ input: options.input, crlfDelay: Infinity });
  const session = createStdioSession(tools, () => {
    stopping = true;
    reader.close();
  });

  options.io.write(`${JSON.stringify({ event: "ready", tools: tools.name })}\n`);

  await new Promise<void>((resolve) => {
    reader.on("line", (line) => {
      // Once draining, no new frame is accepted. Anything already being handled
      // is synchronous and has therefore already finished.
      if (stopping) return;
      const response = session.handle(line);
      if (response !== null) options.io.write(`${response}\n`);
    });
    reader.on("close", () => resolve());
  });

  options.io.write(`${JSON.stringify({ event: "stopped", handled: session.handled })}\n`);
  return EXIT_OK;
}

async function main(): Promise<void> {
  const io: StdioIo = {
    write: (line) => process.stdout.write(line),
    writeError: (text) => process.stderr.write(text),
  };
  // Signals close stdin, which ends the frame loop through the same path a
  // normal end-of-input takes. One shutdown route, so the drained path and the
  // signalled path are the same tested code. Registered inside `main` so that
  // merely IMPORTING this module installs no handler.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => process.stdin.destroy());
  }
  let code = EXIT_FAULT;
  try {
    code = await runStdio({ env: readProcessEnvironment(), io, input: process.stdin });
  } catch (error) {
    io.writeError(`mcp-stdio faulted: ${error instanceof Error ? error.message : "unknown error"}\n`);
  }
  process.exit(code);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
