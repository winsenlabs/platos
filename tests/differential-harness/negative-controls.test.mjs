// WIN-284 — the negative controls, and the controls on the controls.
//
// The first test runs the whole catalogue and requires every seeded divergence
// to be caught. On its own that is not enough evidence: a harness that reported
// divergence for every input would pass it. So the rest of this file proves the
// controls are themselves sensitive — that each one goes red when the thing it
// is watching is removed.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SEEDS,
  assertSeedCoverage,
  baselineObservation,
  catalogueCompletenessFailures,
  catalogueIrreducibilityFailures,
  seedSignature,
} from "./seeds.mjs";
import {
  COMPARATORS,
  DIVERGENCE_CODES,
  JOINT_DIVERGENCES,
  absorbedCodes,
  assertComparatorCoverage,
  assertJointDivergencesAreWellFormed,
  requiredSeedSignatures,
} from "./comparators.mjs";
import { DIMENSIONS, validateObservation } from "./observation.mjs";
import { dimensionSensitivityFailures, seedsForScenario } from "./postgres-conservation.mjs";
import { CONSERVATION_SCENARIO, TIER_BOUNDARY_SCENARIO } from "./scenarios.mjs";
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

test("every code that CAN be emitted alone has a seed that emits it alone", () => {
  // The isolating requirement, read back from the comparators rather than from
  // the catalogue, so this test cannot pass by agreeing with itself.
  const signatures = new Set(SEEDS.map(seedSignature));
  const absorbed = absorbedCodes();
  for (const code of DIVERGENCE_CODES) {
    if (absorbed.has(code)) continue;
    assert.ok(signatures.has(code), `${code} has no isolating seed`);
  }
  for (const joint of JOINT_DIVERGENCES) {
    assert.ok(signatures.has([...joint.codes].sort().join("+")), `${joint.id} has no seed`);
  }
  // Exactly as many seeds as there are required signatures: no seed exists that
  // the comparators do not require, and no requirement is met twice.
  assert.equal(SEEDS.length, requiredSeedSignatures().size);
  assert.equal(new Set(SEEDS.map(seedSignature)).size, SEEDS.length);
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

test("MUTATION: assertSeedCoverage rejects a TRUNCATED catalogue — deleting any single seed fails", () => {
  // THE CONTROL THAT MAKES THE CLAIM TRUE.
  //
  // The previous rule required each code to be covered by SOME seed, which
  // meant four of the seeds could each be deleted with every gate staying
  // green. "Rejects a truncated catalogue" was therefore a claim the code did
  // not support. It does now, and this is the proof: every one-seed deletion is
  // enumerated and each must produce at least one failure.
  assert.ok(SEEDS.length > 0);
  const survivors = [];
  for (const [index, seed] of SEEDS.entries()) {
    const truncated = SEEDS.filter((_, position) => position !== index);
    const failures = assertSeedCoverage(truncated);
    if (failures.length === 0) survivors.push(seed.id);
    else {
      assert.ok(
        failures.some(
          (failure) =>
            failure.includes("has no isolating seed") ||
            failure.includes("has no seed") ||
            failure.includes("has no seeded divergence"),
        ),
        `deleting ${seed.id} failed for an unrelated reason: ${JSON.stringify(failures)}`,
      );
    }
  }
  assert.deepEqual(
    survivors,
    [],
    `these seeds can be deleted with every gate staying green: ${survivors.join(", ")}`,
  );
});

test("MUTATION: a redundant seed is refused, because it makes its twin deletable", () => {
  const duplicated = [...SEEDS, { ...SEEDS[0], id: "duplicate-of-the-first-seed" }];
  const failures = catalogueIrreducibilityFailures(duplicated);
  assert.equal(failures.length, 2, JSON.stringify(failures));
  assert.ok(failures.every((failure) => failure.includes("can be deleted with the catalogue still complete")));
});

test("MUTATION: every shape rule on a seed can be made to fire", () => {
  // The catalogue rules are only as good as the shape rules underneath them: a
  // seed with a duplicate id, an unknown dimension, an unknown code or a
  // one-word description would otherwise satisfy "complete and irreducible"
  // while being unreadable or wrong. One control per branch, so none of them is
  // a line nobody has watched go red.
  const base = {
    id: "shape-probe",
    dimension: "status",
    describes: "a seed whose prose is long enough to satisfy the description rule, said plainly",
    expectedCodes: ["status-changed"],
  };
  const failuresFor = (seeds) => assertSeedCoverage(seeds);

  assert.ok(
    failuresFor([base, { ...base }]).some((failure) => failure.includes("is declared twice")),
  );
  assert.ok(
    failuresFor([{ ...base, dimension: "telemetry" }]).some((failure) =>
      failure.includes("names unknown dimension telemetry"),
    ),
  );
  assert.ok(
    failuresFor([{ ...base, describes: "too short" }]).some((failure) =>
      failure.includes("must describe the difference it introduces"),
    ),
  );
  assert.ok(
    failuresFor([{ ...base, expectedCodes: ["not-a-real-code"] }]).some((failure) =>
      failure.includes("expects unknown code not-a-real-code"),
    ),
  );
});

test("MUTATION: every shape rule on a joint divergence can be made to fire", () => {
  const wellFormed = {
    id: "probe",
    codes: ["status-changed", "header-added"],
    absorbs: [],
    describes: "a joint entry whose prose is long enough to satisfy the description rule, said plainly",
  };
  const fires = (joints, text) =>
    assert.ok(
      assertJointDivergencesAreWellFormed(joints).some((failure) => failure.includes(text)),
      `${text} never fired: ${JSON.stringify(assertJointDivergencesAreWellFormed(joints))}`,
    );

  assert.deepEqual(assertJointDivergencesAreWellFormed([wellFormed]), []);
  fires([wellFormed, { ...wellFormed, codes: ["status-changed", "event-added"] }], "is declared twice");
  fires([{ ...wellFormed, codes: ["status-changed"] }], "must name at least two codes");
  fires([wellFormed, { ...wellFormed, id: "second" }], "repeats the signature");
  fires([{ ...wellFormed, codes: ["status-changed", "not-a-real-code"] }], "names unknown code not-a-real-code");
  fires([{ ...wellFormed, describes: "short" }], "must say in prose");

  // And the committed declarations pass it.
  assert.deepEqual(assertJointDivergencesAreWellFormed(), []);
  assert.ok(JOINT_DIVERGENCES.length > 0);
});

test("MUTATION: a joint divergence that absorbs a code it does not name is refused", () => {
  const failures = assertJointDivergencesAreWellFormed([
    {
      id: "malformed",
      codes: ["status-changed", "header-added"],
      absorbs: ["auth-scope-added"],
      describes: "a joint entry that claims to absorb a code it never emits, which would silently remove a requirement",
    },
  ]);
  assert.ok(failures.some((failure) => failure.includes("absorbs auth-scope-added, which it does not name")), JSON.stringify(failures));
});

test("MUTATION: a code absorbed by two joint divergences is refused", () => {
  const failures = assertJointDivergencesAreWellFormed([
    {
      id: "first",
      codes: ["schema-type-changed", "schema-value-changed"],
      absorbs: ["schema-type-changed"],
      describes: "the real joint entry, absorbing the code that cannot be emitted on its own by compareSchema",
    },
    {
      id: "second",
      codes: ["schema-type-changed", "header-added"],
      absorbs: ["schema-type-changed"],
      describes: "a second absorber, which would make each of the two proofs individually deletable and neither required",
    },
  ]);
  assert.ok(
    failures.some((failure) => failure.includes("absorbed by more than one joint divergence")),
    JSON.stringify(failures),
  );
});

test("MUTATION: an unrequired signature and a missing one are both reported", () => {
  // Completeness read against a deliberately altered requirement set, so the
  // rule is exercised rather than merely satisfied by the committed catalogue.
  const failures = catalogueCompletenessFailures(SEEDS.filter((seed) => seedSignature(seed) !== "status-changed"));
  assert.ok(
    failures.some((failure) => failure.includes("status-changed has no isolating seed")),
    JSON.stringify(failures),
  );
});

test("MUTATION: a seed that moves more than it declares fails, so isolation is not merely asserted", () => {
  // Exactness is the property that makes "isolating seed" mean something. A
  // seed that quietly changed a second dimension would still have passed under
  // superset matching, and every isolating claim in the catalogue would be
  // unfalsifiable.
  const leaky = {
    ...SEEDS[0],
    id: "status-change-that-also-adds-a-header",
    seed: (observation) => {
      const next = SEEDS[0].seed(observation);
      next.response.headers["x-leaked"] = "1";
      return next;
    },
  };
  return runSeededControl(leaky).then((result) => {
    assert.equal(result.passed, false);
    assert.equal(result.verdict, "divergent");
    assert.match(result.detail, /unexpected: header-added/u);
  });
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

// ---------------------------------------------------------------------------
// The store runner's dimension-sensitivity rule, controlled WITHOUT Docker
// ---------------------------------------------------------------------------
//
// The phase itself runs only where a Docker daemon exists. Its RULE does not
// have to: it is a pure function, so every branch is driven here and ships as
// part of `test:differential-harness` rather than living in a transcript.

const allMoved = (seeds, dimensions) => new Map(seeds.map((seed) => [seed.id, new Set(dimensions)]));

test("dimension sensitivity: the committed conservation seeds satisfy the rule", () => {
  for (const scenario of [CONSERVATION_SCENARIO, TIER_BOUNDARY_SCENARIO]) {
    const seeds = seedsForScenario(scenario);
    assert.ok(seeds.length > 0, `${scenario.id} has no seeds`);
    const { failures, provenBy } = dimensionSensitivityFailures(
      scenario,
      seeds,
      allMoved(seeds, scenario.dimensions),
    );
    assert.deepEqual(failures, [], JSON.stringify(failures));
    // Every declared dimension is claimed, and every seed claims something —
    // so no seed can be deleted without the phase noticing.
    assert.deepEqual(Object.keys(provenBy).sort(), [...scenario.dimensions].sort());
    for (const seed of seeds) assert.ok((seed.proves ?? []).length > 0, `${seed.id} proves nothing`);
  }
});

test("MUTATION: deleting a conservation seed leaves its dimension unproven", () => {
  // The correction's own control, in CI. Deleting either of the two seeds added
  // for auth and status must name the dimension that lost its evidence.
  const scenario = CONSERVATION_SCENARIO;
  const seeds = seedsForScenario(scenario);
  for (const victim of seeds) {
    const remaining = seeds.filter((seed) => seed.id !== victim.id);
    const { failures } = dimensionSensitivityFailures(
      scenario,
      remaining,
      allMoved(remaining, scenario.dimensions),
    );
    assert.ok(
      failures.some((failure) => failure.includes("no seed is designated to prove it")),
      `deleting ${victim.id} left every dimension proven: ${JSON.stringify(failures)}`,
    );
  }
});

test("MUTATION: two designated provers for one dimension are refused", () => {
  const scenario = CONSERVATION_SCENARIO;
  const seeds = seedsForScenario(scenario).map((seed) =>
    seed.proves.includes("schema") ? { ...seed, proves: [...seed.proves, "status"] } : seed,
  );
  const { failures } = dimensionSensitivityFailures(scenario, seeds, allMoved(seeds, scenario.dimensions));
  assert.ok(failures.some((failure) => failure.includes("designated provers")), JSON.stringify(failures));
});

test("MUTATION: a designated prover that did not move its dimension is refused", () => {
  const scenario = CONSERVATION_SCENARIO;
  const seeds = seedsForScenario(scenario);
  const moved = allMoved(seeds, scenario.dimensions);
  const authProver = seeds.find((seed) => seed.proves.includes("auth"));
  moved.set(authProver.id, new Set(scenario.dimensions.filter((dimension) => dimension !== "auth")));
  const { failures } = dimensionSensitivityFailures(scenario, seeds, moved);
  assert.deepEqual(failures, [
    `${authProver.id} is designated to prove auth but its run produced no auth divergence`,
  ]);
});

test("MUTATION: a seed claiming a dimension its scenario does not declare is refused", () => {
  const scenario = TIER_BOUNDARY_SCENARIO;
  const seeds = seedsForScenario(scenario).map((seed) => ({ ...seed, proves: [...seed.proves, "store"] }));
  const { failures } = dimensionSensitivityFailures(scenario, seeds, allMoved(seeds, scenario.dimensions));
  assert.ok(
    failures.some((failure) => failure.includes("claims to prove store, which")),
    JSON.stringify(failures),
  );
});

test("MUTATION: a seed that proves nothing is refused as deletable", () => {
  const scenario = CONSERVATION_SCENARIO;
  const seeds = [...seedsForScenario(scenario), { id: "freeloader", proves: [] }];
  const { failures } = dimensionSensitivityFailures(scenario, seeds, allMoved(seeds, scenario.dimensions));
  assert.ok(
    failures.some((failure) => failure.includes("freeloader proves no declared dimension")),
    JSON.stringify(failures),
  );
});

// ---------------------------------------------------------------------------
// ISOLATING CONTROLS for the two guards that a redundant second guard covered
// ---------------------------------------------------------------------------
//
// Independent verification found that neutering `assertObservation` and
// `assertComparatorCoverage` left both gates green — not because either
// property is unenforced, but because a second guard caught the same input
// first. Redundancy is fine; redundancy that hides whether the primary guard
// still works is not. These two controls remove the second guard from the
// picture so each is provable on its own.

test("ISOLATION: the observation validator refuses a malformed observation the storeIdentity guard would let through", async () => {
  // Both sides name a store, and the two names differ, so the isolation guard
  // has nothing to say. The only thing left that can refuse this run is
  // validateObservation.
  const malformed = {
    ...baselineObservation("candidate"),
    storeIdentity: "store-candidate",
    usage: { measured: ["inputUnits"], inputUnits: 1, outputUnits: 0, costMicros: 0, durationMs: -4 },
  };
  assert.ok(validateObservation(malformed).some((error) => error.includes("usage.durationMs")));

  const result = await twinRun(SELF_TEST_SCENARIO, {
    oracle: createRecordedSubject({
      side: "oracle",
      recordings: { [SELF_TEST_SCENARIO.id]: baselineObservation("oracle") },
      provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
    }),
    candidate: { async run() { return malformed; } },
  });
  assert.equal(result.verdict, "invalid");
  assert.ok(result.failures.some((failure) => failure.includes("usage.durationMs")), JSON.stringify(result.failures));
});

test("ISOLATION: assertComparatorCoverage reports a dimension with no comparator, and a comparator with no dimension", () => {
  // Called with a deliberately broken registry, so `validateScenario` — which
  // independently refuses a dimension with no comparator — cannot be what makes
  // this pass.
  const missing = assertComparatorCoverage({ ...COMPARATORS, store: undefined });
  assert.deepEqual(missing, ["dimension store has no comparator"]);

  const stray = assertComparatorCoverage({ ...COMPARATORS, invented: () => [] });
  assert.deepEqual(stray, ["comparator invented is not an acceptance dimension"]);

  assert.deepEqual(assertComparatorCoverage(), []);
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
