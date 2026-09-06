import assert from "node:assert/strict";
import { test } from "node:test";

import { PORT_PATH, PROBES, RULES, analyzeSource, checkCasts, checkProbes, checkTransactionOutcome } from "./transaction-outcome.mjs";

const SOURCE = "packages/contexts/tenancy/application/probe.ts";

function rulesFired(path, text) {
  return [...new Set(analyzeSource(path, text).map((violation) => violation.rule))].sort();
}

function observed(id) {
  const row = checkProbes().observed.find((probe) => probe.id === id);
  assert.ok(row !== undefined, `no probe named ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// X1 — the live refusal, read back from the compiler.
//
// These cases do not assert against a fixture this file writes. They compile
// against `packages/kernel/src/ports/unit-of-work.ts` AS COMMITTED and assert
// what `tsc` said about it, so mutating that signature turns them red. An
// assertion comparing two things one author controls cannot fail; this pair is
// joined to the TypeScript compiler and to a file in another package.
// ---------------------------------------------------------------------------

test("X1 — the committed port REFUSES a callback whose answer is a Result", () => {
  // THE DEFECT, RESTORED AS A QUESTION: this is the exact shape `detect-crossings`
  // shipped — an error `Result` returned from inside `run`, which RESOLVES, which
  // COMMITS. If the port accepts it, the crossing lands with no delivery rows
  // beside it and nothing in this repository notices.
  assert.equal(observed("result").refused, true, "run accepted a Result-valued callback; the M2.5 defect is writable again");
  assert.equal(
    observed("result-union").refused,
    true,
    "run accepted a Result-in-a-union callback; the refusal does not survive a `| null`",
  );
});

test("X1 — the committed port ACCEPTS every shape that is not a Result", () => {
  // THE OTHER HALF, AND IT IS NOT PADDING. `NotResult<Value>` mutated to plain
  // `never` refuses everything, which would leave the case above green and the
  // port unusable. Six ordinary answers pin the discrimination as exact.
  for (const id of ["void", "undefined", "null-union", "array", "record", "scope"]) {
    assert.equal(observed(id).refused, false, `run refused ${id}; the refusal is too wide to be about Result`);
  }
});

test("X1 — the probes actually resolved the port, so a pass is not vacuous", () => {
  // TS2307 is "cannot find module". If the kernel moved or the specifier rotted,
  // every `refused` probe would report a diagnostic for the WRONG reason and this
  // gate would go green on a refusal it never saw.
  // This case asserts ONLY vacuity, and deliberately not the refusal — two
  // guards that go red together cannot be told apart, and the two above already
  // own the refusal itself.
  for (const probe of checkProbes().observed) {
    assert.ok(!probe.codes.includes("TS2307"), `probe ${probe.id} could not resolve ${PORT_PATH}`);
  }
  assert.equal(PROBES.filter((probe) => probe.expect === "refused").length, 2);
  assert.equal(PROBES.filter((probe) => probe.expect === "accepted").length, 6);
});

// ---------------------------------------------------------------------------
// X2 — nothing casts its way past a refusal that still holds.
// ---------------------------------------------------------------------------

test("X2 — an assertion on the receiver of .run( is refused", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const go = (uow) => (uow as Loose).run(work);\n`), ["X2"]);
  assert.deepEqual(rulesFired(SOURCE, `export const go = (d) => (d.unitOfWork as Loose).run(work);\n`), ["X2"]);
  // Parenthesised twice is the same move.
  assert.deepEqual(rulesFired(SOURCE, `export const go = (uow) => ((uow as Loose)).run(work);\n`), ["X2"]);
  // The angle-bracket spelling.
  assert.deepEqual(rulesFired(SOURCE, `export const go = (uow) => (<Loose>uow).run(work);\n`), ["X2"]);
});

test("X2 — the honest call sites are not refused", () => {
  assert.deepEqual(rulesFired(SOURCE, `export const go = (d) => d.unitOfWork.run(work);\n`), []);
  assert.deepEqual(rulesFired(SOURCE, `export const go = (d) => runResult(d.unitOfWork, work);\n`), []);
  // A cast somewhere else in the same call is not a cast of the RECEIVER.
  assert.deepEqual(rulesFired(SOURCE, `export const go = (d) => d.unitOfWork.run(work as Work);\n`), []);
  // `.run(` on something that is not a unit of work at all.
  assert.deepEqual(rulesFired(SOURCE, `export const go = (s) => (s as Sandbox).runTask(work);\n`), []);
});

test("X2 — a comment describing the cast is prose, not a cast", () => {
  // The port's own header explains the escape it forbids, in the sentence that
  // forbids it. A regex gate would fail on the documentation of its own rule.
  assert.deepEqual(
    rulesFired(SOURCE, `// Never write (unitOfWork as Loose).run(work) — use runResult.\nexport const go = (d) => runResult(d.unitOfWork, work);\n`),
    [],
  );
});

// ---------------------------------------------------------------------------
// The live tree.
// ---------------------------------------------------------------------------

test("the committed tree passes both rules", () => {
  const result = checkTransactionOutcome();
  assert.deepEqual(result.violations, []);
  assert.equal(result.probeCount, PROBES.length);
  assert.equal(RULES.length, 2);
});

test("the cast scan is not vacuous", () => {
  // A SCAN THAT FOUND NOTHING TO SCAN IS NOT A PASS. A renamed root or a broken
  // walk would otherwise report "ok: 0 violations" for ever.
  const { fileCount } = checkCasts();
  assert.ok(fileCount > 1000, `cast scan reached only ${fileCount} file(s); the V1 roots hold far more`);
});

test("the one escape lives in exactly one file, and it is the port's own", () => {
  // `runResult` cannot discharge the constraint on a bare type parameter, so the
  // kernel holds an `UnconstrainedUnitOfWork` view for its own single call. The
  // gate skips exactly that path; if the skip were widened, this is what says so.
  assert.equal(PORT_PATH, "packages/kernel/src/ports/unit-of-work.ts");
  const { violations } = checkCasts();
  assert.deepEqual(violations, []);
});
