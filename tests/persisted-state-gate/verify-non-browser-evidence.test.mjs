import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { contractPath, verifyNonBrowserEvidence } from "./verify-non-browser-evidence.mjs";

const clone = (value) => structuredClone(value);
const candidateSha = "a".repeat(40);
const runId = "run-123";
const now = Date.parse("2026-08-25T06:00:00.000Z");
const runStartedAt = "2026-08-25T05:59:00.000Z";

function passingResult(contract) {
  return {
    schemaVersion: contract.schemaVersion,
    gate: contract.gate,
    suite: contract.suite,
    requiredEvidence: true,
    commitSha: candidateSha,
    runId,
    generatedAt: "2026-08-25T05:59:30.000Z",
    database: {
      provider: "postgresql",
      serverVersion: "PostgreSQL 16.4",
    },
    assertions: contract.assertions.map((item) => ({
      id: item.id,
      capabilityId: item.capabilityId,
      category: item.category,
      status: "passed",
      facts: clone(item.expectedFacts),
    })),
  };
}

async function fixture() {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  return {
    contract,
    result: passingResult(contract),
    expectedCandidateSha: candidateSha,
    expectedRunId: runId,
    now,
    runStartedAt,
  };
}

test("accepts exact fresh candidate-bound facts for all 18 PostgreSQL cells", async () => {
  await assert.doesNotReject(verifyNonBrowserEvidence(await fixture()));
});

for (const [name, mutate, pattern] of [
  [
    "missing assertion",
    (value) => value.result.assertions.pop(),
    /runtime assertion count drifted/,
  ],
  [
    "duplicate assertion",
    (value) => (value.result.assertions[1] = clone(value.result.assertions[0])),
    /duplicate runtime assertion id/,
  ],
  ["failed assertion", (value) => (value.result.assertions[0].status = "failed"), /did not pass/],
  [
    "non-PostgreSQL result",
    (value) => (value.result.database.provider = "sqlite"),
    /not produced by PostgreSQL/,
  ],
  ["null SHA", (value) => (value.result.commitSha = null), /does not match the candidate/],
  [
    "wrong SHA",
    (value) => (value.result.commitSha = "b".repeat(40)),
    /does not match the candidate/,
  ],
  ["wrong run ID", (value) => (value.result.runId = "prior-run"), /does not match the current run/],
  ["missing generatedAt", (value) => delete value.result.generatedAt, /generatedAt is absent/],
  [
    "stale artifact",
    (value) => (value.result.generatedAt = "2026-08-25T05:00:00.000Z"),
    /artifact is stale|predates/,
  ],
  [
    "artifact from before this runner",
    (value) => (value.result.generatedAt = "2026-08-25T05:58:59.999Z"),
    /predates the current runner/,
  ],
  [
    "future artifact",
    (value) => (value.result.generatedAt = "2026-08-25T06:00:06.000Z"),
    /in the future/,
  ],
  [
    "wrong stable error status",
    (value) => (value.result.assertions[0].facts.stableError.status = 500),
    /facts drifted/,
  ],
  [
    "missing stable error code",
    (value) => delete value.result.assertions[0].facts.stableError.code,
    /facts drifted/,
  ],
  [
    "wrong foreign after count",
    (value) => (value.result.assertions[0].facts.foreignState.afterCount += 1),
    /facts drifted/,
  ],
  [
    "wrong recovery outcome",
    (value) => (value.result.assertions[0].facts.recovery.outcome = "claimed-only"),
    /facts drifted/,
  ],
  [
    "wrong read-back invariant",
    (value) => (value.result.assertions[0].facts.readBack.invariant = "different"),
    /facts drifted/,
  ],
  [
    "unexpected runtime assertion field",
    (value) => (value.result.assertions[0].selfReported = true),
    /runtime assertion shape drifted/,
  ],
  [
    "unrequired run",
    (value) => (value.result.requiredEvidence = false),
    /did not run in required evidence mode/,
  ],
]) {
  test(`rejects ${name}`, async () => {
    const value = await fixture();
    mutate(value);
    await assert.rejects(verifyNonBrowserEvidence(value), pattern);
  });
}
