import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  EXPLAIN_CONTRACT,
  QUERY_COUNT_CONTRACT,
  SUITE_CONTRACT,
  verifyEvidenceArtifactDirectory,
} from "./verify-artifacts.mjs";

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
