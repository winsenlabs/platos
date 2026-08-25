import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  runIdentity,
  runNonBrowserEvidence,
  validateVitestReport,
} from "./run-non-browser-evidence.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = JSON.parse(
  readFileSync(
    path.join(repositoryRoot, "tests/persisted-state-gate/non-browser-evidence-contract.json"),
    "utf8"
  )
);
const candidateSha = "a".repeat(40);
const runId = "run-123";
const generatedAt = "2026-08-25T06:00:00.000Z";

function environment(outputPath) {
  return {
    DATABASE_URL: "postgresql://required:required@database:5432/required",
    GITHUB_SHA: candidateSha,
    GITHUB_RUN_ID: runId,
    PLATOS_CANDIDATE_SHA: candidateSha,
    PLATOS_EVIDENCE_RUN_ID: runId,
    PLATOS_NON_BROWSER_EVIDENCE_OUTPUT: outputPath,
  };
}

function passingReport() {
  return {
    numTotalTests: contract.suiteTestCount,
    numPassedTests: contract.suiteTestCount,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [
      {
        name: path.join(
          repositoryRoot,
          "apps/agent/src/integration/non-browser-completion-postgres.integration.test.ts"
        ),
        status: "passed",
        assertionResults: Array.from({ length: contract.suiteTestCount }, () => ({
          status: "passed",
        })),
      },
    ],
  };
}

function passingArtifact() {
  return {
    schemaVersion: contract.schemaVersion,
    gate: contract.gate,
    suite: contract.suite,
    requiredEvidence: true,
    commitSha: candidateSha,
    runId,
    generatedAt,
    database: { provider: "postgresql", serverVersion: "PostgreSQL 16.4" },
    assertions: contract.assertions.map((item) => ({
      id: item.id,
      capabilityId: item.capabilityId,
      category: item.category,
      status: "passed",
      facts: structuredClone(item.expectedFacts),
    })),
  };
}

test("runner deletes stale output, pins required identity, runs one suite, and verifies it", async () => {
  const directory = "/var/tmp/non-browser-runner-test";
  const outputPath = path.join(directory, "evidence.json");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  await writeFile(outputPath, "stale artifact\n");

  let executed = false;
  await runNonBrowserEvidence({
    env: environment(outputPath),
    now: () => new Date(generatedAt),
    execute(command, args, options) {
      executed = true;
      assert.equal(command, "pnpm");
      assert.deepEqual(args.slice(0, 7), [
        "--filter",
        "platos-agent",
        "exec",
        "vitest",
        "run",
        "src/integration/non-browser-completion-postgres.integration.test.ts",
        "--reporter=json",
      ]);
      assert.equal(
        existsSync(outputPath),
        false,
        "stale artifact was not deleted before execution"
      );
      assert.equal(options.env.PLATOS_NON_BROWSER_EVIDENCE_REQUIRED, "1");
      assert.equal(options.env.PLATOS_NON_BROWSER_EVIDENCE_CANDIDATE_SHA, candidateSha);
      assert.equal(options.env.PLATOS_NON_BROWSER_EVIDENCE_RUN_ID, runId);
      const reportPath = args.find((arg) => arg.startsWith("--outputFile=")).slice(13);
      writeFileSync(reportPath, `${JSON.stringify(passingReport())}\n`);
      writeFileSync(outputPath, `${JSON.stringify(passingArtifact())}\n`);
    },
  });
  assert.equal(executed, true);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).commitSha, candidateSha);
  await rm(directory, { recursive: true, force: true });
});

test("runner leaves no stale evidence when the suite command fails", async () => {
  const directory = "/var/tmp/non-browser-runner-failure-test";
  const outputPath = path.join(directory, "evidence.json");
  await mkdir(directory, { recursive: true });
  await writeFile(outputPath, "stale artifact\n");
  await assert.rejects(
    runNonBrowserEvidence({
      env: environment(outputPath),
      now: () => new Date(generatedAt),
      execute() {
        throw new Error("suite failed");
      },
    }),
    /suite failed/
  );
  assert.equal(existsSync(outputPath), false);
  await rm(directory, { recursive: true, force: true });
});

test("run identity rejects missing, malformed, and mismatched candidate metadata", () => {
  assert.throws(() => runIdentity({}), /GITHUB_SHA is required/);
  assert.throws(
    () => runIdentity({ GITHUB_SHA: "short", GITHUB_RUN_ID: runId }),
    /exact lowercase commit SHA/
  );
  assert.throws(
    () =>
      runIdentity({
        GITHUB_SHA: candidateSha,
        GITHUB_RUN_ID: runId,
        PLATOS_CANDIDATE_SHA: "b".repeat(40),
      }),
    /must exactly match GITHUB_SHA/
  );
  assert.throws(
    () =>
      runIdentity({
        GITHUB_SHA: candidateSha,
        GITHUB_RUN_ID: runId,
        PLATOS_EVIDENCE_RUN_ID: "other-run",
      }),
    /must exactly match GITHUB_RUN_ID/
  );
});

test("Vitest report rejects skipped tests, count drift, and extra files", () => {
  const skipped = passingReport();
  skipped.numPassedTests -= 1;
  skipped.numPendingTests = 1;
  skipped.testResults[0].assertionResults[0].status = "skipped";
  assert.throws(() => validateVitestReport(skipped, contract), /not every suite test passed/);

  const drifted = passingReport();
  drifted.numTotalTests -= 1;
  assert.throws(() => validateVitestReport(drifted, contract), /suite test count drifted/);

  const extra = passingReport();
  extra.testResults.push({ name: "unrelated.test.ts", status: "passed", assertionResults: [] });
  assert.throws(() => validateVitestReport(extra, contract), /exactly one test file/);
});
