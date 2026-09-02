// WIN-284 — the coverage matrix must be impossible to inflate.
//
// The interesting assertions are the mutation controls. A matrix that only
// asserts its own current numbers is a matrix that will happily record a
// shrunken denominator the day someone shrinks it.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SURFACE_OWNERS,
  assertMarkdownIsGateSafe,
  buildDocument,
  buildMatrix,
  enumerateCells,
  matrixDigest,
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
