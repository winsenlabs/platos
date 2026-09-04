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
    // +67: the same issue makes `agents` real (context 5) — 16 domain modules
    // and 14 domain suites, 16 application modules and 10 application suites,
    // 4 ports, 4 in-memory doubles, and the contracts barrel plus its split
    // read-model module and its suite. The 67 are likewise NET of the 4
    // released placeholders, and two of them exist only because the ADR M0.3 §6
    // budget bit in its warning band and the answer was to split rather than to
    // waive.
    //
    // +83: the same issue makes `governance` real (context 14). The tree holds
    // 86 TypeScript files — 19 domain modules and 16 domain suites, 17
    // application modules and 14 application suites, 9 ports, 9 in-memory
    // doubles and testing fixtures, and 2 contracts files (the barrel and its
    // suite) — of which FOUR are the generated placeholders adoption released
    // and this code replaced in place, so 82 are new. The 83rd is
    // `mutations.json`, the guard ledger that names every authorization check,
    // cap, kill switch and erasure step in the package together with the edit
    // that would remove it. That one is the single `config` file in this delta
    // and needed NO new ledger rule: `packages.contexts.config` already matches
    // `packages/contexts/**/*.json`.
    //
    // The 83 conserves against the other two censuses rather than standing
    // alone: 82 TypeScript files (51 source + 31 test, which is the same +82
    // that `scripts/arch/arch-boundaries.test.mjs` counts as 464 -> 546 and
    // `scripts/arch/max-file-lines.test.mjs` counts as 395 -> 477) plus the one
    // JSON. All three are NET of the 4 generated placeholders adoption released
    // and this code replaced in place. A deletion cannot hide inside this
    // addition because the same 82 has to appear in three independently
    // computed places.
    packages: 422,
    "internal-packages": 0,
    // WIN-254 added four reviewed docs; WIN-252 legal provenance adds five
    // exact evidence files under docs/audits/sbom.
    //
    // M2 INTEGRATION DELTA — apps-core-api 0 -> 19, apps-mcp-stdio 0 -> 3,
    // packages 1 -> 339, docs-content 9 -> 13, root-infra 10 -> 39,
    // total +20 -> +413. Five branches add files on independent axes, so each
    // area is the SUM of every contribution, not any one alone.
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
    // 20 + 5 + 19 + 278 + 24 + 67 = 413, and + 83 for governance = 496.
    "docs-content": 13,
    "root-infra": 39,
  };
  assert.equal(summary.totalFiles, rulesDocument.baseline.totalFiles + 496);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(summary.areaCounts).map(([area, count]) => [area, count - rulesDocument.baseline.areaCounts[area]])
    ),
    expectedDeltas
  );
  assert.equal(
    Object.values(summary.areaCounts).reduce((a, b) => a + b, 0),
    // M2 integration: same +20 -> +496 combined delta as the totalFiles
    // assertion above (WIN-299 +5, WIN-284 +19, WIN-256 domain contracts +278,
    // WIN-297 +24, WIN-256 agents +67, WIN-256 governance +83); this one
    // re-derives it by summing the per-area counts independently.
    rulesDocument.baseline.totalFiles + 496
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
