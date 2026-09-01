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
  // 74 -> 263. WIN-256 made packages/kernel and four contexts real, so the ADR
  // M0.3 §6 file-size budget now applies to real production source rather than
  // to placeholders. Every one of the 263 is inside the 400/500-line budget.
  assert.equal(result.fileCount, 263);
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
