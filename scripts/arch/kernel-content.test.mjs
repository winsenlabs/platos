import assert from "node:assert/strict";
import { test } from "node:test";

import { KERNEL_ROOT, RULES, analyzeSource, checkKernel } from "./kernel-content.mjs";

const SOURCE = `${KERNEL_ROOT}/vo/probe.ts`;
const TEST_SOURCE = `${KERNEL_ROOT}/vo/probe.test.ts`;

function rulesFired(path, text) {
  return [...new Set(analyzeSource(path, text).map((violation) => violation.rule))].sort();
}

// Every case below is a PAIR: a bad fixture that must fire the rule and a good
// fixture that must not. A gate proven only on the failing half can still be
// one that rejects everything.

test("K1 — the kernel imports only its own relative modules", () => {
  assert.deepEqual(rulesFired(SOURCE, `import { z } from "zod";\nexport type A = typeof z;\n`), ["K1"]);
  assert.deepEqual(rulesFired(SOURCE, `import { readFileSync } from "node:fs";\nexport type A = typeof readFileSync;\n`), ["K1"]);
  assert.deepEqual(rulesFired(SOURCE, `export * from "@platos/context-tenancy";\n`), ["K1"]);
  assert.deepEqual(rulesFired(SOURCE, `export type A = import("ioredis").Redis;\n`), ["K1"]);
  assert.deepEqual(rulesFired(SOURCE, `export const load = () => import("minio");\n`), ["K1"]);

  assert.deepEqual(rulesFired(SOURCE, `import type { X } from "./x.js";\nexport type A = X;\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `export * from "../ports/index.js";\n`), []);
});

test("K1 — a kernel test may import the runner, and nothing else external", () => {
  assert.deepEqual(rulesFired(TEST_SOURCE, `import { it } from "vitest";\nit("x", () => {});\n`), []);
  assert.deepEqual(rulesFired(TEST_SOURCE, `import { z } from "zod";\n`), ["K1"]);
  // The same runner import from production code is still a violation.
  assert.deepEqual(rulesFired(SOURCE, `import { it } from "vitest";\n`), ["K1"]);
});

test("K2 — the kernel declares no stateful class", () => {
  assert.deepEqual(
    rulesFired(SOURCE, `export class SystemClock {\n  constructor(private readonly base: Date) {}\n}\n`),
    ["K2", "K5"],
  );
  assert.deepEqual(rulesFired(SOURCE, `class Counter {\n  private count = 0;\n}\n`), ["K2"]);

  // A class with neither constructor parameters nor instance state is not state.
  assert.deepEqual(rulesFired(SOURCE, `class Marker {\n  static readonly kind = "marker";\n}\n`), []);
});

test("K3 — the kernel holds no mutable module-level state", () => {
  assert.deepEqual(rulesFired(SOURCE, `let cache = 1;\nexport type A = typeof cache;\n`), ["K3"]);
  assert.deepEqual(rulesFired(SOURCE, `var registry = {};\nexport type A = typeof registry;\n`), ["K3"]);

  assert.deepEqual(rulesFired(SOURCE, `const LIMIT = 10;\nexport type A = typeof LIMIT;\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `declare const brand: unique symbol;\nexport type A = typeof brand;\n`), []);
});

test("K4 — the kernel reads no clock, randomness, process or network", () => {
  for (const [source, label] of [
    [`export const now = () => new Date();\n`, "new Date()"],
    [`export const now = () => Date.now();\n`, "Date.now()"],
    [`export const pick = () => Math.random();\n`, "Math.random()"],
    [`export const key = () => process.env.SECRET;\n`, "process"],
    [`export const get = () => fetch("/x");\n`, "fetch"],
    [`export const later = () => setTimeout(() => {}, 1);\n`, "setTimeout"],
    [`export const id = () => crypto.randomUUID();\n`, "crypto"],
  ]) {
    assert.ok(rulesFired(SOURCE, source).includes("K4"), label);
  }

  // The PORTS that exist so the kernel need not do any of the above.
  assert.deepEqual(
    rulesFired(SOURCE, `export interface Clock {\n  now(): Date;\n}\n`),
    [],
    "declaring a Date-returning port is the sanctioned way to express time",
  );
  // A property named like a forbidden global is a name, not a reference.
  assert.deepEqual(rulesFired(SOURCE, `export interface Env {\n  readonly process: string;\n}\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `export const shape = { crypto: "aes" } as const;\n`), []);
});

test("K5 — the kernel exports only types, enums, functions and immutable consts", () => {
  assert.ok(rulesFired(SOURCE, `export const registry = {};\n`).includes("K5"));
  assert.ok(rulesFired(SOURCE, `export const items = [1, 2, 3];\n`).includes("K5"));
  assert.ok(rulesFired(SOURCE, `export class Service {}\n`).includes("K5"));

  for (const source of [
    `export interface Port { readonly kind: "x"; }\n`,
    `export type Id = string;\n`,
    `export enum Level { Debug }\n`,
    `export function add(a: number, b: number): number { return a + b; }\n`,
    `export const USD = "USD";\n`,
    `export const SHAPE = { a: 1 } as const;\n`,
    `export const FROZEN = Object.freeze({ a: 1 });\n`,
    `export const half = (n: number) => n / 2;\n`,
  ]) {
    assert.deepEqual(rulesFired(SOURCE, source), [], source.trim());
  }
});

test("the gate is not foolable by a keyword inside a string or a comment", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const note = "class X { constructor(a) {} }";\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `// import { Redis } from "ioredis"; new Date(); let x = 1;\nexport type A = string;\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `/* Math.random() and process.env */\nexport type A = string;\n`), []);
});

test("every declared rule has at least one fixture that fires it", () => {
  const fired = new Set([
    ...rulesFired(SOURCE, `import { z } from "zod";\n`),
    ...rulesFired(SOURCE, `class C { private n = 0; }\n`),
    ...rulesFired(SOURCE, `let c = 1;\n`),
    ...rulesFired(SOURCE, `export const now = () => new Date();\n`),
    ...rulesFired(SOURCE, `export const registry = {};\n`),
  ]);
  for (const rule of RULES) assert.ok(fired.has(rule.id), `no fixture fires ${rule.id} (${rule.description})`);
});

test("the live kernel satisfies every rule, and the scan is not vacuous", () => {
  const result = checkKernel();
  assert.deepEqual(result.violations, []);
  assert.ok(result.fileCount > 0, "a vacuous scan must not be reported as a pass");
  assert.ok(result.fileCount >= 17, `expected the real kernel, scanned only ${result.fileCount} file(s)`);
});
