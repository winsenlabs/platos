import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

export const QUERY_COUNT_CONTRACT = [
  {
    file: "memory-semantic-search.query-count.json",
    endpoint: "MemoryService.semanticSearch",
    fixtureRows: 1_559,
    maximumQueryCount: 12,
  },
  {
    file: "memory-dense-page.query-count.json",
    endpoint: "MemoryService.listPage",
    fixtureRows: 384,
    maximumQueryCount: 8,
  },
  {
    file: "knowledge-graph-dense-page.query-count.json",
    endpoint: "KnowledgeGraphService.getEntitiesPage",
    fixtureRows: 141,
    maximumQueryCount: 6,
  },
];
export const EXPLAIN_CONTRACT = [
  {
    file: "memory-semantic-search.explain.json",
    endpoint: "MemoryService.semanticSearch",
    rowLimit: 200,
    plans: ["search"],
  },
  {
    file: "memory-dense-page.explain.json",
    endpoint: "MemoryService.listPage",
    rowLimit: 100,
    plans: ["items", "count"],
  },
  {
    file: "knowledge-graph-dense-page.explain.json",
    endpoint: "KnowledgeGraphService.getEntitiesPage",
    rowLimit: 50,
    plans: ["items", "count"],
  },
];

const EXPLAIN_ARTIFACT_MAX_BYTES = 256 * 1024;

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
  assert.deepEqual(
    manifest.evidence.queryCounts,
    QUERY_COUNT_CONTRACT.map(({ file }) => file),
    "manifest query-count filenames drifted"
  );
  assert.deepEqual(
    manifest.evidence.explains,
    EXPLAIN_CONTRACT.map(({ file }) => file),
    "manifest EXPLAIN filenames drifted"
  );
  assert.equal(
    manifest.evidence.runtime,
    "postgres-runtime.json",
    "manifest runtime filename drifted"
  );

  const runtime = await readJson(resolve(root, "postgres-runtime.json"));
  assert.equal(runtime.kind, "postgres-runtime", "runtime evidence kind is invalid");
  assert.match(runtime.serverVersion, /^16(?:\.|$)/, "gate did not use PostgreSQL 16");
  assert.match(runtime.pgvectorVersion, /^\d+\.\d+/, "pgvector extension version is absent");

  for (const contract of QUERY_COUNT_CONTRACT) {
    const evidence = await readJson(resolve(root, contract.file));
    assert.equal(evidence.kind, "query-count", `${contract.file} is not query-count evidence`);
    assert.equal(evidence.endpoint, contract.endpoint, `${contract.file} endpoint drifted`);
    assert.equal(
      evidence.fixtureRows,
      contract.fixtureRows,
      `${contract.file} fixture size drifted`
    );
    assert.equal(
      evidence.maximumQueryCount,
      contract.maximumQueryCount,
      `${contract.file} declared maximum drifted`
    );
    assert.ok(
      Number.isInteger(evidence.queryCount) && evidence.queryCount > 0,
      `${contract.file} is unmeasured`
    );
    assert.ok(
      evidence.queryCount <= contract.maximumQueryCount,
      `${contract.file} exceeds its query-count budget`
    );
  }

  for (const contract of EXPLAIN_CONTRACT) {
    const path = resolve(root, contract.file);
    const evidence = await readJson(path);
    assert.equal(evidence.kind, "postgres-explain", `${contract.file} is not EXPLAIN evidence`);
    assert.equal(evidence.endpoint, contract.endpoint, `${contract.file} endpoint drifted`);
    assert.deepEqual(evidence.options, ["ANALYZE", "BUFFERS", "FORMAT JSON"]);
    assert.equal(evidence.bounded.statementTimeoutMs, 15_000, `${contract.file} timeout drifted`);
    assert.equal(
      evidence.bounded.rowLimit,
      contract.rowLimit,
      `${contract.file} row bound drifted`
    );
    assert.equal(
      evidence.bounded.maximumArtifactBytes,
      EXPLAIN_ARTIFACT_MAX_BYTES,
      `${contract.file} artifact bound drifted`
    );
    assert.deepEqual(
      Object.keys(evidence.plans).sort(),
      [...contract.plans].sort(),
      `${contract.file} required plan set drifted`
    );
    for (const planName of contract.plans) {
      const captured = evidence.plans[planName];
      const label = `${contract.file}.${planName}`;
      assert.equal(captured.source, "captured-prisma-query", `${label} is not endpoint SQL`);
      assert.equal(
        captured.normalizedSql,
        normalizeSql(captured.normalizedSql),
        `${label} SQL is not normalized`
      );
      assert.equal(
        captured.normalizedSqlSha256,
        sha256(captured.normalizedSql),
        `${label} normalized SQL hash is invalid`
      );
      const serializedPlan = JSON.stringify(captured.plan);
      assert.match(serializedPlan, /"Actual Rows"/, `${label} did not execute ANALYZE`);
      assert.match(serializedPlan, /"Shared Hit Blocks"/, `${label} did not capture buffers`);
    }
    const artifactStat = await stat(path);
    assert.ok(
      artifactStat.size <= evidence.bounded.maximumArtifactBytes,
      `${contract.file} exceeds its declared artifact bound`
    );
  }

  return { suites: SUITE_CONTRACT.length, tests: totalTests };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function normalizeSql(sql) {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2] || process.env.PLATOS_POSTGRES_EVIDENCE_DIR;
  assert.ok(directory, "usage: node verify-artifacts.mjs <artifact-directory>");
  const result = await verifyEvidenceArtifactDirectory(directory);
  console.log(
    `Verified PostgreSQL evidence: ${result.suites} suites, ${result.tests} tests, zero skipped`
  );
}
