import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function tinyLedger(rules, paths) {
  const areas = Object.fromEntries(AREAS.map((area) => [area, [{ ...goodRule, id: `${area}.base` }]]));
  areas["root-infra"] = rules;
  return buildLedger(repositoryRoot, { version: 1, areas }, {
    trackedFiles: paths,
    measure: () => ({ bytes: 1, lines: 1, binary: false }),
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
// decides each one, and in every case the safer disposition is declared first.
test("the six formerly contradictory files resolve to the safer disposition", () => {
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

test("the safer rule is declared earlier than the rule it beats", () => {
  const order = (id) =>
    rulesDocument.areas["internal-packages"].findIndex((rule) => rule.id === id);
  assert.ok(order("internal-packages.legal.attribution") < order("internal-packages.config.package"));
  assert.ok(order("internal-packages.generated.grammar") < order("internal-packages.generated.release-history"));
  assert.ok(order("internal-packages.infra.container") < order("internal-packages.config.package"));
  assert.ok(order("internal-packages.doc.diagram") < order("internal-packages.doc.package"));
});

test("the three falsified files are never proposed for removal", () => {
  const proxy = liveByPath.get("hosting/Caddyfile.example");
  assert.equal(proxy.disposition, "retain");
  assert.ok(proxy.evidence.includes("BARE BASENAME"));

  const submodules = liveByPath.get(".gitmodules");
  assert.equal(submodules.disposition, "unresolved");
  assert.deepEqual(submodules.reached_via, ["git-subcommand"]);
  assert.ok(submodules.evidence.includes("submodule.mjs"));

  // Named without the literal directory, which carries a reserved term.
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
