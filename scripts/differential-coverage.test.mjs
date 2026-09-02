// WIN-284 — the coverage matrix must be impossible to inflate.
//
// The interesting assertions are the mutation controls. A matrix that only
// asserts its own current numbers is a matrix that will happily record a
// shrunken denominator the day someone shrinks it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

import {
  CENSUS_SOURCES,
  REST_CENSUS_PATH,
  SURFACE_OWNERS,
  assertMarkdownIsGateSafe,
  buildDocument,
  buildMatrix,
  enumerateCells,
  matrixDigest,
  readRestCensus,
  reconcileRestCensus,
  renderMarkdown,
  summarise,
} from "./differential-coverage.mjs";
import {
  SCENARIO_REGISTRY,
  assertRegistryIsWellFormed,
  claimedCapabilities,
} from "../tests/differential-harness/scenarios.mjs";

test("the denominator matches the M0 censuses exactly", () => {
  const summary = summarise(
    buildMatrix(enumerateCells(), SCENARIO_REGISTRY, claimedCapabilities()).rows,
  );
  // Each number is the census's own published total, not a number this test
  // invented. If a census moves, this fails and someone has to look.
  assert.equal(summary.bySurface.rest.total, 300, "WIN-247 counted 300 REST operations");
  assert.equal(summary.bySurface.mcp.total, 202, "WIN-247 counted 202 MCP tools");
  assert.equal(summary.bySurface.store.total, 93, "WIN-247 counted 93 tenancy models");
  assert.equal(summary.bySurface.bff.total, 117, "WIN-294 counted 117 BFF entrypoints");
  assert.equal(summary.cells, Object.values(summary.bySurface).reduce((total, entry) => total + entry.total, 0));
});

test("every cell carries a status, and every uncovered cell names who covers it", async () => {
  const { document, failures } = await buildDocument();
  assert.deepEqual(failures, []);
  for (const row of document.rows) {
    assert.ok(["covered", "uncovered"].includes(row.status), `${row.id} has no status`);
    if (row.status === "uncovered") {
      assert.match(row.blockedBy ?? "", /^WIN-\d+$/u, `${row.id} is uncovered with no owning issue`);
      assert.ok(row.reason && row.reason.length > 20, `${row.id} is uncovered with no stated reason`);
    } else {
      assert.ok(row.scenarios.length > 0, `${row.id} is covered by no scenario`);
    }
  }
});

test("coverage is computed from the scenario registry, never asserted in the matrix", async () => {
  const { document } = await buildDocument();
  const covered = document.rows.filter((row) => row.status === "covered").map((row) => row.id).sort();
  assert.deepEqual(covered, claimedCapabilities());
});

// ---------------------------------------------------------------------------
// MUTATION CONTROLS
// ---------------------------------------------------------------------------

test("MUTATION: a claim naming a capability no census contains is a hard error", () => {
  const { errors } = buildMatrix(enumerateCells(), [
    { id: "invented", subject: "postgres-twin", dimensions: ["store"], capabilities: ["store:NotAModel"] },
  ], ["store:NotAModel"]);
  assert.ok(
    errors.some((error) => error.includes("cannot invent a capability")),
    JSON.stringify(errors),
  );
});

test("MUTATION: dropping a cell moves the digest, so the denominator cannot shrink quietly", () => {
  const cells = enumerateCells();
  const full = matrixDigest(buildMatrix(cells, SCENARIO_REGISTRY, claimedCapabilities()).rows);
  const shrunk = matrixDigest(
    buildMatrix(cells.slice(1), SCENARIO_REGISTRY, claimedCapabilities()).rows,
  );
  assert.notEqual(full, shrunk);
});

test("MUTATION: flipping a cell to covered moves the digest", () => {
  const cells = enumerateCells();
  const before = matrixDigest(buildMatrix(cells, SCENARIO_REGISTRY, claimedCapabilities()).rows);
  const after = matrixDigest(
    buildMatrix(cells, [...SCENARIO_REGISTRY, {
      id: "extra",
      subject: "postgres-twin",
      dimensions: ["store"],
      capabilities: ["store:Thread"],
    }], [...claimedCapabilities(), "store:Thread"]).rows,
  );
  assert.notEqual(before, after);
});

test("MUTATION: a registry entry claiming nothing is rejected", () => {
  const failures = assertRegistryIsWellFormed([
    { id: "claims-nothing", subject: "postgres-twin", dimensions: ["store"], capabilities: [] },
  ]);
  assert.ok(failures.some((failure) => failure.includes("claims no capability")));
});

test("MUTATION: a registry entry with no dimensions or no subject is rejected", () => {
  const failures = assertRegistryIsWellFormed([{ id: "hollow", capabilities: ["store:Thread"] }]);
  assert.ok(failures.some((failure) => failure.includes("declares no dimensions")));
  assert.ok(failures.some((failure) => failure.includes("does not name the subject")));
});

// Assembled at run time rather than written as a literal, so this file does not
// itself carry the reserved term it is testing for. Same idiom, and the same
// reason, as scripts/vocabulary-boundary.nul.test.mjs line 27.
const RESERVED_TERM = ["t", "r", "i", "g", "g", "e", "r"].join("");

test("MUTATION: a summary that enumerates a reserved-vocabulary capability id is refused", () => {
  // Eighteen MCP tool ids name the external orchestration integration and carry
  // reserved terms. The Markdown must aggregate rather than enumerate; this
  // proves the guard notices when it stops doing so.
  assert.throws(
    () => assertMarkdownIsGateSafe(`| \`mcp:${RESERVED_TERM}.runs.list\` | some-scenario |`),
    /reserved vocabulary/u,
  );
});

test("the committed summary is gate-safe as rendered", async () => {
  const { document } = await buildDocument();
  assert.doesNotThrow(() => assertMarkdownIsGateSafe(renderMarkdown(document)));
});

test("every enumerated surface has an owning issue", () => {
  const surfaces = new Set(enumerateCells().map((entry) => entry.surface));
  for (const surface of surfaces) {
    assert.ok(SURFACE_OWNERS[surface], `${surface} has no owning issue`);
    assert.match(SURFACE_OWNERS[surface].issue, /^WIN-\d+$/u);
  }
});

test("capability cell ids are unique", () => {
  const ids = enumerateCells().map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// The fourth census is READ, and these controls prove it
// ---------------------------------------------------------------------------
//
// The gate previously declared four censuses as provenance and enumerated from
// three. The independent REST census could be edited arbitrarily and `--check`
// stayed green at exit 0, which made "generated from 4 M0 censuses" a claim the
// code did not support. It is now reconciled against, and every control below
// is a tamper that must turn the gate red.

function tamperedCensus(edit) {
  const census = JSON.parse(JSON.stringify(readRestCensus()));
  edit(census);
  return census;
}

test("the independent REST census is declared as a source and is actually read", () => {
  assert.ok(CENSUS_SOURCES.includes(REST_CENSUS_PATH));
  const { failures, reconciliation } = reconcileRestCensus(enumerateCells(), readRestCensus());
  assert.deepEqual(failures, []);
  assert.equal(reconciliation.agrees, true);
  // The committed census really does corroborate the enumerated denominator,
  // rather than the check passing because both sides read the same file.
  assert.equal(reconciliation.enumeratedRestCells, reconciliation.independentManifestOps);
  assert.equal(reconciliation.enumeratedOperatorCells, reconciliation.independentManifestOperator);
  assert.ok(reconciliation.independentUniqueRoutes > 0 && reconciliation.controllers > 0);
});

test("MUTATION: a REST denominator the independent census disagrees with is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => {
      census.totals.manifestOps -= 1;
      census.table[0].manifestOps -= 1;
      census.totals.independentUniqueRoutes -= 1;
    }),
  );
  assert.ok(
    failures.some((failure) => failure.includes("two enumerations of one surface disagree")),
    JSON.stringify(failures),
  );
});

test("MUTATION: an operator-protected count the independent census disagrees with is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => {
      census.totals.manifestOperator += 1;
      census.table[0].manifestOperator += 1;
    }),
  );
  assert.ok(
    failures.some((failure) => failure.includes("operator-protected sub-denominator is not established")),
    JSON.stringify(failures),
  );
});

test("MUTATION: a census that failed its own reconciliation cannot corroborate anything", () => {
  const failed = reconcileRestCensus(enumerateCells(), tamperedCensus((census) => { census.ok = false; })).failures;
  assert.ok(failed.some((failure) => failure.includes("a failed census cannot corroborate")), JSON.stringify(failed));

  const withFailures = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => { census.failures = ["a controller is missing from the manifest"]; }),
  ).failures;
  assert.ok(withFailures.some((failure) => failure.includes("unresolved failures")), JSON.stringify(withFailures));

  const misreconciled = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => { census.table[0].routeOk = false; }),
  ).failures;
  assert.ok(
    misreconciled.some((failure) => failure.includes("own route/operator reconciliation did not hold")),
    JSON.stringify(misreconciled),
  );
});

test("MUTATION: a census whose totals stop matching its own table is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => { census.table[0].manifestOps += 1; }),
  );
  assert.ok(
    failures.some((failure) => failure.includes("per-controller table sums to")),
    JSON.stringify(failures),
  );
});

test("MUTATION: a census that no longer satisfies its own route identity is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => { census.totals.dualMountAliasOps += 1; }),
  );
  assert.ok(
    failures.some((failure) => failure.includes("no longer satisfies its own identity")),
    JSON.stringify(failures),
  );
});

test("MUTATION: an operator floor above the manifest operator count is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => { census.totals.independentOperatorFloor = census.totals.manifestOperator + 1; }),
  );
  assert.ok(failures.some((failure) => failure.includes("operator floor")), JSON.stringify(failures));
});

test("MUTATION: a census stripped of the fields this gate reads is refused, not skipped", () => {
  // The quiet failure mode: a source that stops carrying what the reader needs
  // and is silently treated as having nothing to say.
  const { failures, reconciliation } = reconcileRestCensus(enumerateCells(), { ok: true, failures: [] });
  assert.equal(reconciliation, null);
  assert.ok(
    failures.some((failure) => failure.includes("cannot be declared a source of the REST denominator")),
    JSON.stringify(failures),
  );
});

test("MUTATION: a census this gate cannot read fails with the stated reason, not a stack trace", () => {
  // `main` reports failures before rendering, so a document whose
  // reconciliation could not be computed produces the sentence that explains
  // why rather than a TypeError from the renderer. Exercised through the CLI
  // because the ordering inside `main` is the thing under test.
  const censusPath = join(repositoryRoot, REST_CENSUS_PATH);
  const original = readFileSync(censusPath, "utf8");
  try {
    writeFileSync(censusPath, `${JSON.stringify({ ok: true, failures: [] }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [join(repositoryRoot, "scripts/differential-coverage.mjs"), "--check"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /cannot be declared a source of the REST denominator/u);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /TypeError/u);
  } finally {
    writeFileSync(censusPath, original);
  }
});

test("the committed artifact states which sources enumerate and which reconciles", async () => {
  const { document } = await buildDocument();
  assert.deepEqual([...document.sources].sort(), [...CENSUS_SOURCES].sort());
  assert.ok(!document.enumeratedFrom.includes(REST_CENSUS_PATH));
  assert.equal(document.enumeratedFrom.length, CENSUS_SOURCES.length - 1);
  assert.equal(document.reconciledAgainst.source, REST_CENSUS_PATH);
  assert.equal(document.reconciledAgainst.agrees, true);
});
