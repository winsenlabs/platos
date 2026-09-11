import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  auditNonBrowserCompletionEvidence,
  auditValidatedCompletionEvidence,
  NON_BROWSER_RESIDUE,
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

// ── THE NON-BROWSER HALF, CLAIMED ON ITS OWN (M4 finish) ───────────────────
//
// The completion gate is red at 125 and the committed matrix is PINNED to that
// shape, so the 18 non-browser cells were never closable by editing a status. They
// close through a runtime artifact — and the only path that consumed one also
// demanded digest-pinned candidate images from a job that is red on `v1`. So 18
// REACHABLE cells were unreportable because 107 unreachable ones were, and "the
// number went down by about 18" was the best anybody could say.
//
// These cases make it exact: promoting the 18 leaves EXACTLY browser evidence 107
// and nothing else — no idempotency cell, no concurrency cell, no persisted-state
// cell — and the fall is checked against the committed matrix's own blocker count
// rather than against the constant 125.

test("closing the 18 non-browser cells leaves exactly 107 browser blockers and nothing else", async () => {
  const value = fixture();
  const original = clone(value.matrix);
  const result = await auditNonBrowserCompletionEvidence({
    matrix: value.matrix,
    contract: value.contract,
    nonBrowserResult: value.nonBrowserResult,
    candidateSha: SHA,
    runId: RUN_ID,
    now: NOW,
  });
  assert.deepEqual(result, {
    candidateSha: SHA,
    runId: RUN_ID,
    nonBrowserCells: 18,
    blockersBefore: 125,
    blockersAfter: 107,
    remaining: [{ category: "browser evidence", count: 107 }],
  });
  assert.deepEqual(result.remaining, NON_BROWSER_RESIDUE.map((entry) => ({ ...entry })));
  assert.deepEqual(value.matrix, original, "the committed matrix fixture was mutated");
});

test("the residue is asserted, so a matrix that grows a NON-browser blocker fails", async () => {
  const value = fixture();
  // One capability's recovery cell falls out of the accepted set. It is not one of
  // the 18, so the evidence cannot close it and the residue stops being browser
  // evidence alone — which is the claim, rather than "the count went down".
  const victim = value.matrix.capabilities.find(
    (capability) => !value.contract.assertions.some((cell) => cell.capabilityId === capability.capabilityId),
  );
  assert.ok(victim, "every capability is named by the contract, so this control is vacuous");
  victim.recovery.status = "required-not-verified";
  await assert.rejects(
    auditNonBrowserCompletionEvidence({
      matrix: value.matrix,
      contract: value.contract,
      nonBrowserResult: value.nonBrowserResult,
      candidateSha: SHA,
      runId: RUN_ID,
      now: NOW,
    }),
    /committed matrix no longer has the exact expected-red completion shape|other than browser evidence/,
  );
});

test("the non-browser audit still refuses evidence that is not this HEAD's", async () => {
  const value = fixture();
  value.nonBrowserResult.commitSha = "0".repeat(40);
  await assert.rejects(
    auditNonBrowserCompletionEvidence({
      matrix: value.matrix,
      contract: value.contract,
      nonBrowserResult: value.nonBrowserResult,
      candidateSha: SHA,
      runId: RUN_ID,
      now: NOW,
    }),
    /artifact commit SHA does not match the candidate/,
  );
});

test("the non-browser audit needs no browser reference at all", () => {
  // The whole reason it exists as a separate entry point: `auditValidatedCompletionEvidence`
  // takes a `browserReference` and validates 428 visual cells against digest-pinned
  // candidate images. This one's parameter list cannot ask for one.
  const parameters = auditNonBrowserCompletionEvidence.toString();
  assert.ok(!parameters.includes("browserReference"), "the non-browser audit reads a browser reference");
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
