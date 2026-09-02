// WIN-284 — the negative controls, and the controls on the controls.
//
// The first test runs the whole catalogue and requires every seeded divergence
// to be caught. On its own that is not enough evidence: a harness that reported
// divergence for every input would pass it. So the rest of this file proves the
// controls are themselves sensitive — that each one goes red when the thing it
// is watching is removed.

import assert from "node:assert/strict";
import { test } from "node:test";

import { SEEDS, assertSeedCoverage, baselineObservation } from "./seeds.mjs";
import { DIVERGENCE_CODES } from "./comparators.mjs";
import { DIMENSIONS } from "./observation.mjs";
import {
  ORACLE_COMMIT,
  SELF_TEST_SCENARIO,
  formatReport,
  runCleanControl,
  runNegativeControls,
  runSeededControl,
} from "./negative-controls.mjs";
import { createRecordedSubject, createSeededCandidateSubject } from "./subjects/recorded.mjs";
import { twinRun } from "./twin-run.mjs";

test("every seeded divergence is caught, every vacuous run is refused", async () => {
  const report = await runNegativeControls();
  const failed = report.controls.filter((control) => !control.passed);
  assert.deepEqual(failed, [], formatReport(report));
  assert.deepEqual(report.structural, []);
  assert.ok(report.ok);
  assert.equal(report.oracleCommit, ORACLE_COMMIT);
});

test("the catalogue covers every divergence code the comparators can emit", () => {
  assert.deepEqual(assertSeedCoverage(), []);
  const covered = new Set(SEEDS.flatMap((seed) => seed.expectedCodes));
  for (const code of DIVERGENCE_CODES) assert.ok(covered.has(code), `${code} has no seed`);
  for (const dimension of DIMENSIONS) {
    assert.ok(SEEDS.some((seed) => seed.dimension === dimension), `${dimension} has no seed`);
  }
});

test("the clean control passes only because the two sides really are equivalent", async () => {
  const clean = await runCleanControl();
  assert.ok(clean.passed);
  // And it compared something: every dimension carried facts on both sides.
  for (const [dimension, counts] of Object.entries(clean.factCounts)) {
    assert.ok(counts.oracle > 0 && counts.candidate > 0, `${dimension} compared nothing`);
  }
});

// ---------------------------------------------------------------------------
// MUTATION CONTROLS on the controls themselves
// ---------------------------------------------------------------------------

test("MUTATION: a seed goes uncaught when its dimension is not compared", async () => {
  // Proves each seeded control's pass depends on its comparator actually
  // running. If the control still passed with the dimension removed, it would
  // be passing for some unrelated reason and telling us nothing.
  for (const seed of SEEDS) {
    const withoutDimension = {
      ...SELF_TEST_SCENARIO,
      dimensions: SELF_TEST_SCENARIO.dimensions.filter((dimension) => dimension !== seed.dimension),
    };
    const result = await twinRun(withoutDimension, {
      oracle: createRecordedSubject({
        side: "oracle",
        recordings: { [SELF_TEST_SCENARIO.id]: baselineObservation("oracle") },
        provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
      }),
      candidate: createSeededCandidateSubject({
        recordings: { [SELF_TEST_SCENARIO.id]: baselineObservation("candidate") },
        provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
        transform: seed.seed,
        label: seed.id,
      }),
    });
    const codes = (result.divergences ?? []).map((entry) => entry.code);
    for (const code of seed.expectedCodes) {
      assert.ok(
        !codes.includes(code),
        `${seed.id} was still reported as ${code} with the ${seed.dimension} dimension removed; ` +
          "the control is not measuring what it claims to measure",
      );
    }
  }
});

test("MUTATION: assertSeedCoverage rejects a catalogue with an uncovered code", () => {
  const truncated = SEEDS.filter((seed) => seed.dimension !== "store");
  const failures = assertSeedCoverage(truncated);
  assert.ok(failures.some((failure) => failure.includes("has no seed")), JSON.stringify(failures));
  assert.ok(failures.some((failure) => failure.includes("dimension store")));
});

test("MUTATION: assertSeedCoverage rejects a seed with no expected code", () => {
  const failures = assertSeedCoverage([
    { id: "vague", dimension: "status", describes: "claims to change something without saying what", expectedCodes: [] },
  ]);
  assert.ok(failures.some((failure) => failure.includes("declares no expected divergence code")));
});

test("MUTATION: a seeded control fails when the seed is replaced by a no-op", async () => {
  // The final sanity check on the runner: if the "seed" changes nothing, the
  // run is parity and the control must report failure rather than success.
  const inert = { ...SEEDS[0], seed: (observation) => observation };
  const result = await runSeededControl(inert);
  assert.equal(result.passed, false);
  assert.equal(result.verdict, "parity");
});

test("a recorded subject refuses to stand in for the candidate without a stated reason", () => {
  assert.throws(
    () =>
      createRecordedSubject({
        side: "candidate",
        recordings: {},
        provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
      }),
    /is not a twin-run/u,
  );
});

test("a recording without provenance is refused", () => {
  assert.throws(
    () => createRecordedSubject({ side: "oracle", recordings: {}, provenance: { capturedAt: "now" } }),
    /must carry the commit/u,
  );
  assert.throws(
    () => createRecordedSubject({ side: "oracle", recordings: {}, provenance: { commit: ORACLE_COMMIT } }),
    /must carry the moment/u,
  );
});

test("a missing recording raises rather than returning an empty observation", async () => {
  const subject = createRecordedSubject({
    side: "oracle",
    recordings: {},
    provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
  });
  await assert.rejects(() => subject.run({ id: "absent" }), /no recording for scenario/u);
});
