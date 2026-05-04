/**
 * `ToolTestRunner` tests — mirrors `platools-py/tests/test_runner.py`.
 *
 * Exercises single-tool runs, input validation, negative cases, and
 * the batch + coverage flows the `platools test` CLI delegates to.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolRegistry } from "../src/core/registry.js";
import { makeToolFactory } from "../src/core/decorator.js";
import {
  BatchResult,
  ToolTestRunner,
  coverageReport,
  type BatchTestCase,
} from "../src/testing/index.js";

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  const tool = makeToolFactory(registry);
  tool(
    {
      name: "add",
      description: "Add two integers together",
      input: z.object({ a: z.number().int(), b: z.number().int() }),
      output: z.object({ total: z.number().int() }),
    },
    ({ a, b }) => ({ total: a + b }),
  );
  tool(
    {
      name: "throws",
      description: "Always throws an error for testing",
      input: z.object({}),
      output: z.object({}),
    },
    () => {
      throw new Error("boom");
    },
  );
  return registry;
}

describe("ToolTestRunner", () => {
  it("runs a tool and reports success", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const result = await runner.runAsync("add", { a: 2, b: 3 });
    expect(result.passed).toBe(true);
    expect(result.output).toEqual({ total: 5 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports schema validation failures as passed=false", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const result = await runner.runAsync("add", { a: "nope", b: 3 });
    expect(result.passed).toBe(false);
    expect(result.error).toContain("input schema validation failed");
  });

  it("rejects extra keys as input validation errors", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const result = await runner.runAsync("add", { a: 1, b: 2, c: 9 });
    expect(result.passed).toBe(false);
    expect(result.error).toContain("unexpected key");
  });

  it("captures handler exceptions", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const result = await runner.runAsync("throws", {});
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/boom/);
  });

  it("reports an unknown tool as a failure without duration", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const result = await runner.runAsync("nope", {});
    expect(result.passed).toBe(false);
    expect(result.error).toContain("not registered");
    expect(result.durationMs).toBe(0);
  });

  it("inverts negative batch cases (expect_error=true)", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const cases: BatchTestCase[] = [
      { tool: "throws", params: {}, expectError: true, expectSuccess: true },
      { tool: "add", params: { a: 1, b: 2 } },
    ];
    const batch = await runner.runBatch(cases);
    expect(batch).toBeInstanceOf(BatchResult);
    expect(batch.passed).toBe(2);
    expect(batch.failed).toBe(0);
  });

  it("fails a negative case if the tool unexpectedly succeeds", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const cases: BatchTestCase[] = [
      { tool: "add", params: { a: 1, b: 2 }, expectError: true, expectSuccess: true },
    ];
    const batch = await runner.runBatch(cases);
    expect(batch.passed).toBe(0);
    expect(batch.failed).toBe(1);
    expect(batch.cases[0]!.error).toContain("expected error");
  });

  it("computes p50 / p95 latency", async () => {
    const runner = new ToolTestRunner(buildRegistry());
    const cases: BatchTestCase[] = Array.from({ length: 10 }, (_, i) => ({
      tool: "add",
      params: { a: i, b: i },
    }));
    const batch = await runner.runBatch(cases);
    expect(batch.latencyP50).toBeGreaterThanOrEqual(0);
    expect(batch.latencyP95).toBeGreaterThanOrEqual(batch.latencyP50);
  });
});

describe("coverageReport", () => {
  it("marks tools with at least one test case", () => {
    const registry = buildRegistry();
    const cases: BatchTestCase[] = [{ tool: "add", params: { a: 1, b: 2 } }];
    const report = coverageReport(registry, cases);
    expect(report["add"]).toBe(true);
    expect(report["throws"]).toBe(false);
  });
});
