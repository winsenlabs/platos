import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EXPLAIN_CONTRACT,
  minimumPostgresMajor,
  postgresMajor,
  POSTGRES_IMAGE_PIN_SOURCE,
  QUERY_COUNT_CONTRACT,
  resolveArtifactDirectoryArgument,
  SUITE_CONTRACT,
  verifyEvidenceArtifactDirectory,
} from "./verify-artifacts.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("artifact verifier CLI ignores pnpm separators and rejects extra paths", () => {
  assert.equal(resolveArtifactDirectoryArgument(["--", "artifacts/evidence"], undefined), "artifacts/evidence");
  assert.equal(resolveArtifactDirectoryArgument(["--"], "configured/evidence"), "configured/evidence");
  assert.throws(
    () => resolveArtifactDirectoryArgument(["first", "second"], undefined),
    /at most one/,
  );
});

test("artifact verifier rejects skipped assertions", async () => {
  const directory = await fixtureDirectory();
  try {
    const reportPath = resolve(directory, "suites", "memory-retrieval.json");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    report.numPendingTests = 1;
    report.numPassedTests -= 1;
    await writeJson(reportPath, report);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /skipped or todo/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier rejects query-count regressions", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "memory-dense-page.query-count.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.queryCount = evidence.maximumQueryCount + 1;
    await writeJson(path, evidence);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /query-count budget/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a changed declared query-count maximum", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "memory-dense-page.query-count.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.maximumQueryCount += 1;
    await writeJson(path, evidence);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /declared maximum drifted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier hard-pins query endpoint and fixture size", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "knowledge-graph-dense-page.query-count.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.endpoint = "PlausibleService.list";
    await writeJson(path, evidence);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /endpoint drifted/);

    evidence.endpoint = "KnowledgeGraphService.getEntitiesPage";
    evidence.fixtureRows += 1;
    await writeJson(path, evidence);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /fixture size drifted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier validates ANALYZE independently for each required plan", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "memory-dense-page.explain.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    delete evidence.plans.items.plan[0].Plan["Actual Rows"];
    await writeJson(path, evidence);
    await assert.rejects(
      verifyEvidenceArtifactDirectory(directory),
      /memory-dense-page\.explain\.json\.items did not execute ANALYZE/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier validates buffers independently for each required plan", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "knowledge-graph-dense-page.explain.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    delete evidence.plans.count.plan[0].Plan["Shared Hit Blocks"];
    await writeJson(path, evidence);
    await assert.rejects(
      verifyEvidenceArtifactDirectory(directory),
      /knowledge-graph-dense-page\.explain\.json\.count did not capture buffers/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier rejects a normalized endpoint SQL hash mutation", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "memory-semantic-search.explain.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    evidence.plans.search.normalizedSqlSha256 = "0".repeat(64);
    await writeJson(path, evidence);
    await assert.rejects(
      verifyEvidenceArtifactDirectory(directory),
      /normalized SQL hash is invalid/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ── THE POSTGRESQL FLOOR (was an exact `/^16/` pin) ────────────────────────
//
// The pin was widened to a floor because the evidence turned out not to assert
// anything specific to major 16: all fourteen cases across the four suites pass
// against a native `postgresql@17` (17.10, pgvector 0.8.5), and the only failure
// was the string match itself. Widening a refusal is only safe if the widened one
// still refuses, so these cases are the proof that it does — and they mutate the
// captured evidence and the pinned workflow rather than asserting against
// constants this suite owns.

test("the floor is READ OFF the workflow's pinned image, not kept as a literal here", () => {
  const workflow = readFileSync(resolve(repositoryRoot, POSTGRES_IMAGE_PIN_SOURCE), "utf8");
  const major = minimumPostgresMajor(workflow);
  // Joined to the real file: the number must be the one actually pinned there.
  assert.ok(workflow.includes(`pgvector/pgvector:pg${major}`), "derived floor is not the pinned tag");
  assert.equal(minimumPostgresMajor(), major, "the default read disagrees with the explicit one");
});

test("a workflow whose jobs pin DISAGREEING majors is refused, not averaged", () => {
  assert.throws(
    () => minimumPostgresMajor("a: pgvector/pgvector:pg16\nb: pgvector/pgvector:pg17\n"),
    /must not drift apart/
  );
  assert.throws(() => minimumPostgresMajor("no image pinned here\n"), /pins no pgvector/);
});

test("server_version parses on both real shapes and refuses what is not one", () => {
  // The two strings `current_setting('server_version')` actually answers: the
  // pinned image, and the native install the suites were re-proven against.
  assert.equal(postgresMajor("16.4"), 16);
  assert.equal(postgresMajor("17.10 (Homebrew)"), 17);
  assert.equal(postgresMajor(""), null);
  assert.equal(postgresMajor(undefined), null);
  assert.equal(postgresMajor("sixteen"), null);
});

test("artifact verifier REFUSES evidence captured on a server older than the floor", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "postgres-runtime.json");
    const runtime = JSON.parse(await readFile(path, "utf8"));
    const floor = minimumPostgresMajor();

    // One major below the pin: the case the floor exists to catch.
    runtime.serverVersion = `${floor - 1}.13`;
    await writeJson(path, runtime);
    await assert.rejects(
      verifyEvidenceArtifactDirectory(directory),
      new RegExp(`gate used PostgreSQL ${floor - 1}, older than the ${floor} pinned`)
    );

    // And an ancient one, so the refusal is not an off-by-one that only rejects
    // the immediately preceding major.
    runtime.serverVersion = "9.6.24";
    await writeJson(path, runtime);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /older than the/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact verifier tells an UNREADABLE version apart from a too-old one", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "postgres-runtime.json");
    const runtime = JSON.parse(await readFile(path, "utf8"));
    delete runtime.serverVersion;
    await writeJson(path, runtime);
    // A broken capture and a wrong server are different operator actions, so the
    // two refusals must not share a message.
    await assert.rejects(
      verifyEvidenceArtifactDirectory(directory),
      /carries no readable PostgreSQL version/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the floor ADMITS the newer server the suites were re-proven against", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "postgres-runtime.json");
    const runtime = JSON.parse(await readFile(path, "utf8"));
    runtime.serverVersion = "17.10 (Homebrew)";
    await writeJson(path, runtime);
    const result = await verifyEvidenceArtifactDirectory(directory);
    assert.equal(result.suites, SUITE_CONTRACT.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixtureDirectory() {
  const directory = await mkdtemp(resolve(tmpdir(), "platos-postgres-evidence-"));
  await mkdir(resolve(directory, "suites"), { recursive: true });
  const suites = SUITE_CONTRACT.map((contract) => ({
    ...contract,
    passed: contract.expectedTests,
    failed: 0,
    skipped: 0,
  }));
  await writeJson(resolve(directory, "manifest.json"), {
    schemaVersion: 1,
    gate: "win236-win237-postgres-evidence",
    status: "passed",
    commitSha: "a".repeat(40),
    suites,
    totals: { tests: 14, failed: 0, skipped: 0 },
    evidence: {
      queryCounts: QUERY_COUNT_CONTRACT.map(({ file }) => file),
      explains: EXPLAIN_CONTRACT.map(({ file }) => file),
      runtime: "postgres-runtime.json",
    },
  });
  for (const contract of SUITE_CONTRACT) {
    await writeJson(resolve(directory, "suites", `${contract.slug}.json`), {
      numTotalTests: contract.expectedTests,
      numPassedTests: contract.expectedTests,
      numFailedTests: 0,
      numPendingTests: 0,
      numFailedTestSuites: 0,
      numPendingTestSuites: 0,
    });
  }
  await writeJson(resolve(directory, "postgres-runtime.json"), {
    kind: "postgres-runtime",
    serverVersion: "16.4",
    pgvectorVersion: "0.8.0",
  });
  for (const contract of QUERY_COUNT_CONTRACT) {
    await writeJson(resolve(directory, contract.file), {
      kind: "query-count",
      queryCount: 4,
      endpoint: contract.endpoint,
      fixtureRows: contract.fixtureRows,
      maximumQueryCount: contract.maximumQueryCount,
    });
  }
  for (const contract of EXPLAIN_CONTRACT) {
    await writeJson(resolve(directory, contract.file), {
      kind: "postgres-explain",
      endpoint: contract.endpoint,
      options: ["ANALYZE", "BUFFERS", "FORMAT JSON"],
      bounded: {
        statementTimeoutMs: 15_000,
        rowLimit: contract.rowLimit,
        maximumArtifactBytes: 262_144,
      },
      plans: Object.fromEntries(
        contract.plans.map((planName) => [planName, capturedPlan(planName)])
      ),
    });
  }
  return directory;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function capturedPlan(planName) {
  const normalizedSql = `SELECT * FROM "public"."Fixture" WHERE "plan" = $1 /* ${planName} */`;
  return {
    source: "captured-prisma-query",
    normalizedSql,
    normalizedSqlSha256: createHash("sha256").update(normalizedSql).digest("hex"),
    plan: [{ Plan: { "Actual Rows": planName === "count" ? 1 : 50, "Shared Hit Blocks": 4 } }],
  };
}
