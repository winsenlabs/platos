/**
 * Tool test runner — `platools test`.
 *
 * Ported from `platools/testing/runner.py`. Invokes a single
 * registered tool with a params dict, validates the input against
 * the tool's Zod schema, dispatches the call, times it, and
 * returns a `TestResult`.
 *
 * Validation uses the tool's own Zod schema rather than a separate
 * JSON Schema engine — the SDK already depends on Zod and the
 * Python SDK's equivalent (building a throwaway Pydantic model on
 * the fly) is semantically identical for the shapes consumer tools
 * actually use.
 */

import { ZodError, type z } from "zod";

import type { ToolRegistry } from "../core/registry.js";
import { makeLocalContext } from "../core/decorator.js";

export interface TestResult {
  readonly tool: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly error?: string;
  readonly output?: unknown;
}

export interface BatchTestCase {
  readonly tool: string;
  readonly params: Record<string, unknown>;
  readonly expectSuccess?: boolean;
  readonly expectError?: boolean;
}

export class BatchResult {
  public constructor(public readonly cases: readonly TestResult[]) {}

  public get passed(): number {
    return this.cases.filter((c) => c.passed).length;
  }

  public get failed(): number {
    return this.cases.filter((c) => !c.passed).length;
  }

  public get latencyP50(): number {
    if (this.cases.length === 0) return 0;
    const sorted = [...this.cases.map((c) => c.durationMs)].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1]! + sorted[mid]!) / 2;
    }
    return sorted[mid]!;
  }

  public get latencyP95(): number {
    if (this.cases.length === 0) return 0;
    const sorted = [...this.cases.map((c) => c.durationMs)].sort((a, b) => a - b);
    const idx = Math.max(0, Math.round(sorted.length * 0.95) - 1);
    return sorted[idx]!;
  }
}

/**
 * Single-tool invocation harness.
 *
 * Build with a `ToolRegistry`; call `run(toolName, params)` to
 * invoke one tool. The runner is reusable across many calls so
 * batch mode loops over `runAsync`.
 */
export class ToolTestRunner {
  public constructor(private readonly registry: ToolRegistry) {}

  public hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  public listToolNames(): string[] {
    return this.registry.names();
  }

  public async runAsync(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<TestResult> {
    const tool = this.registry.get(toolName);
    if (tool === undefined) {
      return {
        tool: toolName,
        passed: false,
        durationMs: 0,
        error: `tool "${toolName}" is not registered`,
      };
    }

    // Reject keys not in the schema (typo guard). Zod's `.strict()`
    // path can be bypassed by relaxed schemas, so we do the check
    // explicitly against the properties the schema accepts.
    try {
      rejectExtraKeys(tool.inputZodSchema, params);
    } catch (err) {
      return {
        tool: toolName,
        passed: false,
        durationMs: 0,
        error: `input schema validation failed: ${formatError(err)}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = tool.inputZodSchema.parse(params);
    } catch (err) {
      const message = err instanceof ZodError ? err.issues.map((i) => i.message).join("; ") : formatError(err);
      return {
        tool: toolName,
        passed: false,
        durationMs: 0,
        error: `input schema validation failed: ${message}`,
      };
    }

    const start = performanceNow();
    try {
      const ctx = makeLocalContext(`local-${toolName}`);
      const output = await tool.handler(parsed, ctx);
      const durationMs = performanceNow() - start;
      return { tool: toolName, passed: true, durationMs, output };
    } catch (err) {
      const durationMs = performanceNow() - start;
      const name = err instanceof Error ? err.constructor.name : "Error";
      return {
        tool: toolName,
        passed: false,
        durationMs,
        error: `${name}: ${formatError(err)}`,
      };
    }
  }

  public async runBatch(cases: readonly BatchTestCase[]): Promise<BatchResult> {
    const results: TestResult[] = [];
    for (const testCase of cases) {
      const raw = await this.runAsync(testCase.tool, testCase.params);
      if (expectsFailure(testCase)) {
        const passed = raw.error !== undefined;
        results.push({
          tool: testCase.tool,
          passed,
          durationMs: raw.durationMs,
          error: passed ? undefined : "expected error but tool succeeded",
          output: raw.output,
        });
      } else {
        results.push(raw);
      }
    }
    return new BatchResult(results);
  }
}

export function expectsFailure(testCase: BatchTestCase): boolean {
  return testCase.expectError === true || testCase.expectSuccess === false;
}

/**
 * Return a `{toolName: hasTest}` map for every registered tool.
 * Rendered as a checklist by the CLI's `--coverage` flag so
 * consumers can see which tools haven't been exercised.
 */
export function coverageReport(
  registry: ToolRegistry,
  cases: readonly BatchTestCase[],
): Record<string, boolean> {
  const covered = new Set(cases.map((c) => c.tool));
  const out: Record<string, boolean> = {};
  for (const name of registry.names()) out[name] = covered.has(name);
  return out;
}

// ----- helpers -----

function performanceNow(): number {
  // Node's `performance.now()` gives sub-ms resolution; fall back
  // to `Date.now()` for environments that don't expose it.
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Reject any keys in `params` not present in the Zod schema's
 * `shape`. Only applies to `ZodObject` schemas — the doctor will
 * have already flagged non-object tool inputs.
 */
function rejectExtraKeys(schema: z.ZodTypeAny, params: Record<string, unknown>): void {
  const shape = extractShape(schema);
  if (shape === null) return;
  const allowed = new Set(Object.keys(shape));
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      throw new Error(`unexpected key: ${key}`);
    }
  }
}

function extractShape(schema: z.ZodTypeAny): Record<string, unknown> | null {
  // Walk through `.optional()`, `.nullable()`, `.default()`, etc. to
  // find the underlying `ZodObject`. Zod exposes the shape via
  // `._def.shape()` on object schemas; bail out gracefully if the
  // schema isn't object-shaped.
  let current: z.ZodTypeAny = schema;
  // Zod's schema definitions expose an internal `typeName` tag.
  // We type it loosely here because Zod doesn't export these constants.
  const seen = new Set<z.ZodTypeAny>();
  while (!seen.has(current)) {
    seen.add(current);
    const def: { typeName?: string; innerType?: z.ZodTypeAny; shape?: () => Record<string, unknown> } =
      (current as unknown as { _def: { typeName?: string; innerType?: z.ZodTypeAny; shape?: () => Record<string, unknown> } })._def;
    if (def.typeName === "ZodObject" && typeof def.shape === "function") {
      return def.shape();
    }
    if (def.innerType !== undefined) {
      current = def.innerType;
      continue;
    }
    break;
  }
  return null;
}
