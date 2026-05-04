/**
 * `platools test` CLI command.
 *
 * Ported from `platools/cli/test.py`. Mirrors the Python flag surface:
 *
 *     platools test                                # batch from platools-tests.yaml
 *     platools test --file my-tests.yaml           # explicit batch file
 *     platools test process_refund                 # single tool, no params
 *     platools test process_refund --params '{...}'
 *     platools test --coverage                     # coverage checklist
 *
 * Loads the consumer's tools the same way `platools doctor` does —
 * import the target module, scan for `Platools` instances, and merge
 * their registries. Defaults to `platools-tests.yaml` in the current
 * directory when neither `--file` nor a positional tool name is given.
 *
 * Exit code:
 *   - 0 if every test case passed
 *   - 1 if any case failed
 *   - 2 on argument / file errors
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import type { ToolRegistry } from "../core/registry.js";
import {
  type BatchResult,
  type BatchTestCase,
  type TestResult,
  ToolTestRunner,
  coverageReport,
  loadBatchFile,
} from "../testing/index.js";
import { loadRegistryFromModule } from "./doctor.js";

const DEFAULT_BATCH_FILE = "platools-tests.yaml";

export interface TestCliOptions {
  readonly modulePath?: string;
  readonly toolName?: string;
  readonly paramsJson?: string;
  readonly batchFile?: string;
  readonly showCoverage?: boolean;
  readonly stdout?: (line: string) => void;
  readonly stderr?: (line: string) => void;
}

/**
 * Programmatic entry point for `platools test`. Returns the process
 * exit code so the CLI bin can `process.exit(code)` directly.
 */
export async function runTest(options: TestCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line));

  let registry: ToolRegistry;
  try {
    registry = await loadRegistryFromModule(options.modulePath);
  } catch (err) {
    stderr(`platools test: failed to load module: ${formatError(err)}\n`);
    return 2;
  }

  const runner = new ToolTestRunner(registry);

  // Coverage mode is independent of single / batch modes. It reports
  // coverage against the supplied (or default) batch file, or an
  // empty list if no batch file is found.
  if (options.showCoverage === true) {
    let cases: BatchTestCase[] = [];
    try {
      if (options.batchFile !== undefined) {
        cases = loadBatchFile(options.batchFile);
      } else {
        const defaultPath = resolvePath(process.cwd(), DEFAULT_BATCH_FILE);
        if (existsSync(defaultPath)) cases = loadBatchFile(defaultPath);
      }
    } catch (err) {
      stderr(`platools test: ${formatError(err)}\n`);
      return 2;
    }
    stdout(formatCoverage(coverageReport(registry, cases)));
    return 0;
  }

  // Single-tool mode.
  if (options.toolName !== undefined && options.toolName !== "") {
    let params: Record<string, unknown> = {};
    if (options.paramsJson !== undefined && options.paramsJson !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(options.paramsJson);
      } catch (err) {
        stderr(`platools test: invalid --params JSON: ${formatError(err)}\n`);
        return 2;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        stderr("platools test: --params must decode to a JSON object\n");
        return 2;
      }
      params = parsed as Record<string, unknown>;
    }
    const result = await runner.runAsync(options.toolName, params);
    stdout(formatSingle(result));
    return result.passed ? 0 : 1;
  }

  // Batch mode (default).
  let resolvedBatch: string | null = null;
  if (options.batchFile !== undefined) {
    resolvedBatch = options.batchFile;
  } else {
    const defaultPath = resolvePath(process.cwd(), DEFAULT_BATCH_FILE);
    if (existsSync(defaultPath)) resolvedBatch = defaultPath;
  }
  if (resolvedBatch === null) {
    stderr(
      `platools test: no batch file found. Pass --file <path> or create ${DEFAULT_BATCH_FILE} in the current directory.\n`,
    );
    return 2;
  }

  let cases: BatchTestCase[];
  try {
    cases = loadBatchFile(resolvedBatch);
  } catch (err) {
    stderr(`platools test: ${formatError(err)}\n`);
    return 2;
  }
  if (cases.length === 0) {
    stdout(`${resolvedBatch}: no test cases defined\n`);
    return 0;
  }

  const batch = await runner.runBatch(cases);
  stdout(formatBatch(batch));
  return batch.failed === 0 ? 0 : 1;
}

export async function testCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseTestArgs(argv);
  if (parsed.help) {
    process.stdout.write(testHelpText());
    return 0;
  }
  return runTest({
    modulePath: parsed.modulePath,
    toolName: parsed.toolName,
    paramsJson: parsed.paramsJson,
    batchFile: parsed.batchFile,
    showCoverage: parsed.showCoverage,
  });
}

export function testHelpText(): string {
  return [
    "Usage: platools test [tool] [--module <path>] [--params <json>]",
    "                     [--file <path>] [--coverage]",
    "",
    "Runtime tool exerciser for Platools.",
    "",
    "Positional:",
    "  tool            Optional tool name. When given, runs that single tool",
    "                  with --params instead of batch mode.",
    "",
    "Options:",
    "  --module <p>    Dotted module path or file to import before running",
    "                  tests (loads platools.tool() registrations as a side",
    "                  effect).",
    "  --params <j>    JSON-encoded params dict for single-tool mode.",
    "  --file <p>      Path to a YAML batch file (default: ./platools-tests.yaml).",
    "  --coverage      Print a coverage checklist instead of running tests.",
    "  -h, --help      Show this help and exit.",
    "",
  ].join("\n");
}

interface ParsedTestArgs {
  modulePath?: string;
  toolName?: string;
  paramsJson?: string;
  batchFile?: string;
  showCoverage: boolean;
  help: boolean;
}

export function parseTestArgs(argv: readonly string[]): ParsedTestArgs {
  const out: {
    modulePath?: string;
    toolName?: string;
    paramsJson?: string;
    batchFile?: string;
    showCoverage: boolean;
    help: boolean;
  } = {
    showCoverage: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else if (arg === "--coverage") {
      out.showCoverage = true;
    } else if (arg === "--module") {
      out.modulePath = argv[i + 1];
      i += 1;
    } else if (arg === "--params") {
      out.paramsJson = argv[i + 1];
      i += 1;
    } else if (arg === "--file") {
      out.batchFile = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith("-")) {
      // First positional becomes the tool name.
      if (out.toolName === undefined) out.toolName = arg;
    }
  }
  return out;
}

// ----- formatters ---------------------------------------------------------

function formatBatch(result: BatchResult): string {
  const lines: string[] = [];
  lines.push(`Tests: ${result.passed} passed, ${result.failed} failed`);
  if (result.cases.length > 0) {
    lines.push(
      `Latency: p50 ${result.latencyP50.toFixed(1)}ms, p95 ${result.latencyP95.toFixed(1)}ms`,
    );
  }
  lines.push("");
  for (const testCase of result.cases) {
    const marker = testCase.passed ? "✓" : "✗";
    let line = `  ${marker} ${testCase.tool} (${testCase.durationMs.toFixed(1)}ms)`;
    if (testCase.error !== undefined) {
      line += ` — ${testCase.error}`;
    }
    lines.push(line);
  }
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function formatSingle(result: TestResult): string {
  const marker = result.passed ? "✓" : "✗";
  const lines = [`${marker} ${result.tool} (${result.durationMs.toFixed(1)}ms)`];
  if (result.error !== undefined) {
    lines.push(`  error: ${result.error}`);
  } else if (result.output !== undefined && result.output !== null) {
    lines.push(`  output: ${safeJson(result.output)}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatCoverage(report: Record<string, boolean>): string {
  const names = Object.keys(report).sort();
  const covered = names.filter((name) => report[name]).length;
  const lines = [
    `Coverage: ${covered}/${names.length} tools have at least one test`,
    "",
  ];
  for (const name of names) {
    const marker = report[name] === true ? "✓" : "·";
    lines.push(`  ${marker} ${name}`);
  }
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
