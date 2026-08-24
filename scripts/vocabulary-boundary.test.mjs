import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
  applyCollisionAnchors,
  formatReport,
  scanRepository,
  sha256,
  validateManifest,
} from "./vocabulary-boundary.mjs";

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

test("the production manifest separates SecondarySurfaces vendor and product contexts", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../docs/vocabulary-boundary-exceptions.json", import.meta.url), "utf8")
  );
  const entries = manifest.exceptions.filter(
    (entry) => entry.path === "apps/webapp/app/components/platos/surfaces/SecondarySurfaces.tsx" && entry.rule === "trigger"
  );
  const entriesByAnchor = new Map();
  for (const entry of entries) {
    const anchor = `${entry.line}:${entry.semanticContextSha256}`;
    entriesByAnchor.set(anchor, [...(entriesByAnchor.get(anchor) ?? []), entry]);
  }
  assert(entries.some((entry) => entry.classification === "vendor"));
  assert(entries.some((entry) => entry.classification === "migration-debt"));
  assert(
    [...entriesByAnchor.values()].some(
      (anchoredEntries) =>
        anchoredEntries.some((entry) => entry.classification === "vendor") &&
        anchoredEntries.some((entry) => entry.classification === "migration-debt")
    )
  );
  assert(entries.every((entry) => entry.localContextSha256 && entry.semanticContextSha256));
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

test("vendor and technical exceptions require an event-bound removal condition", () => {
  const { root, manifest } = fixture({ "src/external.ts": "External Trigger\n" });
  const [finding] = findingsWithoutExceptions(root, manifest);
  const exception = exceptionFor(finding, vendorLifecycle);
  delete exception.removalEvent;
  assert.match(validateManifest({ ...manifest, exceptions: [exception] }).join("\n"), /removalEvent/u);
});
