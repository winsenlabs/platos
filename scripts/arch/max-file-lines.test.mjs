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
  // 74 -> 263 -> 328. WIN-256 made packages/kernel and four contexts real, so
  // the ADR M0.3 §6 file-size budget now applies to real production source
  // rather than to placeholders. Every one of the 263 is inside the 400/500-line
  // budget.
  //
  // +65: the same issue makes `providers` real. The budget bit once while it was
  // being written — one test module reached 441 effective lines — and the answer
  // was to split it along the seam the budget was pointing at, into a write-path
  // suite and a read-path suite, rather than to raise the number. Every one of
  // the 328 is inside the budget and none is inside the 400-line warning band.
  //
  // +55: the same issue makes `tools` real. This is the budget's largest single
  // test: the three source files it replaces are 1,644, 845 and 587 lines, and
  // §6 names the first of those as the failure the budget exists to prevent.
  // The 1,644-line executor became a routing rule, a permission rule, a
  // transport resolution and one use case with a single exit — 256 effective
  // lines, the largest non-test module in the package.
  //
  // The budget bit once, exactly as it did for `providers`: one test module
  // reached 400 effective lines, the top of the warning band. The answer was to
  // split it along the seam the budget was pointing at — the entity/inbound
  // policy suite out of the hosted-surface suite — rather than to raise the
  // number. That split is why the delta is 55 and not 54.
  assert.equal(result.fileCount, 383);
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
