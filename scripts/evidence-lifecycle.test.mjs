import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MANIFEST_PATH,
  DRAFT_PATH,
  POINT_IN_TIME_PATHS,
  STATUSES,
  SUPERSESSIONS,
  buildManifest,
  classifyLifecyclePath,
  deriveRulesLifecycle,
  draftPayloadBytes,
  DRAFT_PAYLOAD_SHA256,
  validateHistoricalDocument,
  validateManifest,
  validateRulesDocument,
} from "./evidence-lifecycle.mjs";

const repositoryRoot = new URL("..", import.meta.url).pathname;

function committed() {
  return JSON.parse(readFileSync(new URL(`../${MANIFEST_PATH}`, import.meta.url), "utf8"));
}

function has(errors, text) {
  assert.ok(errors.some((error) => error.includes(text)), `expected ${JSON.stringify(text)} in\n${errors.join("\n")}`);
}

test("committed lifecycle manifest classifies every approved evidence path exactly once", () => {
  const manifest = committed();
  // M2 INTEGRATION DELTA — 246 -> 250 entries, ACCEPTED 221 -> 225. Two
  // branches each add two ACCEPTED entries on independent axes; both sides
  // independently wrote 248/223, so the integrated count is the SUM of the two
  // +2 contributions, not the value either branch pinned alone.
  //
  // WIN-299 (M2.6) +2, both under docs/audits/sbom/advisory/ and both
  // classified ACCEPTED because they bind CURRENT repository truth rather than
  // a snapshot: advisory-policy.json must dispose every CRITICAL/HIGH finding
  // in the live receipt or audit:advisory:check fails, and README.md documents
  // that contract. Their sibling osv-report.json stays POINT-IN-TIME (one
  // dated scan).
  //
  // WIN-284 +2: docs/audits/win-284-differential-coverage.{json,md}, the
  // generated differential capability coverage matrix. They are pinned in
  // EXPLICIT_ACCEPTED_AMBIGUOUS_PATHS rather than left to the ambiguous-root
  // rule, which refuses to guess. ACCEPTED rather than POINT-IN-TIME because
  // the matrix is reconciled to the four M0 censuses on every run and its
  // covered column moves as M4-M6 land; a snapshot classification would be
  // false about what the artifact is for.
  //
  // WIN-259 (M2.4) +1: docs/audits/win-259-secret-response-census.json, the
  // dispositioned raw-secret RESPONSE count. ACCEPTED for the same reason the
  // two above are: `audit:secret-response-census` re-scans the 143 request
  // surfaces on every run and fails when the live result and the file disagree,
  // so it binds current repository truth rather than recording one date. It is
  // pinned by name in EXPLICIT_ACCEPTED_AMBIGUOUS_PATHS because it is only HALF
  // generated — the scanner emits path/key/occurrences and a human writes the
  // disposition and the reason — and the ambiguous-root rule refuses to guess.
  //
  // No branch adds a POINT-IN-TIME, SUPERSEDED-BY or DRAFT entry, so those
  // three counts are deliberately unchanged.
  assert.equal(manifest.entryCount, 251, "exact protected evidence corpus includes the design and licence provenance receipts, vendored source artifacts, the WIN-299 advisory disposition register, the WIN-284 differential coverage matrix, and the WIN-259 secret-response census");
  assert.deepEqual(manifest.counts, { ACCEPTED: 226, "SUPERSEDED-BY": 4, "POINT-IN-TIME": 20, DRAFT: 1 });
  assert.equal(POINT_IN_TIME_PATHS.length, 20);
  assert.equal(Object.keys(SUPERSESSIONS).length, 4);
  assert.deepEqual(Object.keys(manifest.counts), STATUSES);
  assert.deepEqual(validateManifest(manifest, repositoryRoot), []);
});

test("unknown status and status-specific unknown or missing fields are rejected", () => {
  const unknown = committed();
  unknown.entries[0].status = "CURRENT";
  has(validateManifest(unknown, repositoryRoot), "status is unknown");

  const extra = committed();
  extra.entries[0].target = extra.entries[1].path;
  has(validateManifest(extra, repositoryRoot), "fields are invalid for ACCEPTED");

  const missing = committed();
  delete missing.entries[0].binds;
  has(validateManifest(missing, repositoryRoot), "fields are invalid for ACCEPTED");
});

test("duplicate, missing, stale hash, stale mode, and outside-root paths are rejected", () => {
  const duplicate = committed();
  duplicate.entries.splice(1, 0, { ...duplicate.entries[0] });
  has(validateManifest(duplicate, repositoryRoot), "classified exactly once");

  const missing = committed();
  missing.entries.pop();
  has(validateManifest(missing, repositoryRoot), "classification drift");

  const staleHash = committed();
  staleHash.entries[0].sha256 = "0".repeat(64);
  has(validateManifest(staleHash, repositoryRoot), "classification drift");

  const staleMode = committed();
  staleMode.entries[0].mode = staleMode.entries[0].mode === "100644" ? "100755" : "100644";
  has(validateManifest(staleMode, repositoryRoot), "classification drift");

  const outside = committed();
  outside.entries[0].path = "package.json";
  has(validateManifest(outside, repositoryRoot), "outside approved evidence roots");
});

function accepted(path) {
  return { path, status: "ACCEPTED", mode: "100644", sha256: "1".repeat(64), binds: "current-repository-truth" };
}

function superseded(path, target) {
  return { path, status: "SUPERSEDED-BY", mode: "100644", sha256: "2".repeat(64), target, relationshipSource: "rules/manifest.json" };
}

function manifestWith(entries) {
  return {
    $schema: "platos.evidence-lifecycle/v1",
    generatedBy: "node scripts/evidence-lifecycle.mjs write",
    asOf: "2026-08-30",
    approvedRoots: ["ai/", "content/", "design/", "docs/adr/", "docs/audits/", "docs/refactor/", "docs/research/", "examples/", "references/", "rules/"],
    generatedExclusions: ["docs/audits/win-254-protected-paths.json", "docs/audits/win-254-evidence-lifecycle.json"],
    classificationRules: [],
    protectedPathSetSha256: "0".repeat(64),
    currentStatuses: ["ACCEPTED"],
    historicalStatuses: ["SUPERSEDED-BY", "POINT-IN-TIME", "DRAFT"],
    openQuestions: [],
    entryCount: entries.length,
    counts: Object.fromEntries(STATUSES.map((status) => [status, entries.filter((entry) => entry.status === status).length])),
    entries,
  };
}

test("supersession requires an existing accepted target and rejects cycles", () => {
  const orphan = manifestWith([superseded("docs/audits/a.md", "docs/audits/missing.md")]);
  has(validateManifest(orphan, repositoryRoot), "supersession target is missing or case-mismatched");

  const cycle = manifestWith([
    superseded("docs/audits/a.md", "docs/audits/b.md"),
    superseded("docs/audits/b.md", "docs/audits/a.md"),
  ]);
  has(validateManifest(cycle, repositoryRoot), "supersession cycle detected");

  const draftTarget = manifestWith([
    superseded("docs/audits/a.md", "docs/audits/b.md"),
    { path: "docs/audits/b.md", status: "DRAFT", mode: "100644", sha256: "3".repeat(64), notice: "not-current-acceptance" },
  ]);
  has(validateManifest(draftTarget, repositoryRoot), "supersession chain must terminate in ACCEPTED");
});

test("POINT-IN-TIME requires source, baseline, and a valid non-future date", () => {
  const point = {
    path: "docs/audits/a.md",
    status: "POINT-IN-TIME",
    mode: "100644",
    sha256: "4".repeat(64),
    sourceSnapshot: "scanner receipt",
    baseline: "historical snapshot",
    date: "2999-01-01",
  };
  has(validateManifest(manifestWith([point]), repositoryRoot, { now: new Date("2026-08-30T23:59:59Z") }), "date is invalid or future");
  point.date = "2026-02-30";
  has(validateManifest(manifestWith([point]), repositoryRoot), "date is invalid or future");
  point.date = "2026-08-30";
  point.baseline = "";
  has(validateManifest(manifestWith([point]), repositoryRoot), "explicit baseline semantics");
});

test("DRAFT cannot appear in the current status set and ACCEPTED must bind current truth", () => {
  const draftCurrent = committed();
  draftCurrent.currentStatuses = ["ACCEPTED", "DRAFT"];
  has(validateManifest(draftCurrent, repositoryRoot), "only ACCEPTED may be current");

  const acceptedDrift = manifestWith([accepted("docs/audits/a.md")]);
  acceptedDrift.entries[0].binds = "historical-only";
  has(validateManifest(acceptedDrift, repositoryRoot), "must bind current repository truth");
});

test("historical Markdown and MDX require searchable lifecycle frontmatter and the first rendered banner", () => {
  const manifest = committed();
  for (const entry of manifest.entries.filter((item) => item.status !== "ACCEPTED" && /\.mdx?$/u.test(item.path))) {
    const source = readFileSync(new URL(`../${entry.path}`, import.meta.url), "utf8");
    assert.deepEqual(validateHistoricalDocument(entry.path, entry, source), [], entry.path);
  }

  const draft = manifest.entries.find((entry) => entry.status === "DRAFT");
  const source = readFileSync(new URL(`../${draft.path}`, import.meta.url), "utf8");
  has(validateHistoricalDocument(draft.path, draft, source.replace('lifecycle: "DRAFT"', 'lifecycle: "ACCEPTED"')), "frontmatter lifecycle");
  has(validateHistoricalDocument(draft.path, draft, source.replace("> **Lifecycle: DRAFT.**", "> **Status: Draft.**")), "first rendered content");
  has(validateHistoricalDocument(draft.path, draft, source.replace('title: "[DRAFT]', 'title: "')), "searchable frontmatter title");
  has(
    validateHistoricalDocument(draft.path, draft, source.replace('lifecycle: "DRAFT"', 'lifecycle: "DRAFT"\nlifecycle: "ACCEPTED"')),
    "frontmatter YAML is invalid",
  );
  has(
    validateHistoricalDocument(draft.path, draft, source.replace('title: "[DRAFT]', 'title: "duplicate"\ntitle: "[DRAFT]')),
    "frontmatter YAML is invalid",
  );
});

test("DRAFT lifecycle envelope preserves the original historical payload bytes", () => {
  const source = readFileSync(new URL(`../${DRAFT_PATH}`, import.meta.url), "utf8");
  assert.equal(createHash("sha256").update(draftPayloadBytes(source)).digest("hex"), DRAFT_PAYLOAD_SHA256);
  assert.throws(
    () => draftPayloadBytes(source.replace('lifecycle: "DRAFT"', 'lifecycle: "ACCEPTED"')),
    /exact reviewed DRAFT lifecycle envelope/u,
  );
  has(
    validateHistoricalDocument(DRAFT_PATH, { status: "DRAFT" }, `${source}payload drift\n`),
    "historical draft payload bytes changed",
  );
});

test("semantic historical roots never fall through to ACCEPTED and ambiguous evidence requires review", () => {
  assert.equal(
    classifyLifecyclePath("docs/audits/history/win-255/stale-report.md", repositoryRoot).status,
    "POINT-IN-TIME",
  );
  assert.throws(
    () => classifyLifecyclePath("docs/refactor/unreviewed-snapshot.md", repositoryRoot),
    /ambiguous evidence requires an explicit lifecycle classification/u,
  );
  assert.throws(
    () => classifyLifecyclePath("docs/research/unreviewed-snapshot.mdx", repositoryRoot),
    /ambiguous evidence requires an explicit lifecycle classification/u,
  );
});

test("rules supersession follows same-name options in currentVersion and rejects version divergence", () => {
  const document = JSON.parse(readFileSync(new URL("../rules/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(validateRulesDocument(document), []);

  const wrongCurrent = structuredClone(document);
  wrongCurrent.currentVersion = "4.1.0";
  has(validateRulesDocument(wrongCurrent), "currentVersion and same-name option continuity diverge");

  const renamed = structuredClone(document);
  renamed.versions["4.3.0"].options.find((option) => option.name === "basic").name = "basic-renamed";
  has(validateRulesDocument(renamed), "no same-name option exists in currentVersion");

  const futureOldVersion = structuredClone(document);
  futureOldVersion.versions["4.2.0"] = {
    options: [{ name: "basic", path: "4.2.0/basic-tasks.md" }],
  };
  assert.equal(
    deriveRulesLifecycle(futureOldVersion).supersessions.get("rules/4.2.0/basic-tasks.md"),
    "rules/4.3.0/basic-tasks.md",
  );
});

test("asOf, openQuestions, generated exclusions, rules, counts, and byte order are exact", () => {
  const mutations = [
    (manifest) => { manifest.asOf = "2026-08-29"; },
    (manifest) => { manifest.openQuestions = ["later"]; },
    (manifest) => { manifest.generatedExclusions.push("docs/audits/extra.json"); },
    (manifest) => { manifest.classificationRules.reverse(); },
    (manifest) => { manifest.counts.ACCEPTED += 1; },
    (manifest) => { [manifest.entries[0], manifest.entries[1]] = [manifest.entries[1], manifest.entries[0]]; },
  ];
  for (const mutate of mutations) {
    const manifest = committed();
    mutate(manifest);
    assert.ok(validateManifest(manifest, repositoryRoot).length > 0);
  }
});

test("supersession targets reject self, traversal, case drift, and target deletion", () => {
  const sourcePath = Object.keys(SUPERSESSIONS)[0];
  for (const target of [sourcePath, "../outside.md", SUPERSESSIONS[sourcePath].toUpperCase()]) {
    const manifest = committed();
    manifest.entries.find((entry) => entry.path === sourcePath).target = target;
    assert.ok(validateManifest(manifest, repositoryRoot).some((error) => /target|SUPERSEDED-BY|drift/u.test(error)));
  }
  const deleted = committed();
  const target = SUPERSESSIONS[sourcePath];
  deleted.entries = deleted.entries.filter((entry) => entry.path !== target);
  deleted.entryCount -= 1;
  deleted.counts.ACCEPTED -= 1;
  has(validateManifest(deleted, repositoryRoot), "target is missing or case-mismatched");
});

test("deterministic generation is byte-equivalent in memory", () => {
  assert.deepEqual(buildManifest(repositoryRoot), buildManifest(repositoryRoot));
});
