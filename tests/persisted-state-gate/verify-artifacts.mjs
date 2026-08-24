#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
const budgets = JSON.parse(
  await readFile("tests/persisted-state-gate/budgets.unmeasured.json", "utf8")
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
assert.equal(result.fixture.sha256, fixture.sha256, "gate result references a different fixture");
assert.deepEqual(result.fixture.counts, fixture.counts, "gate result fixture counts drifted");
assert.ok(result.assertions.length > 0, "gate result contains no integration assertions");
assert.equal(
  result.assertions.filter((item) => item.status !== "passed").length,
  0,
  "gate result contains failed or unknown assertions"
);
assert.equal(
  result.measurements.status,
  "unmeasured",
  "this slice must not claim uncollected measurements"
);
assert.equal(
  budgets.measurementStatus,
  "unmeasured",
  "budget fixture must remain explicitly unmeasured"
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

for (const group of [budgets.performance, budgets.queries, budgets.bundles]) {
  for (const budget of group) {
    assert.equal(budget.baseline, null, `${budget.id} has an invented baseline`);
    assert.equal(budget.threshold, null, `${budget.id} has an invented threshold`);
    assert.equal(
      budget.measurementArtifact,
      null,
      `${budget.id} has an invented measurement artifact`
    );
  }
}

process.stdout.write(`WIN-235 artifacts verified for fixture ${fixture.sha256}\n`);
