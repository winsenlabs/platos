import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

import {
  WIN254_COMMANDS,
  WIN254_REGENERATION_COMMANDS,
  commandLine,
  regenerateWin254,
  validateRegenerationOrder,
  verifyWin254,
} from "./verify-win254.mjs";

const expected = [
  "pnpm audit:docs-link-integrity",
  "pnpm audit:design-provenance",
  "pnpm audit:contract-map",
  "pnpm audit:protected-paths",
  "pnpm audit:evidence-lifecycle",
  "pnpm audit:docs-build",
  "pnpm audit:root-manifest",
  "pnpm audit:v1-ledger",
  "pnpm test:vocabulary",
  "pnpm audit:vocabulary",
  "pnpm audit:win253-clickhouse-split",
  "pnpm audit:sbom:check",
  "pnpm audit:workspace-reachability",
  "pnpm audit:win253-vendored-build",
  "pnpm audit:advisory:check",
];

const expectedRegeneration = [
  "node scripts/vocabulary-boundary.mjs --write",
  "node scripts/clickhouse-split-audit.mjs --write",
  "node scripts/audit-sbom.mjs generate",
  "node scripts/workspace-reachability.mjs generate",
  "node scripts/vendored-build-audit.mjs --write",
  "node scripts/protected-paths.mjs write",
  "node scripts/evidence-lifecycle.mjs write",
];

test("Mintlify is an exact lockfile-backed docs dependency invoked only through the workspace binary", () => {
  const docsPackage = JSON.parse(readFileSync(new URL("../docs/package.json", import.meta.url), "utf8"));
  assert.equal(docsPackage.devDependencies.mintlify, "4.2.836");
  assert.deepEqual(docsPackage.scripts, {
    dev: "pnpm exec mintlify dev --port 3050",
    validate: "pnpm exec mintlify validate --telemetry false",
    "broken-links": "pnpm exec mintlify broken-links --check-anchors --check-snippets --check-redirects --telemetry false",
  });
  assert.ok(Object.values(docsPackage.scripts).every((command) => !command.includes("dlx")));

  const lockfile = parse(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
  assert.equal(lockfile.importers.docs.devDependencies.mintlify.specifier, "4.2.836");
  assert.match(lockfile.importers.docs.devDependencies.mintlify.version, /^4\.2\.836(?:\(|$)/u);
});

test("combined verifier composes each owning check exactly once in acceptance order", () => {
  assert.deepEqual(WIN254_COMMANDS.map(commandLine), expected);
  assert.equal(new Set(expected).size, expected.length);
});

test("canonical regeneration has one acyclic dependency-ordered pass", () => {
  assert.deepEqual(
    WIN254_REGENERATION_COMMANDS.map((step) => commandLine(step.command)),
    expectedRegeneration,
  );
  assert.deepEqual(validateRegenerationOrder(), [
    "vocabulary",
    "clickhouse",
    "sbom",
    "workspaceReachability",
    "vendoredBuild",
    "protectedPaths",
    "evidenceLifecycle",
  ]);
});

test("regeneration dependency validation rejects workspace reachability before ClickHouse", () => {
  const mutated = [...WIN254_REGENERATION_COMMANDS];
  [mutated[1], mutated[3]] = [mutated[3], mutated[1]];
  assert.throws(
    () => validateRegenerationOrder(mutated),
    /regeneration step workspaceReachability must follow dependency clickhouse/u,
  );
});

test("canonical regeneration executes every generator exactly once", () => {
  const called = [];
  const result = regenerateWin254("/var/tmp", {
    spawn(executable, args) {
      called.push([executable, ...args].join(" "));
      return { status: 0 };
    },
  });
  assert.deepEqual(called, expectedRegeneration);
  assert.deepEqual(result, { ok: true, commandCount: expectedRegeneration.length });
});

test("combined verifier fails closed at every composed check", () => {
  for (const [failureIndex, failedCommand] of expected.entries()) {
    const called = [];
    const result = verifyWin254("/var/tmp", {
      spawn(executable, args) {
        const command = [executable, ...args].join(" ");
        called.push(command);
        return { status: command === failedCommand ? 7 : 0 };
      },
    });
    assert.deepEqual(called, expected.slice(0, failureIndex + 1));
    assert.deepEqual(result, { ok: false, command: failedCommand, status: 7 });
  }
});

test("combined verifier reports success only after every composed check runs", () => {
  const called = [];
  const result = verifyWin254("/var/tmp", {
    spawn(executable, args) {
      called.push([executable, ...args].join(" "));
      return { status: 0 };
    },
  });
  assert.deepEqual(called, expected);
  assert.deepEqual(result, { ok: true, commandCount: expected.length });
});
