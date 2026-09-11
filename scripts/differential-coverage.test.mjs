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
  reconcileScanRoots,
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
  // WIN-267 R1: 300 -> 308. The REST census is the operation manifest's own
  // total, and the manifest now walks TWO scan roots — R1 landed the first eight
  // routes under `apps/core-api/src/transports`. Every one of the eight is
  // UNCOVERED by the differential harness and says so with an owning issue,
  // which is the honest state: the harness twin-runs stores, and a REST surface
  // that has just been born has no second implementation to be run against.
  // WIN-272 (M4.6): 308 -> 309, the stream lane's one route. It is UNCOVERED by
  // the differential harness and says so with an owning issue, for the reason all
  // eight before it are: the harness twin-runs STORES, and a stream lane whose
  // journal is a Redis log has no second implementation to be run against.
  // M4 FINISH: 309 -> 310, the chat-stream POST. The AGENT root's own count moves
  // for the first time — 300 -> 301 — because a user message cannot travel in a
  // request line and the only streaming handler read it from a query parameter.
  // It is UNCOVERED by the differential harness for the reason the nine before it
  // are: the harness twin-runs STORES, and this route runs a turn.
  // WIN-268 (M4.2) 310 -> 313: the tier-2 MCP policy surface's three routes. Every
  // one is UNCOVERED by the differential harness, and the reason is the same one the
  // ten before them give rather than an omission — the harness twin-runs STORES
  // against the oracle, and these three routes have no oracle counterpart to twin
  // against: the code they replace answered no route at all. A denominator that grew
  // and a numerator that did not is the honest record of that.
  assert.equal(summary.bySurface.rest.total, 313, "WIN-247 counted 300 REST operations; WIN-267 R1 adds 8, WIN-272 one more, M4 finish one more, WIN-268 M4.2 three more");
  assert.equal(summary.bySurface.mcp.total, 202, "WIN-247 counted 202 MCP tools");
  // WIN-267 G1: 93 -> 94. `EvalRun` is the canonical row `governance`'s
  // `EvalRunQueue` port enqueues into — ADR M0.3 §1 row 14's "eval runs enqueue
  // as durable jobs", which the legacy tree had no table for at all. The store
  // census is the model count in `internal-packages/tenancy-database`, so it
  // moves with the schema and this assertion is what makes that visible.
  assert.equal(summary.bySurface.store.total, 94, "WIN-247 counted 93 tenancy models; WIN-267 G1 adds EvalRun");
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
  // WIN-268 (M4.2) P1 — THE COMPARISON IS AGAINST THE UNIQUE COUNT, and the
  // subtraction is stated rather than folded away. The census counts route
  // BINDINGS because a decorator is a binding and a decorator is what it can
  // corroborate from source; the matrix enumerates unique method/path
  // OPERATIONS. They were the same number until the two MCP token mints became
  // the first operations served by BOTH deployables.
  assert.equal(reconciliation.enumeratedRestCells, reconciliation.independentUniqueOperations);
  assert.equal(
    reconciliation.independentUniqueOperations,
    reconciliation.independentManifestOps - reconciliation.independentCrossRootBindings,
  );
  assert.equal(
    reconciliation.enumeratedOperatorCells,
    reconciliation.independentUniqueOperatorOperations,
  );
  // NOT VACUOUS: the surplus is real on this tree, so the subtraction above is
  // exercised rather than being a subtraction of zero.
  assert.ok(
    reconciliation.independentCrossRootBindings > 0,
    "expected at least one operation served by both deployables",
  );
  assert.ok(reconciliation.independentUniqueRoutes > 0 && reconciliation.controllers > 0);
});

test("MUTATION: a REST denominator the independent census disagrees with is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => {
      census.totals.manifestOps -= 1;
      census.table[0].manifestOps -= 1;
      census.totals.independentUniqueRoutes -= 1;
      // WIN-268 P1 — tampered CONSISTENTLY, so this mutation still reaches the
      // denominator comparison rather than being stopped one check earlier by
      // the cross-root identity. The identity has its own control below.
      census.totals.uniqueOperations -= 1;
    }),
  );
  assert.ok(
    failures.some((failure) => failure.includes("two enumerations of one surface disagree")),
    JSON.stringify(failures),
  );
});

test("MUTATION: a census whose own cross-root identity does not hold is refused", () => {
  // WIN-268 (M4.2) P1. The surplus is what lets bindings and operations differ,
  // so a census that publishes a surplus its own two totals do not support is
  // publishing an arbitrary denominator. Without this control the subtraction
  // added for the cross-deployable mints would be an unchecked escape hatch:
  // any disagreement could be absorbed by inflating `crossRootBindings`.
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => {
      census.totals.crossRootBindings += 3;
    }),
  );
  assert.ok(
    failures.some((failure) => failure.includes("cross-root identity")),
    JSON.stringify(failures),
  );
});

test("MUTATION: an operator-protected count the independent census disagrees with is refused", () => {
  const { failures } = reconcileRestCensus(
    enumerateCells(),
    tamperedCensus((census) => {
      census.totals.manifestOperator += 1;
      census.table[0].manifestOperator += 1;
      census.totals.uniqueOperatorOperations += 1;
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

// ── WIN-267 (M4.1): the denominator, reconciled PER SCAN ROOT ───────────────
// One agreed total hides a disagreement about WHICH TREES were counted. These
// cases mutate the split rather than the total: the same 300, attributed
// differently, or attributed to a root only one mechanism has heard of.

const capabilityStub = (roots, total) => ({
  totals: { restOperations: total },
  scanRoots: { roots },
});
const censusStub = (roots) => ({ totals: { scanRoots: roots } });

test("MUTATION: a scan root only one mechanism declares is refused", () => {
  const { failures } = reconcileScanRoots(
    capabilityStub([{ id: "agent", dir: "apps/agent/src", operations: 300 }], 300),
    censusStub([
      { id: "agent", dir: "apps/agent/src", manifestOperations: 300, sourceControllers: 27, sourceDecorators: 281, ok: true },
      { id: "core-api-transports", dir: "apps/core-api/src/transports", manifestOperations: 0, sourceControllers: 0, sourceDecorators: 0, ok: true },
    ]),
  );
  assert.ok(
    failures.some((f) => f.includes("core-api-transports") && f.includes("not looking at the same set of trees")),
    failures.join("\n"),
  );
});

test("MUTATION: the same total split differently between roots is refused", () => {
  // 300 either way. Only the per-root split shows that one mechanism has moved
  // four operations into a tree the other says is empty.
  const { failures } = reconcileScanRoots(
    capabilityStub(
      [
        { id: "agent", dir: "apps/agent/src", operations: 296 },
        { id: "core-api-transports", dir: "apps/core-api/src/transports", operations: 4 },
      ],
      300,
    ),
    censusStub([
      { id: "agent", dir: "apps/agent/src", manifestOperations: 300, sourceControllers: 27, sourceDecorators: 281, ok: true },
      { id: "core-api-transports", dir: "apps/core-api/src/transports", manifestOperations: 0, sourceControllers: 0, sourceDecorators: 0, ok: true },
    ]),
  );
  assert.equal(failures.length, 2, failures.join("\n"));
  for (const id of ["agent", "core-api-transports"]) {
    assert.ok(failures.some((f) => f.includes(id) && f.includes("per-root denominator")), failures.join("\n"));
  }
});

test("MUTATION: a root that failed its own source reconciliation cannot corroborate the denominator", () => {
  const { failures } = reconcileScanRoots(
    capabilityStub([{ id: "agent", dir: "apps/agent/src", operations: 300 }], 300),
    censusStub([{ id: "agent", dir: "apps/agent/src", manifestOperations: 300, sourceControllers: 27, sourceDecorators: 281, ok: false }]),
  );
  assert.ok(failures.some((f) => f.includes("failed its own source-to-manifest reconciliation")), failures.join("\n"));
});

test("MUTATION: per-root counts that do not sum to the published total are refused", () => {
  const { failures } = reconcileScanRoots(
    capabilityStub([{ id: "agent", dir: "apps/agent/src", operations: 299 }], 300),
    censusStub([{ id: "agent", dir: "apps/agent/src", manifestOperations: 299, sourceControllers: 27, sourceDecorators: 281, ok: true }]),
  );
  assert.ok(failures.some((f) => f.includes("sum to 299")), failures.join("\n"));
});

test("MUTATION: a census that publishes no split is refused, not skipped", () => {
  const { failures, scanRoots } = reconcileScanRoots(capabilityStub([], 0), { totals: {} });
  assert.equal(scanRoots, null);
  assert.ok(failures.some((f) => f.includes("independent census publishes no totals.scanRoots")), failures.join("\n"));
});

test("BASELINE: the committed matrix agrees root by root, and BOTH roots now carry routes", async () => {
  const { document } = await buildDocument();
  const rows = document.restScanRoots.rows;
  assert.deepEqual(rows.map((r) => r.id), ["agent", "core-api-transports"]);
  for (const row of rows) assert.equal(row.agrees, true, `${row.id} does not agree`);
  const core = rows.find((r) => r.id === "core-api-transports");
  // 0 -> 8 (WIN-267 R1). The root was declared while empty so the first route to
  // land would be counted rather than discovered later; this is that landing, and
  // BOTH enumerators moved to the same number on their own — the generator's AST
  // walk and the independent census's glob. Their agreement is `row.agrees`
  // above, and it is the whole reason two mechanisms exist.
  //
  // WIN-268 (M4.2) P1 8 -> 10: the two MCP one-time-secret token mints.
  // WIN-272 (M4.6) 10 -> 11: the stream lane's one route.
  // WIN-268 (M4.2) 11 -> 14: the tier-2 policy surface's three, and this is the first
  // entry here where ONE controller carries THREE decorators. Both enumerators moved
  // to 14 on their own again — the generator's AST walk and the independent census's
  // glob — and `row.agrees` above is what says so.
  // WIN-268 (M4.2) THE TOKEN LIFECYCLE 14 -> 18: the four MCP token lifecycle routes,
  // and this is the first entry here where the operation count moves and the
  // CONTROLLER count does not — all four land in the two mint controllers, because
  // the entity/environment pair check is the same check for a listing and a
  // revocation as for a mint. Both enumerators moved to 18 on their own again, and
  // `row.agrees` above is what says so.
  assert.equal(core.enumeratedOperations, 18);
  assert.equal(core.independentOperations, 18);
  // AND THE PER-ROOT SUM CARRIES THE SURPLUS TERM. A root sum counts an
  // operation once per root that serves it, and the two mints are served by
  // both, so the sum exceeds the unique denominator by exactly the surplus the
  // census publishes. Stated as an equality with the term rather than relaxed.
  //
  // WIN-268 (M4.2) THE TOKEN LIFECYCLE moves the surplus 2 -> 6 and the UNIQUE
  // denominator NOT AT ALL, which is the clearest demonstration this file has that
  // the term was the right shape. The four token lifecycle routes were already
  // served by `apps/agent` — that is precisely why they sat in the generated
  // manifest with an implementation and no V1 handler — so each gained a SECOND
  // implementation and no new operation entered the surface. A tolerance would have
  // absorbed this silently; an equality with a published term reports it.
  assert.equal(
    document.restScanRoots.total - document.reconciledAgainst.independentCrossRootBindings,
    document.reconciledAgainst.enumeratedRestCells,
  );
  assert.equal(document.reconciledAgainst.independentCrossRootBindings, 6);
});
