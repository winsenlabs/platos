#!/usr/bin/env node
// WIN-284 — state conservation against two REAL isolated PostgreSQL stores.
//
// The recorded negative controls prove the comparators are sensitive. They
// cannot prove the harness works against a database, because nothing in them
// touches one. This runner closes that gap: two separate databases, both built
// by the repository's own `prisma migrate deploy` over the real 93-model
// tenancy schema, driven by identical operation sequences, dumped and compared.
//
// It runs the same three phases as the recorded controls:
//
//   CLEAN    identical operation sequences on both stores must report parity,
//            despite genuinely independent UUIDs, clocks and sequences.
//   SEEDED   one real difference applied to the candidate store — a row not
//            written, a value changed, an operation reordered, a side effect
//            skipped, a tier boundary crossed — each of which must be caught,
//            with the right code.
//   ISOLATION the two stores must be provably distinct, or the whole exercise
//            is one database compared with itself.
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

import { createPostgresSubject, runStatement, startTwinStores } from "./subjects/postgres-twin.mjs";
import { twinRun } from "./twin-run.mjs";

const ORGANIZATION_SLUG = "win284-conservation";

// Deliberately real tenancy tables with a real foreign key and a real cascade,
// so "state conservation" means something a reviewer can check against the
// schema rather than against a fixture invented for the harness.
//
// TIMESTAMP NOTE: each operation is its own `psql` process, so two operations
// cannot land in the same millisecond in practice and instant-rank sees the
// same number of distinct instants on both sides. If they ever did tie, the
// ranks would differ and the run would report a FALSE POSITIVE — never a false
// negative. That is the safe direction for a harness to fail in.
export const CONSERVATION_SCENARIO = Object.freeze({
  id: "tenancy-organization-project-conservation",
  title: "Organization and Project lifecycle conserved across two isolated stores",
  dimensions: Object.freeze(["status", "schema", "events", "auth", "sideEffects", "usage", "store"]),
  storeTables: Object.freeze(["Organization", "Project"]),
  resultOf: "select-projects",
  sideEffectVerbs: Object.freeze({
    "insert-organization": "insert",
    "insert-project-alpha": "insert",
    "insert-project-beta": "insert",
    "archive-project-beta": "update",
  }),
  operations: Object.freeze([
    Object.freeze({
      id: "insert-organization",
      target: "Organization",
      sql: `INSERT INTO public."Organization" (id, slug, name, "createdAt", "updatedAt")
            VALUES (gen_random_uuid(), '${ORGANIZATION_SLUG}', 'WIN-284 conservation', now(), now())
            RETURNING slug, name`,
    }),
    Object.freeze({
      id: "insert-project-alpha",
      target: "Project",
      sql: `INSERT INTO public."Project" (id, "organizationId", slug, name, "createdAt", "updatedAt")
            SELECT gen_random_uuid(), o.id, 'alpha', 'Alpha', now(), now()
            FROM public."Organization" o WHERE o.slug = '${ORGANIZATION_SLUG}'
            RETURNING slug, name`,
    }),
    Object.freeze({
      id: "insert-project-beta",
      target: "Project",
      sql: `INSERT INTO public."Project" (id, "organizationId", slug, name, "createdAt", "updatedAt")
            SELECT gen_random_uuid(), o.id, 'beta', 'Beta', now(), now()
            FROM public."Organization" o WHERE o.slug = '${ORGANIZATION_SLUG}'
            RETURNING slug, name`,
    }),
    Object.freeze({
      id: "archive-project-beta",
      target: "Project",
      sql: `UPDATE public."Project" SET "archivedAt" = now(), "updatedAt" = now()
            WHERE slug = 'beta' RETURNING slug, name`,
    }),
    Object.freeze({
      id: "select-projects",
      sql: `SELECT slug, name, ("archivedAt" IS NOT NULL) AS archived
            FROM public."Project" ORDER BY slug`,
    }),
  ]),
});

// The end-user tier boundary, enforced by PostgreSQL from grants derived from
// the real end-user.prisma model list.
export const TIER_BOUNDARY_SCENARIO = Object.freeze({
  id: "tenancy-end-user-tier-boundary",
  title: "The end-user tier cannot read an operator-only table",
  dimensions: Object.freeze(["status", "events", "auth"]),
  resultOf: "read-operator-table",
  operations: Object.freeze([
    Object.freeze({
      id: "read-operator-table",
      role: "restricted",
      sql: `SELECT slug FROM public."Organization"`,
    }),
  ]),
});

export const SCENARIOS = Object.freeze([CONSERVATION_SCENARIO, TIER_BOUNDARY_SCENARIO]);

// ---------------------------------------------------------------------------
// Seeded divergences applied to the REAL candidate store
// ---------------------------------------------------------------------------

// Each seed rewrites the scenario the CANDIDATE side runs. The oracle always
// runs the unmodified scenario, so any divergence is attributable to the seed
// and to nothing else.
export const STORE_SEEDS = Object.freeze([
  Object.freeze({
    id: "real-row-never-written",
    describes: "The candidate never inserts the second project. The response still looks plausible; the store is short a row.",
    expectedCodes: Object.freeze(["store-row-missing"]),
    seed: (scenario) => ({
      ...scenario,
      operations: scenario.operations.filter((operation) => operation.id !== "insert-project-beta"),
    }),
  }),
  Object.freeze({
    id: "real-value-changed",
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
    describes: "The candidate creates the two projects in the opposite order. Identical final state, different event sequence.",
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
    id: "real-tier-boundary-crossed",
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

function resetStore(store) {
  // Cascade from Organization: Project has ON DELETE CASCADE, so this proves
  // the cascade too. A row left behind between phases would make the next
  // phase's comparison meaningless.
  runStatement(store, `DELETE FROM public."Organization" RETURNING id`, "owner");
}

async function runPhase(scenario, stores, seed = null) {
  const oracleScenario = scenario;
  const candidateScenario = seed ? seed.seed(scenario) : scenario;
  const oracle = createPostgresSubject({ side: "oracle", store: stores.oracle });
  const candidate = createPostgresSubject({ side: "candidate", store: stores.candidate });
  return twinRun(scenario, {
    oracle: { run: () => oracle.run(oracleScenario) },
    candidate: { run: () => candidate.run(candidateScenario) },
  });
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

    for (const seed of STORE_SEEDS) {
      const scenario = seed.scenario ?? CONSERVATION_SCENARIO;
      resetStore(twins.stores.oracle);
      resetStore(twins.stores.candidate);
      const result = await runPhase(scenario, twins.stores, seed);
      const observed = (result.divergences ?? []).map((entry) => entry.code);
      const missing = seed.expectedCodes.filter((code) => !observed.includes(code));
      results.push({
        phase: "seeded",
        id: seed.id,
        describes: seed.describes,
        expectedCodes: [...seed.expectedCodes],
        observedCodes: observed,
        verdict: result.verdict,
        passed: result.verdict === "divergent" && missing.length === 0,
        detail: missing.length === 0 && result.verdict === "divergent"
          ? `caught against real stores as ${observed.join(", ")}`
          : `expected ${seed.expectedCodes.join(", ")}, saw ${result.verdict} with ${observed.join(", ") || "no divergences"}`,
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
