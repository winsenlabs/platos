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
  // 74 -> 263 -> 328 -> 372 -> 427 -> 478 -> 555 -> 618 -> 666. WIN-256 made
  // packages/kernel and four contexts
  // real, so the ADR M0.3 §6 file-size budget now applies to real production
  // source rather than to placeholders. Every one of the 263 is inside the
  // 400/500-line budget.
  //
  // +65: the same issue makes `providers` real. The budget bit once while it was
  // being written — one test module reached 441 effective lines — and the answer
  // was to split it along the seam the budget was pointing at, into a write-path
  // suite and a read-path suite, rather than to raise the number.
  //
  // +44: the same issue makes `eventing` real. Its 44 files are the budget's own
  // argument: they are a refactor of one 587-line Nest service
  // (apps/agent/src/mcp-platform/events.service.ts) that was already over the
  // 500-line hard error, and no file in the replacement exceeds 200.
  //
  // +55: the same issue makes `skills` real. Every one is inside the budget, and
  // the largest is the in-memory repository double at roughly 330 counted lines
  // — a deliberate consequence of splitting the context into 14 domain modules
  // and 13 named use cases rather than a registry service, which is the shape §6
  // exists to force.
  //
  // +77: the same issue makes `memory` real. The budget bit once again, at 446
  // effective lines, and the answer was the same one — the module was the
  // knowledge-graph suite covering both the write use cases and the read ones,
  // and it split into `knowledge-graph.test.ts` and `graph-queries.test.ts`
  // along exactly the seam the two modules under test already had.
  //
  // +63: the same issue makes `cost-monitoring` real. The budget bit once
  // again, at 412 effective lines in the alerting suite, and the answer was
  // again to split along the seam it pointed at — recording a crossing is one
  // durable decision and sending one is another, and they were only in one file
  // because they were written in one sitting.
  //
  // +51: the same issue makes `jobs` real. Its production source is split across
  // `execute-job.ts`, `register-job.ts` and the two approval use cases rather
  // than reproducing the 571-line `job-execution.service.ts` it replaces, which
  // is the §6 corollary about named sub-use-case files doing its job.
  //
  // +48: the same issue makes `privacy` real (ADR M0.3 §1 row 18). The erasure
  // orchestration is split into named use-case modules rather than one service,
  // and NONE of its 48 files reaches the 400-line warning band — measured over
  // the integrated tree, not carried from the branch, which is why the warning
  // list below is unchanged at three files.
  //
  // Each branch pinned only the axis it could see: eventing pinned 307
  // (263 + 44), skills pinned 318 (263 + 55), and each pinned 372 and 383
  // respectively once rebased onto the providers tip; jobs pinned 379
  // (328 + 51) on v1, memory pinned 405 (328 + 77) and cost-monitoring pinned
  // 391 (328 + 63) and privacy pinned 376 (328 + 48). The axes are disjoint, so
  // the integrated census is their SUM and not any branch pin:
  // 328 + 44 + 55 + 51 + 77 + 63 + 48 = 666.
  //
  // THREE FILES ARE IN THE WARNING BAND, and this comment says so rather than
  // repeating the sentence that was true before `jobs` and `memory` landed:
  //
  //   packages/contexts/jobs/application/approval-lifecycle.test.ts   465
  //   packages/contexts/memory/application/authorization.test.ts      448
  //   packages/contexts/memory/contracts/index.test.ts                404
  //
  // All three are TEST modules, all three are below the 500-line hard error,
  // and the gate reports them as warnings by design. The assertions below pin
  // what the gate ENFORCES — zero errors — and deliberately do not pin zero
  // warnings, because the warning band exists to be visible rather than empty.
  // The jobs branch's own note claimed its largest file was "well inside the
  // 400-line warn threshold", and the memory and cost-monitoring branches each
  // said "none is inside the warning band"; running the audit over the
  // integrated tree shows none of those sentences was true of the tree it
  // describes, so all three claims are corrected here rather than carried.
  // cost-monitoring itself adds no file to this list — its own 412-line
  // alerting suite was split before adoption — but its blanket sentence was
  // still a claim about the whole census. The privacy branch said "every one of
  // the 328 is inside the budget and none is inside the 400-line warning band",
  // which was already false of the tree it was rebased onto; it is corrected
  // here rather than carried, and privacy itself adds no file to the list.
  assert.equal(result.fileCount, 666);
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
