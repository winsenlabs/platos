import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { normalizeRepositoryPath } from "./identity.mjs";
import {
  LEDGER_DISPOSITIONS,
  formatLedgerReport,
  parseLedger,
  readLedger,
  verifyLedger,
} from "./ledger.mjs";

// -----------------------------------------------------------------------------
// The fixture is the REAL ledger. It is produced by the canonical generator
// (scripts/v1-ledger.mjs) run over this repository -- never a hand-authored
// schema. Every assertion below is against that output.
// -----------------------------------------------------------------------------

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ledgerScript = fileURLToPath(new URL("../v1-ledger.mjs", import.meta.url));
const outPath = join(mkdtempSync(join("/var/tmp", "platos-ledger-consumer-")), "real-ledger.json");

// `--out` writes the artifact BEFORE the check-mode drift comparison sets a
// non-zero exit, so an out-of-date committed fingerprint still yields a complete
// artifact. Tolerate that exit; assert the artifact exists instead.
try {
  execFileSync("node", [ledgerScript, `--out=${outPath}`], { cwd: repositoryRoot, stdio: "ignore" });
} catch {
  // drift (STALE fingerprint) sets exitCode 1 but the --out artifact is written
}
assert.ok(existsSync(outPath), "the generator must have written the real ledger artifact");

const { ledger, errors } = readLedger(outPath);
// Tracked paths are the ledger's own rows: the generator asserts one row per
// tracked file, so this is the faithful tracked set, not an invented one.
const trackedPaths = new Set(ledger.rows.map((row) => normalizeRepositoryPath(row.path)));
const rowsByDisposition = (disposition) => ledger.rows.filter((row) => row.disposition === disposition);
const firstRow = (disposition) => rowsByDisposition(disposition)[0];

test("the consumer reads the REAL container shape (rows, not entries)", () => {
  assert.deepEqual(errors, [], "a complete real ledger parses without error");
  assert.equal(ledger.version, 1);
  assert.equal(ledger.complete, true);
  assert.ok(Array.isArray(ledger.rows) && ledger.rows.length > 0);
  assert.ok(ledger.summary && typeof ledger.summary.classificationSha256 === "string");
  // The speculative container never existed here.
  assert.equal(ledger.entries, undefined, "the real artifact carries rows, never entries");
  // And no row carries a `target`; a move destination is not in the ledger.
  for (const row of ledger.rows) {
    assert.ok(!("target" in row), `real rows carry no target field (${row.path})`);
  }
});

test("the accepted vocabulary is the generator's, and the invented 'keep' is gone", () => {
  assert.deepEqual(LEDGER_DISPOSITIONS, [
    "retain",
    "move-refactor",
    "regenerate",
    "archive",
    "delete",
    "unresolved",
  ]);
  assert.ok(!LEDGER_DISPOSITIONS.includes("keep"), "'keep' was invented; the real word is 'retain'");
  for (const row of ledger.rows) {
    assert.ok(LEDGER_DISPOSITIONS.includes(row.disposition), `${row.path}: ${row.disposition}`);
  }
});

test("retain and regenerate rows are corroborated by presence in the tracked tree", () => {
  const verdict = verifyLedger({ ledger, moves: [], trackedPaths });
  const verifiedPaths = new Set(verdict.verified.map((record) => record.path));
  for (const row of [...rowsByDisposition("retain"), ...rowsByDisposition("regenerate")]) {
    assert.ok(
      verifiedPaths.has(normalizeRepositoryPath(row.path)),
      `${row.disposition} ${row.path} should verify by presence`
    );
  }
});

test("FAIL CLOSED: every declared move-refactor is flagged when no move corroborates it", () => {
  // The real ledger declares 1000+ move-refactors as future intent; the tree has
  // performed none of them. With no corroborating move, not one may be reported
  // as verified -- the move target is unavailable.
  const moveRows = rowsByDisposition("move-refactor");
  assert.ok(moveRows.length > 0, "the real ledger must contain move-refactor rows to exercise this");

  const verdict = verifyLedger({ ledger, moves: [], trackedPaths });
  const verifiedPaths = new Set(verdict.verified.map((record) => record.path));
  const flaggedByPath = new Map(verdict.flagged.map((record) => [record.path, record]));

  for (const row of moveRows) {
    const path = normalizeRepositoryPath(row.path);
    assert.ok(!verifiedPaths.has(path), `move-refactor ${path} must never verify without a move`);
    const flag = flaggedByPath.get(path);
    assert.ok(flag, `move-refactor ${path} must be flagged`);
    assert.match(flag.reason, /move target is unavailable/u);
  }

  // And the human-readable report must not claim any move-refactor as ok.
  const report = formatLedgerReport(verdict);
  assert.ok(!/evidence-ok\s+move-refactor/u.test(report), "no flagged move may be reported as evidence-ok");
});

test("a corroborated move promotes exactly that relocation to verified, target derived from the move", () => {
  const mv = firstRow("move-refactor");
  const derivedTarget = `relocated/${mv.path}`;
  const moves = [
    { from: mv.path, to: derivedTarget, similarity: 100, source: "git-rename", identical: true },
  ];
  const verdict = verifyLedger({ ledger, moves, trackedPaths });

  const verifiedRow = verdict.verified.find((record) => record.path === normalizeRepositoryPath(mv.path));
  assert.ok(verifiedRow, "the corroborated move-refactor row must now verify");
  assert.equal(verifiedRow.disposition, "move-refactor");
  // The destination came from the detected move, not from any ledger field.
  assert.equal(verifiedRow.target, derivedTarget);
  assert.match(verifiedRow.evidence, /git-rename \(pure move\)/u);

  // Every OTHER move-refactor with no move is still flagged: fail-closed holds.
  const otherFlagged = verdict.flagged.filter((record) => record.disposition === "move-refactor");
  assert.equal(otherFlagged.length, rowsByDisposition("move-refactor").length - 1);
});

test("archive is corroborated only by a real relocation, never by the row alone", () => {
  const arc = firstRow("archive");
  assert.ok(arc, "the real ledger must contain an archive row");

  const withoutMove = verifyLedger({ ledger, moves: [], trackedPaths });
  const flag = withoutMove.flagged.find((record) => record.path === normalizeRepositoryPath(arc.path));
  assert.ok(flag, "an archive with no corroborating move is flagged");
  assert.match(flag.reason, /move target is unavailable/u);

  const target = `archive/${arc.path}`;
  const withMove = verifyLedger({
    ledger,
    moves: [{ from: arc.path, to: target, similarity: 100, source: "content-digest", identical: false }],
    trackedPaths,
  });
  const verifiedRow = withMove.verified.find((record) => record.path === normalizeRepositoryPath(arc.path));
  assert.ok(verifiedRow, "an archive corroborated by a move verifies");
  assert.equal(verifiedRow.target, target);
});

test("delete verifies only when unreachable, and a delete that is secretly a move is flagged", () => {
  assert.equal(rowsByDisposition("delete").length, 0, "WIN-254 retains the inherited live corpus");
  const del = {
    ...ledger.rows[0],
    path: "synthetic/delete-candidate.txt",
    disposition: "delete",
    reached_via: ["NONE"],
  };
  const ledgerWithDelete = { ...ledger, rows: [del] };

  const asOrphan = verifyLedger({ ledger: ledgerWithDelete, moves: [], trackedPaths });
  const verifiedRow = asOrphan.verified.find((record) => record.path === normalizeRepositoryPath(del.path));
  assert.ok(verifiedRow, "an unreachable delete candidate is corroborated");
  assert.match(verifiedRow.evidence, /unreachable/u);

  const asMove = verifyLedger({
    ledger: ledgerWithDelete,
    moves: [{ from: del.path, to: `moved/${del.path}`, similarity: 100, source: "git-rename", identical: true }],
    trackedPaths,
  });
  const flag = asMove.flagged.find((record) => record.path === normalizeRepositoryPath(del.path));
  assert.ok(flag, "a delete that is actually a move must be flagged, not passed");
  assert.match(flag.reason, /relocation, not a deletion/u);
});

test("unresolved is never verified", () => {
  const verdict = verifyLedger({ ledger, moves: [], trackedPaths });
  const verifiedPaths = new Set(verdict.verified.map((record) => record.path));
  const flaggedByPath = new Map(verdict.flagged.map((record) => [record.path, record]));
  for (const row of rowsByDisposition("unresolved")) {
    const path = normalizeRepositoryPath(row.path);
    assert.ok(!verifiedPaths.has(path), `unresolved ${path} must never verify`);
    assert.match(flaggedByPath.get(path).reason, /unresolved/u);
  }
});

test("an incomplete generator run is refused wholesale", () => {
  // Reuse the REAL artifact's rows and summary; only flip the completeness bit
  // the generator itself sets when a file is unmatched or unassigned. This is
  // the real schema, not a synthetic one.
  const incomplete = JSON.stringify({ ...ledger, complete: false });
  const parsed = parseLedger(incomplete);
  assert.ok(
    parsed.errors.some((message) => /complete=false/u.test(message)),
    "an incomplete run must be reported as an error"
  );
});
