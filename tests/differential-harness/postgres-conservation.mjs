#!/usr/bin/env node
// WIN-284 — state conservation against two REAL isolated PostgreSQL stores.
//
// The recorded negative controls prove the comparators are sensitive. They
// cannot prove the harness works against a database, because nothing in them
// touches one. This runner closes that gap: two separate databases, both built
// by the repository's own `prisma migrate deploy` over the real 93-model
// tenancy schema, driven by identical operation sequences, dumped and compared.
//
// It runs the same three phases as the recorded controls, plus one this runner
// needs because its scenarios declare every dimension at once:
//
//   CLEAN    identical operation sequences on both stores must report parity,
//            despite genuinely independent UUIDs, clocks and sequences.
//   SEEDED   one real difference applied to the candidate store — a row not
//            written, a value changed, an operation reordered, a side effect
//            skipped, a status changed, a tier downgraded, a tier boundary
//            crossed — each of which must be caught, with the right code.
//   ISOLATION the two stores must be provably distinct, or the whole exercise
//            is one database compared with itself.
//   DIMENSION every dimension a scenario declares must have exactly one
//   SENSITIVITY designated seed that was seen to move it ON THAT SCENARIO. A
//            dimension that is structurally constant still carries facts, so it
//            passes the anti-vacuity guard while comparing a constant; this
//            phase refuses that. Designating the prover, rather than accepting
//            "some phase moved it", is what keeps every seed load-bearing.
//
// This needs Docker and is meant for the Mac mini or hosted CI. It FAILS when
// Docker is absent rather than skipping: a suite that silently skips is
// indistinguishable from a suite that passes, and that is the failure mode this
// whole issue exists to prevent.
//
// Run: node tests/differential-harness/postgres-conservation.mjs [--out=<file>] [--keep]

import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { NORMALISERS } from "./normalisers.mjs";
import { CONSERVATION_SCENARIO, SCENARIO_REGISTRY, TIER_BOUNDARY_SCENARIO } from "./scenarios.mjs";
import { createPostgresSubject, runStatement, startTwinStores } from "./subjects/postgres-twin.mjs";
import { twinRun } from "./twin-run.mjs";

export const SCENARIOS = SCENARIO_REGISTRY;


// ---------------------------------------------------------------------------
// Seeded divergences applied to the REAL candidate store
// ---------------------------------------------------------------------------

// Each seed rewrites the scenario the CANDIDATE side runs. The oracle always
// runs the unmodified scenario, so any divergence is attributable to the seed
// and to nothing else.
//
// `expectedCodes` here is the set of codes that MUST be present, not the
// complete set — unlike the recorded catalogue in seeds.mjs, which is matched
// exactly. Two real databases produce a wider blast radius than a fixture (a
// failed read also empties the body and changes the row accounting), and
// pinning the complete set would turn an incidental extra code into a red gate
// on a real-infrastructure run. The full observed set is reported on every
// phase, so nothing is hidden by the looser rule; it is stated rather than
// implied.
//
// EVERY DECLARED DIMENSION MUST BE ABLE TO FAIL ON THE SCENARIO THAT DECLARES
// IT. Independent verification found that `auth` and `status` were structurally
// constant across the conservation seeds: all four left every role `owner` and
// never failed a statement, so those two dimensions were adding facts to
// `factCounts` on the flagship scenario without ever having been watched go red
// there. Both comparators were proven sensitive elsewhere, which made this a
// weak claim rather than a blind gate — but "proven elsewhere" is exactly the
// argument this harness refuses to accept from anyone else. Two seeds close it:
// one moves `status` alone, one moves `auth` and `status` together through a
// real PostgreSQL privilege denial on the flagship scenario itself.
//
// `proves` is what stops those two seeds being deletable in turn. Each seed
// names the dimensions it is the DESIGNATED evidence for, and the
// dimension-sensitivity phase requires every declared dimension to have exactly
// one designated prover which actually moved it. "Some phase happened to move
// it" would not have been enough: the tier-downgrade seed also moves `status`,
// so under a looser rule the status seed could be deleted and status would be
// left provable only alongside an authorisation change. Naming the evidence
// makes each seed load-bearing and makes the deletion of any of them red.
export const STORE_SEEDS = Object.freeze([
  Object.freeze({
    id: "real-row-never-written",
    proves: Object.freeze(["store", "usage"]),
    describes: "The candidate never inserts the second project. The response still looks plausible; the store is short a row.",
    expectedCodes: Object.freeze(["store-row-missing"]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.filter((operation) => operation.id !== "insert-project-beta"),
    }),
  }),
  Object.freeze({
    id: "real-value-changed",
    proves: Object.freeze(["schema"]),
    describes: "The candidate writes a different project name. Same row count, same shape, different persisted value.",
    expectedCodes: Object.freeze(["store-row-missing", "store-row-extra"]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.map((operation) =>
        operation.id === "insert-project-alpha"
          ? { ...operation, sql: operation.sql.replace("'Alpha'", "'Alpha (changed)'") }
          : operation,
      ),
    }),
  }),
  Object.freeze({
    id: "real-side-effect-skipped",
    proves: Object.freeze(["sideEffects"]),
    describes: "The candidate never performs the archive update, so a side effect the oracle performed simply does not happen.",
    expectedCodes: Object.freeze(["side-effect-missing"]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.map((operation) =>
        operation.id === "archive-project-beta"
          ? { ...operation, sql: `UPDATE public."Project" SET "updatedAt" = now() WHERE slug = 'nothing-matches' RETURNING slug, name` }
          : operation,
      ),
    }),
  }),
  Object.freeze({
    id: "real-operations-reordered",
    proves: Object.freeze(["events"]),
    describes:
      "The candidate creates the two projects in the opposite order. The same two rows exist at the end, but " +
      "the event sequence differs AND the two rows swap which of them carries the earlier instant, so the run " +
      "reports store row differences alongside event-reordered. Saying 'identical final state' would be wrong: " +
      "instant-rank is part of the persisted state this harness compares.",
    expectedCodes: Object.freeze(["event-reordered"]),
    seed: (scenario) => {
      const operations = [...scenario.operations];
      const alpha = operations.findIndex((operation) => operation.id === "insert-project-alpha");
      const beta = operations.findIndex((operation) => operation.id === "insert-project-beta");
      [operations[alpha], operations[beta]] = [operations[beta], operations[alpha]];
      return { ...scenario, operations };
    },
  }),
  Object.freeze({
    id: "real-status-changed-on-conservation",
    proves: Object.freeze(["status"]),
    describes:
      "The candidate reads a table that does not exist where the oracle read the projects. PostgreSQL answers " +
      "42P01, the subject maps it to 404, and the flagship scenario's status dimension has to report it. This " +
      "seed exists so `status` is a dimension that has been watched go red on THIS scenario, not only on the " +
      "tier-boundary one.",
    expectedCodes: Object.freeze(["status-changed"]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.map((operation) =>
        operation.id === "select-projects"
          ? {
              ...operation,
              sql: `SELECT slug, name, ("archivedAt" IS NOT NULL) AS archived
            FROM public."ProjectThatWasNeverMigrated" ORDER BY slug`,
            }
          : operation,
      ),
    }),
  }),
  Object.freeze({
    id: "real-tier-downgraded-on-conservation",
    proves: Object.freeze(["auth"]),
    describes:
      "The candidate performs the flagship scenario's final read as the end-user tier while the oracle performs " +
      "it as the operator tier. PostgreSQL refuses it with a real 42501 — the grant genuinely does not exist, " +
      "because Project is not in prisma/end-user.prisma — so principal, decision, reason and status all move on " +
      "the conservation scenario itself. This is what makes `auth` a dimension the flagship scenario can fail on " +
      "rather than one it merely declares.",
    expectedCodes: Object.freeze([
      "auth-principal-changed",
      "auth-decision-changed",
      "auth-reason-changed",
      "status-changed",
    ]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.map((operation) =>
        operation.id === "select-projects" ? { ...operation, role: "restricted" } : operation,
      ),
    }),
  }),
  Object.freeze({
    id: "real-tier-boundary-crossed",
    proves: Object.freeze(["status", "events", "auth"]),
    describes: "The candidate performs the read as the operator tier where the oracle used the end-user tier. PostgreSQL allows it, and the harness must report the authorisation difference rather than the successful read.",
    scenario: TIER_BOUNDARY_SCENARIO,
    expectedCodes: Object.freeze(["auth-decision-changed", "auth-principal-changed", "status-changed"]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.map((operation) => ({ ...operation, role: "owner" })),
    }),
  }),
]);

// ---------------------------------------------------------------------------
// Dimension sensitivity — extracted so it is provable WITHOUT Docker
// ---------------------------------------------------------------------------

// The rule the `dimension-sensitivity` phase applies, as a pure function of the
// scenario, the seeds that target it, and which dimensions each seed's run
// actually moved.
//
// It is separated from `runConservation` on purpose. Left inline, the only way
// to watch this gate go red would be to hand-mutate the source on a machine with
// a Docker daemon — which means the control would live in somebody's transcript
// rather than in CI. As a pure function it is exercised by the no-Docker suite
// on every run, and `negative-controls.test.mjs` drives each of its branches.
export function dimensionSensitivityFailures(scenario, seeds, movedBySeed) {
  const failures = [];
  const provenBy = {};
  for (const dimension of scenario.dimensions) {
    const designated = seeds.filter((seed) => (seed.proves ?? []).includes(dimension));
    if (designated.length === 0) {
      failures.push(
        `${dimension} is declared but no seed is designated to prove it; a dimension that cannot fail here ` +
          "is counting facts rather than comparing them",
      );
      continue;
    }
    if (designated.length > 1) {
      failures.push(
        `${dimension} has ${designated.length} designated provers (${designated.map((seed) => seed.id).join(", ")}); ` +
          "with more than one, either could be deleted and the evidence would still look complete",
      );
      continue;
    }
    const [prover] = designated;
    provenBy[dimension] = prover.id;
    if (!(movedBySeed.get(prover.id) ?? new Set()).has(dimension)) {
      failures.push(`${prover.id} is designated to prove ${dimension} but its run produced no ${dimension} divergence`);
    }
  }
  for (const seed of seeds) {
    for (const dimension of seed.proves ?? []) {
      if (!scenario.dimensions.includes(dimension)) {
        failures.push(`${seed.id} claims to prove ${dimension}, which ${scenario.id} does not declare`);
      }
    }
    if ((seed.proves ?? []).length === 0) {
      failures.push(`${seed.id} proves no declared dimension; it could be deleted with this phase staying green`);
    }
  }
  return { failures, provenBy };
}

// Which seeds target which scenario. `scenario` on a seed is optional and
// defaults to the flagship, so this is the one place that default is resolved.
export function seedsForScenario(scenario, seeds = STORE_SEEDS) {
  return seeds.filter((seed) => (seed.scenario ?? CONSERVATION_SCENARIO).id === scenario.id);
}

// ---------------------------------------------------------------------------

function resetStore(store) {
  // Cascade from Organization: Project has ON DELETE CASCADE, so this proves
  // the cascade too. A row left behind between phases would make the next
  // phase's comparison meaningless.
  runStatement(store, `DELETE FROM public."Organization" RETURNING id`, "owner");
}

async function runPhase(scenario, stores, seed = null, options = {}) {
  const oracleScenario = scenario;
  const candidateScenario = seed ? seed.seed(scenario) : scenario;
  const oracle = createPostgresSubject({ side: "oracle", store: stores.oracle });
  const candidate = createPostgresSubject({ side: "candidate", store: stores.candidate });
  return twinRun(
    scenario,
    {
      oracle: { run: () => oracle.run(oracleScenario) },
      candidate: { run: () => candidate.run(candidateScenario) },
    },
    options,
  );
}

export async function runConservation(options = {}) {
  assertDockerIsAvailable();
  const twins = await startTwinStores({ repositoryRoot: options.repositoryRoot ?? process.cwd() });
  const results = [];
  try {
    if (twins.stores.oracle.database === twins.stores.candidate.database) {
      throw new Error("the two stores are the same database");
    }
    results.push({
      phase: "isolation",
      id: "distinct-databases",
      passed: true,
      detail: `oracle=${twins.stores.oracle.database} candidate=${twins.stores.candidate.database} on container ${twins.container}`,
    });
    results.push({
      phase: "isolation",
      id: "tier-grants-derived-from-schema",
      passed: twins.endUserModels.length > 0,
      detail: `restricted role granted on ${twins.endUserModels.length} tables read from prisma/end-user.prisma: ${twins.endUserModels.join(", ")}`,
    });

    for (const scenario of SCENARIOS) {
      resetStore(twins.stores.oracle);
      resetStore(twins.stores.candidate);
      const clean = await runPhase(scenario, twins.stores);
      results.push({
        phase: "clean",
        id: scenario.id,
        verdict: clean.verdict,
        passed: clean.verdict === "parity",
        factCounts: clean.factCounts ?? null,
        detail: clean.verdict === "parity"
          ? "two independently populated stores compare equal after normalisation"
          : `${clean.verdict}: ${[...(clean.failures ?? []), ...(clean.divergences ?? []).map((entry) => `${entry.code} ${entry.path}`)].join("; ")}`,
      });
    }

    // Parity has to be EARNED. If the two stores compared equal with the
    // register switched off, they were not independently populated and the
    // clean phase above would be proving nothing about normalisation. This
    // phase requires them to diverge without it — real independent UUIDs,
    // clocks and sequence starts, exactly the nondeterminism the register
    // exists to absorb.
    resetStore(twins.stores.oracle);
    resetStore(twins.stores.candidate);
    const unnormalised = await runPhase(CONSERVATION_SCENARIO, twins.stores, null, {
      skipNormalisers: NORMALISERS.map((normaliser) => normaliser.id),
    });
    results.push({
      phase: "earned-parity",
      id: "clean-run-diverges-without-the-register",
      verdict: unnormalised.verdict,
      passed: unnormalised.verdict === "divergent",
      observedCodes: [...new Set((unnormalised.divergences ?? []).map((entry) => entry.code))],
      detail: unnormalised.verdict === "divergent"
        ? `${unnormalised.divergences.length} divergences without normalisation, so the stores really are independent`
        : `the two stores compared as ${unnormalised.verdict} with normalisation off; they are not independently populated`,
    });

    // Which dimensions each scenario has actually been watched go red on,
    // accumulated across its seeded phases and asserted below, and which seed
    // moved each one.
    const dimensionsMoved = new Map(SCENARIOS.map((scenario) => [scenario.id, new Set()]));
    const movedBySeed = new Map();

    for (const seed of STORE_SEEDS) {
      const scenario = seed.scenario ?? CONSERVATION_SCENARIO;
      resetStore(twins.stores.oracle);
      resetStore(twins.stores.candidate);
      const result = await runPhase(scenario, twins.stores, seed);
      const observed = (result.divergences ?? []).map((entry) => entry.code);
      const missing = seed.expectedCodes.filter((code) => !observed.includes(code));
      const moved = new Set((result.divergences ?? []).map((entry) => entry.dimension));
      for (const dimension of moved) dimensionsMoved.get(scenario.id)?.add(dimension);
      movedBySeed.set(seed.id, moved);
      results.push({
        phase: "seeded",
        id: seed.id,
        scenario: scenario.id,
        describes: seed.describes,
        expectedCodes: [...seed.expectedCodes],
        observedCodes: observed,
        observedDimensions: [...new Set((result.divergences ?? []).map((entry) => entry.dimension))].sort(),
        verdict: result.verdict,
        passed: result.verdict === "divergent" && missing.length === 0,
        detail: missing.length === 0 && result.verdict === "divergent"
          ? `caught against real stores as ${observed.join(", ")}`
          : `expected ${seed.expectedCodes.join(", ")}, saw ${result.verdict} with ${observed.join(", ") || "no divergences"}`,
      });
    }

    // EVERY DECLARED DIMENSION MUST BE ABLE TO FAIL ON THE SCENARIO THAT
    // DECLARES IT.
    //
    // A scenario declares seven dimensions and every one of them contributes
    // facts to `factCounts`, which is what the anti-vacuity guard reads. A
    // dimension that is structurally constant for a scenario still passes that
    // guard — it has facts, they are simply the same facts every time — so it
    // inflates the appearance of coverage without being sensitive. Proving the
    // comparator sensitive on some OTHER scenario is not the same claim, and
    // this harness does not accept "proven elsewhere" from anybody else.
    //
    // Each declared dimension must have exactly ONE designated prover among the
    // seeds that target the scenario, and that seed must actually have moved it.
    // "Some phase moved it" would be weaker in a way that matters: two seeds can
    // both move `status`, and either could then be deleted while the phase
    // stayed green. Naming the evidence makes every seed load-bearing.
    for (const scenario of SCENARIOS) {
      const moved = dimensionsMoved.get(scenario.id) ?? new Set();
      const { failures, provenBy } = dimensionSensitivityFailures(
        scenario,
        seedsForScenario(scenario),
        movedBySeed,
      );

      results.push({
        phase: "dimension-sensitivity",
        id: scenario.id,
        declaredDimensions: [...scenario.dimensions],
        dimensionsMoved: [...moved].sort(),
        provenBy,
        passed: failures.length === 0,
        detail: failures.length === 0
          ? `all ${scenario.dimensions.length} declared dimensions have a designated seed that was seen to move them`
          : failures.join("; "),
      });
    }
  } finally {
    if (!options.keep) twins.stop();
  }

  return {
    version: 1,
    issue: "WIN-284",
    schema: "internal-packages/tenancy-database/prisma/schema.prisma",
    totals: {
      phases: results.length,
      passed: results.filter((entry) => entry.passed).length,
      failed: results.filter((entry) => !entry.passed).length,
    },
    results,
    ok: results.every((entry) => entry.passed),
  };
}

function assertDockerIsAvailable() {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    // Fail, never skip. A skipped store-conservation run reads identically to a
    // passing one in a summary, and that is the vacuity this issue is about.
    throw new Error(
      "the twin-PostgreSQL conservation run needs a working Docker daemon and will not skip: " +
        (error.message ?? String(error)),
    );
  }
}

export function formatReport(report) {
  const lines = [`WIN-284 store conservation: ${report.totals.passed}/${report.totals.phases} phases passed`];
  for (const entry of report.results) {
    lines.push(`  ${entry.passed ? "PASS" : "FAIL"} [${entry.phase}] ${entry.id}: ${entry.detail}`);
  }
  lines.push(report.ok ? "ok: conservation holds and every seeded store divergence was caught" : "FAILED");
  return lines.join("\n");
}

async function main(argv) {
  const report = await runConservation({ keep: argv.includes("--keep") });
  console.log(formatReport(report));
  const out = argv.find((argument) => argument.startsWith("--out="));
  if (out) writeFileSync(out.slice("--out=".length), `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) await main(process.argv.slice(2));
