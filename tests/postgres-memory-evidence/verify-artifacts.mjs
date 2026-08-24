import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SUITE_CONTRACT = [
  {
    slug: "memory-retrieval",
    file: "src/memory/memory-retrieval-postgres.integration.test.ts",
    expectedTests: 4,
  },
  {
    slug: "knowledge-graph",
    file: "src/memory/knowledge-graph-postgres.integration.test.ts",
    expectedTests: 7,
  },
  {
    slug: "memory-import-export",
    file: "src/memory/memory-import-export-postgres.integration.test.ts",
    expectedTests: 2,
  },
  {
    slug: "memory-profile-upgrade",
    file: "src/memory/memory-profile-upgrade-postgres.integration.test.ts",
    expectedTests: 1,
  },
];

const QUERY_COUNT_FILES = [
  "memory-semantic-search.query-count.json",
  "memory-dense-page.query-count.json",
  "knowledge-graph-dense-page.query-count.json",
];
const EXPLAIN_FILES = [
  "memory-semantic-search.explain.json",
  "memory-dense-page.explain.json",
  "knowledge-graph-dense-page.explain.json",
];

export async function verifyEvidenceArtifactDirectory(directory) {
  const root = resolve(directory);
  const manifest = await readJson(resolve(root, "manifest.json"));
  assert.equal(manifest.schemaVersion, 1, "unexpected evidence schema version");
  assert.equal(manifest.gate, "win236-win237-postgres-evidence", "unexpected gate name");
  assert.equal(manifest.status, "passed", "PostgreSQL evidence gate did not pass");
  assert.match(manifest.commitSha, /^[a-f0-9]{40}$/, "manifest commit SHA is not immutable");
  assert.deepEqual(
    manifest.suites.map(({ slug }) => slug),
    SUITE_CONTRACT.map(({ slug }) => slug)
  );

  let totalTests = 0;
  for (const contract of SUITE_CONTRACT) {
    const report = await readJson(resolve(root, "suites", `${contract.slug}.json`));
    assert.equal(
      report.numTotalTests,
      contract.expectedTests,
      `${contract.slug} test count drifted`
    );
    assert.equal(report.numFailedTests, 0, `${contract.slug} contains failed tests`);
    assert.equal(report.numPendingTests, 0, `${contract.slug} contains skipped or todo tests`);
    assert.equal(report.numFailedTestSuites, 0, `${contract.slug} contains a failed suite`);
    assert.equal(report.numPendingTestSuites ?? 0, 0, `${contract.slug} contains a skipped suite`);
    assert.equal(
      report.numPassedTests,
      contract.expectedTests,
      `${contract.slug} did not pass every test`
    );
    totalTests += report.numTotalTests;
  }
  assert.equal(manifest.totals.tests, totalTests, "manifest test total does not match reports");
  assert.equal(manifest.totals.skipped, 0, "manifest reports skipped assertions");
  assert.equal(manifest.totals.failed, 0, "manifest reports failed assertions");

  const runtime = await readJson(resolve(root, "postgres-runtime.json"));
  assert.equal(runtime.kind, "postgres-runtime", "runtime evidence kind is invalid");
  assert.match(runtime.serverVersion, /^16(?:\.|$)/, "gate did not use PostgreSQL 16");
  assert.match(runtime.pgvectorVersion, /^\d+\.\d+/, "pgvector extension version is absent");

  for (const file of QUERY_COUNT_FILES) {
    const evidence = await readJson(resolve(root, file));
    assert.equal(evidence.kind, "query-count", `${file} is not query-count evidence`);
    assert.ok(
      Number.isInteger(evidence.queryCount) && evidence.queryCount > 0,
      `${file} is unmeasured`
    );
    assert.ok(
      evidence.queryCount <= evidence.maximumQueryCount,
      `${file} exceeds its query-count budget`
    );
  }

  for (const file of EXPLAIN_FILES) {
    const path = resolve(root, file);
    const evidence = await readJson(path);
    assert.equal(evidence.kind, "postgres-explain", `${file} is not EXPLAIN evidence`);
    assert.deepEqual(evidence.options, ["ANALYZE", "BUFFERS", "FORMAT JSON"]);
    assert.ok(evidence.bounded.statementTimeoutMs > 0, `${file} has no statement timeout`);
    assert.ok(evidence.bounded.rowLimit > 0, `${file} has no row bound`);
    const serializedPlans = JSON.stringify(evidence.plans);
    assert.match(serializedPlans, /"Actual Rows"/, `${file} did not execute ANALYZE`);
    assert.match(serializedPlans, /"Shared Hit Blocks"/, `${file} did not capture buffers`);
    const artifactStat = await stat(path);
    assert.ok(
      artifactStat.size <= evidence.bounded.maximumArtifactBytes,
      `${file} exceeds its declared artifact bound`
    );
  }

  return { suites: SUITE_CONTRACT.length, tests: totalTests };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] || process.env.PLATOS_POSTGRES_EVIDENCE_DIR;
  assert.ok(directory, "usage: node verify-artifacts.mjs <artifact-directory>");
  const result = await verifyEvidenceArtifactDirectory(directory);
  console.log(
    `Verified PostgreSQL evidence: ${result.suites} suites, ${result.tests} tests, zero skipped`
  );
}
