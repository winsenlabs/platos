#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const contractPath = path.join(
  repositoryRoot,
  "tests/persisted-state-gate/non-browser-evidence-contract.json"
);

function exactSha(value, name) {
  assert.match(value ?? "", /^[a-f0-9]{40}$/, `${name} must be an exact lowercase commit SHA`);
  return value;
}

function exactRunId(value, name) {
  assert.match(
    value ?? "",
    /^[A-Za-z0-9_.:-]{1,128}$/,
    `${name} must be a stable non-empty run ID`
  );
  return value;
}

export async function verifyNonBrowserEvidence({
  contract,
  result,
  expectedCandidateSha,
  expectedRunId,
  now = Date.now(),
  runStartedAt,
}) {
  assert.equal(contract.schemaVersion, 2, "unsupported non-browser evidence contract");
  const candidateSha = exactSha(expectedCandidateSha, "expected candidate SHA");
  const runId = exactRunId(expectedRunId, "expected run ID");

  assert.equal(result.schemaVersion, contract.schemaVersion, "result schema version drifted");
  assert.equal(result.gate, contract.gate, "unexpected non-browser evidence gate");
  assert.equal(result.suite, contract.suite, "result names a different integration suite");
  assert.equal(result.requiredEvidence, true, "suite did not run in required evidence mode");
  assert.equal(result.commitSha, candidateSha, "artifact commit SHA does not match the candidate");
  assert.equal(result.runId, runId, "artifact run ID does not match the current run");
  assert.equal(result.database?.provider, "postgresql", "evidence was not produced by PostgreSQL");
  assert.match(
    result.database?.serverVersion ?? "",
    /^PostgreSQL\s+\d+/i,
    "PostgreSQL server version is absent"
  );

  const generatedAt = Date.parse(result.generatedAt ?? "");
  assert.ok(Number.isFinite(generatedAt), "artifact generatedAt is absent or invalid");
  assert.ok(generatedAt <= now + 5_000, "artifact generatedAt is in the future");
  assert.ok(now - generatedAt <= contract.maxArtifactAgeMs, "artifact is stale");
  if (runStartedAt !== undefined) {
    const startedAt = Date.parse(runStartedAt);
    assert.ok(Number.isFinite(startedAt), "runner start time is invalid");
    assert.ok(generatedAt >= startedAt, "artifact predates the current runner invocation");
  }

  assert.equal(
    contract.assertions.length,
    18,
    "non-browser contract must contain exactly 18 cells"
  );
  const expectedIds = new Set();
  const expectedCells = new Set();
  for (const item of contract.assertions) {
    assert.ok(!expectedIds.has(item.id), `duplicate contract assertion id ${item.id}`);
    expectedIds.add(item.id);
    const cell = `${item.capabilityId}.${item.category}`;
    assert.ok(!expectedCells.has(cell), `duplicate contract completion cell ${cell}`);
    expectedCells.add(cell);
    assert.deepEqual(
      Object.keys(item.expectedFacts).sort(),
      ["foreignState", "readBack", "recovery", "stableError"],
      `${item.id} contract facts are incomplete`
    );
  }

  assert.equal(
    result.assertions?.length,
    contract.assertions.length,
    "runtime assertion count drifted"
  );
  const runtimeById = new Map();
  for (const item of result.assertions ?? []) {
    assert.ok(!runtimeById.has(item.id), `duplicate runtime assertion id ${item.id}`);
    runtimeById.set(item.id, item);
  }

  for (const expected of contract.assertions) {
    const observed = runtimeById.get(expected.id);
    assert.ok(observed, `missing runtime assertion ${expected.id}`);
    assert.deepEqual(
      Object.keys(observed).sort(),
      ["capabilityId", "category", "facts", "id", "status"],
      `${expected.id} runtime assertion shape drifted`
    );
    assert.equal(observed.capabilityId, expected.capabilityId, `${expected.id} capability drifted`);
    assert.equal(observed.category, expected.category, `${expected.id} category drifted`);
    assert.equal(observed.status, "passed", `${expected.id} did not pass`);
    assert.deepEqual(observed.facts, expected.expectedFacts, `${expected.id} facts drifted`);
  }

  for (const id of runtimeById.keys()) {
    assert.ok(expectedIds.has(id), `unexpected runtime assertion ${id}`);
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function cliValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function cliResultPath() {
  const values = process.argv.slice(2);
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--candidate-sha" || values[index] === "--run-id") {
      index += 1;
      continue;
    }
    if (!values[index].startsWith("--")) return values[index];
  }
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resultPath = path.resolve(cliResultPath() ?? "artifacts/win235/non-browser-evidence.json");
  const expectedCandidateSha = cliValue("--candidate-sha") ?? process.env.PLATOS_CANDIDATE_SHA;
  const expectedRunId =
    cliValue("--run-id") ??
    process.env.PLATOS_NON_BROWSER_EVIDENCE_RUN_ID ??
    process.env.GITHUB_RUN_ID;
  await verifyNonBrowserEvidence({
    contract: await readJson(contractPath),
    result: await readJson(resultPath),
    expectedCandidateSha,
    expectedRunId,
  });
  process.stdout.write(`Verified 18 non-browser completion cells from ${resultPath}\n`);
}
