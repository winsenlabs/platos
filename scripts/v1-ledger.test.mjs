import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  AREAS,
  DISPOSITIONS,
  KINDS,
  PROTECTED_DISPOSITIONS,
  REACHED_VIA,
  WORKSPACE_REACHABILITY_ARTIFACTS,
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

// Builds a throwaway git repository on disk and stages files, so buildLedger
// runs its REAL enumeration and file-reading corpus path with no injected
// corpus or measure -- the code that mutation N4 disabled while all the
// injected-corpus tests above stayed green.
function realRepoFixture(files) {
  const root = mkdtempSync(join("/var/tmp", "platos-ledger-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync("git", ["add", "--all"], { cwd: root });
  return root;
}

test("prospective-tree enumeration includes additions and removes absent index paths", () => {
  const root = realRepoFixture({ "tracked.txt": "old\n" });
  try {
    rmSync(join(root, "tracked.txt"));
    writeFileSync(join(root, "new\nfile.txt"), "new\n");
    assert.deepEqual(listTrackedFiles(root), ["new\nfile.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prospective-tree enumeration rejects invalid UTF-8 and retains dangling symlinks", () => {
  const invalidRoot = realRepoFixture({ "valid.txt": "valid\n" });
  try {
    const invalidPath = Buffer.concat([Buffer.from(`${invalidRoot}/invalid-`), Buffer.from([0xff])]);
    // APFS/HFS+ enforce UTF-8 filenames and reject this with EILSEQ, so the
    // bypass being asserted here is not constructible on macOS. Linux ext4/xfs
    // accept arbitrary bytes, so the assertion runs there -- where CI runs. Only
    // EILSEQ is tolerated; any other error still fails, so this never skips
    // silently.
    let constructible = true;
    try {
      writeFileSync(invalidPath, "invalid\n");
    } catch (error) {
      if (error?.code !== "EILSEQ") throw error;
      constructible = false;
    }
    if (constructible) {
      execFileSync("git", ["add", "--all"], { cwd: invalidRoot });
      assert.throws(() => listTrackedFiles(invalidRoot), /pathname with invalid UTF-8 bytes/u);
    }
  } finally {
    rmSync(invalidRoot, { recursive: true, force: true });
  }

  const symlinkRoot = realRepoFixture({ "valid.txt": "valid\n" });
  try {
    symlinkSync("missing-target", join(symlinkRoot, "dangling-link"));
    execFileSync("git", ["add", "--", "dangling-link"], { cwd: symlinkRoot });
    assert.deepEqual(listTrackedFiles(symlinkRoot), ["dangling-link", "valid.txt"]);
  } finally {
    rmSync(symlinkRoot, { recursive: true, force: true });
  }
});

const orphanRulesDoc = docWithArea("root-infra", [
  { ...goodRule, id: "orphan-delete", match: ["scripts/img/orphan.png"], kind: "asset", disposition: "delete", reached_via: ["NONE"] },
  { ...goodRule, id: "scripts-catch-all", match: ["scripts/**"], kind: "doc", disposition: "retain", reached_via: ["CI"] },
]);
orphanRulesDoc.areas["docs-content"] = [
  { ...goodRule, id: "docs-corpus", match: ["docs/**"], kind: "doc", disposition: "retain", reached_via: ["docs-reference"] },
];

test("the live build reads files and catches a real reference to a delete candidate", () => {
  // Same tree twice, differing only in whether a page cites the orphan. This
  // exercises the real readFileSync corpus population: disabling it (N4) makes
  // both cases report zero references and this assertion fails.
  const referenced = realRepoFixture({
    "scripts/img/orphan.png": "\x89PNG fake image bytes\n",
    "scripts/page.md": "gallery: ![shot](./img/orphan.png)\n",
  });
  try {
    const result = buildLedger(referenced, orphanRulesDoc);
    assert.equal(result.deleteReferences.length, 1);
    assert.equal(result.deleteReferences[0].path, "scripts/img/orphan.png");
    assert.ok(result.deleteReferences[0].referencedBy.includes("scripts/page.md"));
    const failures = checkInvariants(result, listTrackedFiles(referenced), new Set());
    assert.ok(failures.some((f) => f.includes("scripts/img/orphan.png is classified delete but is referenced by")));
  } finally {
    rmSync(referenced, { recursive: true, force: true });
  }

  const clean = realRepoFixture({
    "scripts/img/orphan.png": "\x89PNG fake image bytes\n",
    "scripts/page.md": "gallery: no image here\n",
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
    rows: [{ path: "scripts/img/orphan.png", disposition: "delete" }],
  });
  // The artifact names the orphan, but as ledger data, so it is not a reference.
  assert.equal(looksLikeLedgerArtifact(artifact), true);
  const repo = realRepoFixture({
    "scripts/img/orphan.png": "\x89PNG fake image bytes\n",
    "docs/v1-ledger.json": artifact,
  });
  try {
    const result = buildLedger(repo, orphanRulesDoc);
    assert.deepEqual(result.deleteReferences, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("generated workspace reachability artifacts are data, not live path references", () => {
  const repo = realRepoFixture({
    "scripts/img/orphan.png": "\x89PNG fake image bytes\n",
    [WORKSPACE_REACHABILITY_ARTIFACTS[0]]: JSON.stringify({ evidence: "scripts/img/orphan.png" }),
    [WORKSPACE_REACHABILITY_ARTIFACTS[1]]: "Evidence for `scripts/img/orphan.png`\n",
  });
  try {
    const result = buildLedger(repo, orphanRulesDoc);
    assert.deepEqual(result.deleteReferences, []);

    const control = buildLedger(repo, orphanRulesDoc, { corpusExclude: [] });
    assert.equal(control.deleteReferences.length, 1);
    assert.deepEqual(control.deleteReferences[0].referencedBy, WORKSPACE_REACHABILITY_ARTIFACTS);
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

test("area counts reconcile against the baseline plus exact WIN-254 and legal-provenance additions", () => {
  const summary = summarize(live.rows);
  const expectedDeltas = {
    "apps-agent": 0,
    "apps-webapp": 0,
    // 0 -> 19. WIN-297 makes apps/core-api a real process: 12 source files
    // (composition/{adapter-bindings,registry}, config/{schema,load},
    // health/readiness, http/{health.controller,http.module,token},
    // runtime/{correlation,in-flight,lifecycle,process-ports}) classified by the
    // new apps-core-api.source.process rule, plus 7 suites. main.ts,
    // app.module.ts and the six transport seams were rewritten in place and add
    // no files. The transports rule stays at exactly 6 — the new rule is
    // declared ahead of it so process code does not inherit transport evidence.
    "apps-core-api": 19,
    // 0 -> 3. The stdio binary's runtime (config, frame loop, host-runtime
    // loader), the in-repository host runtime the executable evidence points at,
    // and its suite.
    "apps-mcp-stdio": 3,
    // 1 -> 207 -> 272 -> 339. WIN-252 added packages/core/NOTICE (the upstream
    // MIT attribution, kept out of LICENSE so every publishable package's
    // LICENSE stays byte-identical to the repository Apache-2.0 text). WIN-256
    // then added 206 files making packages/kernel and four contexts real
    // (identity-access, secrets, tenancy, files) — domain, application, ports,
    // contracts, in-memory use cases and test builders.
    //
    // +65: the same issue makes `providers` real (ADR M0.3 §1 context 4) —
    // 17 domain modules and 13 domain suites, 20 application modules and 7
    // application suites, 3 ports, 5 in-memory doubles, and the contracts
    // barrel with its suite. The 65 are NET of the 4 generated placeholders
    // that adoption released and this code replaced in place.
    //
    // +44: the same issue makes `eventing` real (ADR M0.3 §1 row 17) — 44
    // files under packages/contexts/eventing, 30 source and 14 test. The four
    // generated placeholders it replaces (domain, application,
    // application/ports and contracts barrels) were already tracked, so they
    // change bytes without changing the count, which is why 34 source files
    // on disk conserve to a delta of 30.
    //
    // +55: the same issue makes `skills` real (M2.1) — 35 source and 20 test.
    // The source is 14 domain modules (the manifest parser and its YAML subset,
    // the catalogue aggregate, the project/environment install pair,
    // visibility, prompt composition, tool namespacing, environment readiness,
    // category derivation, import-source rewriting, identifiers, errors,
    // policy), 4 driven ports, 13 application use cases and 4 in-memory testing
    // doubles. Its four barrels were already tracked as generator placeholders
    // and are EDITED, not added, which is why 55 and not 59.
    //
    // +51: the same issue makes `jobs` real (ADR M0.3 §1 row 11) — 35 source
    // and 16 test. domain 23 (two aggregates, the invocation acceptance table,
    // the payload admission rules, the execution-request gate and the
    // idempotency decision, each with its co-located suite), application 17,
    // its ports 4, its in-memory testing doubles 6, and the contracts barrel 1.
    // Its four generator placeholders were already tracked, so they do not
    // appear in this delta — adoption releases a source tree, it does not add
    // files.
    //
    // +77: the same issue makes `memory` real (ADR M0.3 §1 row 8) — 17 domain
    // modules and 15 domain suites, 17 application modules and 12 application
    // suites, 5 ports, 8 in-memory doubles and their barrel, and the contracts
    // barrel with its suite. The 77 are likewise NET of the 4 generated
    // placeholders adoption released and this code replaced in place.
    //
    // +63: the same issue makes `cost-monitoring` real (ADR M0.3 §1 row 13) —
    // 15 domain modules and 12 domain suites, 16 application modules and 8
    // application suites, 4 ports, 6 in-memory doubles, and the contracts
    // barrel with its suite. The 63 are NET of the same 4 generated
    // placeholders every adoption releases and this code replaced in place.
    //
    // +48: the same issue makes `privacy` real (ADR M0.3 §1 row 18) — 48 net
    // files under packages/contexts/privacy, 33 source (10 domain modules, 4
    // driven ports, 13 use-case and composition modules, 3 in-memory doubles, 2
    // contracts entrypoints, 1 barrel) and 15 test suites. Its four generator
    // placeholders were already tracked and are EDITED, not added, so adoption
    // itself moves nothing here; only the released source tree does.
    //
    // +48: the same issue makes `observability` real (ADR M0.3 §1 row 16) — 48
    // net files under packages/contexts/observability, 33 source (14 domain
    // modules plus the domain barrel, 4 ports modules plus their barrel, 7
    // application modules plus the application barrel, the contracts barrel and
    // 5 in-memory testing doubles) and 15 test suites (9 domain, 5 application,
    // 1 contract). The observability branch's own tip recorded 47: the 48th is
    // application/drain-projections.lanes.test.ts, split out because the
    // end-to-end tool-call and usage cases took drain-projections.test.ts to 453
    // effective lines, past the ADR M0.3 §6 400-line warning band.
    //
    // +67: the same issue makes `agents` real (ADR M0.3 §1 context 5) — 16
    // domain modules and 14 domain suites, 16 application modules and 10
    // application suites, 4 ports, 4 in-memory doubles, and the contracts barrel
    // plus its split read-model module and its suite. The 67 are likewise NET of
    // the 4 released placeholders, and two of them exist only because the ADR
    // M0.3 §6 budget bit in its warning band and the answer was to split rather
    // than to waive.
    //
    //
    // +56: the same issue makes `tools` real (ADR M0.3 §1 context 7) — 17
    // domain modules and 13 domain suites, 12 application modules and 4
    // application suites, 3 ports, 4 in-memory doubles, and the contracts
    // barrel with its suite, which is 55; the 56th is
    // contracts/operator-gate.test.ts, the suite proving the operator gate on
    // all fourteen published methods that have one — eleven of which had no
    // refusal case at all, six of those eleven mutating. It is ONE file because
    // the twenty-eight cases had to be written out rather than looped: the
    // test-case census refuses an `it()` declared inside a loop, and folding
    // them into the contracts barrel suite would have pushed that file past the
    // ADR M0.3 §6 warning line. The 56 are NET of the 4 generated placeholders
    // that adoption released and this code replaced in place, exactly as every
    // other adoption's delta is.
    //
    // +42: the same issue makes `channels` real (ADR M0.3 §1 row 9) — 27 source
    // and 15 test files under packages/contexts/channels, NET of the 4 generated
    // placeholders adoption released and this code replaced in place. Its
    // `credentialRevision` third axis on `ChannelInstallation` is carried
    // deliberately, not tidied away: `channel-persistence.service.ts` already
    // enforces three axes, so deleting the field would be a silent regression.
    //
    // +84: the same issue makes `governance` real (ADR M0.3 §1 row 14). The tree
    // holds 87 TypeScript files — 19 domain modules and 16 domain suites, 17
    // application modules and 14 application suites, 9 ports, 10 in-memory
    // doubles and testing fixtures, and 2 contracts files (the barrel and its
    // suite) — of which FOUR are the generated placeholders adoption released
    // and this code replaced in place, so 83 are new. The 84th is
    // `mutations.json`, the guard ledger that names every authorization check,
    // cap, kill switch and erasure step in the package together with the edit
    // that would remove it. That one is the single `config` file in this delta
    // and needed NO new ledger rule: `packages.contexts.config` already matches
    // `packages/contexts/**/*.json`.
    //
    // The 84 conserves against the other two censuses rather than standing
    // alone: 83 TypeScript files (52 source + 31 test, which is the same +83
    // that `scripts/arch/arch-boundaries.test.mjs` counts as 948 -> 1031 and
    // `scripts/arch/max-file-lines.test.mjs` counts as 879 -> 962) plus the one
    // JSON. Its branch stated those two as 464 -> 547 and 395 -> 478, which were
    // its own tree's numbers; the DELTA is what conserves and the delta is
    // unchanged. All three are NET of the 4 generated placeholders adoption
    // released and this code replaced in place. A deletion cannot hide inside
    // this addition because the same 83 has to appear in three independently
    // computed places.
    //
    // THE ADOPTIONS ARE SUMMED, NOT SIDE-PICKED: they add DISJOINT files under
    // eleven different package directories, plus eight more into a twelfth that
    // was already real, and each moves this one number, so
    // 272 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42 + 84 + 8 = 915. The
    // eventing
    // branch pinned 316, the skills branch pinned 327, the jobs branch pinned
    // 323, the memory branch pinned 349, the cost-monitoring branch pinned 335
    // and the privacy branch pinned 320, the observability branch pinned 320 as
    // well, the agents branch pinned 339, the tools branch pinned 328 and the
    // channels branch pinned 314; the governance branch, which alone branched
    // from the agents branch rather than from v1, pinned 423 (272 + 67 + 84) and
    // was blind to the other nine. Each is right for its own tree alone. Taking
    // any of them would leave whole
    // contexts' files unaccounted while the gate stayed green on the branch it
    // came from.
    // +8: WIN-256's `conversations` prerequisite (ADR M0.3 §14) puts the
    // inference surface on the ModelRouter port. Four source modules under
    // packages/contexts/providers — domain/prompt.ts, domain/prompt-cache.ts,
    // domain/generation.ts and application/run-model-generation.ts — and the
    // four suites beside them. It ADOPTS NO PROJECT, so unlike every delta
    // above it releases no placeholder and replaces nothing: this +8 is gross
    // and net alike. Its branch pinned 280 (272 + 8) on v1 and was blind to all
    // eleven adoptions; 907 + 8 = 915 here.
    //
    // +34: WIN-256's MODEL ROUTER ADAPTER. Fifteen source modules and fifteen
    // suites under packages/adapters/model-router-providers, the sole holder of
    // the inference SDK, plus two domain modules and two suites under
    // packages/contexts/providers — the tool-input repair and the
    // structured-output correction, both PURE, which is the same property that
    // puts prompt-cache.ts in the domain too.
    //
    // It is the FIRST delta on this axis that lands under
    // `packages/adapters/**` rather than `packages/contexts/**`, and the first
    // adapter adoption of any kind. Adoption releases that project's TWO
    // declaration placeholders (src/adapter.ts and src/index.ts) and this code
    // replaced BOTH in place under the same names, so the +34 is 32 + 2 with no
    // subtraction hidden inside it and is net as well as gross. Its branch
    // pinned 314 (272 + 8 + 34) on the prerequisite tip and was blind to all
    // eleven adoptions above; 915 + 34 = 949 here, and 314 is wrong by exactly
    // the 635 those eleven contribute.
    //
    // WIN-257 OPERATOR IDENTITY (M2.2) adds 18, 949 -> 967, ALL in `packages`
    // and all under `packages/contexts/**`. T2 adds no file at all -- composing
    // tenancy is a manifest subpath, a wiring edit and a fixture helper in files
    // that already existed. T1 +2 (the first implementation of the published
    // IdentityAccessContract and its refusal suite); T3 +4 (the two
    // transactional writes whose only home was a Prisma `$transaction` in a
    // Remix route, and a suite for each); T4 +8 (tenancy domain/visibility.ts,
    // the authorization rule ported out of
    // apps/webapp/app/services/projectAccess.server.ts where it existed only as
    // a Prisma.ProjectWhereInput, plus application/operator-read-models.ts;
    // identity-access domain/end-user.ts and application/list-end-users.ts, the
    // read this context published none of despite being sole writer of EndUser;
    // and a suite for each of the four); T5 +4 (identity-access
    // domain/session-cookie.ts, the cookie exchange contract moved out of
    // apps/webapp/app/services/auth.server.ts, and its suite, plus the two
    // suites the ADR M0.3 section 6 line budget forced out of
    // identity-access-service.test.ts -- a SPLIT, not new coverage). Its branch
    // pinned packages 272 -> 290 and the combined delta 346 -> 364 on v1, blind
    // to every adoption above; the +18 is the part that conserves and 290 is not
    // the number here. No new ledger rule was needed.
    //
    // WIN-256 CONVERSATIONS, the seventeenth and last context, adds 75, ALL in
    // `packages` and all under packages/contexts/conversations: 78 real .ts
    // files stand where 4 generated placeholders stood and one mutations.json
    // joins them, so 78 - 4 + 1 = 75 and the release is written into the number
    // rather than hidden by it. Nothing may import this context, so no file
    // outside it moves. Its branch pinned packages 990 (915 + 75) on a tree that
    // had neither the adapter nor WIN-257; the three deltas are disjoint and SUM,
    // 915 + 34 + 18 + 75 = 1042, and neither 967 nor 990 is the number here.
    // WIN-258 POSTGRES-TENANCY (M2.3) adds 13, ALL in `packages` and all under
    // packages/adapters/postgres-tenancy: 15 real files stand where 2 generated
    // placeholders stood, so 15 - 2 = 13 and the release is written into the
    // number rather than hidden by it. On the kind axis the same 13 is +8 source
    // (10 modules less the 2 released placeholders, which were themselves
    // source), +4 test and +1 fixture — the SQL that seeds the identity-access
    // rows this adapter is not the writer of, which needed the one new ledger
    // rule this issue adds. Nothing outside that directory moves: the generator
    // adoption, the new boundary rule, the sole-writer delegation and every
    // census pin are edits to files that already existed.
    //
    // A FOURTEENTH file joined it once the guard sweep had been run:
    // `packages/adapters/postgres-tenancy/mutations.json`, the 22-entry ledger,
    // which the existing `packages.adapters.config` rule already classifies, so
    // it needed no rule of its own. 16 real files where 2 placeholders stood.
    // 1042 + 13 + 1 = 1056, and on the kind axis the extra 1 is config.
    //
    // WIN-258 TRANCHE 2 — the identity-access canonical store — adds 23 more to
    // the SAME directory, 1056 -> 1079, and to no other area at all. ADR M0.3
    // §15 is why: one PostgreSQL database is one client is one adapter
    // DIRECTORY, so both contexts' repositories live in `postgres-tenancy` and
    // there is no thirteenth adapter package to move `packages` a second way.
    //
    //   +15 source  identity-mapping, identity-rows, identity-guards, the seven
    //               store modules and the identity-repository composite, the two
    //               conformance-scenario halves, identity-harness and
    //               identity-differential-harness
    //   +7  test    identity-mapping.test and the six integration suites
    //               (conformance, constraints, transaction, statements,
    //               differential, differential-login)
    //   +1  config  mutations-identity.json, the 37-entry guard ledger, under
    //               the same packages.adapters.config rule as mutations.json
    //
    // 15 + 7 + 1 = 23. NOTHING is released this time — the directory was already
    // adopted at tranche 1, so no placeholder is subtracted and the 23 additions
    // ARE the whole delta. The gate widenings, the ADR §15 amendment, the
    // composition-root binding table, the census and sole-writer pins, the CI
    // job and the regenerated evidence are all edits to files that already
    // existed. 1056 + 23 = 1079.
    //
    // WIN-258 TRANCHE 3 — tenancy's OTHER FIVE PORTS — adds 12 more to the SAME
    // directory, 1079 -> 1091, and again to no other area at all. The five ports
    // are a row lock and an advisory lock, a session revoker, an access-key
    // revocation counter, an invitation token issuer and an operator directory;
    // five of the six ports on `TenancyDependencies` that are not the
    // repository, and they are here because a lock a use case takes has to be
    // held by the transaction its writes are in.
    //
    //   +6  source  locks, access-key-revocation, operator-peers,
    //               invitation-token, the shared ports-conformance scenario and
    //               ports-harness
    //   +5  test    invitation-token.test and the four integration suites
    //               (locks, ports-conformance, ports-transaction,
    //               ports-statements)
    //   +1  config  mutations-ports.json, the 21-entry guard ledger, under the
    //               same packages.adapters.config rule as the other two
    //
    // 6 + 5 + 1 = 12. NOTHING is released — the directory has had no placeholder
    // left since tranche 1 — so the 12 additions ARE the whole delta. The one
    // re-export added to tenancy's ports entry point, the adapter assembly, the
    // census, arch, line-budget and sole-writer pins and the regenerated
    // evidence are all edits to files that already existed. 1079 + 12 = 1091.
    //
    // WIN-258 TRANCHE 4 — the kernel outbox — adds 18, and this is the FIRST
    // WIN-258 delta that lands in TWO adapter directories, because the outbox is
    // two packages. `Event` has an owner that is an adapter rather than a
    // context, and ADR M0.3 §15 gives the ORM one home, so the package that owns
    // the port cannot be the package that issues its INSERT.
    //
    //   packages/adapters/outbox              +11  five source modules (store,
    //               event-id, envelope, in-memory, conformance), four suites,
    //               conformance-scenario.json and mutations.json. Its two
    //               generated placeholders — adapter.ts and index.ts — are
    //               EDITED in place by adoption, not added, which is why 11 and
    //               not 13.
    //   packages/adapters/postgres-tenancy     +7  outbox-store and
    //               outbox-harness, four real-PostgreSQL suites, and
    //               mutations-outbox.json.
    //
    // On the kind axis the same 18 is +7 source, +8 test and +3 config; both
    // JSON documents land on the existing packages.adapters.config rule and
    // needed no rule of their own. Nothing outside those two directories moves:
    // the generator adoption, the sole-writer delegation, the composition root's
    // cross-adapter assertion and every census pin are edits to files that
    // already existed. 1079 + 18 = 1097.
    //
    // BOTH TRANCHES LAND, so this area carries BOTH tails: 1079 + 12 + 18 =
    // 1109. Each branch pinned 1079 + its own addition and each was right
    // alone; taking either merged would understate the packages area by the
    // other's twelve or eighteen files.
    packages: 1109,
    "internal-packages": 0,
    // WIN-254 added four reviewed docs; WIN-252 legal provenance adds five
    // exact evidence files under docs/audits/sbom.
    //
    // M2 INTEGRATION DELTA — apps-core-api 0 -> 19, apps-mcp-stdio 0 -> 3,
    // packages 1 -> 907 -> 915 -> 949, docs-content 9 -> 13, root-infra 10 -> 39,
    // total +20 -> +991 -> +1025. Sixteen branches add files on independent
    // axes, so each area is the SUM of every contribution, not any one alone;
    // WIN-256's `conversations` prerequisite adds eight to `packages` and to
    // nothing else, and its model router adapter adds the last thirty-four to
    // `packages` and to nothing else. The running total on this line read +981
    // while the assertions below already read +991; it was short by the
    // prerequisite's 8 and the capability-matrix +2, and is carried through
    // here rather than left stale.
    //
    // WIN-299 (M2.6) contributes +5 (docs-content +2, root-infra +3):
    //   docs-content  docs/audits/sbom/advisory/README.md
    //                 docs/audits/sbom/advisory/advisory-policy.json
    //   root-infra    scripts/lib/advisory-dispositions.mjs
    //                 scripts/advisory-dispositions.test.mjs
    //                 scripts/verify-advisory-nonvacuity.mjs
    // advisory-policy.json lands on the docs/audits/**/*.json audit-receipts
    // rule (kind "generated"), the same bucket that already carries the
    // hand-maintained licence overlay docs/audits/sbom/license-policy.json.
    //
    // WIN-284 (differential harness) contributes +19 (docs-content +2,
    // root-infra +17):
    //   docs-content +2 — the generated differential capability coverage
    //   matrix, docs/audits/win-284-differential-coverage.{json,md}. Both
    //   classify under the existing docs-content.evidence.audit-receipts and
    //   .audit-notes rules and are pinned ACCEPTED in
    //   scripts/evidence-lifecycle.mjs, because they are reconciled to the M0
    //   censuses on every run rather than being a snapshot of what coverage
    //   looked like on some past date.
    //
    //   root-infra +17 — two under scripts/ (differential-coverage.mjs and its
    //   mutation suite, classified root-infra.tooling.scripts and
    //   root-infra.test.script-suites) and fifteen under
    //   tests/differential-harness/ (README, observation, normalisers,
    //   comparators, twin-run, seeds, scenarios, the two runners, four test
    //   suites and two subjects), all classified root-infra.test.harness.
    //
    // WIN-256 (domain contracts) contributes +278 (packages +271,
    // docs-content +0, root-infra +7):
    //   packages 1 -> 272 — the five real contexts (secrets, files, tenancy,
    //   identity-access, providers) plus packages/kernel: domain modules,
    //   application suites, ports, in-memory doubles and the contracts barrel.
    //   NET of the 4 generated placeholders that adoption released and this
    //   code replaced in place.
    //
    //   root-infra +7 — five for the ADR §5.3 kernel-content assertion and its
    //   tests and the §5.2 ownership map and sole-writer lint and its tests,
    //   plus two for owner decision 9 (2026-09-02): the per-package test CASE
    //   census scripts/arch/test-case-census.mjs and its control suite. Both
    //   classify as root-infra.tooling.scripts; `scripts/*.test.mjs` is a
    //   single-level glob and does not reach `scripts/arch/`. Adopting
    //   `providers` adds no file: it is one line appended to the generator's
    //   ADOPTED_PROJECTS list, in a file that already existed.
    //
    //   docs-content +0 — WIN-256 adds no document to that area.
    //
    // WIN-256 (tools context) contributes a further +56, all of it packages
    // (725 -> 781), and nothing to any other area:
    //   packages +56 — packages/contexts/tools made real, plus the
    //   operator-gate suite the unproven-guard wave added; enumerated in the
    //   packages comment above. NET of the 4 generated placeholders that
    //   adoption released and this code replaced in place, exactly as the
    //   providers delta was.
    //
    //   root-infra +0, docs-content +0 — adopting `tools` appends one line to
    //   the generator's ADOPTED_PROJECTS list in a file that already exists,
    //   and the canary reconciliations edit existing suites. The axis is
    //   disjoint from WIN-297's apps/* and WIN-284's tests/*, so the merged
    //   delta is the sum, not a reconciliation.
    //
    // WIN-297 (composition root) contributes +24 (apps-core-api +19,
    // apps-mcp-stdio +3, root-infra +2), all attributed above and below.
    //
    //   root-infra +2 — scripts/arch/composition-root.mjs, which narrows rule
    //   (j) from a package to the single file entitled to import an adapter,
    //   and its 22-control suite, which carries the real-tree negative
    //   controls for rules (j) and (a). These are DISTINCT from WIN-256's own
    //   +2 (the test-case census and its control suite): both branches moved
    //   root-infra from 15 to 17 on their own lineage, but on different files,
    //   so the integrated value is 10 + 3 + 17 + 7 + 2 = 39, not 17.
    //
    // WIN-256 (agents context) contributes +67, ENTIRELY on the packages axis
    // — 272 -> 339, enumerated in the packages comment above. Adoption itself
    // adds no root-infra file: it is one line appended to the generator's
    // ADOPTED_PROJECTS list, in a file that already existed, exactly as it was
    // for `providers`. docs-content and both apps areas are untouched, which is
    // why this slice composes with the other four by addition rather than by
    // reconciliation.
    //
    // No new ledger rule was needed by any branch beyond WIN-297's
    // apps-core-api.source.process rule, which is declared ahead of the
    // transports rule so process code does not inherit transport evidence.
    // Every added file is enumerated above and conserves exactly to these
    // deltas; attributed for ledger-owner review, not forced to green.
    // WIN-256 (eventing context) contributes +44, WIN-256 (skills context)
    // contributes +55, WIN-256 (jobs context) contributes +51, WIN-256 (memory
    // context) contributes +77 and WIN-256 (cost-monitoring context)
    // contributes +63, all five ENTIRELY on the packages axis —
    // 272 -> 316 -> 371 -> 422 -> 499 -> 562 -> 610 -> 658 -> 725, enumerated in the packages
    // comment above. No adoption adds a root-infra file: each appends one line to the
    // generator's ADOPTED_PROJECTS list and edits the census pins, all in files
    // that already existed. docs-content and both apps areas are untouched,
    // which is why these slices compose with the other four — and with each
    // other — by addition rather than by reconciliation.
    //
    // WIN-256 (tools context) contributes +56, WIN-256 (channels context)
    // contributes +42 and WIN-256 (governance context) contributes +84 on the
    // same packages axis, 725 -> 781 -> 823 -> 907 — and, with the
    // prerequisite's 8 and conversations' 75, on to 990 — for the same
    // reason and with the same absence of a root-infra or docs-content file.
    // Governance's 84 is the only adoption delta that is not purely TypeScript:
    // 83 .ts files plus `mutations.json`, which the existing
    // `packages.contexts.config` rule already classifies, so no ledger rule
    // changed for it either. WIN-256 (conversations context) contributes +75,
    // the LAST of the seventeen and the second delta of that shape: 78 real .ts
    // files replace the 4 generated placeholders adoption released, plus its own
    // 89-entry `mutations.json` under the same config rule, so 78 - 4 + 1 = 75.
    // On the kind axis that same 75 is 45 source (49 .ts source less the 4
    // released placeholders, which were themselves source), 29 test and 1
    // config. Nothing may import this context (ADR M0.3 section 1 row 16), so it
    // touches no file outside packages/contexts/conversations and composes with
    // every slice above by addition.
    //
    // WIN-256 (capability-matrix ownership) contributes +2, both root-infra,
    // and is a different slice of the same issue from the domain-contracts
    // +278 above:
    //   scripts/arch/route-ownership.mjs   root-infra.tooling.scripts, source
    //   scripts/capability-matrix.test.mjs root-infra.test.script-suites, test
    // Nothing is deleted on that axis, so the two additions ARE the whole
    // delta and no removal can hide inside them: root-infra 39 -> 41, and
    // kindCounts source +1 and test +1 sum to the same 2. Its axis is disjoint
    // from every context adoption above — those move `packages` alone and this
    // one moves `root-infra` alone — so the integrated delta is the SUM,
    // 989 + 2, and neither branch pin (897 or 348) is correct here.
    //
    // WIN-256's MODEL ROUTER ADAPTER contributes +34, ALL of it on the packages
    // axis (915 -> 949) and none of it anywhere else:
    //
    //   packages/adapters/model-router-providers/src  15 source + 15 suites
    //     the sole holder of the inference SDK. Fifteen modules because ADR
    //     M0.3 §6 is the reason the extraction source's turn engine is 7,121
    //     lines, and fifteen suites because the end-to-end one reached 645
    //     effective lines as a single file.
    //
    //   packages/contexts/providers/domain            2 source + 2 suites
    //     tool-input-repair and structured-output: the two PURE pieces the
    //     adapter would otherwise have hidden beside an SDK call, on the same
    //     argument prompt-cache.ts already makes for itself.
    //
    // Every other area is unchanged by it. The generator adoption, the widened
    // max-file-lines selector, the seven new error codes and the census pins
    // are all edits to files that already existed and add none.
    //
    // 20 + 5 + 19 + 278 + 24 + 44 + 55 + 51 + 77 + 63 + 48 + 48 + 67 + 56 + 42
    //   + 84 + 8 + 2 + 34 + 18 + 75 + 13 + 1 = 1132, + 23 (WIN-258 tranche 2)
    //   = 1155, + 12 (WIN-258 tranche 3) + 18 (WIN-258 tranche 4, in TWO
    //   adapter directories) = 1185.
    "docs-content": 13,
    "root-infra": 41,
  };
  assert.equal(summary.totalFiles, rulesDocument.baseline.totalFiles + 1185);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(summary.areaCounts).map(([area, count]) => [area, count - rulesDocument.baseline.areaCounts[area]])
    ),
    expectedDeltas
  );
  assert.equal(
    Object.values(summary.areaCounts).reduce((a, b) => a + b, 0),
    // M2 integration: same +20 -> +1118 combined delta as the totalFiles
    // assertion above (WIN-299 +5, WIN-284 +19, WIN-256 domain contracts +278,
    // WIN-297 +24, WIN-256 eventing +44, WIN-256 skills +55, WIN-256 jobs +51,
    // WIN-256 memory +77, WIN-256 cost-monitoring +63, WIN-256 privacy +48,
    // WIN-256 observability +48, WIN-256 agents +67, WIN-256 tools +56,
    // WIN-256 channels +42, WIN-256 governance +84, the WIN-256 `conversations`
    // prerequisite +8, WIN-256 capability-matrix ownership +2, WIN-256's model
    // router adapter +34, WIN-257 operator identity +18, WIN-256 conversations
    // +75, WIN-258 postgres-tenancy +13 and its guard ledger +1, and WIN-258
    // tranche 2's identity-access canonical store +23, WIN-258 tranche 3's other
    // five tenancy ports +12, and WIN-258 tranche 4's kernel outbox +18 across
    // TWO adapter directories); this one re-derives it by summing the per-area
    // counts independently, so the two can DISAGREE and be caught.
    rulesDocument.baseline.totalFiles + 1185
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
test("the retained formerly contradictory files resolve as the charter requires", () => {
  assert.equal(liveByPath.get("internal-packages/run-engine/runengine-diagram.monojson").disposition, "retain");
  const license = liveByPath.get("internal-packages/otlp-importer/LICENSE");
  assert.equal(license.kind, "legal");
  assert.equal(license.disposition, "retain");
  assert.equal(license.protected, true);
});

test("the assembled tree has no live delete candidates or delete references", () => {
  // Delete behavior remains covered by fixture mutation tests above. WIN-254
  // retains the inherited documentation corpus, so the assembled live ledger
  // intentionally has no delete disposition.
  assert.deepEqual(live.deleteReferences, []);
  assert.equal(live.rows.filter((row) => row.disposition === "delete").length, 0);
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

test("the two surviving falsified files are never proposed for removal", () => {
  const proxy = liveByPath.get("hosting/Caddyfile.example");
  assert.equal(proxy.disposition, "retain");
  assert.ok(proxy.evidence.includes("BARE BASENAME"));

  const submodules = liveByPath.get(".gitmodules");
  assert.equal(submodules.disposition, "unresolved");
  assert.deepEqual(submodules.reached_via, ["git-subcommand"]);
  assert.ok(submodules.evidence.includes("submodule.mjs"));

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
    "internal-packages/database/prisma/migrations/20221206131204_init/migration.sql",
  ]) {
    const row = liveByPath.get(path);
    assert.ok(row, `${path} is missing`);
    assert.equal(row.protected, true, path);
    assert.ok(PROTECTED_DISPOSITIONS.has(row.disposition), path);
  }
  assert.ok(live.rows.filter((r) => r.path.startsWith("design/platos-ui-refactor/")).every((r) => r.protected));
  assert.equal(liveByPath.get("design/README.md").protected, true);
  const contentRows = live.rows.filter((row) => row.path.startsWith("content/"));
  assert.ok(contentRows.length > 80, "content protection selector is non-vacuous");
  assert.ok(contentRows.every((row) => row.protected && PROTECTED_DISPOSITIONS.has(row.disposition)));
  for (const root of ["ai/", "docs/", "examples/", "references/", "rules/"]) {
    const rows = live.rows.filter((row) => row.path.startsWith(root));
    assert.ok(rows.length > 0, `${root} protection selector is non-vacuous`);
    assert.ok(rows.every((row) => row.protected && PROTECTED_DISPOSITIONS.has(row.disposition)), root);
  }
});

test("stable evidence categories win before broad documentation buckets", () => {
  assert.equal(liveByPath.get("docs/adr/M0.3-bounded-contexts.md").rule_id, "docs-content.evidence.adr");
  assert.equal(liveByPath.get("docs/audits/history/win-252/prompt-caching-progress.md").rule_id, "docs-content.evidence.audit-history");
  assert.equal(liveByPath.get("docs/audits/sbom/closure-receipts.json").rule_id, "docs-content.evidence.audit-receipts");
  assert.equal(liveByPath.get("docs/audits/M0.5-dependency-sbom.md").rule_id, "docs-content.lifecycle.point-in-time-reports");
  assert.equal(liveByPath.get("docs/audits/sbom/advisory/osv-report.json").rule_id, "docs-content.lifecycle.point-in-time-snapshots");
  assert.equal(liveByPath.get("docs/refactor/platos-trigger-refactor.md").rule_id, "docs-content.lifecycle.draft");
  assert.equal(liveByPath.get("rules/4.0.0/basic-tasks.md").rule_id, "docs-content.lifecycle.rules-superseded");
  assert.equal(liveByPath.get("rules/4.3.0/basic-tasks.md").rule_id, "docs-content.lifecycle.rules-accepted-targets");
  assert.equal(liveByPath.get("rules/manifest.json").rule_id, "docs-content.lifecycle.rules-manifest");
  assert.equal(liveByPath.get("design/platos-ui-refactor.provenance.json").rule_id, "docs-content.design.provenance");
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
