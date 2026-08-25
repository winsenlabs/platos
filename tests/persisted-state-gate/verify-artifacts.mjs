#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PERFORMANCE_RECEIPT_FILE,
  verifyPerformanceVerificationReceipt,
} from "./performance-verification-receipt.mjs";

const artifactDirectory = path.resolve(process.argv[2] ?? "artifacts/win235");
const fixture = JSON.parse(
  await readFile(path.join(artifactDirectory, "fixture-manifest.json"), "utf8")
);
const result = JSON.parse(
  await readFile(path.join(artifactDirectory, "gate-results.json"), "utf8")
);
const candidateImages = JSON.parse(
  await readFile(path.join(artifactDirectory, "candidate-images.json"), "utf8")
);
const performanceArtifactRaw = await readFile(
  path.join(artifactDirectory, "performance-results.json"),
  "utf8"
);
const performanceReceipt = JSON.parse(
  await readFile(path.join(artifactDirectory, PERFORMANCE_RECEIPT_FILE), "utf8")
);
const { sha256, ...fixtureBody } = fixture;
const calculatedSha = createHash("sha256")
  .update(`${JSON.stringify(fixtureBody, null, 2)}\n`)
  .digest("hex");
assert.equal(sha256, calculatedSha, "fixture manifest SHA-256 does not match its canonical body");
assert.equal(result.gate, "win235-persisted-state", "unexpected persisted-state gate name");
assert.equal(
  result.commitSha,
  candidateImages.commitSha,
  "gate result and candidate images use different commits"
);
verifyPerformanceVerificationReceipt(
  performanceReceipt,
  performanceArtifactRaw,
  candidateImages.commitSha
);
assert.deepEqual(
  result.images,
  {
    agent: candidateImages.agent,
    webapp: candidateImages.webapp,
    migrations: candidateImages.migrations,
  },
  "gate result does not identify the exact tested candidate images"
);
for (const [name, image] of Object.entries(result.images)) {
  assert.match(
    image,
    /^ghcr\.io\/.+@sha256:[a-f0-9]{64}$/,
    `${name} is not an immutable GHCR digest`
  );
}
assert.equal(result.status, "passed", "persisted-state integration result is not green");
assert.deepEqual(
  result.measurements,
  {
    status: "enforced",
    budgetsFile: "tests/persisted-state-gate/budgets.v1.json",
    performanceArtifact: "performance-results.json",
    performanceReceipt: PERFORMANCE_RECEIPT_FILE,
  },
  "persisted-state result is not bound to enforced performance evidence"
);
assert.equal(result.fixture.sha256, fixture.sha256, "gate result references a different fixture");
assert.deepEqual(result.fixture.counts, fixture.counts, "gate result fixture counts drifted");
assert.ok(result.assertions.length > 0, "gate result contains no integration assertions");
assert.equal(
  result.assertions.filter((item) => item.status !== "passed").length,
  0,
  "gate result contains failed or unknown assertions"
);
const passedAssertions = new Map(
  result.assertions.filter((item) => item.status === "passed").map((item) => [item.id, item])
);
const liveRegressionProofs = {
  "mismatched enum": "negative.enum-mismatch",
  "false total": "loader.agents.persisted-total",
  "missing action contract": "action.agent.update",
  "broken generated link": "loader.agents.generated-link",
  "non-persisted mutation": "action.memory.import",
};
for (const [regression, assertionId] of Object.entries(liveRegressionProofs)) {
  assert.ok(
    passedAssertions.has(assertionId),
    `${regression} has no passing live Remix/controller/read-back assertion (${assertionId})`
  );
}
assert.equal(
  passedAssertions.get("negative.enum-mismatch").readBack.persisted,
  false,
  "mismatched enum probe persisted data"
);
assert.equal(
  passedAssertions.get("loader.agents.persisted-total").readBack.total,
  passedAssertions.get("loader.agents.persisted-total").readBack.persistedTotal,
  "live Remix collection total does not match persisted scope density"
);
assert.equal(
  passedAssertions.get("action.agent.update").readBack.versions,
  2,
  "live Agent update action did not persist its new version"
);
assert.match(
  passedAssertions.get("loader.agents.generated-link").readBack.href,
  /\/agents\/[a-f0-9-]{36}$/,
  "server-rendered Agent link does not target a persisted Agent identity"
);
assert.match(
  passedAssertions.get("action.memory.import").readBack.memoryId,
  /^[a-f0-9-]{36}$/,
  "live Memory import has no persisted read-back identity"
);

process.stdout.write(`WIN-235 artifacts verified for fixture ${fixture.sha256}\n`);
