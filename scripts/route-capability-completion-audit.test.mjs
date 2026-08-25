import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditValidatedCompletionEvidence,
  exactRunIdentity,
  readCommittedMatrix,
  runEvidenceBackedCompletionAudit,
} from "./route-capability-completion-audit.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const RUN_ID = "completion-audit-test-123";
const NOW = Date.parse("2026-08-25T08:00:00.000Z");

function clone(value) {
  return structuredClone(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const matrixBytes = readFileSync(
    path.join(ROOT, "docs/audits/win-234-route-capability-parity.json")
  );
  const matrix = JSON.parse(matrixBytes.toString("utf8"));
  const contract = JSON.parse(
    readFileSync(
      path.join(ROOT, "tests/persisted-state-gate/non-browser-evidence-contract.json"),
      "utf8"
    )
  );
  const nonBrowserResult = {
    schemaVersion: contract.schemaVersion,
    gate: contract.gate,
    suite: contract.suite,
    requiredEvidence: true,
    commitSha: SHA,
    runId: RUN_ID,
    generatedAt: "2026-08-25T07:59:30.000Z",
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
  const cells = matrix.capabilities.flatMap(({ capabilityId }) =>
    ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"].map((visualMode) => ({
      capabilityId,
      visualMode,
    }))
  );
  const browserReference = {
    commitSha: SHA,
    matrixSha256: sha256(matrixBytes),
    candidateImages: {
      commitSha: SHA,
      agent: `ghcr.io/winsenlabs/agent@sha256:${"a".repeat(64)}`,
      webapp: `ghcr.io/winsenlabs/webapp@sha256:${"b".repeat(64)}`,
      migrations: `ghcr.io/winsenlabs/migrations@sha256:${"c".repeat(64)}`,
    },
    coverage: { capabilities: 107, cells: 428 },
    cells,
  };
  return {
    matrix,
    matrixBytes,
    contract,
    nonBrowserResult,
    browserReference,
    candidateSha: SHA,
    runId: RUN_ID,
    now: NOW,
  };
}

test("promotes exactly 18 non-browser cells and 107 browser fields only in memory", async () => {
  const value = fixture();
  const original = clone(value.matrix);
  const result = await auditValidatedCompletionEvidence(value);
  assert.deepEqual(result, {
    candidateSha: SHA,
    runId: RUN_ID,
    nonBrowserCells: 18,
    browserFields: 107,
    unresolvedCells: 0,
  });
  assert.deepEqual(value.matrix, original, "the committed matrix fixture was mutated");
});

test("reads the capability matrix from exact HEAD instead of the dirty worktree", () => {
  const committed = readCommittedMatrix({ candidateSha: SHA, repositoryRoot: ROOT });
  const expected = execFileSync(
    "git",
    ["show", `${SHA}:docs/audits/win-234-route-capability-parity.json`],
    { cwd: ROOT }
  );
  assert.deepEqual(committed.bytes, expected);
  assert.equal(committed.matrix.capabilities.length, 107);
  assert.equal(
    committed.matrix.capabilities.every(
      ({ browserEvidence }) => browserEvidence.status === "required-not-verified"
    ),
    true
  );
});

for (const [name, mutate, pattern] of [
  [
    "stale non-browser evidence",
    (value) => (value.nonBrowserResult.generatedAt = "2026-08-25T07:00:00.000Z"),
    /artifact is stale/,
  ],
  [
    "wrong-SHA non-browser evidence",
    (value) => (value.nonBrowserResult.commitSha = "d".repeat(40)),
    /does not match the candidate/,
  ],
  [
    "wrong-run non-browser evidence",
    (value) => (value.nonBrowserResult.runId = "prior-run"),
    /does not match the current run/,
  ],
  [
    "incomplete non-browser evidence",
    (value) => value.nonBrowserResult.assertions.pop(),
    /runtime assertion count drifted/,
  ],
  [
    "mismatched committed matrix hash",
    (value) => (value.browserReference.matrixSha256 = "e".repeat(64)),
    /matrix hash does not match the committed matrix/,
  ],
  [
    "wrong browser candidate identity",
    (value) => (value.browserReference.candidateImages.commitSha = "f".repeat(40)),
    /candidate images are not exact HEAD/,
  ],
  [
    "missing browser capability ID",
    (value) => {
      const missing = value.matrix.capabilities[0].capabilityId;
      value.browserReference.cells = value.browserReference.cells.filter(
        ({ capabilityId }) => capabilityId !== missing
      );
      value.browserReference.cells.push(
        ...["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"].map((visualMode) => ({
          capabilityId: "unexpected-capability",
          visualMode,
        }))
      );
    },
    /browser evidence capability IDs is not exact/,
  ],
  [
    "extra non-browser capability ID",
    (value) => {
      value.contract.assertions[0].capabilityId = "unexpected-capability";
      value.nonBrowserResult.assertions[0].capabilityId = "unexpected-capability";
    },
    /non-browser contract completion cells is not exact/,
  ],
]) {
  test(`rejects ${name}`, async () => {
    const value = fixture();
    mutate(value);
    await assert.rejects(auditValidatedCompletionEvidence(value), pattern);
  });
}

test("rejects missing exact-run identity before reading evidence", () => {
  assert.throws(
    () => exactRunIdentity({ env: {}, repositoryRoot: ROOT }),
    /PLATOS_CANDIDATE_SHA is required/
  );
  assert.throws(
    () => exactRunIdentity({ env: { PLATOS_CANDIDATE_SHA: SHA }, repositoryRoot: ROOT }),
    /GITHUB_RUN_ID is required/
  );
});

test("rejects a PLATOS_CANDIDATE_SHA that is not exact HEAD", () => {
  assert.throws(
    () =>
      exactRunIdentity({
        env: { PLATOS_CANDIDATE_SHA: "a".repeat(40), GITHUB_RUN_ID: RUN_ID },
        repositoryRoot: ROOT,
      }),
    /does not match exact HEAD/
  );
});

test("rejects missing non-browser evidence and missing browser evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "route-completion-audit-"));
  const env = {
    PLATOS_CANDIDATE_SHA: SHA,
    GITHUB_RUN_ID: RUN_ID,
    PLATOS_NON_BROWSER_EVIDENCE_OUTPUT: path.join(root, "missing-non-browser.json"),
    WIN234_BROWSER_ARTIFACT_DIR: path.join(root, "missing-browser"),
  };
  try {
    await assert.rejects(
      runEvidenceBackedCompletionAudit({ env, repositoryRoot: ROOT, now: NOW }),
      /ENOENT/
    );

    const value = fixture();
    const nonBrowserPath = path.join(root, "non-browser.json");
    await writeFile(nonBrowserPath, `${JSON.stringify(value.nonBrowserResult, null, 2)}\n`, "utf8");
    await assert.rejects(
      runEvidenceBackedCompletionAudit({
        env: { ...env, PLATOS_NON_BROWSER_EVIDENCE_OUTPUT: nonBrowserPath },
        repositoryRoot: ROOT,
        now: NOW,
      }),
      /ENOENT/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary pnpm audit:route-parity:completion remains red without artifacts", () => {
  const result = spawnSync("pnpm", ["audit:route-parity:completion"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /completion gate is RED \(125 actionable blockers across 4 categories\)/
  );
});
