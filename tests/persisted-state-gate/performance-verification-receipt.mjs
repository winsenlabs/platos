import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const PERFORMANCE_ARTIFACT_FILE = "performance-results.json";
export const PERFORMANCE_RECEIPT_FILE = "performance-verification-receipt.json";

export function createPerformanceVerificationReceipt(artifact, performanceArtifactRaw) {
  return {
    $schema: "./performance-verification-receipt.schema.json",
    schemaVersion: 1,
    gate: "win235-measured-performance-verification",
    status: "passed",
    commitSha: artifact.commitSha,
    performanceArtifact: {
      file: PERFORMANCE_ARTIFACT_FILE,
      sha256: sha256(performanceArtifactRaw),
    },
    budgetContract: artifact.budgetContract,
    fixtureSha256: artifact.fixture.sha256,
  };
}

export function verifyPerformanceVerificationReceipt(
  receipt,
  performanceArtifactRaw,
  expectedCommit
) {
  const performanceArtifact = JSON.parse(performanceArtifactRaw);
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "$schema",
      "budgetContract",
      "commitSha",
      "fixtureSha256",
      "gate",
      "performanceArtifact",
      "schemaVersion",
      "status",
    ].sort(),
    "performance verification receipt fields drifted"
  );
  assert.equal(receipt.$schema, "./performance-verification-receipt.schema.json");
  assert.equal(receipt.schemaVersion, 1, "unexpected performance receipt schema version");
  assert.equal(
    receipt.gate,
    "win235-measured-performance-verification",
    "unexpected performance receipt gate"
  );
  assert.equal(receipt.status, "passed", "measured performance verification did not pass");
  assert.equal(
    receipt.commitSha,
    expectedCommit,
    "performance verification receipt is not bound to the exact candidate SHA"
  );
  assert.deepEqual(
    Object.keys(receipt.performanceArtifact ?? {}).sort(),
    ["file", "sha256"],
    "performance receipt artifact binding fields drifted"
  );
  assert.equal(receipt.performanceArtifact.file, PERFORMANCE_ARTIFACT_FILE);
  assert.equal(
    receipt.performanceArtifact.sha256,
    sha256(performanceArtifactRaw),
    "performance verification receipt does not match performance-results.json"
  );
  assert.equal(
    performanceArtifact.status,
    "measured",
    "performance-results.json is not a measured artifact"
  );
  assert.equal(
    performanceArtifact.commitSha,
    expectedCommit,
    "performance-results.json is not bound to the exact candidate SHA"
  );
  assert.deepEqual(
    receipt.budgetContract,
    performanceArtifact.budgetContract,
    "performance receipt budget binding drifted"
  );
  assert.equal(
    receipt.fixtureSha256,
    performanceArtifact.fixture?.sha256,
    "performance receipt fixture binding drifted"
  );
  return receipt;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
