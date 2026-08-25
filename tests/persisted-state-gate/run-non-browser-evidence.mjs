#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractPath, verifyNonBrowserEvidence } from "./verify-non-browser-evidence.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const suitePath = "src/integration/non-browser-completion-postgres.integration.test.ts";

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

export function runIdentity(env = process.env) {
  const candidateSha = requiredEnvironment(env, "PLATOS_CANDIDATE_SHA");
  assert.match(
    candidateSha,
    /^[a-f0-9]{40}$/,
    "PLATOS_CANDIDATE_SHA must be an exact lowercase commit SHA"
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(candidateSha, head, "PLATOS_CANDIDATE_SHA does not match exact HEAD");
  const runId = env.PLATOS_EVIDENCE_RUN_ID?.trim() || requiredEnvironment(env, "GITHUB_RUN_ID");
  assert.match(runId, /^[A-Za-z0-9_.:-]{1,128}$/, "evidence run ID is invalid");
  if (env.PLATOS_EVIDENCE_RUN_ID && env.GITHUB_RUN_ID) {
    assert.equal(
      env.PLATOS_EVIDENCE_RUN_ID,
      env.GITHUB_RUN_ID,
      "PLATOS_EVIDENCE_RUN_ID must exactly match GITHUB_RUN_ID"
    );
  }
  return { candidateSha, runId };
}

export function validateVitestReport(report, contract) {
  assert.equal(report.numTotalTests, contract.suiteTestCount, "suite test count drifted");
  assert.equal(report.numPassedTests, contract.suiteTestCount, "not every suite test passed");
  assert.equal(report.numFailedTests, 0, "suite reported failed tests");
  assert.equal(report.numPendingTests, 0, "suite reported skipped or pending tests");
  assert.equal(report.testResults?.length, 1, "runner did not execute exactly one test file");
  assert.match(
    report.testResults[0]?.name ?? "",
    /non-browser-completion-postgres\.integration\.test\.ts$/,
    "runner executed an unexpected test file"
  );
  assert.equal(report.testResults[0]?.status, "passed", "integration suite did not pass");
  const skippedAssertions = (report.testResults[0]?.assertionResults ?? []).filter(
    (item) => item.status === "pending" || item.status === "skipped" || item.status === "todo"
  );
  assert.equal(skippedAssertions.length, 0, "suite contains skipped assertions");
}

export async function runNonBrowserEvidence({
  env = process.env,
  execute = execFileSync,
  now = () => new Date(),
} = {}) {
  requiredEnvironment(env, "DATABASE_URL");
  const identity = runIdentity(env);
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const outputPath = path.resolve(
    repositoryRoot,
    env.PLATOS_NON_BROWSER_EVIDENCE_OUTPUT ?? "artifacts/win235/non-browser-evidence.json"
  );
  const reportPath = path.join(path.dirname(outputPath), "non-browser-vitest-report.json");
  const runStartedAt = now().toISOString();

  await mkdir(path.dirname(outputPath), { recursive: true });
  await Promise.all([rm(outputPath, { force: true }), rm(reportPath, { force: true })]);

  execute(
    "pnpm",
    [
      "--filter",
      "platos-agent",
      "exec",
      "vitest",
      "run",
      suitePath,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      cwd: repositoryRoot,
      stdio: "inherit",
      env: {
        ...env,
        PLATOS_NON_BROWSER_EVIDENCE_REQUIRED: "1",
        PLATOS_NON_BROWSER_EVIDENCE_OUTPUT: outputPath,
        PLATOS_NON_BROWSER_EVIDENCE_CANDIDATE_SHA: identity.candidateSha,
        PLATOS_NON_BROWSER_EVIDENCE_RUN_ID: identity.runId,
      },
    }
  );

  const report = JSON.parse(await readFile(reportPath, "utf8"));
  validateVitestReport(report, contract);
  const result = JSON.parse(await readFile(outputPath, "utf8"));
  await verifyNonBrowserEvidence({
    contract,
    result,
    expectedCandidateSha: identity.candidateSha,
    expectedRunId: identity.runId,
    now: now().getTime(),
    runStartedAt,
  });
  process.stdout.write(
    `Verified ${contract.assertions.length} non-browser cells for ${identity.candidateSha} in run ${identity.runId}\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runNonBrowserEvidence();
}
