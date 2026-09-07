import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTEXTS_ROOT,
  RULES,
  SCANNED_LAYERS,
  analyzeSource,
  checkAmbientTime,
} from "./ambient-time.mjs";

const SOURCE = `${CONTEXTS_ROOT}/tenancy/application/probe.ts`;
const DOMAIN = `${CONTEXTS_ROOT}/tenancy/domain/probe.ts`;

function rulesFired(path, text) {
  return [...new Set(analyzeSource(path, text).map((violation) => violation.rule))].sort();
}

// EVERY CASE IS A PAIR: a fixture that must fire the rule and a fixture that
// must not. A gate proven only on its failing half can still be one that rejects
// everything, and a gate proven only on its passing half is one that never
// fires — which is what this gate would be worth if it were only run against a
// tree that is already clean.

test("T1 — Date.now() is the wall clock", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const at = () => Date.now();\n`), ["T1"]);
  assert.deepEqual(rulesFired(SOURCE, `export const age = (from) => Date.now() - from;\n`), ["T1"]);

  // The port, which is the whole point.
  assert.deepEqual(rulesFired(SOURCE, `export const at = (clock) => clock.now();\n`), []);
  // A property called `now` on something that is not Date.
  assert.deepEqual(rulesFired(SOURCE, `export const at = (deps) => deps.now();\n`), []);
  // A parse of a stored value.
  assert.deepEqual(rulesFired(SOURCE, `export const parse = (text) => Date.parse(text);\n`), []);
});

test("T1 — a comment naming Date.now() is prose, not a call", () => {
  // FOUR CONTEXT HEADERS IN THIS TREE SAY "no `new Date()`" AND "Date.now()" IN
  // PROSE. A regex gate would have failed on the very sentences that describe
  // the rule it enforces, which is why this walks the parser instead.
  assert.deepEqual(
    rulesFired(
      SOURCE,
      `// Time is a PORT. Nothing here calls Date.now() or new Date().\nexport const at = (clock) => clock.now();\n`,
    ),
    [],
  );
  assert.deepEqual(
    rulesFired(SOURCE, `export const advice = "do not call Date.now() or new Date()";\n`),
    [],
  );
});

test("T2 — new Date() with no argument is the same read wearing a constructor", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const at = () => new Date();\n`), ["T2"]);
  assert.deepEqual(rulesFired(DOMAIN, `export const row = { archivedAt: new Date() };\n`), ["T2"]);

  // DECODING IS ALLOWED, and must be: a use case that could not name any instant
  // could not name the one the Clock handed it either.
  assert.deepEqual(rulesFired(SOURCE, `export const at = (ms) => new Date(ms);\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `export const at = () => new Date("2026-01-01T00:00:00.000Z");\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `export const due = (now, ms) => new Date(now.getTime() + ms);\n`), []);
  // A type reference, not a construction.
  assert.deepEqual(rulesFired(SOURCE, `export type At = Date;\n`), []);
});

test("T3 — a monotonic reading is still a reading", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const span = () => performance.now();\n`), ["T3"]);
  assert.deepEqual(rulesFired(SOURCE, `export const span = (timer) => timer.now();\n`), []);
});

test("T4 — randomness comes from the IdGenerator port", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const pick = () => Math.random();\n`), ["T4"]);
  assert.deepEqual(rulesFired(SOURCE, `export const slug = (ids) => ids.ulid();\n`), []);
  // The rest of Math is arithmetic and is not a reading.
  assert.deepEqual(
    rulesFired(SOURCE, `export const cap = (a, b) => Math.min(Math.round(a), Math.max(b, 0));\n`),
    [],
  );
});

test("T5 — scheduling belongs behind a port", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const later = (fn) => setTimeout(fn, 10);\n`), ["T5"]);
  assert.deepEqual(rulesFired(SOURCE, `export const every = (fn) => setInterval(fn, 10);\n`), ["T5"]);
  assert.deepEqual(rulesFired(SOURCE, `export const soon = (fn) => setImmediate(fn);\n`), ["T5"]);

  // NAMING THE SCHEDULER IS NOT SCHEDULING. A type position has to stay legal or
  // a port that returns a handle becomes unspellable.
  assert.deepEqual(rulesFired(SOURCE, `export type Handle = ReturnType<typeof setTimeout>;\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `export const later = (deps, fn) => deps.schedule(fn, 10);\n`), []);
});

test("a file can fire several rules at once, and each is named", () => {
  const violations = analyzeSource(
    SOURCE,
    `export const go = () => {\n  const a = Date.now();\n  const b = new Date();\n  const c = Math.random();\n  return setTimeout(() => [a, b, c], 1);\n};\n`,
  );
  assert.deepEqual(
    violations.map((violation) => violation.rule),
    ["T1", "T2", "T4", "T5"],
  );
  // Line numbers, because a report that says only "somewhere in this file" is a
  // report someone has to grep for.
  assert.deepEqual(
    violations.map((violation) => violation.line),
    [2, 3, 4, 5],
  );
});

test("every rule id is distinct and every one is exercised above", () => {
  const ids = RULES.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["T1", "T2", "T3", "T4", "T5"]);
});

test("the live tree is clean, and the scan is not vacuous", () => {
  const result = checkAmbientTime();
  // NON-VACUITY FIRST. "ok: 0 violations" over 0 files is the failure mode every
  // green gate should be asked about before its verdict is believed. Ten real
  // findings were fixed when this gate was first run — all of them fixtures in
  // domain/application suites that said `new Date()` and therefore behaved
  // differently depending on when the suite ran.
  assert.ok(result.fileCount > 100, `expected a real scan, saw ${result.fileCount} file(s)`);
  assert.deepEqual(result.violations, []);
});

test("the scanned layers are the onion's inside, not the whole tree", () => {
  // ADAPTERS ARE OUT OF SCOPE ON PURPOSE. An adapter is where infrastructure
  // lives; `process-ports.ts` implements the Clock with `new Date()` and must.
  assert.deepEqual(SCANNED_LAYERS, ["domain", "application"]);
  assert.equal(CONTEXTS_ROOT, "packages/contexts");
});
