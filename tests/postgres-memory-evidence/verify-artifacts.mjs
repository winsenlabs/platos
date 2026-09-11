import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where the server this evidence must be at least as new as is actually pinned. */
export const POSTGRES_IMAGE_PIN_SOURCE = ".github/workflows/ci.yml";

/**
 * THE MINIMUM PostgreSQL MAJOR, READ OFF THE IMAGE CI ACTUALLY PINS.
 *
 * WHAT THIS REPLACED, AND WHY THE OLD ASSERTION WAS THE WRONG SHAPE. This file
 * used to assert `/^16(?:\.|$)/` against the artifact's `serverVersion` with the
 * message "gate did not use PostgreSQL 16". That is an EXACTNESS claim, and the
 * thing it was guarding — "this artifact came from the server CI pins" — is
 * already guarded, harder, one layer up: the `postgres-memory-evidence` job pins
 * `pgvector/pgvector:pg16` BY SHA256 DIGEST, which is an immutability no version
 * string can express. So in CI the old assertion was a second, weaker copy of a
 * constraint the workflow already enforced, and the only thing it could actually
 * decide was whether the suites may run anywhere else.
 *
 * They may, and the decision was made on evidence rather than on principle. All
 * fourteen cases across the four suites — every query-count budget, every EXPLAIN
 * plan, the sequential-scan refusal, the row, buffer and timing ceilings — were
 * executed against a native Homebrew `postgresql@17` (17.10) with pgvector 0.8.5
 * and passed. The ONLY failure was this string match. Nothing the evidence asserts
 * is specific to major 16: the ceilings are UPPER bounds, so a newer planner that
 * is equal or better still satisfies them, and `pgvectorVersion` is asserted to be
 * present rather than to be a value.
 *
 * SO IT IS A FLOOR, AND THE FLOOR IS NOT A LITERAL THIS FILE KEEPS. It is parsed
 * out of the workflow's own `pgvector/pgvector:pgNN` tags, so the day CI moves to
 * `pg17` the floor moves with it and no edit here is required or possible to
 * forget. An assertion comparing two numbers this file owns could not fail; this
 * one is joined to the file that decides the answer.
 *
 * EVERY OCCURRENCE MUST AGREE. `ci.yml` pins the same image in three jobs and its
 * own comments say they must not drift onto different versions. Parsing all of
 * them and refusing a disagreement makes that comment an assertion.
 */
export function minimumPostgresMajor(
  workflow = readFileSync(resolve(repositoryRoot, POSTGRES_IMAGE_PIN_SOURCE), "utf8")
) {
  const majors = [...workflow.matchAll(/pgvector\/pgvector:pg(\d+)/g)].map((match) =>
    Number(match[1])
  );
  assert.ok(
    majors.length > 0,
    `${POSTGRES_IMAGE_PIN_SOURCE} pins no pgvector/pgvector:pgNN image, so the evidence floor cannot be derived`
  );
  const distinct = [...new Set(majors)];
  assert.equal(
    distinct.length,
    1,
    `${POSTGRES_IMAGE_PIN_SOURCE} pins disagreeing PostgreSQL majors (${distinct.join(", ")}); the evidence jobs must not drift apart`
  );
  return distinct[0];
}

/**
 * The major version out of a `server_version` string, or null when there is none.
 *
 * `current_setting('server_version')` answers `16.4` on the pinned image and
 * `17.10 (Homebrew)` on a native install, so the parse takes the leading integer
 * and ignores the rest rather than matching a whole shape.
 */
export function postgresMajor(serverVersion) {
  const match = /^(\d+)(?:[.\s]|$)/.exec(String(serverVersion ?? "").trim());
  return match === null ? null : Number(match[1]);
}

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
  // TWO DISTINCT REFUSALS AND NOT ONE. "no version at all" and "a version older
  // than the floor" are different operator actions — a broken capture versus a
  // wrong server — and a single message could not tell them apart.
  const major = postgresMajor(runtime.serverVersion);
  assert.notEqual(
    major,
    null,
    `runtime evidence carries no readable PostgreSQL version (${JSON.stringify(runtime.serverVersion)})`
  );
  const floor = minimumPostgresMajor();
  assert.ok(
    major >= floor,
    `gate used PostgreSQL ${major}, older than the ${floor} pinned in ${POSTGRES_IMAGE_PIN_SOURCE}`
  );
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

export function resolveArtifactDirectoryArgument(args, configuredDirectory) {
  const positional = args.filter((argument) => argument !== "--");
  assert.ok(positional.length <= 1, "expected at most one artifact-directory argument");
  return positional[0] || configuredDirectory;
}

function normalizeSql(sql) {
  return sql.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolveArtifactDirectoryArgument(
    process.argv.slice(2),
    process.env.PLATOS_POSTGRES_EVIDENCE_DIR,
  );
  assert.ok(directory, "usage: node verify-artifacts.mjs <artifact-directory>");
  const result = await verifyEvidenceArtifactDirectory(directory);
  console.log(
    `Verified PostgreSQL evidence: ${result.suites} suites, ${result.tests} tests, zero skipped`
  );
}
