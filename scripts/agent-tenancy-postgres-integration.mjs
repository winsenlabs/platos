#!/usr/bin/env node
// THE MCP-SURFACE AND TOOL-LIFECYCLE REAL-DATABASE SUITES, RUN BY A JOB THAT
// FINDS THEM RATHER THAN BY A LIST SOMEBODY HAS TO REMEMBER TO EXTEND.
//
// THE DEFECT THIS EXISTS TO CLOSE — the FOURTH instance of it this programme has
// found. `permission-gateway-forged-scope.integration.test.ts`,
// `macros-replay-postgres.integration.test.ts` and
// `end-users-tenancy-postgres.integration.test.ts` were named by NOTHING in
// `.github/workflows/ci.yml`. They are real-PostgreSQL tenancy proofs — a forged
// scope triple refused, a replay's parameters round-tripped, an end-user's rows
// held inside one organization — they passed review, and they had never
// executed in CI. `registry-incoherent-pair-postgres.integration.test.ts` was in
// the same state and is included here for the same reason.
//
// A GATE IS A GATE ONLY WHILE A JOB NAMES IT. `clean-prisma-delegates` sat red
// for 1,064 commits for exactly this reason, and `pnpm test:ci-policy`'s
// filesystem enumeration was built after the third instance — but its roots are
// the V1 packages plus `apps/core-api` and `apps/mcp-stdio`, and these suites
// live under `apps/agent/src`, which no enumeration reached.
//
// WHY A WALK AND NOT A LIST OF FILES. The Redis integration job selects suites by
// the word `integration` in their FILENAME, so a new one joins by being named.
// This does the same thing one level up: the roots are path CONSTANTS, the files
// are whatever is under them, and a suite added tomorrow is run tomorrow with no
// line to add here. `scripts/ci-policy.test.mjs` joins this walk to the workflow
// so the job cannot stop naming the script either.
//
// WHY THE `*_REQUIRED` FLAGS ARE DERIVED AND NOT LISTED. Each suite gates itself
// on its own environment variable so that a machine with no database SKIPS rather
// than failing to connect — and a skip that reports green is the whole reason
// this programme distrusts summaries. The flag names differ per suite
// (`MCP_FORGED_SCOPE_REQUIRED`, `END_USER_TENANCY_REQUIRED`,
// `TOOL_REGISTRY_TENANCY_REQUIRED`), so a list of them here would be the same
// forgettable list in a different place. They are READ OUT OF THE SUITES
// THEMSELVES, and the belt-and-braces underneath is the report check below: a
// SKIPPED suite or a SKIPPED test fails this script whether its flag was found or
// not.
//
//   node scripts/agent-tenancy-postgres-integration.mjs
//
// Requires PLATOS_POSTGRES_INTEGRATION_DATABASE_URL. Fails, rather than skips,
// when it is absent — the same decision the two container-backed steps above it
// in `ci.yml` make, and for the same reason.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { parseVitestJson } from "../tests/postgres-memory-evidence/vitest-json.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/** The workspace whose `vitest` runs these files. A filter, not a guess. */
export const PACKAGE = "platos-agent";

/**
 * The directories walked, as PATH CONSTANTS.
 *
 * They are exported because `scripts/ci-policy.test.mjs` imports them: the case
 * that proves every suite under these roots is reachable must read the roots from
 * here rather than restate them, or the two could disagree about which tree is
 * gated. Enumerating from a constant rather than from a string literal is the
 * lesson a "complete" fix learned the hard way — one found by grepping a file for
 * a literal broke on the next file, which held its path in a constant.
 */
export const SUITE_ROOTS = ["apps/agent/src/mcp-platform", "apps/agent/src/tool-gateway"];

export const SUITE_SUFFIX = ".integration.test.ts";

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/** Every integration suite under the roots, repository-relative and sorted. */
export function discoverSuites() {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(SUITE_SUFFIX)) {
        found.push(path.relative(repositoryRoot, full));
      }
    }
  };
  for (const root of SUITE_ROOTS) walk(path.join(repositoryRoot, root));
  return found.sort();
}

/**
 * The `*_REQUIRED` gate flags the discovered suites read, from their own source.
 *
 * A suite writes `process.env.SOMETHING_REQUIRED === "1"` and throws when the
 * database URL is missing. Setting every name it names turns "no database" into a
 * loud failure at import time instead of a silent `describe.skip`.
 */
export function requiredFlagsIn(sources) {
  const flags = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]*_REQUIRED)\b/gu)) {
      flags.add(match[1]);
    }
  }
  return [...flags].sort();
}

function main() {
  const databaseUrl = process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL?.trim();
  assert.ok(
    databaseUrl,
    "PLATOS_POSTGRES_INTEGRATION_DATABASE_URL is required; these suites apply the canonical " +
      "migrations into a private schema of a real PostgreSQL and drop it afterwards",
  );

  const suites = discoverSuites();
  // NON-VACUITY. A walk that found nothing would run vitest with no files, which
  // exits 0 only because `--passWithNoTests` is off — and if it were ever on this
  // whole job would be a green that proved nothing. The roots or the suffix being
  // wrong is the failure mode, so it is the failure reported.
  assert.ok(
    suites.length > 0,
    `no ${SUITE_SUFFIX} suite found under ${SUITE_ROOTS.join(", ")}; the roots or the suffix are wrong`,
  );

  const flags = requiredFlagsIn(
    suites.map((suite) => readFileSync(path.join(repositoryRoot, suite), "utf8")),
  );
  assert.ok(
    flags.length > 0,
    "no *_REQUIRED gate flag found in any discovered suite; a suite with no flag can skip silently",
  );

  console.log(`Running ${suites.length} suite(s) under ${SUITE_ROOTS.join(", ")}:`);
  for (const suite of suites) console.log(`  ${suite}`);
  console.log(`Gate flags read from those sources: ${flags.join(", ")}`);

  // Vitest resolves positional filters against the package's own root, which is
  // where `--filter` puts the working directory.
  const packageRoot = path.join(repositoryRoot, "apps/agent");
  const relativeSuites = suites.map((suite) => path.relative(packageRoot, path.join(repositoryRoot, suite)));

  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      PACKAGE,
      "exec",
      "vitest",
      "run",
      ...relativeSuites,
      "--no-file-parallelism",
      "--testTimeout=300000",
      "--hookTimeout=300000",
      "--reporter=json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        PLATOS_POSTGRES_INTEGRATION_DATABASE_URL: databaseUrl,
        ...Object.fromEntries(flags.map((flag) => [flag, "1"])),
      },
      maxBuffer: 128 * 1024 * 1024,
    },
  );

  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.error, undefined, `vitest could not start: ${result.error?.message}`);

  const report = parseVitestJson(result.stdout ?? "", "agent-tenancy-postgres");
  console.log(
    `total ${report.numTotalTests}, passed ${report.numPassedTests}, ` +
      `failed ${report.numFailedTests}, pending ${report.numPendingTests}, ` +
      `suites ${report.numTotalTestSuites} (pending ${report.numPendingTestSuites ?? 0})`,
  );

  // THE SKIP CHECK IS THE POINT, NOT THE EXIT CODE. A suite whose gate variable
  // is unset reports `describe.skip` and vitest exits 0; a tranche once reported
  // 218/218 that way and merged two regressions. Every discovered file must have
  // executed every case it declares.
  assert.equal(result.status, 0, "at least one suite failed");
  assert.equal(report.numFailedTests, 0, "a suite reported failed tests");
  assert.equal(report.numPendingTests, 0, "a suite SKIPPED tests; the database gate did not open");
  assert.equal(
    report.numPendingTestSuites ?? 0,
    0,
    "a whole suite was SKIPPED; the database gate did not open",
  );
  // EVERY DISCOVERED FILE, BY NAME AND NOT BY COUNT. `numTotalTestSuites` counts
  // `describe` blocks, so a count would agree with the wrong set of files. The
  // report's own per-file entries are compared to the walk, which is what makes
  // "the job runs what the tree holds" an assertion rather than an intention.
  const executed = new Set(
    (report.testResults ?? []).map((entry) => path.relative(repositoryRoot, entry.name)),
  );
  assert.deepEqual(
    [...executed].sort(),
    suites,
    "the files vitest reported are not the files the walk discovered",
  );
  assert.ok(report.numPassedTests > 0, "no test actually ran");
  console.log("OK — every discovered suite ran against a real PostgreSQL");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main();
}
