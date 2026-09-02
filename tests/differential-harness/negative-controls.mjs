#!/usr/bin/env node
// WIN-284 — the negative-control runner.
//
// This is the acceptance clause the issue calls out as the one that matters
// most and is easiest to skip. It executes in three phases and all three must
// hold; any one of them alone is worthless.
//
//   PHASE 1  CLEAN RUN. Twin-run two observations that differ ONLY in
//            nondeterminism — different UUIDs, different clocks, different
//            sequence starts, different measured durations. The verdict must be
//            `parity`. Without this phase a harness that reports divergence for
//            everything would pass every seeded control below and look perfect.
//
//   PHASE 2  SEEDED RUNS. For each seed, twin-run the same oracle against a
//            candidate carrying exactly one deliberate difference. The verdict
//            must be `divergent` AND the expected divergence codes must all be
//            present. "Something changed" is not a pass: a harness that cannot
//            say WHAT changed is unusable against a 14k-line decomposition.
//
//   PHASE 3  VACUITY CONTROLS. Feed the engine the shapes that make this class
//            of harness go quietly green — an empty observation, a scenario
//            declaring a dimension it never populated, both sides pointed at
//            the same store — and require it to refuse each one rather than
//            report parity.
//
// Run: node tests/differential-harness/negative-controls.mjs [--out=<file>]

import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { SEEDS, assertSeedCoverage, baselineObservation } from "./seeds.mjs";
import { assertRegisterIsSensitive } from "./normalisers.mjs";
import { assertComparatorCoverage } from "./comparators.mjs";
import { createRecordedSubject, createSeededCandidateSubject } from "./subjects/recorded.mjs";
import { twinRun } from "./twin-run.mjs";

// The frozen, admin-enforced oracle this harness is built against. It is
// carried as provenance on the recordings below.
//
// SAID PLAINLY SO NOBODY HAS TO INFER IT: the self-test recording is a
// SYNTHETIC FIXTURE, not a capture from that commit. Nothing here has replayed
// real `main` behaviour, and nothing here claims to. Its job is to exercise the
// comparators, the register and the engine's refusals with a subject that has
// no moving parts, so a control that fails is unambiguously the harness's
// fault and not the environment's.
//
// Capturing genuine oracle recordings needs a running instance of the frozen
// commit to read — `test.platos.dev`, read-only per the charter — and it only
// becomes useful once there is a V1 candidate to twin-run those recordings
// against. Both belong with the surfaces WIN-285 covers. The state-conservation
// half of this issue is where real systems are compared today, and that runs
// against two live PostgreSQL stores, not against a fixture.
export const ORACLE_COMMIT = "89c12b8aa8da75c561dc879f370aaefb6e3359bc";

// Every dimension, so a seed in any dimension reaches its comparator.
export const SELF_TEST_SCENARIO = Object.freeze({
  id: "harness-self-test",
  title: "Harness self-test: every dimension, populated on both sides",
  dimensions: Object.freeze(["status", "schema", "events", "auth", "sideEffects", "usage", "store"]),
  tolerance: Object.freeze({ costMicros: 0.01 }),
});

function oracleSubject() {
  return createRecordedSubject({
    side: "oracle",
    recordings: { [SELF_TEST_SCENARIO.id]: baselineObservation("oracle") },
    provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z", note: "synthetic self-test fixture; not a capture from the oracle commit" },
  });
}

function cleanCandidateSubject() {
  return createSeededCandidateSubject({
    recordings: { [SELF_TEST_SCENARIO.id]: baselineObservation("candidate") },
    provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z", note: "synthetic self-test fixture; differs only in nondeterminism" },
    transform: (observation) => observation,
    label: "clean",
  });
}

export async function runCleanControl() {
  const result = await twinRun(SELF_TEST_SCENARIO, {
    oracle: oracleSubject(),
    candidate: cleanCandidateSubject(),
  });
  return {
    phase: "clean",
    id: "unseeded-twin-run",
    expected: "parity",
    verdict: result.verdict,
    passed: result.verdict === "parity",
    detail:
      result.verdict === "parity"
        ? "two sides differing only in identifiers, clocks, durations and sequence starts compare equal"
        : `unseeded run reported ${result.verdict}: ${[...(result.failures ?? []), ...(result.divergences ?? []).map((entry) => `${entry.code} ${entry.path}`)].join("; ")}`,
    factCounts: result.factCounts ?? null,
  };
}

export async function runSeededControl(seed) {
  const result = await twinRun(SELF_TEST_SCENARIO, {
    oracle: oracleSubject(),
    candidate: createSeededCandidateSubject({
      recordings: { [SELF_TEST_SCENARIO.id]: baselineObservation("candidate") },
      provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z", note: `seeded: ${seed.id}` },
      transform: seed.seed,
      label: seed.id,
    }),
  });
  const observedCodes = (result.divergences ?? []).map((entry) => entry.code);
  const missing = seed.expectedCodes.filter((code) => !observedCodes.includes(code));
  const passed = result.verdict === "divergent" && missing.length === 0;
  return {
    phase: "seeded",
    id: seed.id,
    dimension: seed.dimension,
    describes: seed.describes,
    expectedCodes: [...seed.expectedCodes],
    observedCodes,
    verdict: result.verdict,
    passed,
    detail: passed
      ? `caught as ${observedCodes.join(", ")}`
      : `expected ${seed.expectedCodes.join(", ")} but the run was ${result.verdict} with ${observedCodes.join(", ") || "no divergences"}`,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: the ways this harness could go green over nothing
// ---------------------------------------------------------------------------

function emptyObservation(side) {
  return {
    scenario: SELF_TEST_SCENARIO.id,
    side,
    subject: `empty:${side}`,
    storeIdentity: `store-${side}`,
    response: { status: 200, headers: {}, body: null },
    events: [],
    auth: { principal: null, scopes: [], decision: "allow", reason: null },
    sideEffects: [],
    usage: { measured: [], inputUnits: 0, outputUnits: 0, costMicros: 0, durationMs: 0 },
    store: {},
  };
}

async function vacuityControls() {
  const controls = [];

  // (a) Both sides produced nothing. A naive comparator reports parity; this
  //     engine must call it vacuous, because silence is not agreement.
  const emptyRun = await twinRun(SELF_TEST_SCENARIO, {
    oracle: { async run() { return emptyObservation("oracle"); } },
    candidate: { async run() { return emptyObservation("candidate"); } },
  });
  controls.push({
    phase: "vacuity",
    id: "both-sides-empty",
    expected: "vacuous",
    verdict: emptyRun.verdict,
    passed: emptyRun.verdict === "vacuous",
    detail: emptyRun.verdict === "vacuous"
      ? `refused: ${emptyRun.failures.length} dimension(s) carried no comparable facts`
      : `two empty observations were reported as ${emptyRun.verdict}`,
  });

  // (b) One store, twin-run against itself. Always compares equal.
  const sameStore = await twinRun(SELF_TEST_SCENARIO, {
    oracle: { async run() { return { ...baselineObservation("oracle"), storeIdentity: "shared" }; } },
    candidate: { async run() { return { ...baselineObservation("candidate"), storeIdentity: "shared" }; } },
  });
  controls.push({
    phase: "vacuity",
    id: "shared-store-identity",
    expected: "invalid",
    verdict: sameStore.verdict,
    passed: sameStore.verdict === "invalid",
    detail: sameStore.verdict === "invalid"
      ? "refused: both sides reported the same store, so the stores were not isolated"
      : `a shared store was reported as ${sameStore.verdict}`,
  });

  // (c) A scenario that declares no dimensions compares nothing.
  const noDimensions = await twinRun(
    { id: "no-dimensions", dimensions: [] },
    { oracle: oracleSubject(), candidate: cleanCandidateSubject() },
  );
  controls.push({
    phase: "vacuity",
    id: "scenario-declares-no-dimensions",
    expected: "unsound",
    verdict: noDimensions.verdict,
    passed: noDimensions.verdict === "unsound",
    detail: noDimensions.verdict === "unsound"
      ? "refused: a scenario comparing nothing cannot report parity"
      : `an empty scenario was reported as ${noDimensions.verdict}`,
  });

  // (d) A malformed observation must be rejected, not coerced.
  const malformed = await twinRun(SELF_TEST_SCENARIO, {
    oracle: oracleSubject(),
    candidate: { async run() { return { scenario: SELF_TEST_SCENARIO.id, side: "candidate" }; } },
  });
  controls.push({
    phase: "vacuity",
    id: "malformed-observation",
    expected: "invalid",
    verdict: malformed.verdict,
    passed: malformed.verdict === "invalid",
    detail: malformed.verdict === "invalid"
      ? "refused: an observation missing its required fields is rejected rather than defaulted"
      : `a malformed observation was reported as ${malformed.verdict}`,
  });

  // (e) A standing approval that never matches would become a permanent mute.
  const staleApproval = await twinRun(
    {
      ...SELF_TEST_SCENARIO,
      id: "stale-approval-probe",
      approvedDifferences: [
        {
          code: "status-changed",
          rationale: "probe approval that is deliberately never matched by the clean run",
          issue: "WIN-284",
        },
      ],
    },
    {
      oracle: createRecordedSubject({
        side: "oracle",
        recordings: { "stale-approval-probe": baselineObservation("oracle") },
        provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
      }),
      candidate: createSeededCandidateSubject({
        recordings: { "stale-approval-probe": baselineObservation("candidate") },
        provenance: { commit: ORACLE_COMMIT, capturedAt: "2026-09-02T00:00:00.000Z" },
        transform: (observation) => observation,
        label: "clean",
      }),
    },
  );
  controls.push({
    phase: "vacuity",
    id: "stale-approved-difference",
    expected: "stale-approval",
    verdict: staleApproval.verdict,
    passed: staleApproval.verdict === "stale-approval",
    detail: staleApproval.verdict === "stale-approval"
      ? "refused: an approved difference that never occurs is a permanent mute and fails the run"
      : `an unmatched approval was reported as ${staleApproval.verdict}`,
  });

  return controls;
}

// ---------------------------------------------------------------------------

export async function runNegativeControls() {
  const registerFailures = assertRegisterIsSensitive();
  const seedFailures = assertSeedCoverage();
  const comparatorFailures = assertComparatorCoverage();

  const clean = await runCleanControl();
  const seeded = [];
  for (const seed of SEEDS) seeded.push(await runSeededControl(seed));
  const vacuity = await vacuityControls();

  const controls = [clean, ...seeded, ...vacuity];
  const structural = [
    ...registerFailures.map((failure) => ({ kind: "normaliser-register", failure })),
    ...seedFailures.map((failure) => ({ kind: "seed-catalogue", failure })),
    ...comparatorFailures.map((failure) => ({ kind: "comparator-coverage", failure })),
  ];

  return {
    version: 1,
    issue: "WIN-284",
    oracleCommit: ORACLE_COMMIT,
    totals: {
      controls: controls.length,
      passed: controls.filter((control) => control.passed).length,
      failed: controls.filter((control) => !control.passed).length,
      seeds: seeded.length,
      structuralFailures: structural.length,
    },
    structural,
    controls,
    ok: structural.length === 0 && controls.every((control) => control.passed),
  };
}

export function formatReport(report) {
  const lines = [
    `WIN-284 negative controls: ${report.totals.passed}/${report.totals.controls} controls passed`,
  ];
  for (const entry of report.structural) lines.push(`FAIL [${entry.kind}] ${entry.failure}`);
  for (const control of report.controls) {
    lines.push(`  ${control.passed ? "PASS" : "FAIL"} [${control.phase}] ${control.id}: ${control.detail}`);
  }
  lines.push(report.ok ? "ok: the harness detects every seeded divergence and refuses every vacuous run" : "FAILED");
  return lines.join("\n");
}

async function main(argv) {
  const report = await runNegativeControls();
  console.log(formatReport(report));
  const out = argv.find((argument) => argument.startsWith("--out="));
  if (out) writeFileSync(out.slice("--out=".length), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

// Exact entry-point check. A "does the filename end with" heuristic would also
// fire when a test imports this module, and the CLI would run inside the suite.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) await main(process.argv.slice(2));
