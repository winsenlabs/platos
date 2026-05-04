/**
 * YAML batch file loader for `platools test`.
 *
 * Ported from `platools/testing/runner.py::load_batch_file`. Parses
 * a `platools-tests.yaml` into `BatchTestCase[]` with the same
 * contradictory-flag detection the Python loader enforces.
 *
 * Schema (spec):
 *
 *     tests:
 *       - tool: process_refund
 *         params: { order_id: 'abc123', reason: 'damaged' }
 *         expect_success: true
 *       - tool: process_refund
 *         params: { order_id: '' }
 *         expect_error: true
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

import type { BatchTestCase } from "./runner.js";

export function loadBatchFile(path: string): BatchTestCase[] {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a YAML mapping at the top level`);
  }
  const tests = (parsed as { tests?: unknown }).tests;
  if (!Array.isArray(tests)) {
    throw new Error(`${path}: expected "tests:" to be a list`);
  }

  const cases: BatchTestCase[] = [];
  for (const entry of tests) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: every test entry must be a mapping`);
    }
    const record = entry as Record<string, unknown>;
    const tool = String(record.tool ?? "");
    if (tool === "") {
      throw new Error(`${path}: test entry missing "tool" field`);
    }
    const rawParams = record.params ?? {};
    if (rawParams === null || typeof rawParams !== "object" || Array.isArray(rawParams)) {
      throw new Error(`${path}: "params" must be a mapping`);
    }
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
      params[String(k)] = v;
    }
    const expectSuccessSet = "expect_success" in record || "expectSuccess" in record;
    const expectErrorSet = "expect_error" in record || "expectError" in record;
    const expectSuccess = Boolean(record.expect_success ?? record.expectSuccess ?? true);
    const expectError = Boolean(record.expect_error ?? record.expectError ?? false);

    if (expectSuccessSet && expectErrorSet && expectSuccess && expectError) {
      throw new Error(
        `${path}: test entry for "${tool}" sets both "expect_success: true" and "expect_error: true" — pick one`,
      );
    }
    if (expectSuccessSet && !expectSuccess && expectErrorSet && !expectError) {
      throw new Error(
        `${path}: test entry for "${tool}" sets both "expect_success: false" and "expect_error: false" — this asserts neither outcome, which is meaningless`,
      );
    }

    cases.push({ tool, params, expectSuccess, expectError });
  }
  return cases;
}
