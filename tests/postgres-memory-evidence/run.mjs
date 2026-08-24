import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SUITE_CONTRACT, verifyEvidenceArtifactDirectory } from "./verify-artifacts.mjs";
import { guardedPublicSchemaResetSql, validateDisposableDatabaseUrl } from "./reset-guard.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const artifactDirectory = resolve(
  repositoryRoot,
  process.env.PLATOS_POSTGRES_EVIDENCE_DIR || "artifacts/win236-win237-postgres"
);
const databaseUrl = process.env.PLATOS_POSTGRES_INTEGRATION_DATABASE_URL?.trim();

assert.ok(databaseUrl, "PLATOS_POSTGRES_INTEGRATION_DATABASE_URL is required");
assert.equal(
  process.env.PLATOS_POSTGRES_INTEGRATION_ALLOW_RESET,
  "1",
  "PLATOS_POSTGRES_INTEGRATION_ALLOW_RESET=1 is required because the gate resets public schema"
);
validateDisposableDatabaseUrl(databaseUrl);

rmSync(artifactDirectory, { recursive: true, force: true });
mkdirSync(resolve(artifactDirectory, "suites"), { recursive: true });

const suiteSummaries = [];
for (const contract of SUITE_CONTRACT) {
  resetPublicSchema(databaseUrl);
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "platos-agent",
      "exec",
      "vitest",
      "run",
      contract.file,
      "--no-file-parallelism",
      "--reporter=json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        PLATOS_POSTGRES_EVIDENCE_DIR: artifactDirectory,
        PLATOS_POSTGRES_EVIDENCE_REQUIRED: "1",
        PLATOS_POSTGRES_INTEGRATION_DATABASE_URL: databaseUrl,
        PLATOS_POSTGRES_INTEGRATION_EXTERNAL: "1",
      },
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  const stdoutPath = resolve(artifactDirectory, "suites", `${contract.slug}.stdout.log`);
  const stderrPath = resolve(artifactDirectory, "suites", `${contract.slug}.stderr.log`);
  writeFileSync(stdoutPath, result.stdout || "", "utf8");
  writeFileSync(stderrPath, result.stderr || "", "utf8");
  assert.equal(
    result.error,
    undefined,
    `${contract.slug} could not start: ${result.error?.message}`
  );
  assert.equal(result.status, 0, `${contract.slug} failed; inspect ${stderrPath}`);

  const report = parseVitestJson(result.stdout, contract.slug);
  assert.equal(report.numTotalTests, contract.expectedTests, `${contract.slug} test count drifted`);
  assert.equal(
    report.numPassedTests,
    contract.expectedTests,
    `${contract.slug} did not pass every test`
  );
  assert.equal(report.numFailedTests, 0, `${contract.slug} has failed tests`);
  assert.equal(report.numPendingTests, 0, `${contract.slug} has skipped or todo tests`);
  assert.equal(report.numPendingTestSuites ?? 0, 0, `${contract.slug} has a skipped suite`);
  writeFileSync(
    resolve(artifactDirectory, "suites", `${contract.slug}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  suiteSummaries.push({
    ...contract,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests,
  });
  console.log(
    `${contract.slug}: ${report.numPassedTests}/${contract.expectedTests} passed, zero skipped`
  );
}

const commitSha =
  process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
const manifest = {
  $schema: "./artifact-schema.json",
  schemaVersion: 1,
  gate: "win236-win237-postgres-evidence",
  status: "passed",
  commitSha,
  command: "pnpm test:postgres-memory:evidence",
  suites: suiteSummaries,
  totals: {
    tests: suiteSummaries.reduce((total, suite) => total + suite.passed, 0),
    failed: suiteSummaries.reduce((total, suite) => total + suite.failed, 0),
    skipped: suiteSummaries.reduce((total, suite) => total + suite.skipped, 0),
  },
  evidence: {
    queryCounts: [
      "memory-semantic-search.query-count.json",
      "memory-dense-page.query-count.json",
      "knowledge-graph-dense-page.query-count.json",
    ],
    explains: [
      "memory-semantic-search.explain.json",
      "memory-dense-page.explain.json",
      "knowledge-graph-dense-page.explain.json",
    ],
    runtime: "postgres-runtime.json",
  },
};
writeFileSync(
  resolve(artifactDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
copyFileSync(
  resolve(import.meta.dirname, "artifact-schema.json"),
  resolve(artifactDirectory, "artifact-schema.json")
);

const verified = await verifyEvidenceArtifactDirectory(artifactDirectory);
console.log(`PostgreSQL evidence gate passed: ${verified.suites} suites, ${verified.tests} tests`);

function resetPublicSchema(url) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@platos/tenancy-database",
      "exec",
      "prisma",
      "db",
      "execute",
      "--stdin",
      "--schema",
      "prisma/schema.prisma",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url },
      input: guardedPublicSchemaResetSql(),
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  assert.equal(result.error, undefined, `database reset could not start: ${result.error?.message}`);
  assert.equal(result.status, 0, `database reset failed: ${result.stderr || result.stdout}`);
}

function parseVitestJson(stdout, slug) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${slug} did not emit valid Vitest JSON: ${error.message}`);
  }
}
