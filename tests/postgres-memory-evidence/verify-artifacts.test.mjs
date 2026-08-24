import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SUITE_CONTRACT, verifyEvidenceArtifactDirectory } from "./verify-artifacts.mjs";

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

test("artifact verifier rejects non-ANALYZE plans", async () => {
  const directory = await fixtureDirectory();
  try {
    const path = resolve(directory, "memory-dense-page.explain.json");
    const evidence = JSON.parse(await readFile(path, "utf8"));
    delete evidence.plans.items[0].Plan["Actual Rows"];
    delete evidence.plans.count[0].Plan["Actual Rows"];
    await writeJson(path, evidence);
    await assert.rejects(verifyEvidenceArtifactDirectory(directory), /did not execute ANALYZE/);
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
  for (const name of [
    "memory-semantic-search.query-count.json",
    "memory-dense-page.query-count.json",
    "knowledge-graph-dense-page.query-count.json",
  ]) {
    await writeJson(resolve(directory, name), {
      kind: "query-count",
      queryCount: 4,
      maximumQueryCount: 8,
    });
  }
  for (const name of [
    "memory-semantic-search.explain.json",
    "memory-dense-page.explain.json",
    "knowledge-graph-dense-page.explain.json",
  ]) {
    await writeJson(resolve(directory, name), {
      kind: "postgres-explain",
      options: ["ANALYZE", "BUFFERS", "FORMAT JSON"],
      bounded: { statementTimeoutMs: 15_000, rowLimit: 50, maximumArtifactBytes: 262_144 },
      plans: {
        items: [{ Plan: { "Actual Rows": 50, "Shared Hit Blocks": 4 } }],
        count: [{ Plan: { "Actual Rows": 1, "Shared Hit Blocks": 4 } }],
      },
    });
  }
  return directory;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
