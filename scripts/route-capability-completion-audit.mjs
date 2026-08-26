#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completionBlockers, runCompletionGate } from "./route-capability-parity.mjs";
import {
  contractPath,
  verifyNonBrowserEvidence,
} from "../tests/persisted-state-gate/verify-non-browser-evidence.mjs";
import { consumeValidatedBrowserEvidenceReference } from "../tests/browser-evidence/verify-artifacts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MATRIX_REPOSITORY_PATH = "docs/audits/win-234-route-capability-parity.json";
const NON_BROWSER_FIELDS = ["idempotency", "concurrency", "persistedReadBack"];
const VISUAL_MODE_COUNT = 4;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactSet(actual, expected, label) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  assert.equal(actualSet.size, actual.length, `${label} contains duplicates`);
  assert.deepEqual([...actualSet].sort(), [...expectedSet].sort(), `${label} is not exact`);
}

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

export function exactRunIdentity({
  env = process.env,
  repositoryRoot = ROOT,
  execute = execFileSync,
} = {}) {
  const candidateSha = requiredEnvironment(env, "PLATOS_CANDIDATE_SHA");
  assert.match(
    candidateSha,
    /^[a-f0-9]{40}$/,
    "PLATOS_CANDIDATE_SHA must be an exact lowercase commit SHA"
  );
  const runId = requiredEnvironment(env, "GITHUB_RUN_ID");
  assert.match(runId, /^[A-Za-z0-9_.:-]{1,128}$/, "GITHUB_RUN_ID must be a stable run ID");
  const head = execute("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert.equal(candidateSha, head, "PLATOS_CANDIDATE_SHA does not match exact HEAD");
  return { candidateSha, runId };
}

export function readCommittedMatrix({
  candidateSha,
  repositoryRoot = ROOT,
  execute = execFileSync,
} = {}) {
  const bytes = execute("git", ["show", `${candidateSha}:${MATRIX_REPOSITORY_PATH}`], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    bytes,
    matrix: JSON.parse(bytes.toString("utf8")),
  };
}

function expectedNonBrowserCells(matrix) {
  return matrix.capabilities.flatMap((capability) =>
    NON_BROWSER_FIELDS.filter((field) => capability[field].status === "required-not-verified").map(
      (field) => `${capability.capabilityId}.${field}`
    )
  );
}

function contractNonBrowserCells(contract) {
  return contract.assertions.map(({ capabilityId, category }) => `${capabilityId}.${category}`);
}

function validatePendingMatrix(matrix, contract) {
  assert.equal(
    matrix.capabilities.length,
    107,
    "committed matrix must contain exactly 107 capabilities"
  );
  const matrixCapabilityIds = matrix.capabilities.map(({ capabilityId }) => capabilityId);
  exactSet(matrixCapabilityIds, matrixCapabilityIds, "committed matrix capability IDs");

  const browserRows = matrix.capabilities.filter(
    ({ browserEvidence }) => browserEvidence.status === "required-not-verified"
  );
  assert.equal(
    browserRows.length,
    matrix.capabilities.length,
    "committed matrix browser evidence must remain required-not-verified"
  );

  const pendingCells = expectedNonBrowserCells(matrix);
  assert.equal(
    pendingCells.length,
    18,
    "committed matrix must contain exactly 18 pending non-browser cells"
  );
  exactSet(
    contractNonBrowserCells(contract),
    pendingCells,
    "non-browser contract completion cells"
  );

  assert.deepEqual(
    completionBlockers(matrix).map(({ category, count }) => ({ category, count })),
    [
      { category: "idempotency", count: 7 },
      { category: "concurrency", count: 9 },
      { category: "persisted-state evidence", count: 2 },
      { category: "browser evidence", count: 107 },
    ],
    "committed matrix no longer has the exact expected-red completion shape"
  );
}

function validateCandidateImages(candidateImages, candidateSha) {
  assert.deepEqual(
    Object.keys(candidateImages ?? {}).sort(),
    ["agent", "commitSha", "migrations", "webapp"],
    "browser candidate image identity shape drifted"
  );
  assert.equal(
    candidateImages.commitSha,
    candidateSha,
    "browser candidate images are not exact HEAD"
  );
  for (const name of ["agent", "webapp", "migrations"]) {
    assert.match(
      candidateImages[name],
      /^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/,
      `${name} browser candidate identity is not digest pinned`
    );
  }
}

function validateBrowserReference(reference, matrix, matrixSha256, candidateSha) {
  assert.equal(reference.commitSha, candidateSha, "browser evidence reference is not exact HEAD");
  assert.equal(
    reference.matrixSha256,
    matrixSha256,
    "browser evidence matrix hash does not match the committed matrix"
  );
  validateCandidateImages(reference.candidateImages, candidateSha);
  assert.equal(
    reference.coverage?.capabilities,
    107,
    "browser evidence does not cover 107 capabilities"
  );
  assert.equal(reference.coverage?.cells, 428, "browser evidence does not cover 428 visual cells");
  assert.equal(reference.cells?.length, 428, "browser evidence artifact index is incomplete");

  const matrixCapabilityIds = matrix.capabilities.map(({ capabilityId }) => capabilityId);
  const browserCapabilityIds = [
    ...new Set(reference.cells.map(({ capabilityId }) => capabilityId)),
  ];
  exactSet(browserCapabilityIds, matrixCapabilityIds, "browser evidence capability IDs");
  for (const capabilityId of matrixCapabilityIds) {
    assert.equal(
      reference.cells.filter((cell) => cell.capabilityId === capabilityId).length,
      VISUAL_MODE_COUNT,
      `${capabilityId} browser evidence does not contain four visual cells`
    );
  }
}

export async function auditValidatedCompletionEvidence({
  matrix,
  matrixBytes,
  contract,
  nonBrowserResult,
  browserReference,
  candidateSha,
  runId,
  now = Date.now(),
  completionGate = runCompletionGate,
}) {
  validatePendingMatrix(matrix, contract);
  await verifyNonBrowserEvidence({
    contract,
    result: nonBrowserResult,
    expectedCandidateSha: candidateSha,
    expectedRunId: runId,
    now,
  });

  const matrixHash = sha256(matrixBytes);
  validateBrowserReference(browserReference, matrix, matrixHash, candidateSha);

  const promoted = structuredClone(matrix);
  const promotedById = new Map(
    promoted.capabilities.map((capability) => [capability.capabilityId, capability])
  );
  for (const { capabilityId, category } of contract.assertions) {
    const capability = promotedById.get(capabilityId);
    assert.ok(capability, `non-browser evidence names unknown capability ${capabilityId}`);
    assert.equal(
      capability[category]?.status,
      "required-not-verified",
      `${capabilityId}.${category} is not a pending completion cell`
    );
    capability[category].status = "verified";
  }
  for (const capability of promoted.capabilities) {
    capability.browserEvidence.status = "verified";
  }

  completionGate(promoted, { allowRuntimeEvidencePromotion: true });
  const unresolved = completionBlockers(promoted).reduce((sum, blocker) => sum + blocker.count, 0);
  assert.equal(unresolved, 0, "validated evidence left unresolved completion cells");
  return {
    candidateSha,
    runId,
    nonBrowserCells: contract.assertions.length,
    browserFields: promoted.capabilities.length,
    unresolvedCells: unresolved,
  };
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function runEvidenceBackedCompletionAudit({
  env = process.env,
  repositoryRoot = ROOT,
  execute = execFileSync,
  now = Date.now(),
  consumeBrowserEvidence = consumeValidatedBrowserEvidenceReference,
} = {}) {
  const { candidateSha, runId } = exactRunIdentity({ env, repositoryRoot, execute });
  const { matrix, bytes: matrixBytes } = readCommittedMatrix({
    candidateSha,
    repositoryRoot,
    execute,
  });
  const nonBrowserEvidencePath = path.resolve(
    repositoryRoot,
    env.PLATOS_NON_BROWSER_EVIDENCE_OUTPUT ?? "artifacts/win235/non-browser-evidence.json"
  );
  const browserEvidenceDirectory = path.resolve(
    repositoryRoot,
    env.WIN234_BROWSER_ARTIFACT_DIR ?? "artifacts/win234-browser"
  );
  const [contract, nonBrowserResult] = await Promise.all([
    json(path.resolve(repositoryRoot, path.relative(ROOT, contractPath))),
    json(nonBrowserEvidencePath),
  ]);
  await verifyNonBrowserEvidence({
    contract,
    result: nonBrowserResult,
    expectedCandidateSha: candidateSha,
    expectedRunId: runId,
    now,
  });
  const browserReference = await consumeBrowserEvidence(browserEvidenceDirectory, {
    repositoryRoot,
    expectedHead: candidateSha,
  });
  return auditValidatedCompletionEvidence({
    matrix,
    matrixBytes,
    contract,
    nonBrowserResult,
    browserReference,
    candidateSha,
    runId,
    now,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runEvidenceBackedCompletionAudit();
    process.stdout.write(
      `WIN-234/WIN-238 exact-head completion audit is green: ${result.nonBrowserCells} non-browser cells, ${result.browserFields} browser fields, ${result.unresolvedCells} unresolved cells for ${result.candidateSha} run ${result.runId}.\n`
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
