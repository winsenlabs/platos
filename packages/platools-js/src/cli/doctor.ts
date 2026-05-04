/**
 * `platools doctor` CLI command.
 *
 * Ported from `platools/cli/doctor.py`. Mirrors the Python flag
 * surface: positional `module`, `--json`. Module loading uses
 * dynamic ESM `import()` so consumers can point at their own
 * barrel file (`platools doctor ./dist/tools.js`, for example).
 *
 * Exit code:
 *   - 0 if there are no error-severity findings
 *   - 1 if any error finding is present (CI-friendly)
 *   - 2 on argument / file errors
 */

import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

import { Platools } from "../platools.js";
import { ToolRegistry } from "../core/registry.js";
import { analyzeRegistry, analyzeTools } from "../doctor/analyzer.js";
import { formatReport, reportToJson } from "../doctor/reporter.js";
import type { DoctorReport } from "../doctor/types.js";
import type { ToolDef } from "../types.js";

export interface DoctorCliOptions {
  readonly modulePath?: string;
  readonly outputJson?: boolean;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

/**
 * Build a unified `ToolRegistry` from a user-provided module path.
 *
 * SDK consumers structure their app like this:
 *
 *     // myApp/tools.ts
 *     import { Platools } from "@platools/sdk";
 *     export const platools = new Platools();
 *     platools.tool({...}, async (...) => ...);
 *
 * `platools doctor ./dist/tools.js` dynamically imports the
 * module, finds every exported `Platools` instance, and merges
 * their registries into a fresh composite registry the analyzer
 * walks. Empty modules surface as "Tools: 0 registered".
 */
export async function loadRegistryFromModule(
  modulePath: string | undefined,
): Promise<ToolRegistry> {
  const composite = new ToolRegistry();
  if (modulePath === undefined || modulePath === "") return composite;

  // Accept both bare specifiers (e.g. `@myorg/tools`) and relative
  // file paths. File paths are normalized via `pathToFileURL` so
  // the ESM loader gets a `file://` URL on all platforms.
  const spec = modulePath.startsWith(".") || modulePath.includes("/") || modulePath.endsWith(".js") || modulePath.endsWith(".mjs")
    ? pathToFileURL(resolvePath(process.cwd(), modulePath)).href
    : modulePath;

  const module: Record<string, unknown> = (await import(spec)) as Record<string, unknown>;
  for (const value of Object.values(module)) {
    if (value instanceof Platools) {
      for (const tool of value.registry.all()) {
        if (!composite.has(tool.name)) composite.register(tool);
      }
    }
  }
  return composite;
}

/**
 * Programmatic entry point for `platools doctor`. Returns the
 * process exit code so the CLI bin can `process.exit(code)`.
 */
export async function runDoctor(options: DoctorCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line));

  let registry: ToolRegistry;
  try {
    registry = await loadRegistryFromModule(options.modulePath);
  } catch (err) {
    stderr(`platools doctor: failed to load module: ${formatError(err)}\n`);
    return 2;
  }

  const report = analyzeRegistry(registry);
  if (options.outputJson === true) {
    stdout(`${reportToJson(report)}\n`);
  } else {
    stdout(formatReport(report));
  }
  return report.hasErrors() ? 1 : 0;
}

/** Convenience helper used by tests — analyze a pre-loaded list. */
export function runDoctorOnTools(tools: readonly ToolDef[]): DoctorReport {
  return analyzeTools(tools);
}

export async function doctorCommand(argv: readonly string[]): Promise<number> {
  const { modulePath, outputJson, help } = parseDoctorArgs(argv);
  if (help) {
    process.stdout.write(doctorHelpText());
    return 0;
  }
  return runDoctor({ modulePath, outputJson });
}

export function doctorHelpText(): string {
  return [
    "Usage: platools doctor [module] [--json]",
    "",
    "Static tool-graph analyzer for Platools.",
    "",
    "Positional:",
    "  module       Optional path/specifier to a module exporting a Platools",
    "               instance (e.g. ./dist/tools.js).",
    "",
    "Options:",
    "  --json       Emit a machine-readable JSON report.",
    "  -h, --help   Show this help and exit.",
    "",
  ].join("\n");
}

export function parseDoctorArgs(argv: readonly string[]): {
  modulePath?: string;
  outputJson: boolean;
  help: boolean;
} {
  let modulePath: string | undefined;
  let outputJson = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--json") outputJson = true;
    else if (arg === "-h" || arg === "--help") help = true;
    else if (!arg.startsWith("-")) modulePath = arg;
  }
  return modulePath === undefined
    ? { outputJson, help }
    : { modulePath, outputJson, help };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
