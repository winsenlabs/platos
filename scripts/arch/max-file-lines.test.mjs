import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ERROR_THRESHOLD,
  SELECTORS,
  WARNING_THRESHOLD,
  auditMaxFileLines,
  effectiveLineCount,
} from "./max-file-lines.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = [];

after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function fixture(path, source) {
  const root = mkdtempSync(join(tmpdir(), "platos-max-lines-"));
  fixtures.push(root);
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
  return root;
}

function codeLines(count) {
  return Array.from({ length: count }, (_unused, index) => `export type Line${index} = ${index};`).join("\n");
}

test("selectors and thresholds are the exact accepted WIN-251 max-file-lines slice", () => {
  assert.deepEqual(SELECTORS, ["packages/contexts/**", "apps/core-api/src/transports/**"]);
  assert.equal(WARNING_THRESHOLD, 400);
  assert.equal(ERROR_THRESHOLD, 500);
});

test("effective lines exclude blank and comment-only lines without stripping comment markers in strings", () => {
  const source = [
    "",
    "// comment",
    "/* block",
    " * comment",
    " */",
    "export const url = 'https://example.test/path'; // trailing comment",
    "export const marker = '/* not a comment */';",
    "/* before */ export const value = 1;",
    "",
  ].join("\n");
  assert.equal(effectiveLineCount(source), 3);
});

test("400 effective lines pass, 401 warn, 500 warn, and 501 hard-fail", () => {
  for (const [count, severity] of [[400, null], [401, "warning"], [500, "warning"], [501, "error"]]) {
    const root = fixture("packages/contexts/tools/application/threshold.ts", codeLines(count));
    const result = auditMaxFileLines(root, { selectors: ["packages/contexts/**"] });
    assert.equal(result.fileCount, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(result.findings[0]?.severity ?? null, severity, `effective line count ${count}`);
    assert.equal(result.findings[0]?.effectiveLines ?? count, count);
  }
});

test("comment and blank padding cannot mutate a 400-line file into a warning", () => {
  const padded = `${codeLines(400)}\n${Array.from({ length: 150 }, () => "// padding").join("\n")}\n\n`;
  const root = fixture("apps/core-api/src/transports/rest/padded.ts", padded);
  const result = auditMaxFileLines(root);
  assert.equal(result.fileCount, 1);
  assert.deepEqual(result.findings, []);
});

test("the live selectors scan an exact nonzero source census", () => {
  const result = auditMaxFileLines(repositoryRoot);
  // 74 -> 263 -> 328 -> 395. WIN-256 made packages/kernel and four contexts
  // real, so the ADR M0.3 §6 file-size budget now applies to real production
  // source rather than to placeholders. Every one of the 263 is inside the
  // 400/500-line budget.
  //
  // +65: the same issue makes `providers` real. The budget bit once while it was
  // being written — one test module reached 441 effective lines — and the answer
  // was to split it along the seam the budget was pointing at, into a write-path
  // suite and a read-path suite, rather than to raise the number. Every one of
  // the 328 is inside the budget and none is inside the 400-line warning band.
  //
  // +67: the same issue makes `agents` real. The budget bit TWICE here, in the
  // 400-line WARNING band rather than at the 500-line wall, and both were split
  // rather than waived:
  //
  //   contracts/index.ts, 450 effective. The read models moved to
  //   `contracts/views.ts` and are re-exported, so the published surface is
  //   still one entrypoint and the barrel is the driving port alone.
  //
  //   application/agent-lifecycle.test.ts, 407 effective. Split into a write
  //   suite and a read suite along the seam the budget was pointing at: what a
  //   write PUT IN THE STORE, and what a caller can SEE.
  //
  // Two of the 67 files exist only because of those splits. Every one of the 395
  // is inside the budget and none is inside the warning band.
  //
  // +83: the same issue makes `governance` real. The layout was designed for the
  // ceiling up front — the extraction source's `eval.service.ts` is 678 lines
  // and lands here as `run-judge.ts`, `read-evals.ts` and four domain modules —
  // so the production tree never approached the budget. It bit ONCE, in the
  // 400-line WARNING band rather than at the 500-line wall, and in a test
  // double:
  //
  //   application/testing/in-memory-eval-stores.ts, 401 effective. It held three
  //   repositories, and the third had no reason to be there: a criterion and an
  //   eval are coupled by `AgentEval.criterion @relation(onDelete: Cascade)`,
  //   which the double now models, and a golden set is coupled to neither. Split
  //   into `in-memory-eval-stores.ts` and
  //   `in-memory-golden-sets-repository.ts` along that seam rather than waived.
  //
  // One of the 83 files exists only because of that split. Every one of the 478
  // is inside the budget and none is inside the warning band.
  //
  // Written out so a DELETION CANNOT HIDE INSIDE AN ADDITION: 74 -> 263 -> 328
  // -> 395 -> 478, which is 263 + 65 + 67 + 83. Adoption replaces a context's
  // four placeholders in place and adds the rest, so this number only ever
  // grows and a fall in it is always a finding.
  assert.equal(result.fileCount, 478);
  assert.equal(result.fileCount, 263 + 65 + 67 + 83);
  assert.deepEqual(result.errors, []);
  assert.equal(result.findings.filter((finding) => finding.severity === "error").length, 0);
});

test("selector drift to missing roots fails non-vacuity independently", () => {
  const result = auditMaxFileLines(repositoryRoot, { selectors: ["packages/not-a-context/**"] });
  assert.equal(result.fileCount, 0);
  assert.ok(result.errors.some((error) => error === "selector matched zero source files: packages/not-a-context/**"));
});

test("one valid selector cannot hide a second selector that matches nothing", () => {
  const result = auditMaxFileLines(repositoryRoot, {
    selectors: ["packages/contexts/**", "apps/core-api/src/not-a-transport/**"],
  });
  assert.ok(result.fileCount > 0);
  assert.deepEqual(result.errors, ["selector matched zero source files: apps/core-api/src/not-a-transport/**"]);
});

test("threshold inversion fails closed", () => {
  const root = fixture("packages/contexts/tools/application/one.ts", "export type One = 1;\n");
  const result = auditMaxFileLines(root, { warningThreshold: 500, errorThreshold: 400 });
  assert.ok(result.errors.some((error) => error.includes("must be lower")));
});
