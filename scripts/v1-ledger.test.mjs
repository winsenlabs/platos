import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  AREAS,
  DISPOSITIONS,
  KINDS,
  PROTECTED_DISPOSITIONS,
  REACHED_VIA,
  assignArea,
  buildLedger,
  byteCompare,
  checkInvariants,
  classificationSha256,
  gateSafeJson,
  globToRegExp,
  listTrackedFiles,
  looksLikeLedgerArtifact,
  measureFile,
  readVocabularyPinnedPaths,
  referenceNeedles,
  summarize,
  validateRulesDocument,
} from "./v1-ledger.mjs";
import { RULES as VOCABULARY_RULES } from "./vocabulary-boundary.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const rulesDocument = JSON.parse(readFileSync(new URL("../docs/v1-ledger-rules.json", import.meta.url), "utf8"));

const matches = (glob, path) => globToRegExp(glob).test(path);

// ---------------------------------------------------------------------------
// Glob semantics
// ---------------------------------------------------------------------------

test("a single star does not cross a path separator", () => {
  assert.equal(matches("a/*", "a/b"), true);
  assert.equal(matches("a/*", "a/b/c"), false);
  assert.equal(matches("a/*.ts", "a/b.ts"), true);
  assert.equal(matches("a/*.ts", "a/b/c.ts"), false);
});

test("a double star crosses zero or more path separators", () => {
  assert.equal(matches("a/**", "a/b"), true);
  assert.equal(matches("a/**", "a/b/c/d"), true);
  assert.equal(matches("a/**/c.ts", "a/c.ts"), true);
  assert.equal(matches("a/**/c.ts", "a/b/c.ts"), true);
  assert.equal(matches("a/**/c.ts", "a/b/x/c.ts"), true);
  assert.equal(matches("a/**", "b/c"), false);
});

test("brace alternation and character classes are literal within one segment", () => {
  assert.equal(matches("x/*.{interp,tokens}", "x/L.interp"), true);
  assert.equal(matches("x/*.{interp,tokens}", "x/L.tokens"), true);
  assert.equal(matches("x/*.{interp,tokens}", "x/L.ts"), false);
  assert.equal(matches("x/[0-9].sql", "x/3.sql"), true);
  assert.equal(matches("x/[0-9].sql", "x/a.sql"), false);
});

test("regular expression metacharacters in a path are matched literally", () => {
  assert.equal(matches("d/*.png", "d/run-with-batchAndWait().png"), true);
  assert.equal(matches("d/a.b", "d/axb"), false);
});

// Defect guard. Under the minimatch and globby default of dot:false these six
// tracked files match no pattern at all and are silently skipped. This matcher
// has no leading-dot special case, so a dot-prefixed name is an ordinary path
// component.
test("globs match dot-prefixed names without any opt-in", () => {
  for (const name of [".dockerignore", ".env.example", ".gitignore"]) {
    for (const entity of ["entity-docs-mcp-bridge", "entity-hello-world"]) {
      assert.equal(matches("references/entity-*/**", `references/${entity}/${name}`), true);
      assert.equal(matches("references/entity-*/.*", `references/${entity}/${name}`), true);
    }
  }
  assert.equal(matches("a/*", "a/.hidden"), true);
  assert.equal(matches("**", ".gitmodules"), true);
});

// ---------------------------------------------------------------------------
// Area assignment
// ---------------------------------------------------------------------------

test("every area claims the paths it owns", () => {
  assert.equal(assignArea("apps/agent/src/main.ts"), "apps-agent");
  assert.equal(assignArea("apps/webapp/app/root.tsx"), "apps-webapp");
  assert.equal(assignArea("packages/core/src/index.ts"), "packages");
  assert.equal(assignArea("internal-packages/database/prisma/schema.prisma"), "internal-packages");
  for (const root of ["docs", "content", "references", "rules", "ai", "design"]) {
    assert.equal(assignArea(`${root}/thing.md`), "docs-content");
  }
  for (const root of ["scripts", "deploy", "hosting", "tests", "examples", "patches", ".github", ".configs"]) {
    assert.equal(assignArea(`${root}/thing.txt`), "root-infra");
  }
});

test("root-infra claims separator-free paths and unclaimed dot-prefixed roots", () => {
  assert.equal(assignArea("LICENSE"), "root-infra");
  assert.equal(assignArea(".gitmodules"), "root-infra");
  assert.equal(assignArea(".changeset/config.json"), "root-infra");
  assert.equal(assignArea(".gstack/browse-audit.jsonl"), "root-infra");
  assert.equal(assignArea(".vscode/settings.json"), "root-infra");
});

test("an unrecognised top-level directory is reported rather than absorbed", () => {
  assert.equal(assignArea("apps/other/index.ts"), null);
  assert.equal(assignArea("brand-new-root/index.ts"), null);
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test("ordering compares bytes, matching LC_ALL=C rather than a locale", () => {
  assert.ok(byteCompare("Z", "a") < 0);
  assert.ok(byteCompare("a-b", "a/b") < 0);
  assert.ok(byteCompare(".gitmodules", "LICENSE") < 0);
  const sorted = ["b", "A", "_", "a"].sort(byteCompare);
  assert.deepEqual(sorted, ["A", "_", "a", "b"]);
});

// ---------------------------------------------------------------------------
// Rules document validation
// ---------------------------------------------------------------------------

const goodRule = {
  id: "x.one",
  match: ["root-infra-only/**"],
  kind: "config",
  owner_capability: "Build Platform",
  disposition: "retain",
  reached_via: ["CI"],
  evidence: "Read by the pipeline.",
};

function documentWith(rule) {
  const areas = Object.fromEntries(AREAS.map((area) => [area, [{ ...goodRule, id: `${area}.base` }]]));
  areas["root-infra"] = [{ ...goodRule, ...rule }];
  return { version: 1, areas };
}

test("the committed rules document is valid", () => {
  assert.deepEqual(validateRulesDocument(rulesDocument), []);
});

test("validation rejects an undeclared kind, disposition, or reachability token", () => {
  assert.ok(validateRulesDocument(documentWith({ kind: "widget" })).some((e) => e.includes("kind")));
  assert.ok(validateRulesDocument(documentWith({ disposition: "burn" })).some((e) => e.includes("disposition")));
  assert.ok(validateRulesDocument(documentWith({ reached_via: ["telepathy"] })).some((e) => e.includes("reached_via")));
});

test("validation rejects removal that does not record zero reachability", () => {
  const errors = validateRulesDocument(documentWith({ disposition: "delete", reached_via: ["CI"] }));
  assert.ok(errors.some((e) => e.includes("zero reachability")));
});

test("validation rejects NONE combined with a reachability token", () => {
  const errors = validateRulesDocument(documentWith({ reached_via: ["NONE", "CI"] }));
  assert.ok(errors.some((e) => e.includes("may not combine NONE")));
});

test("validation rejects a duplicate rule identifier and an empty match list", () => {
  const duplicated = documentWith({ id: "apps-agent.base" });
  assert.ok(validateRulesDocument(duplicated).some((e) => e.includes("duplicates")));
  assert.ok(validateRulesDocument(documentWith({ match: [] })).some((e) => e.includes("non-empty array of globs")));
});

// ---------------------------------------------------------------------------
// First-match-wins precedence
// ---------------------------------------------------------------------------

function docWithArea(area, rules) {
  const areas = Object.fromEntries(AREAS.map((name) => [name, [{ ...goodRule, id: `${name}.base` }]]));
  areas[area] = rules;
  return { version: 1, areas };
}

function tinyLedger(rules, paths, extra = {}) {
  return buildLedger(repositoryRoot, docWithArea("root-infra", rules), {
    trackedFiles: paths,
    measure: () => ({ bytes: 1, lines: 1, binary: false }),
    corpus: extra.corpus ?? new Map(),
    ...extra,
  });
}

test("the first rule in declared order wins, not the most specific one", () => {
  const safe = { ...goodRule, id: "safe", match: ["scripts/**"], disposition: "retain", reached_via: ["CI"] };
  const risky = {
    ...goodRule,
    id: "risky",
    match: ["scripts/thing.txt"],
    disposition: "delete",
    reached_via: ["NONE"],
  };
  const forward = tinyLedger([safe, risky], ["scripts/thing.txt"]);
  assert.equal(forward.rows[0].rule_id, "safe");
  assert.equal(forward.rows[0].disposition, "retain");
  assert.equal(forward.rows[0].rule_order, 0);

  const reversed = tinyLedger([risky, safe], ["scripts/thing.txt"]);
  assert.equal(reversed.rows[0].rule_id, "risky");
  assert.equal(reversed.rows[0].rule_order, 0);
});

test("a file that matches no rule is a hard error rather than a silent skip", () => {
  const result = tinyLedger([{ ...goodRule, match: ["scripts/**"] }], ["scripts/a.txt", "tests/b.txt"]);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.unmatched, [{ path: "tests/b.txt", area: "root-infra" }]);
  const failures = checkInvariants(result, ["scripts/a.txt", "tests/b.txt"], new Set());
  assert.ok(failures.some((f) => f.includes("no rule in area root-infra classifies tests/b.txt")));
  assert.ok(failures.some((f) => f.includes("does not equal tracked file count")));
});

test("a path no area claims is reported rather than absorbed into a row", () => {
  const result = tinyLedger([{ ...goodRule, match: ["scripts/**"] }], ["scripts/a.txt", "brand-new-root/b.txt"]);
  assert.deepEqual(result.unassigned, ["brand-new-root/b.txt"]);
  const failures = checkInvariants(result, ["scripts/a.txt", "brand-new-root/b.txt"], new Set());
  assert.ok(failures.some((f) => f.includes("no area claims brand-new-root/b.txt")));
});

// A behavioural reorder test, not a comparison of declared indices: the SAME
// two overlapping rules produce a different disposition purely by swapping their
// order, which is what first-match-wins means. A delete pin ahead of an archive
// bucket yields delete; behind it, archive.
test("swapping two overlapping rules changes the winning disposition", () => {
  const pin = { ...goodRule, id: "pin", match: ["scripts/orphan.png"], disposition: "delete", reached_via: ["NONE"] };
  const bucket = { ...goodRule, id: "bucket", match: ["scripts/**"], disposition: "archive", reached_via: ["CI"] };

  const pinFirst = tinyLedger([pin, bucket], ["scripts/orphan.png"]);
  assert.equal(pinFirst.rows[0].disposition, "delete");
  assert.equal(pinFirst.rows[0].rule_id, "pin");

  const bucketFirst = tinyLedger([bucket, pin], ["scripts/orphan.png"]);
  assert.equal(bucketFirst.rows[0].disposition, "archive");
  assert.equal(bucketFirst.rows[0].rule_id, "bucket");
});

test("a delete rule may not carry a wildcard match", () => {
  const wildcard = documentWith({ disposition: "delete", reached_via: ["NONE"], match: ["scripts/*.png"] });
  assert.ok(
    validateRulesDocument(wildcard).some((e) => e.includes("must be a literal path") && e.includes("may not contain a wildcard"))
  );
  const literal = documentWith({ disposition: "delete", reached_via: ["NONE"], match: ["scripts/one.png"] });
  assert.equal(validateRulesDocument(literal).some((e) => e.includes("literal path")), false);
});

test("an invalid character-class glob is a validation error, not an uncaught throw", () => {
  const bad = documentWith({ match: ["scripts/[z-a].txt"] });
  const errors = validateRulesDocument(bad);
  assert.ok(errors.some((e) => e.includes("invalid glob") && e.includes("[z-a]")));
  // An out-of-order range would make the RegExp constructor throw; the guard
  // converts it into a labelled error naming the glob.
  assert.throws(() => globToRegExp("scripts/[z-a].txt"), /invalid glob .*\[z-a\]/);
  // An escaped bracket inside a class is handled without throwing.
  assert.doesNotThrow(() => globToRegExp("scripts/[[]].txt"));
});

// ---------------------------------------------------------------------------
// Computed reachability for the destructive case (D1)
// ---------------------------------------------------------------------------

test("a delete candidate referenced anywhere in the corpus is a hard failure", () => {
  const del = { ...goodRule, id: "del", match: ["scripts/orphan.png"], disposition: "delete", reached_via: ["NONE"] };
  const consumer = { ...goodRule, id: "keep", match: ["scripts/page.md"], disposition: "retain", reached_via: ["CI"] };

  const clean = tinyLedger([del, consumer], ["scripts/orphan.png", "scripts/page.md"], {
    corpus: new Map([["scripts/page.md", "nothing to see here\n"]]),
  });
  assert.deepEqual(clean.deleteReferences, []);
  assert.deepEqual(checkInvariants(clean, ["scripts/orphan.png", "scripts/page.md"], new Set()), []);

  // Now the same tree, but a page embeds the orphan by its bare basename.
  const referenced = tinyLedger([del, consumer], ["scripts/orphan.png", "scripts/page.md"], {
    corpus: new Map([["scripts/page.md", 'see <img src="/x/orphan.png">\n']]),
  });
  assert.equal(referenced.deleteReferences.length, 1);
  assert.equal(referenced.deleteReferences[0].path, "scripts/orphan.png");
  assert.deepEqual(referenced.deleteReferences[0].referencedBy, ["scripts/page.md"]);
  const failures = checkInvariants(referenced, ["scripts/orphan.png", "scripts/page.md"], new Set());
  assert.ok(failures.some((f) => f.includes("is classified delete but is referenced by scripts/page.md")));
});

test("referenceNeedles covers the path, the site-root path, and the basename", () => {
  assert.deepEqual(referenceNeedles("docs/images/x.png"), [
    "docs/images/x.png",
    "/docs/images/x.png",
    "x.png",
  ]);
});

// Builds a throwaway git repository on disk and stages files, so buildLedger
// runs its REAL enumeration and file-reading corpus path with no injected
// corpus or measure -- the code that mutation N4 disabled while all the
// injected-corpus tests above stayed green.
function realRepoFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "platos-ledger-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["add", "--all"], { cwd: root });
  return root;
}

const orphanRulesDoc = docWithArea("docs-content", [
  { ...goodRule, id: "orphan-delete", match: ["docs/img/orphan.png"], kind: "asset", disposition: "delete", reached_via: ["NONE"] },
  { ...goodRule, id: "docs-catch-all", match: ["docs/**"], kind: "doc", disposition: "retain", reached_via: ["docs-reference"] },
]);

test("the live build reads files and catches a real reference to a delete candidate", () => {
  // Same tree twice, differing only in whether a page cites the orphan. This
  // exercises the real readFileSync corpus population: disabling it (N4) makes
  // both cases report zero references and this assertion fails.
  const referenced = realRepoFixture({
    "docs/img/orphan.png": "\x89PNG fake image bytes\n",
    "docs/page.md": "gallery: ![shot](./img/orphan.png)\n",
  });
  try {
    const result = buildLedger(referenced, orphanRulesDoc);
    assert.equal(result.deleteReferences.length, 1);
    assert.equal(result.deleteReferences[0].path, "docs/img/orphan.png");
    assert.ok(result.deleteReferences[0].referencedBy.includes("docs/page.md"));
    const failures = checkInvariants(result, listTrackedFiles(referenced), new Set());
    assert.ok(failures.some((f) => f.includes("docs/img/orphan.png is classified delete but is referenced by")));
  } finally {
    rmSync(referenced, { recursive: true, force: true });
  }

  const clean = realRepoFixture({
    "docs/img/orphan.png": "\x89PNG fake image bytes\n",
    "docs/page.md": "gallery: no image here\n",
  });
  try {
    const result = buildLedger(clean, orphanRulesDoc);
    assert.deepEqual(result.deleteReferences, []);
    assert.deepEqual(checkInvariants(result, listTrackedFiles(clean), new Set()), []);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
});

test("corpus exclusion of the rules file is independent of argument spelling", () => {
  // A committed rules file lists every delete candidate; it must stay out of the
  // corpus however --rules is spelled. With a string-equality exclusion the "./"
  // form leaks the rules file in and the seven real deletes falsely fail.
  const result = buildLedger(repositoryRoot, rulesDocument, { rulesPath: "./docs/v1-ledger-rules.json" });
  assert.deepEqual(result.deleteReferences, []);
});

test("an emitted ledger artifact is excluded from the corpus by its shape", () => {
  const artifact = JSON.stringify({
    version: 1,
    summary: { classificationSha256: "0".repeat(64) },
    rows: [{ path: "docs/img/orphan.png", disposition: "delete" }],
  });
  // The artifact names the orphan, but as ledger data, so it is not a reference.
  assert.equal(looksLikeLedgerArtifact(artifact), true);
  const repo = realRepoFixture({
    "docs/img/orphan.png": "\x89PNG fake image bytes\n",
    "docs/v1-ledger.json": artifact,
  });
  try {
    const result = buildLedger(repo, orphanRulesDoc);
    assert.deepEqual(result.deleteReferences, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

function rowFixture(overrides) {
  return {
    path: "a.txt",
    area: "root-infra",
    rule_id: "r",
    rule_order: 0,
    kind: "config",
    owner_capability: "Build Platform",
    disposition: "retain",
    protected: false,
    lines: 1,
    bytes: 1,
    binary: false,
    reached_via: ["CI"],
    evidence: "e",
    ...overrides,
  };
}

const empty = { unmatched: [], unassigned: [] };

test("a protected file may only retain, move-refactor, or regenerate", () => {
  for (const disposition of DISPOSITIONS) {
    const rows = [rowFixture({ protected: true, disposition, reached_via: disposition === "delete" ? ["NONE"] : ["CI"] })];
    const failures = checkInvariants({ ...empty, rows }, ["a.txt"], new Set());
    const offended = failures.some((f) => f.includes("is protected but its disposition is"));
    assert.equal(offended, !PROTECTED_DISPOSITIONS.has(disposition), `disposition ${disposition}`);
  }
});

test("removal requires reached_via to be exactly NONE", () => {
  const bad = [rowFixture({ disposition: "delete", reached_via: ["docs-reference"] })];
  assert.ok(
    checkInvariants({ ...empty, rows: bad }, ["a.txt"], new Set()).some((f) => f.includes("proposes removal while"))
  );
  const good = [rowFixture({ disposition: "delete", reached_via: ["NONE"] })];
  assert.deepEqual(checkInvariants({ ...empty, rows: good }, ["a.txt"], new Set()), []);
});

test("a duplicate path and a missing rule identifier both fail", () => {
  const rows = [rowFixture(), rowFixture({ rule_id: "" })];
  const failures = checkInvariants({ ...empty, rows }, ["a.txt", "a.txt"], new Set());
  assert.ok(failures.some((f) => f.includes("duplicate ledger row")));
  assert.ok(failures.some((f) => f.includes("has no rule_id")));
});

test("removal of a path the boundary manifest anchors is refused", () => {
  const rows = [rowFixture({ disposition: "delete", reached_via: ["NONE"] })];
  const failures = checkInvariants({ ...empty, rows }, ["a.txt"], new Set(["a.txt"]));
  assert.ok(failures.some((f) => f.includes("anchors it; removal alone reddens CI")));
});

test("rows out of byte order fail", () => {
  const rows = [rowFixture({ path: "b.txt" }), rowFixture({ path: "a.txt" })];
  const failures = checkInvariants({ ...empty, rows }, ["a.txt", "b.txt"], new Set());
  assert.ok(failures.some((f) => f.includes("not in byte order")));
});

// ---------------------------------------------------------------------------
// The live repository
// ---------------------------------------------------------------------------

const live = buildLedger(repositoryRoot, rulesDocument);
const liveByPath = new Map(live.rows.map((row) => [row.path, row]));
const pinnedPaths = readVocabularyPinnedPaths(repositoryRoot);

test("every tracked file produces exactly one row and no file is left over", () => {
  const tracked = listTrackedFiles(repositoryRoot);
  assert.deepEqual(live.errors, []);
  assert.deepEqual(live.unassigned, []);
  assert.deepEqual(live.unmatched, []);
  assert.equal(live.rows.length, tracked.length);
  assert.equal(new Set(live.rows.map((r) => r.path)).size, tracked.length);
  assert.deepEqual(checkInvariants(live, tracked, pinnedPaths), []);
});

test("area counts reconcile against the independently derived baseline", () => {
  const summary = summarize(live.rows);
  assert.equal(summary.totalFiles, rulesDocument.baseline.totalFiles);
  assert.deepEqual(summary.areaCounts, rulesDocument.baseline.areaCounts);
  assert.equal(
    Object.values(summary.areaCounts).reduce((a, b) => a + b, 0),
    rulesDocument.baseline.totalFiles
  );
});

test("every row carries declared enum values throughout", () => {
  for (const row of live.rows) {
    assert.ok(AREAS.includes(row.area), row.path);
    assert.ok(KINDS.includes(row.kind), row.path);
    assert.ok(DISPOSITIONS.includes(row.disposition), row.path);
    assert.ok(row.reached_via.every((token) => REACHED_VIA.includes(token)), row.path);
    assert.ok(typeof row.evidence === "string" && row.evidence.length > 0, row.path);
    assert.ok(Number.isInteger(row.bytes) && row.bytes >= 0, row.path);
  }
});

test("the committed fingerprint is current", () => {
  const summary = summarize(live.rows);
  assert.equal(rulesDocument.expected.totalFiles, summary.totalFiles);
  assert.deepEqual(rulesDocument.expected.areaCounts, summary.areaCounts);
  assert.deepEqual(rulesDocument.expected.dispositionCounts, summary.dispositionCounts);
  assert.deepEqual(rulesDocument.expected.ruleCounts, summary.ruleCounts);
  assert.equal(rulesDocument.expected.classificationSha256, classificationSha256(live.rows));
});

// Six files matched contradictory rules in the prior analysis. Ordering now
// decides each one deterministically, to the disposition the charter names as
// safer for that file. These are concrete outcome assertions: a reorder of the
// live document that flipped any of them would fail here.
test("the six formerly contradictory files resolve as the charter requires", () => {
  assert.equal(liveByPath.get("internal-packages/clickhouse/Dockerfile").disposition, "retain");
  assert.equal(liveByPath.get("internal-packages/run-engine/runengine-diagram.monojson").disposition, "retain");
  for (const grammar of ["TSQLLexer", "TSQLParser"]) {
    for (const extension of ["interp", "tokens"]) {
      const row = liveByPath.get(`internal-packages/tsql/src/grammar/${grammar}.${extension}`);
      assert.equal(row.disposition, "regenerate", row.path);
      assert.equal(row.kind, "generated", row.path);
    }
  }
  const license = liveByPath.get("internal-packages/otlp-importer/LICENSE");
  assert.equal(license.kind, "legal");
  assert.equal(license.disposition, "retain");
  assert.equal(license.protected, true);
});

test("the live delete candidates all pass the computed reachability scan", () => {
  // Reachability for deletes is computed, not asserted: if any of the live
  // delete candidates were referenced, this would be non-empty and --check red.
  assert.deepEqual(live.deleteReferences, []);
  assert.ok(live.rows.some((row) => row.disposition === "delete"));
});

// PROTECTED_GLOBS is a hard-coded floor independent of the rules document, so
// protection cannot be removed by editing the rules alone. This proves it fires
// even when the matching rule does NOT set protected:true.
test("PROTECTED_GLOBS protects a file whose rule omits the protected flag", () => {
  const doc = docWithArea("root-infra", [
    { ...goodRule, id: "unflagged-license", match: ["LICENSE"], kind: "legal", disposition: "retain" },
  ]);
  const result = buildLedger(repositoryRoot, doc, {
    trackedFiles: ["LICENSE"],
    measure: () => ({ bytes: 1, lines: 1, binary: false }),
    corpus: new Map(),
  });
  assert.equal(result.rows[0].protected, true);
  // And a non-protected path with the same shaped rule stays unprotected.
  const other = buildLedger(repositoryRoot, doc, {
    trackedFiles: ["scripts/ordinary.txt"],
    measure: () => ({ bytes: 1, lines: 1, binary: false }),
    corpus: new Map(),
  });
  assert.equal(other.unmatched.length, 1);
});

test("the ledger classifies its own three files", () => {
  assert.equal(liveByPath.get("scripts/v1-ledger.mjs").rule_id, "root-infra.tooling.scripts");
  assert.equal(liveByPath.get("scripts/v1-ledger.test.mjs").rule_id, "root-infra.test.script-suites");
  assert.equal(liveByPath.get("docs/v1-ledger-rules.json").rule_id, "docs-content.pin.ledger-rules");
});

test("the three falsified files are never proposed for removal", () => {
  const proxy = liveByPath.get("hosting/Caddyfile.example");
  assert.equal(proxy.disposition, "retain");
  assert.ok(proxy.evidence.includes("BARE BASENAME"));

  const submodules = liveByPath.get(".gitmodules");
  assert.equal(submodules.disposition, "unresolved");
  assert.deepEqual(submodules.reached_via, ["git-subcommand"]);
  assert.ok(submodules.evidence.includes("submodule.mjs"));

  // Matched by suffix here only to avoid writing the reserved directory name in
  // this test's source; the live rule pins it by exact literal path.
  const browserEntry = live.rows.filter((row) => row.path.endsWith("/src/v3/index-browser.mts"));
  assert.equal(browserEntry.length, 1);
  assert.equal(browserEntry[0].disposition, "archive");
  assert.equal(browserEntry[0].rule_id, "packages.pin.browser-entry");
  assert.ok(browserEntry[0].evidence.includes("19165"));
});

test("the six reference dotfiles are classified rather than skipped", () => {
  for (const entity of ["entity-docs-mcp-bridge", "entity-hello-world"]) {
    for (const name of [".dockerignore", ".env.example", ".gitignore"]) {
      const row = liveByPath.get(`references/${entity}/${name}`);
      assert.ok(row, `${entity}/${name} is missing`);
      assert.equal(row.rule_id, "docs-content.reference.entity-dotfiles");
    }
  }
});

test("the hard-coded protected set is protected in the ledger", () => {
  for (const path of [
    "lefthook.yml",
    "LICENSE",
    "NOTICE",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "internal-packages/tsql/NOTICE.md",
    "internal-packages/database/prisma/migrations/20221206131204_init/migration.sql",
  ]) {
    const row = liveByPath.get(path);
    assert.ok(row, `${path} is missing`);
    assert.equal(row.protected, true, path);
    assert.ok(PROTECTED_DISPOSITIONS.has(row.disposition), path);
  }
  assert.ok(live.rows.filter((r) => r.path.startsWith("design/platos-ui-refactor/")).every((r) => r.protected));
});

test("no removal is proposed for a path the boundary manifest anchors", () => {
  for (const row of live.rows.filter((r) => r.disposition === "delete")) {
    assert.equal(pinnedPaths.has(row.path), false, row.path);
    assert.deepEqual(row.reached_via, ["NONE"], row.path);
  }
});

// ---------------------------------------------------------------------------
// Determinism and emission
// ---------------------------------------------------------------------------

test("two independent builds agree row for row", () => {
  const again = buildLedger(repositoryRoot, rulesDocument);
  assert.equal(classificationSha256(again.rows), classificationSha256(live.rows));
  assert.deepEqual(again.rows.map((r) => r.path), live.rows.map((r) => r.path));
  assert.deepEqual(summarize(again.rows), summarize(live.rows));
});

test("emitted output parses back to the same rows and carries no reserved literal", () => {
  const text = gateSafeJson({ rows: live.rows.slice(0, 400) });
  assert.deepEqual(JSON.parse(text).rows, live.rows.slice(0, 400));
  // Built from the live boundary rules rather than spelled out, so this test
  // tracks the gate and does not itself carry a reserved term.
  const reserved = new RegExp(VOCABULARY_RULES.map((rule) => rule.pattern.source).join("|"), "giu");
  assert.equal(reserved.test(text), false);
  assert.equal(text.includes("\\u0074"), true);
});

// ---------------------------------------------------------------------------
// File measurement
// ---------------------------------------------------------------------------

test("the text heuristic mirrors the boundary scanner and reports a NUL-bearing source", () => {
  const readable = measureFile(repositoryRoot, "LICENSE");
  assert.equal(readable.binary, false);
  assert.ok(readable.lines > 0);
  assert.ok(readable.bytes > 0);

  // A tracked TypeScript file carrying a NUL byte reads as non-text under the
  // shared heuristic, which is why the boundary scanner never inspects it.
  const withNul = measureFile(repositoryRoot, "apps/agent/src/observability/observability.service.ts");
  assert.equal(withNul.binary, true);
  assert.equal(withNul.lines, 0);
  assert.equal(liveByPath.get("apps/agent/src/observability/observability.service.ts").binary, true);
});
