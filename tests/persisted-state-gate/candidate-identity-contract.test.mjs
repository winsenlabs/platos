import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

function source(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("persisted-state evidence never binds artifacts to GitHub's synthetic merge SHA", () => {
  const integration = source("apps/webapp/test/persistedStateGate.integration.test.ts");
  const postgresEvidence = source("tests/postgres-memory-evidence/run.mjs");

  for (const [name, contents] of [
    ["persisted-state integration", integration],
    ["PostgreSQL memory evidence", postgresEvidence],
  ]) {
    assert.doesNotMatch(contents, /process\.env\.GITHUB_SHA/, `${name} uses the synthetic merge SHA`);
    assert.match(contents, /process\.env\.PLATOS_CANDIDATE_SHA/, `${name} is not candidate-bound`);
  }
  assert.match(
    integration,
    /commitSha:\s*expectedCommit/,
    "persisted-state results do not reuse the verified candidate identity"
  );
});
