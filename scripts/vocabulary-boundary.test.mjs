import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  anchorKey,
  applyCollisionAnchors,
  formatReport,
  parseCliOptions,
  runWrite,
  scanRepository,
  sha256,
  validateManifest,
} from "./vocabulary-boundary.mjs";
import { createScenario, source, TOKEN } from "../tests/vocabulary-fixtures/scenarios.mjs";
import { pathVocabularyEquivalent, pathVocabularyProfile } from "./vocabulary/classify.mjs";
import { validateRegeneratedManifest } from "./vocabulary/generate.mjs";
import {
  anchorIdentity,
  compareUtf8,
  normalizeRepositoryPath,
  occurrenceId,
  rulesFingerprint,
} from "./vocabulary/identity.mjs";
import { serializeManifest } from "./vocabulary/manifest-io.mjs";
import { inputFingerprint } from "./vocabulary/receipt.mjs";

function fixture(files, exceptions = [], exclusions = []) {
  const root = mkdtempSync(join("/var/tmp", "platos-vocabulary-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  execFileSync("git", ["add", "--all"], { cwd: root });
  return { root, manifest: { version: 1, exclusions, exceptions } };
}

const vendorLifecycle = {
  classification: "vendor",
  owner: "Runtime Integrations",
  rationale: "Names the external Trigger SDK rather than a Platos concept.",
  removalPolicy: "Remove when the vendor contract is removed.",
  removalEvent: "External Trigger SDK support is removed.",
};

const debtLifecycle = {
  classification: "migration-debt",
  owner: "WIN-144",
  rationale: "Pinned product vocabulary awaiting the coordinated M5 release.",
  removalPolicy: "Replace with canonical Platos vocabulary by the deadline.",
  trackingIssue: "WIN-144",
  expiresOn: "2026-09-15",
};

const migrationArchaeologyLifecycle = {
  classification: "migration-archaeology",
  owner: "Data Platform",
  rationale: "Preserves immutable SQL migration syntax byte-for-byte.",
  removalPolicy: "Remove only if the historical migration is removed with its database lineage.",
  removalEvent: "The immutable migration and every database lineage that applied it are retired.",
};

function exceptionFor(finding, lifecycle = vendorLifecycle) {
  const exception = {
    path: finding.path,
    rule: finding.rule,
    matchedText: finding.matchedText,
    line: finding.line,
    column: finding.column,
    localContextSha256: finding.localContextSha256,
    semanticContextKind: finding.semanticContextKind,
    semanticContextSha256: finding.semanticContextSha256,
    ...lifecycle,
  };
  if (finding.collisionContextSha256) {
    exception.collisionContextSha256 = finding.collisionContextSha256;
  }
  return exception;
}

function findingsWithoutExceptions(root, manifest, now = "2026-08-24") {
  return scanRepository(root, manifest, { now: new Date(`${now}T12:00:00.000Z`) }).violations;
}

test("an exact reviewed @trigger.dev SDK context passes", () => {
  const { root, manifest } = fixture({
    "src/external-runtime.ts": 'import { task } from "@trigger.dev/sdk/v3";\n',
  });
  const [finding] = findingsWithoutExceptions(root, manifest);
  manifest.exceptions = [exceptionFor(finding)];
  const result = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.exceptionDrift, []);
});

test("unrelated prepended lines do not change a reviewed contextual fingerprint", () => {
  const { root, manifest } = fixture({
    "src/external-runtime.ts": 'export const integration = "External Trigger";\n',
  });
  const [finding] = findingsWithoutExceptions(root, manifest);
  manifest.exceptions = [exceptionFor(finding)];
  writeFileSync(
    join(root, "src/external-runtime.ts"),
    '// Unrelated copyright header.\nimport "node:assert";\n\nexport const integration = "External Trigger";\n'
  );
  const moved = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.deepEqual(moved.violations, []);
  assert.deepEqual(moved.exceptionDrift, []);
  assert.equal(manifest.exceptions[0].line, 1);
  assert.equal(moved.findings[0].line, 4);
});

test("moving an approved occurrence to another declaration or Markdown section fails", () => {
  const code = fixture({
    "src/external-runtime.ts": [
      "export function vendorIntegration() {",
      '  return "External Trigger";',
      "}",
      "export function productRuntime() {",
      '  return "ready";',
      "}",
      "",
    ].join("\n"),
  });
  const [codeFinding] = findingsWithoutExceptions(code.root, code.manifest);
  code.manifest.exceptions = [exceptionFor(codeFinding)];
  writeFileSync(
    join(code.root, "src/external-runtime.ts"),
    [
      "export function vendorIntegration() {",
      '  return "ready";',
      "}",
      "export function productRuntime() {",
      '  return "External Trigger";',
      "}",
      "",
    ].join("\n")
  );
  const movedDeclaration = scanRepository(code.root, code.manifest, {
    now: new Date("2026-08-24T12:00:00Z"),
  });
  assert.equal(movedDeclaration.violations.length, 1);
  assert.equal(movedDeclaration.exceptionDrift.length, 1);
  assert.match(formatReport(movedDeclaration), /local\/semantic context/u);

  const markdown = fixture({
    "docs/runtime.md": "# External service\n\nTrigger is supported.\n\n# Product runtime\n\nJobs are supported.\n",
  });
  const [markdownFinding] = findingsWithoutExceptions(markdown.root, markdown.manifest);
  markdown.manifest.exceptions = [exceptionFor(markdownFinding)];
  writeFileSync(
    join(markdown.root, "docs/runtime.md"),
    "# External service\n\nJobs are supported.\n\n# Product runtime\n\nTrigger is supported.\n"
  );
  const movedSection = scanRepository(markdown.root, markdown.manifest, {
    now: new Date("2026-08-24T12:00:00Z"),
  });
  assert.equal(movedSection.violations.length, 1);
  assert.equal(movedSection.exceptionDrift.length, 1);
});

test("same-named methods in different class scope chains cannot exchange an exception", () => {
  const original = [
    "export class VendorRuntime {",
    "  run() {",
    '    return "External Trigger";',
    "  }",
    "}",
    "export class ProductRuntime {",
    "  run() {",
    '    return "ready";',
    "  }",
    "}",
    "",
  ].join("\n");
  const { root, manifest } = fixture({ "src/runtimes.ts": original });
  const [finding] = findingsWithoutExceptions(root, manifest);
  assert.equal(finding.semanticContextKind, "source-scope-chain");
  manifest.exceptions = [exceptionFor(finding)];

  writeFileSync(
    join(root, "src/runtimes.ts"),
    original.replace('return "External Trigger";', 'return "ready";').replace(
      'export class ProductRuntime {\n  run() {\n    return "ready";',
      'export class ProductRuntime {\n  run() {\n    return "External Trigger";'
    )
  );
  const moved = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(moved.violations.length, 1);
  assert.equal(moved.exceptionDrift.length, 1);
});

test("source fingerprints include the complete module, namespace, function, class, and method chain", () => {
  const { root, manifest } = fixture({
    "src/nested.ts": [
      "module Outer {",
      "  namespace Inner {",
      "    function build() {",
      "      class Runtime {",
      "        run() {",
      '          return "External Trigger";',
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  const [finding] = findingsWithoutExceptions(root, manifest);
  assert.equal(
    finding.semanticScopeIdentity,
    "module:Outer/namespace:Inner/function:build/class:Runtime/method:run"
  );
});

test("repeated JSON and YAML keys use stable named object identities", () => {
  const jsonOriginal = JSON.stringify(
    {
      runtimes: [
        { name: "vendor", label: "External Trigger" },
        { name: "product", label: "ready" },
      ],
    },
    null,
    2
  );
  const json = fixture({ "config/runtimes.json": `${jsonOriginal}\n` });
  const [jsonFinding] = findingsWithoutExceptions(json.root, json.manifest);
  assert.equal(jsonFinding.semanticContextKind, "json-path");
  assert.match(jsonFinding.semanticScopeIdentity, /runtimes\/\[name=vendor\]\/label/u);
  json.manifest.exceptions = [exceptionFor(jsonFinding)];
  writeFileSync(
    join(json.root, "config/runtimes.json"),
    `${jsonOriginal.replace('"label": "External Trigger"', '"label": "ready"').replace(
      '"name": "product",\n      "label": "ready"',
      '"name": "product",\n      "label": "External Trigger"'
    )}\n`
  );
  const movedJson = scanRepository(json.root, json.manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(movedJson.violations.length, 1);
  assert.equal(movedJson.exceptionDrift.length, 1);

  const yamlOriginal = [
    "runtimes:",
    "  - name: vendor",
    "    label: External Trigger",
    "  - name: product",
    "    label: ready",
    "",
  ].join("\n");
  const yaml = fixture({ "config/runtimes.yml": yamlOriginal });
  const [yamlFinding] = findingsWithoutExceptions(yaml.root, yaml.manifest);
  assert.equal(yamlFinding.semanticContextKind, "yaml-path");
  assert.match(yamlFinding.semanticScopeIdentity, /runtimes\/\[name=vendor\]\/label/u);
  yaml.manifest.exceptions = [exceptionFor(yamlFinding)];
  writeFileSync(
    join(yaml.root, "config/runtimes.yml"),
    yamlOriginal.replace("label: External Trigger", "label: ready").replace(
      "- name: product\n    label: ready",
      "- name: product\n    label: External Trigger"
    )
  );
  const movedYaml = scanRepository(yaml.root, yaml.manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(movedYaml.violations.length, 1);
  assert.equal(movedYaml.exceptionDrift.length, 1);
});

test("duplicate Markdown child headings are bound to their full parent breadcrumb", () => {
  const original = [
    "# Vendor runtime",
    "## Setup",
    "External Trigger",
    "# Product runtime",
    "## Setup",
    "ready",
    "",
  ].join("\n");
  const { root, manifest } = fixture({ "docs/runtime.md": original });
  const [finding] = findingsWithoutExceptions(root, manifest);
  assert.equal(finding.semanticContextKind, "markdown-breadcrumb");
  assert.equal(finding.semanticScopeIdentity, "h1:Vendor runtime/h2:Setup");
  manifest.exceptions = [exceptionFor(finding)];
  writeFileSync(
    join(root, "docs/runtime.md"),
    original.replace("External Trigger", "ready").replace("# Product runtime\n## Setup\nready", "# Product runtime\n## Setup\nExternal Trigger")
  );
  const moved = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(moved.violations.length, 1);
  assert.equal(moved.exceptionDrift.length, 1);
});

test("distinct same-named semantic scope instances require collision-strengthened anchors", () => {
  const { root, manifest } = fixture({
    "docs/repeated.md": [
      "# Runtime",
      "## Setup",
      "External Trigger",
      "vendor-only detail",
      "## Setup",
      "External Trigger",
      "second vendor detail",
      "",
    ].join("\n"),
  });
  const initial = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.deepEqual(initial.manifestErrors, []);
  assert.equal(initial.violations.length, 2);
  assert(initial.violations.every((finding) => finding.collisionContextSha256));

  manifest.exceptions = initial.violations.map((finding) => {
    const exception = exceptionFor(finding);
    delete exception.collisionContextSha256;
    return exception;
  });
  const weak = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.match(weak.manifestErrors.join("\n"), /collisionContextSha256 is required/u);

  manifest.exceptions = initial.violations.map((finding) => exceptionFor(finding));
  const strengthened = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.deepEqual(strengthened.violations, []);
  assert.deepEqual(strengthened.exceptionDrift, []);
});

test("manifest generation rejects unresolved collisions across distinct semantic scopes", () => {
  const common = {
    path: "src/collision.ts",
    rule: "trigger",
    matchedText: "Trigger",
    localContextSha256: sha256("local"),
    semanticContextKind: "source-scope-chain",
    semanticContextSha256: sha256("class:Same/method:run"),
    collisionCandidateSha256: sha256("indistinguishable stronger context"),
  };
  const errors = applyCollisionAnchors([
    { ...common, semanticScopeInstance: "first" },
    { ...common, semanticScopeInstance: "second" },
  ]);
  assert.match(errors.join("\n"), /unresolved fingerprint collision across distinct semantic scopes/u);
});

test("substituting vendor wording with product usage fails the local fingerprint", () => {
  const { root, manifest } = fixture({ "src/mixed.ts": "const value = 'External Trigger';\n" });
  const [finding] = findingsWithoutExceptions(root, manifest);
  manifest.exceptions = [exceptionFor(finding)];
  writeFileSync(join(root, "src/mixed.ts"), "const value = 'Product Trigger';\n");
  const substituted = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(substituted.violations.length, 1);
  assert.equal(substituted.exceptionDrift.length, 1);
});

test("identical spellings can carry different classifications at independent anchors", () => {
  const { root, manifest } = fixture({
    "src/mixed.ts": "External Trigger is supported.\nconst Trigger = platosRuntime;\n",
  });
  const findings = findingsWithoutExceptions(root, manifest);
  assert.equal(findings.length, 2);
  manifest.exceptions = [
    exceptionFor(findings[0], vendorLifecycle),
    exceptionFor(findings[1], debtLifecycle),
  ];
  assert.deepEqual(
    scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") }).violations,
    []
  );

  writeFileSync(join(root, "src/mixed.ts"), "External Trigger is supported.\nconst renamedTrigger = platosRuntime;\n");
  const changed = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(changed.violations.length, 1);
  assert.equal(changed.exceptionDrift.length, 1);
});

test("the production manifest retains only the explicit SecondarySurfaces vendor context", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../docs/vocabulary-boundary-exceptions.json", import.meta.url), "utf8")
  );
  const entries = manifest.exceptions.filter(
    (entry) => entry.path === "apps/webapp/app/components/platos/surfaces/SecondarySurfaces.tsx" && entry.rule === "trigger"
  );
  assert.equal(entries.length, 1);
  assert(entries.every((entry) => entry.classification === "vendor"));
  assert(!entries.some((entry) => entry.classification === "migration-debt"));
  assert(entries.every((entry) => entry.localContextSha256 && entry.semanticContextSha256));
  assert(!manifest.exceptions.some((entry) => entry.classification === "migration-debt"));
  assert(
    !manifest.exceptions.some((entry) => ["WIN-144", "WIN-145", "WIN-146"].includes(entry.trackingIssue))
  );
});

test("one exception cannot approve an added duplicate occurrence", () => {
  const { root, manifest } = fixture({
    "docs/external.md": "# Vendor runtime\n\nExternal Trigger\n",
  });
  const [finding] = findingsWithoutExceptions(root, manifest);
  manifest.exceptions = [exceptionFor(finding)];
  writeFileSync(
    join(root, "docs/external.md"),
    "# Vendor runtime\n\nExternal Trigger\nExternal Trigger\n"
  );
  const duplicate = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(duplicate.violations.length, 1);
  assert.equal(duplicate.exceptionDrift.length, 0);

  manifest.exceptions.push({ ...manifest.exceptions[0] });
  const reviewedBoth = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.deepEqual(reviewedBoth.violations, []);
  assert.deepEqual(reviewedBoth.exceptionDrift, []);
});

test("a nearby edit invalidates only the affected local anchor", () => {
  const padding = "x".repeat(90);
  const original = `export const first = "External Trigger ${padding}";\nexport const second = "${padding} External Trigger";\n`;
  const { root, manifest } = fixture({ "src/external.ts": original });
  const findings = findingsWithoutExceptions(root, manifest);
  manifest.exceptions = findings.map((finding) => exceptionFor(finding));
  writeFileSync(
    join(root, "src/external.ts"),
    `export const first = "Renamed external Trigger ${padding}";\nexport const second = "${padding} External Trigger";\n`
  );
  const changed = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.equal(changed.violations.length, 1);
  assert.equal(changed.exceptionDrift.length, 1);
  assert.equal(changed.violations[0].line, 1);
});

test("retired tools, product secrets, and inherited nouns fail with actions", () => {
  const source = [
    "spawn_bgo();",
    "const secret = TRIGGER_INTERNAL_SECRET;",
    "type Old = TaskRun | Waitpoint | BackgroundWorker | Deployment | Attempt;",
  ].join("\n");
  const { root, manifest } = fixture({ "src/inherited.ts": source });
  const result = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.deepEqual(
    new Set(result.violations.map((finding) => finding.rule)),
    new Set([
      "spawn-bgo",
      "trigger-internal-secret",
      "task-run",
      "waitpoint",
      "background-worker",
      "deployment",
      "attempt",
    ])
  );
  const report = formatReport(result);
  assert.match(report, /Use the Platos-owned spawn_job runtime tool/u);
  assert.match(report, /Use a Platos-owned worker\/authentication secret name/u);
  assert.match(report, /Use Turn for agent work or Job/u);
});

test("all newly tracked textual surfaces are discovered through git ls-files", () => {
  const paths = [
    "apps/new-surface.ts",
    "scripts/new-check.mjs",
    "README.md",
    "config/settings.yml",
    ".github/workflows/new-check.yml",
    "package.json",
    "packages/example/package.json",
  ];
  const files = Object.fromEntries(paths.map((path) => [path, 'productTrigger: "enabled"\n']));
  const { root, manifest } = fixture(files);
  const result = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  const foundPaths = new Set(result.violations.map((finding) => finding.path));
  for (const path of paths) assert(foundPaths.has(path), `${path} bypassed tracked-file discovery`);
  assert.equal(result.files.length, paths.length);
});

test("wildcard exception and exclusion suppression are rejected", () => {
  const manifest = {
    version: 1,
    exclusions: [
      {
        path: "vendor/**",
        classification: "vendor",
        owner: "Runtime Integrations",
        rationale: "Vendor source.",
        removalPolicy: "Remove with vendor source.",
        removalEvent: "Vendor source is removed.",
      },
    ],
    exceptions: [
      {
        path: "apps/**",
        rule: "trigger",
        matchedText: "Trigger",
        line: 1,
        column: 1,
        localContextSha256: sha256("local"),
        semanticContextKind: "declaration",
        semanticContextSha256: sha256("semantic"),
        ...vendorLifecycle,
      },
    ],
  };
  const errors = validateManifest(manifest).join("\n");
  assert.match(errors, /wildcard directory\/file suppression is forbidden/u);
  assert.match(errors, /wildcard exclusion is forbidden/u);
});

test("migration debt requires a valid tracking issue and expires fail-closed", () => {
  const { root, manifest } = fixture({ "src/product.ts": "const trigger = true;\n" });
  const [finding] = findingsWithoutExceptions(root, manifest);
  const invalid = exceptionFor(finding, {
    ...debtLifecycle,
    trackingIssue: "not-an-issue",
    expiresOn: "2026-02-30",
  });
  assert.match(validateManifest({ ...manifest, exceptions: [invalid] }).join("\n"), /trackingIssue|real YYYY-MM-DD/u);

  manifest.exceptions = [exceptionFor(finding, { ...debtLifecycle, expiresOn: "2026-08-23" })];
  const expired = scanRepository(root, manifest, { now: new Date("2026-08-24T12:00:00Z") });
  assert.match(expired.manifestErrors.join("\n"), /expired on 2026-08-23/u);
});

test("migration archaeology is event-bound and restricted to immutable Prisma migrations", () => {
  const path = "internal-packages/example/prisma/migrations/20260824000000_example/migration.sql";
  const { root, manifest } = fixture({ [path]: 'CREATE TRIGGER "immutable_example";\n' });
  const [finding] = findingsWithoutExceptions(root, manifest);
  const exception = exceptionFor(finding, migrationArchaeologyLifecycle);
  assert.deepEqual(validateManifest({ ...manifest, exceptions: [exception] }), []);

  const outsideMigration = {
    ...exception,
    path: "src/product.ts",
  };
  assert.match(
    validateManifest({ ...manifest, exceptions: [outsideMigration] }).join("\n"),
    /restricted to immutable Prisma migration\.sql files/u
  );

  delete exception.removalEvent;
  assert.match(validateManifest({ ...manifest, exceptions: [exception] }).join("\n"), /removalEvent/u);
});

test("non-debt exceptions require an event-bound removal condition", () => {
  const { root, manifest } = fixture({ "src/external.ts": "External Trigger\n" });
  const [finding] = findingsWithoutExceptions(root, manifest);
  const exception = exceptionFor(finding, vendorLifecycle);
  delete exception.removalEvent;
  assert.match(validateManifest({ ...manifest, exceptions: [exception] }).join("\n"), /removalEvent/u);
});

// ---------------------------------------------------------------------------
// WIN-292 -- stable identity across file moves, and deterministic regeneration.
//
// These scenarios are real temp git repositories with real commits and real
// `git mv`; move detection reads git plumbing, so mocks would prove nothing.
// Forbidden tokens come from TOKEN so this file stays clean under its own gate.
// ---------------------------------------------------------------------------

/** Run `body` against a scenario and always clean the temp directories up. */
function withScenario(files, body) {
  const scenario = createScenario(files);
  try {
    body(scenario);
  } finally {
    scenario.cleanup();
  }
}

test("the split identity model reconstructs the gate's anchor byte for byte", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../docs/vocabulary-boundary-exceptions.json", import.meta.url), "utf8")
  );
  // Every one of the production entries, not a sample: the whole point of the
  // split is that it is a re-description of the existing key, not a new one.
  for (const exception of manifest.exceptions) {
    assert.equal(anchorIdentity(exception), anchorKey(exception));
  }
  // Full-set canary (not a sample). M0 integration added 62 exact context-bound
  // exceptions for the accepted, immutable M0 ADRs' external-vendor references
  // (WIN-248/WIN-250, #132), lifting the production set 20349 -> 20411.
  assert.equal(manifest.exceptions.length, 20411);
});

test("fixture: a pure rename keeps the occurrence and rebinds only the path anchor", () => {
  const from = `src/${TOKEN.vendorLower}-client.ts`;
  const to = `src/legacy/${TOKEN.vendorLower}-client.ts`;
  withScenario({ [from]: source.vendorModule() }, (scenario) => {
    const seeded = scenario.seedManifest();
    assert.equal(seeded.exceptions.length, 2);
    assert.deepEqual(scenario.counts(), {
      unchanged: 2,
      moved: 0,
      "path-rebound": 0,
      removed: 0,
      added: 0,
      "context-changed": 0,
    });

    const contentBefore = seeded.exceptions.find((e) => e.semanticContextKind === "source-scope-chain");
    scenario.move(from, to);
    const result = scenario.run();

    assert.deepEqual(result.classification.counts, {
      unchanged: 0,
      moved: 1,
      "path-rebound": 1,
      removed: 0,
      added: 0,
      "context-changed": 0,
    });
    assert.equal(result.reviewRequired.length, 0, "a pure move needs no human review");
    assert.deepEqual(
      result.moves.map((move) => [move.from, move.to, move.identical, move.source]),
      [[from, to, true, "git-rename"]]
    );

    // Identity preserved: the content occurrence is literally the same
    // reviewed judgement, only relocated.
    const contentAfter = result.nextManifest.exceptions.find(
      (e) => e.semanticContextKind === "source-scope-chain"
    );
    assert.equal(occurrenceId(contentAfter), occurrenceId(contentBefore));
    assert.equal(contentAfter.path, to);
    assert.equal(contentAfter.localContextSha256, contentBefore.localContextSha256);
    assert.equal(contentAfter.semanticContextSha256, contentBefore.semanticContextSha256);
    assert.equal(contentAfter.classification, contentBefore.classification);
    assert.equal(contentAfter.rationale, contentBefore.rationale);

    // The path anchor is path-derived, so it is rebound rather than preserved.
    const pathAfter = result.nextManifest.exceptions.find(
      (e) => e.semanticContextKind === "repository-path"
    );
    assert.equal(pathAfter.path, to);
    assert.equal(pathAfter.rule, TOKEN.vendorLower);

    // And the tree is clean again once the manifest is written.
    writeFileSync(scenario.manifestPath, result.manifestText);
    assert.deepEqual(scenario.counts(), {
      unchanged: 2,
      moved: 0,
      "path-rebound": 0,
      removed: 0,
      added: 0,
      "context-changed": 0,
    });
  });
});

test("fixture: a content move into a different scope is never laundered as a file move", () => {
  const from = "src/runtimes.ts";
  const to = "src/legacy/runtimes.ts";
  const original = [
    "export class VendorRuntime {",
    "  connect() {",
    `    return "External ${TOKEN.vendor}";`,
    "  }",
    "}",
    "export class ProductRuntime {",
    "  connect() {",
    '    return "ready";',
    "  }",
    "}",
    "",
  ].join("\n");
  withScenario({ [from]: original }, (scenario) => {
    scenario.seedManifest();
    scenario.move(from, to);
    // The file moved AND the occurrence changed scope inside it.
    scenario.write(
      to,
      original
        .replace(`return "External ${TOKEN.vendor}";`, 'return "ready";')
        .replace(
          `export class ProductRuntime {\n  connect() {\n    return "ready";`,
          `export class ProductRuntime {\n  connect() {\n    return "External ${TOKEN.vendor}";`
        )
    );
    const result = scenario.run();
    assert.equal(result.classification.counts.moved, 0, "scope change must not ride along on a move");
    assert.equal(result.classification.counts.added, 1);
    assert.equal(result.classification.counts.removed, 1);
    assert(result.reviewRequired.length > 0, "this needs a human");
  });
});

test("fixture: a line shift leaves every anchor and the manifest bytes untouched", () => {
  const path = "src/vendor.ts";
  withScenario({ [path]: source.vendorModule() }, (scenario) => {
    scenario.seedManifest();
    const before = readFileSync(scenario.manifestPath, "utf8");
    scenario.write(path, `// Unrelated header.\nimport "node:assert";\n\n${source.vendorModule()}`);

    const result = scenario.run();
    assert.deepEqual(result.classification.counts, {
      unchanged: 1,
      moved: 0,
      "path-rebound": 0,
      removed: 0,
      added: 0,
      "context-changed": 0,
    });
    // Line and column are diagnostics, not identity: nothing to rewrite.
    assert.equal(result.manifestText, before, "a pure line shift must not dirty the manifest");
  });
});

test("fixture: a changed local context demands review and blocks the write", () => {
  const path = "src/vendor.ts";
  withScenario({ [path]: source.vendorModule() }, (scenario) => {
    scenario.seedManifest();
    scenario.write(
      path,
      source.vendorModule().replace(`"External ${TOKEN.vendor}"`, `"Product ${TOKEN.vendor}"`)
    );
    const result = scenario.run();
    assert.equal(result.classification.counts["context-changed"], 1);
    assert.equal(result.classification.counts.added, 0, "it is recognised as the same site, not a new one");
    assert.equal(result.classification.counts.removed, 0);
    assert(result.reviewRequired.length > 0);
    // The refusal is what matters: the reviewed judgement is not carried over
    // onto code nobody has looked at.
    const rewritten = result.nextManifest.exceptions.find(
      (e) => e.semanticContextKind === "source-scope-chain"
    );
    assert.equal(rewritten.matchedText, TOKEN.vendor);
  });
});

test("fixture: duplicate occurrences keep their multiplicity across a pure move", () => {
  const from = "docs/runtime.md";
  const to = "docs/legacy/runtime.md";
  const body = `External ${TOKEN.vendor}\nExternal ${TOKEN.vendor}`;
  withScenario({ [from]: source.markdownSection(body) }, (scenario) => {
    const seeded = scenario.seedManifest();
    assert.equal(seeded.exceptions.length, 2, "two indistinguishable occurrences, two exceptions");
    assert.equal(
      new Set(seeded.exceptions.map((e) => anchorIdentity(e))).size,
      1,
      "they share one anchor and are separated only by multiplicity"
    );

    scenario.move(from, to);
    const result = scenario.run();
    assert.deepEqual(result.classification.counts, {
      unchanged: 0,
      moved: 2,
      "path-rebound": 0,
      removed: 0,
      added: 0,
      "context-changed": 0,
    });
    assert.equal(result.nextManifest.exceptions.length, 2);
    for (const exception of result.nextManifest.exceptions) assert.equal(exception.path, to);
  });
});

test("fixture: deleting a file resolves its exceptions and the write may apply that", () => {
  const path = "src/vendor.ts";
  withScenario({ [path]: source.vendorModule(), "src/keep.ts": "export const ok = 1;\n" }, (scenario) => {
    scenario.seedManifest();
    scenario.remove(path);
    const result = scenario.run();
    assert.deepEqual(result.classification.counts, {
      unchanged: 0,
      moved: 0,
      "path-rebound": 0,
      removed: 1,
      added: 0,
      "context-changed": 0,
    });
    // Removals never weaken the gate, so no review is required for them.
    assert.equal(result.reviewRequired.length, 0);
    assert.equal(result.nextManifest.exceptions.length, 0);
  });
});

test("fixture: newly introduced vocabulary is reported as added and never auto-blessed", () => {
  withScenario({ "src/keep.ts": "export const ok = 1;\n" }, (scenario) => {
    const seeded = scenario.seedManifest();
    assert.equal(seeded.exceptions.length, 0);
    scenario.write("src/new-surface.ts", source.vendorModule());

    const result = scenario.run();
    assert.equal(result.classification.counts.added, 1);
    assert.equal(result.reviewRequired.length, 1);
    // The decisive property: the regenerated manifest does NOT contain it.
    assert.equal(result.nextManifest.exceptions.length, 0);
    assert.match(result.reviewRequired[0].finding.path, /new-surface\.ts/u);
  });
});

test("regeneration is byte-for-byte deterministic across repeated runs", () => {
  const from = `src/${TOKEN.vendorLower}-client.ts`;
  const to = `src/legacy/${TOKEN.vendorLower}-client.ts`;
  withScenario({ [from]: source.vendorModule(), "docs/a.md": source.markdownSection(`External ${TOKEN.vendor}`) }, (scenario) => {
    scenario.seedManifest();
    scenario.move(from, to);

    const first = scenario.run();
    writeFileSync(scenario.manifestPath, first.manifestText);
    const second = scenario.run();
    const third = scenario.run();

    assert.equal(second.manifestText, third.manifestText);
    assert.equal(second.receipt.outputSha256, third.receipt.outputSha256);
    assert.equal(second.receipt.inputSha256, third.receipt.inputSha256);
    assert.equal(second.receipt.rulesSha256, third.receipt.rulesSha256);
    // Re-serializing a settled manifest is a fixed point.
    assert.equal(second.manifestText, readFileSync(scenario.manifestPath, "utf8"));
  });
});

test("the receipt reports input, rules, output and counts that a reviewer can recompute", () => {
  withScenario({ "src/vendor.ts": source.vendorModule() }, (scenario) => {
    scenario.seedManifest();
    const { receipt, manifestText } = scenario.run();
    assert.equal(receipt.outputSha256, sha256(manifestText));
    assert.match(receipt.inputSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.rulesSha256, /^[a-f0-9]{64}$/u);
    assert.equal(receipt.counts.exceptionsBefore, 1);
    assert.equal(receipt.counts.exceptionsAfter, 1);
    assert.equal(receipt.counts.unchanged, 1);
    assert.equal(receipt.manifestPath, "manifest.json", "receipts must not embed machine paths");
  });
});

// The ledger CONSUMER (scripts/vocabulary/ledger.mjs) is now proven against the
// REAL generator output in its own suite, scripts/vocabulary/ledger.test.mjs.
// The speculative-schema tests that lived here (a hand-authored
// { version, entries:[...], target, "keep" } container) were removed when the
// consumer was reconciled to the real ledger; a synthetic ledger schema no
// longer exists anywhere in the tests.

test("path normalization actually canonicalizes non-canonical spellings", () => {
  // The previous version of this test only asserted that production paths are
  // already canonical, which is a property of the DATA -- it passed with a
  // `return input` stub. These inputs exercise the code.
  assert.equal(normalizeRepositoryPath("src\\alpha.ts"), "src/alpha.ts");
  assert.equal(normalizeRepositoryPath("src//alpha.ts"), "src/alpha.ts");
  assert.equal(normalizeRepositoryPath("./src/alpha.ts"), "src/alpha.ts");
  assert.equal(normalizeRepositoryPath("a\\\\b//c/./d.ts"), "a/b/c/./d.ts");
  assert.notEqual(normalizeRepositoryPath("src\\alpha.ts"), "src\\alpha.ts");
  // Idempotent, so applying it twice cannot drift.
  for (const input of ["src\\alpha.ts", "src//alpha.ts", "./src/alpha.ts"]) {
    const once = normalizeRepositoryPath(input);
    assert.equal(normalizeRepositoryPath(once), once);
  }
  // And it must still leave real production paths alone.
  const manifest = JSON.parse(
    readFileSync(new URL("../docs/vocabulary-boundary-exceptions.json", import.meta.url), "utf8")
  );
  for (const entry of [...manifest.exceptions, ...manifest.exclusions]) {
    assert.equal(normalizeRepositoryPath(entry.path), entry.path);
  }
});

test("the gate anchor and the identity anchor agree on non-canonical paths", () => {
  // MAJOR-5: these two agreeing only on today's tidy data is not agreement.
  // Divergence here deadlocks the tool: the gate fails, --write reports success
  // and changes nothing, and the gate fails again with nothing actionable.
  const base = {
    rule: TOKEN.vendorLower,
    matchedText: TOKEN.vendor,
    localContextSha256: sha256("local"),
    semanticContextKind: "source-scope-chain",
    semanticContextSha256: sha256("semantic"),
  };
  for (const spelling of ["./src/alpha.ts", "src//alpha.ts", "src\\alpha.ts", "src/alpha.ts"]) {
    const entry = { ...base, path: spelling };
    assert.equal(anchorIdentity(entry), anchorKey(entry), `disagreed on ${spelling}`);
  }
  // All spellings of one path must collapse to one anchor.
  const anchors = new Set(
    ["./src/alpha.ts", "src//alpha.ts", "src\\alpha.ts", "src/alpha.ts"].map((path) =>
      anchorKey({ ...base, path })
    )
  );
  assert.equal(anchors.size, 1);
});

test("a non-canonical manifest path is rejected with an actionable message", () => {
  const { root, manifest } = fixture({ "src/external.ts": `External ${TOKEN.vendor}\n` });
  const [finding] = findingsWithoutExceptions(root, manifest);
  const exception = { ...exceptionFor(finding), path: "./src/external.ts" };
  const errors = validateManifest({ ...manifest, exceptions: [exception] }).join("\n");
  assert.match(errors, /must be canonical/u);
  assert.match(errors, /src\/external\.ts/u);
});

test("occurrence identity separates genuinely different occurrences", () => {
  // Kills a constant-returning occurrenceId: if everything hashes the same,
  // any exception could relocate onto any other occurrence.
  const base = {
    rule: TOKEN.vendorLower,
    matchedText: TOKEN.vendor,
    localContextSha256: sha256("local"),
    semanticContextKind: "source-scope-chain",
    semanticContextSha256: sha256("semantic"),
  };
  const ids = new Set([
    occurrenceId(base),
    occurrenceId({ ...base, rule: TOKEN.retry }),
    occurrenceId({ ...base, matchedText: TOKEN.vendorLower }),
    occurrenceId({ ...base, localContextSha256: sha256("other") }),
    occurrenceId({ ...base, semanticContextSha256: sha256("other") }),
    occurrenceId({ ...base, semanticContextKind: "markdown-breadcrumb" }),
    occurrenceId({ ...base, collisionContextSha256: sha256("collision") }),
  ]);
  assert.equal(ids.size, 7, "every identity-bearing field must change the occurrence id");
  // Path is deliberately NOT part of it -- that is the whole model.
  assert.equal(occurrenceId({ ...base, path: "a.ts" }), occurrenceId({ ...base, path: "b.ts" }));
});

test("ordering compares UTF-8 bytes, not UTF-16 code units", () => {
  // Kills a compareUtf8 that delegates to < / >: these two disagree exactly on
  // astral-plane characters, which is the classic "regenerated on another
  // machine and the diff moved" bug.
  const astral = String.fromCodePoint(0x1f600); // UTF-8: f0 9f 98 80
  const highBmp = String.fromCodePoint(0xffff); // UTF-8: ef bf bf
  assert.equal(Math.sign(compareUtf8(highBmp, astral)), -1, "ef bf bf sorts before f0 9f 98 80");
  assert.equal(highBmp < astral, false, "UTF-16 ordering disagrees here, which is the point");
  assert.equal(compareUtf8("a", "a"), 0);
  assert.equal(Math.sign(compareUtf8("a", "b")), -1);
});

test("the serializer reproduces the production manifest byte for byte", () => {
  const path = new URL("../docs/vocabulary-boundary-exceptions.json", import.meta.url);
  const original = readFileSync(path, "utf8");
  assert.equal(serializeManifest(JSON.parse(original)), original);
});

// --- Safety properties, each written to fail if its guard is removed. --------

test("relocating an EXCLUSION always demands review and is never applied", () => {
  // The critical one. An exclusion suppresses a whole file, and git rename
  // detection tolerates large content changes, so following a rename here can
  // put an arbitrary source file permanently out of scope.
  const from = "generated/artifact.txt";
  const to = "apps/routes/product-runtime.ts";
  // Large on purpose, mirroring the real attack against a lockfile: git rename
  // detection tolerates a small append into a big file, so the destination is
  // still reported as a rename of the excluded path.
  const bulk = Array.from({ length: 400 }, (_, index) => `generated line ${index}`).join("\n");
  withScenario({ [from]: `${bulk}\n`, "src/keep.ts": "export const ok = 1;\n" }, (scenario) => {
    const manifest = scenario.seedManifest();
    manifest.exclusions = [
      {
        path: from,
        classification: "generated",
        owner: "Build Platform",
        rationale: "Generated artifact.",
        removalPolicy: "Remove when no longer generated.",
        removalEvent: "The generated artifact is retired.",
      },
    ];
    writeFileSync(scenario.manifestPath, serializeManifest(manifest));

    scenario.move(from, to);
    scenario.write(to, `${bulk}\n${TOKEN.retiredTool}();\nconst s = ${TOKEN.secret};\n`);
    const result = scenario.run();

    const relocated = result.exclusionEntries.filter((e) => e.disposition === "exclusion-relocated");
    assert.equal(relocated.length, 1, "the relocation must be recognised");
    assert(
      result.reviewRequired.some((entry) => entry.disposition === "exclusion-relocated"),
      "and must be review-required"
    );
    // It must NOT be applied: the exclusion still names the old path.
    assert.equal(result.nextManifest.exclusions.length, 1);
    assert.equal(result.nextManifest.exclusions[0].path, from);
    // And because the scan honours the manifest as written, the smuggled
    // vocabulary at the destination is reported rather than suppressed.
    const added = result.classification.entries.filter((e) => e.disposition === "added");
    assert(added.some((e) => e.finding.rule === "spawn-bgo"), "the hidden payload must surface");
  });
});

test("a stale exclusion whose file simply vanished is dropped, which only widens scanning", () => {
  const gone = "generated/artifact.txt";
  withScenario({ [gone]: "generated payload\n", "src/keep.ts": "export const ok = 1;\n" }, (scenario) => {
    const manifest = scenario.seedManifest();
    manifest.exclusions = [
      {
        path: gone,
        classification: "generated",
        owner: "Build Platform",
        rationale: "Generated artifact.",
        removalPolicy: "Remove when no longer generated.",
        removalEvent: "The generated artifact is retired.",
      },
    ];
    writeFileSync(scenario.manifestPath, serializeManifest(manifest));
    scenario.remove(gone);

    const result = scenario.run();
    assert.equal(result.exclusionEntries.filter((e) => e.disposition === "exclusion-stale").length, 1);
    assert.equal(result.reviewRequired.length, 0, "dropping an exclusion cannot weaken the gate");
    assert.equal(result.nextManifest.exclusions.length, 0);
  });
});

test("a path anchor is not rebound when the move is not byte-pure", () => {
  // Kills removal of the `move.identical` check.
  const from = `src/${TOKEN.vendorLower}-client.ts`;
  const to = `src/legacy/${TOKEN.vendorLower}-client.ts`;
  withScenario({ [from]: source.vendorModule() }, (scenario) => {
    scenario.seedManifest();
    scenario.move(from, to);
    scenario.write(to, `${source.vendorModule()}export const extra = 1;\n`);

    const result = scenario.run();
    assert.equal(result.classification.counts["path-rebound"], 0, "impure move must not rebind a path anchor");
    assert(result.reviewRequired.length > 0);
  });
});

test("a path anchor is not rebound when the destination carries the word in a new segment", () => {
  // Kills `pathVocabularyEquivalent` -> always true. The rule-id multiset is
  // identical here (one match either side) but the word now lives in a
  // different directory name that nobody approved.
  const from = `src/${TOKEN.vendorLower}-tasks/client.ts`;
  const to = `packages/vendor-${TOKEN.vendorLower}-archive/client.ts`;
  withScenario({ [from]: source.vendorModule() }, (scenario) => {
    scenario.seedManifest();
    scenario.move(from, to);

    const result = scenario.run();
    assert.equal(
      result.classification.counts["path-rebound"],
      0,
      "a new segment carrying the forbidden word needs a human"
    );
    assert(result.reviewRequired.length > 0);
  });
});

test("path vocabulary equivalence compares words and segments, not counts", () => {
  const inDir = `src/${TOKEN.vendorLower}-tasks/client.ts`;
  assert.equal(pathVocabularyEquivalent(inDir, `apps/${TOKEN.vendorLower}-tasks/client.ts`), true);
  assert.equal(pathVocabularyEquivalent(inDir, `a/b/c/${TOKEN.vendorLower}-tasks/client.ts`), true);
  // Same rule, same count, different segment -> not equivalent.
  assert.equal(pathVocabularyEquivalent(inDir, `src/vendor-${TOKEN.vendorLower}-archive/client.ts`), false);
  // Renaming the file itself into the forbidden word is not equivalent either.
  assert.equal(pathVocabularyEquivalent("src/plain/client.ts", `src/plain/${TOKEN.vendorLower}.ts`), false);
  assert.equal(pathVocabularyProfile("src/plain/client.ts").length, 0);
  assert.equal(pathVocabularyProfile(inDir).length, 1);
});

test("a move git never recorded is still corroborated by exact content digest", () => {
  // Kills disabling digestPairings. The destination is untracked, so git rename
  // detection reports nothing and only the digest can pair them.
  const from = "src/vendor.ts";
  const to = "src/relocated/vendor.ts";
  withScenario({ [from]: source.vendorModule(), "src/keep.ts": "export const ok = 1;\n" }, (scenario) => {
    scenario.seedManifest();
    scenario.copyOutsideGit(from, to);

    const result = scenario.run();
    assert.equal(result.moves.length, 1, "the digest must find what git rename detection missed");
    assert.equal(result.moves[0].source, "content-digest");
    assert.equal(result.moves[0].from, from);
    assert.equal(result.moves[0].to, to);
    assert.equal(result.classification.counts.moved, 1);
    assert.equal(result.reviewRequired.length, 0);
  });
});

test("an ambiguous digest pairing is refused rather than guessed", () => {
  // Kills removal of the 1:1 guard. Two identical files vanish and two
  // identical files appear; nothing says which became which.
  const body = source.vendorModule();
  withScenario(
    { "src/one.ts": body, "src/two.ts": body, "src/keep.ts": "export const ok = 1;\n" },
    (scenario) => {
      scenario.seedManifest();
      scenario.remove("src/one.ts");
      scenario.remove("src/two.ts");
      scenario.copyOutsideGit(null, "src/moved/one.ts", body);
      scenario.copyOutsideGit(null, "src/moved/two.ts", body);

      const result = scenario.run();
      assert.equal(result.moves.length, 0, "an ambiguous pairing must not be invented");
      assert.equal(result.classification.counts.moved, 0);
      assert(result.reviewRequired.length > 0);
    }
  );
});

test("the write path refuses a regenerated manifest its own gate would reject", () => {
  // MAJOR-3. migration-archaeology is only legal on an immutable Prisma
  // migration.sql, and 2,172 production entries carry it. Relocating one out of
  // prisma/migrations produces a manifest the gate rejects.
  const from = "db/prisma/migrations/20260101000000_example/migration.sql";
  const to = "db/archive/migration.sql";
  withScenario({ [from]: `CREATE ${TOKEN.vendor.toUpperCase()} "example";\n` }, (scenario) => {
    scenario.seedManifest({
      classification: "migration-archaeology",
      owner: "Data Platform",
      rationale: "Preserves immutable SQL migration syntax byte-for-byte.",
      removalPolicy: "Remove only with its database lineage.",
      removalEvent: "The immutable migration and every lineage that applied it are retired.",
    });
    scenario.move(from, to);

    const result = scenario.run();
    assert.equal(result.classification.counts.moved, 1, "the occurrence itself does relocate");
    assert.equal(result.reviewRequired.length, 0, "the classifier alone sees nothing wrong");

    // ...but the regenerated manifest does not pass the gate, and the write
    // path is what must catch it.
    const gate = validateRegeneratedManifest(scenario.root, result.nextManifest, {
      now: new Date("2026-08-24T12:00:00Z"),
    });
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join("\n"), /restricted to immutable Prisma migration\.sql files/u);
  });
});

test("a fingerprint changes when its input changes", () => {
  // The old test only checked the shape /^[a-f0-9]{64}$/, which a constant
  // satisfies. These assertions fail if the fingerprints stop reading input.
  const first = inputFingerprint({
    textByPath: new Map([["a.ts", "alpha"]]),
    binaryFiles: [],
    excludedFiles: [],
  });
  const changedContent = inputFingerprint({
    textByPath: new Map([["a.ts", "beta"]]),
    binaryFiles: [],
    excludedFiles: [],
  });
  const changedPath = inputFingerprint({
    textByPath: new Map([["b.ts", "alpha"]]),
    binaryFiles: [],
    excludedFiles: [],
  });
  const extraFile = inputFingerprint({
    textByPath: new Map([["a.ts", "alpha"]]),
    binaryFiles: ["c.png"],
    excludedFiles: [],
  });
  assert.equal(new Set([first, changedContent, changedPath, extraFile]).size, 4);
  // Order of insertion must NOT matter; content must.
  assert.equal(
    inputFingerprint({ textByPath: new Map([["a.ts", "x"], ["b.ts", "y"]]), binaryFiles: [], excludedFiles: [] }),
    inputFingerprint({ textByPath: new Map([["b.ts", "y"], ["a.ts", "x"]]), binaryFiles: [], excludedFiles: [] })
  );

  const rules = [{ id: "one", pattern: /alpha/giu }];
  const renamed = [{ id: "two", pattern: /alpha/giu }];
  const repatterned = [{ id: "one", pattern: /beta/giu }];
  const reflagged = [{ id: "one", pattern: /alpha/gu }];
  assert.equal(
    new Set([
      rulesFingerprint(rules),
      rulesFingerprint(renamed),
      rulesFingerprint(repatterned),
      rulesFingerprint(reflagged),
    ]).size,
    4
  );
});

test("argument parsing accepts both flag forms and rejects anything unknown", () => {
  const inline = parseCliOptions(["--since=abc123", "--manifest=m.json", "--check"]);
  assert.deepEqual(inline.errors, []);
  assert.equal(inline.revision, "abc123");
  assert.equal(inline.manifestPath, "m.json");
  assert.equal(inline.check, true);

  // Previously silently ignored, so --since <rev> appeared to work and did not.
  const spaced = parseCliOptions(["--since", "abc123", "--manifest", "m.json", "--write"]);
  assert.deepEqual(spaced.errors, []);
  assert.equal(spaced.revision, "abc123");
  assert.equal(spaced.manifestPath, "m.json");
  assert.equal(spaced.write, true);

  assert.match(parseCliOptions(["--nonsense"]).errors.join(), /unknown option/u);
  assert.match(parseCliOptions(["stray"]).errors.join(), /unexpected argument/u);
  assert.match(parseCliOptions(["--since"]).errors.join(), /requires a value/u);
  assert.match(parseCliOptions(["--since", "--check"]).errors.join(), /requires a value/u);
  assert.match(parseCliOptions(["--check=yes"]).errors.join(), /does not take a value/u);
});

test("fix-H: a committed pure rename is detected via the v1 merge-base without --since", () => {
  // The committed-move fallback. On a real pull request the rename is already
  // in HEAD by the time CI runs, so HEAD-vs-worktree shows nothing and the
  // feature only engages if it falls back to the merge base with an upstream.
  const from = `src/${TOKEN.vendorLower}-client.ts`;
  const to = `src/legacy/${TOKEN.vendorLower}-client.ts`;
  withScenario({ [from]: source.vendorModule() }, (scenario) => {
    scenario.seedManifest();
    scenario.branch("v1"); // the baseline the fallback resolves to
    scenario.move(from, to);
    scenario.commit("rename into legacy/"); // the move now lives in HEAD, not the worktree

    // No --since: revision defaults to HEAD. This can only classify as a move
    // if merge-base(HEAD, v1) is consulted.
    const result = scenario.run();
    assert.equal(
      result.classification.counts.moved,
      1,
      "a committed content move must not degrade to removed+added"
    );
    assert.equal(result.classification.counts["path-rebound"], 1, "the path anchor rides along");
    assert.equal(result.classification.counts.removed, 0);
    assert.equal(result.classification.counts.added, 0);
    assert.deepEqual(
      result.moves.map((move) => [move.from, move.to, move.identical]),
      [[from, to, true]]
    );
    assert(
      result.moveRevisions.length >= 2,
      "the fallback must have added a revision beyond HEAD"
    );
  });
});

test("fix-I: runWrite refuses a gate-rejecting candidate and leaves the manifest byte-identical", async () => {
  // MAJOR-3 at the CLI boundary, not just in the helper. migration-archaeology
  // is legal only on an immutable Prisma migration.sql; relocating one out of
  // prisma/migrations yields a manifest the gate rejects, and the write path
  // itself must catch that.
  const from = "db/prisma/migrations/20260101000000_example/migration.sql";
  const to = "db/archive/migration.sql";
  const scenario = createScenario({ [from]: `CREATE ${TOKEN.vendor.toUpperCase()} "example";\n` });
  const savedExit = process.exitCode;
  try {
    scenario.seedManifest({
      classification: "migration-archaeology",
      owner: "Data Platform",
      rationale: "Preserves immutable SQL migration syntax byte-for-byte.",
      removalPolicy: "Remove only with its database lineage.",
      removalEvent: "The immutable migration and every lineage that applied it are retired.",
    });
    scenario.move(from, to); // out of prisma/migrations -> the gate will reject it
    const before = sha256(readFileSync(scenario.manifestPath, "utf8"));

    const outcome = await runWrite(
      { manifestPath: scenario.manifestPath, revision: "HEAD", write: true },
      scenario.root
    );

    assert.equal(outcome.wrote, false, "runWrite must not write a manifest its own gate rejects");
    assert.equal(outcome.refused, "gate-rejected");
    assert.match(outcome.gate.errors.join("\n"), /restricted to immutable Prisma migration\.sql files/u);
    assert.equal(
      sha256(readFileSync(scenario.manifestPath, "utf8")),
      before,
      "the manifest bytes must be untouched after a refusal"
    );
  } finally {
    scenario.cleanup();
    // runWrite sets process.exitCode on a refusal; don't let that leak into the
    // test runner's own exit status.
    process.exitCode = savedExit;
  }
});
