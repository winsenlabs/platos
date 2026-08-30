import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  INTEGRATION_BASE,
  MARKDOWN_PATH,
  REPORT_PATH,
  REVIEWED_SOURCE_BASE,
  REVIEWED_SOURCE_COMMIT,
  auditRepository,
  existingRetiredRoots,
  markdownText,
  reportText,
  scanApiBoundary,
  scanReachability,
  validateDeletionSet,
} from "./vendored-build-audit.mjs";

const root = resolve(import.meta.dirname, "..");
const candidateNames = [
  "@platos/sdk",
  "@internal/sdk-compat-tests",
  "@platos/build",
  "@platos/python",
  "@platos/rsc",
  "@platos/schema-to-json",
];
const candidateRoots = [
  "packages/trigger-sdk",
  "internal-packages/sdk-compat-tests",
  "packages/build",
  "packages/python",
  "packages/rsc",
  "packages/schema-to-json",
];

function withDetachedWorktree(prefix, revision, run) {
  const scratch = mkdtempSync(`/var/tmp/${prefix}-`);
  const worktree = resolve(scratch, "worktree");
  let added = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, revision], { cwd: root, stdio: "ignore" });
    added = true;
    return run(worktree);
  } finally {
    if (added) execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "ignore" });
    rmSync(scratch, { recursive: true, force: true });
  }
}

const reachabilityFixtures = [
  {
    channel: "package-dependencies",
    path: "packages/consumer/package.json",
    content: JSON.stringify({ dependencies: { "@platos/sdk": "workspace:*" } }),
  },
  {
    channel: "static-imports",
    path: "packages/consumer/src/index.ts",
    content: 'import { task } from "@platos/sdk";\n',
  },
  {
    channel: "side-effect-imports",
    path: "packages/consumer/src/register.ts",
    content: 'import "@platos/build";\n',
  },
  {
    channel: "dynamic-imports",
    path: "packages/consumer/src/lazy.ts",
    content: 'export const load = () => import("@platos/python");\n',
  },
  {
    channel: "filesystem-loaders",
    path: "packages/consumer/src/loader.ts",
    content: 'const manifest = readFileSync(resolve(root, "packages/schema-to-json/package.json"));\n',
  },
  {
    channel: "ts-references",
    path: "packages/consumer/tsconfig.json",
    content: JSON.stringify({ references: [{ path: "../../packages/rsc" }] }),
  },
  {
    channel: "ci",
    path: ".github/workflows/ci.yml",
    content: "run: pnpm --filter @internal/sdk-compat-tests test\n",
  },
  {
    channel: "scripts",
    path: "scripts/build-retired.sh",
    content: "pnpm --filter @platos/build build\n",
  },
  {
    channel: "docker",
    path: "Dockerfile",
    content: "COPY packages/python /opt/python\n",
  },
  {
    channel: "test-config",
    path: "vitest.config.ts",
    content: 'const fixtures = "internal-packages/sdk-compat-tests";\n',
  },
  {
    channel: "docs",
    path: "docs/consumer.md",
    content: "Import task from @platos/sdk.\n",
  },
];

for (const fixture of reachabilityFixtures) {
  test(`consumer mutation flips ${fixture.channel}`, () => {
    const clean = scanReachability([{ path: fixture.path, content: "export {};\n" }], candidateNames, candidateRoots);
    assert.equal(clean[fixture.channel].length, 0);
    const mutated = scanReachability([fixture], candidateNames, candidateRoots);
    assert.ok(mutated[fixture.channel].length > 0, `${fixture.channel} detector did not fire`);
  });
}

test("API mapping distinguishes Trigger runtime and Platos client imports", () => {
  const correct = scanApiBoundary([
    {
      path: "docs/correct.md",
      content: 'import { task, tasks, runs, schedules, wait } from "@trigger.dev/sdk";\nimport { PlatosClient } from "@platosdev/client";\n',
    },
  ]);
  assert.equal(correct.runtimeImports.length, 1);
  assert.equal(correct.clientImports.length, 1);
  assert.deepEqual(correct.legacyImports, []);
  assert.deepEqual(correct.deprecatedSubpathImports, []);
  assert.deepEqual(correct.misroutedRuntimeImports, []);
  assert.deepEqual(correct.misroutedClientImports, []);

  const deprecatedSubpath = scanApiBoundary([
    {
      path: "docs/deprecated.md",
      content: 'import { task, tasks, runs, schedules, wait } from "@trigger.dev/sdk/v3";\n',
    },
  ]);
  assert.equal(deprecatedSubpath.runtimeImports.length, 1, "the deprecated subpath still names runtime APIs");
  assert.equal(deprecatedSubpath.deprecatedSubpathImports.length, 1, "the /v3 mutation must fail closed");
  assert.deepEqual(deprecatedSubpath.misroutedRuntimeImports, []);

  const historical = scanApiBoundary(
    [
      {
        path: "packages/core/CHANGELOG.md",
        content: 'import { task } from "@trigger.dev/sdk/v3";\n',
      },
    ],
    { permittedHistoricalPaths: new Set(["packages/core/CHANGELOG.md"]) }
  );
  assert.deepEqual(historical.deprecatedSubpathImports, []);
  assert.equal(historical.permittedHistoricalDeprecatedSubpathImports.length, 1);

  const blanketReplacement = scanApiBoundary([
    {
      path: "docs/wrong.md",
      content: 'import { task, tasks, PlatosClient } from "@trigger.dev/sdk";\n',
    },
  ]);
  assert.equal(blanketReplacement.misroutedClientImports.length, 1);

  const inverse = scanApiBoundary([
    {
      path: "docs/wrong-client.md",
      content: 'import { tasks, runs } from "@platosdev/client";\n',
    },
  ]);
  assert.equal(inverse.misroutedRuntimeImports.length, 1);

  const legacy = scanApiBoundary([
    {
      path: "docs/legacy.md",
      content: 'import { task, PlatosClient } from "@platos/sdk";\n',
    },
  ]);
  assert.equal(legacy.legacyImports.length, 1);
  assert.equal(legacy.misroutedRuntimeImports.length, 1);
  assert.equal(legacy.misroutedClientImports.length, 1);
});

test("deletion-set validation rejects restored and extra paths", () => {
  const expected = ["packages/build/package.json", "packages/rsc/package.json"];
  const result = validateDeletionSet(expected, ["packages/build/package.json", "README.md"]);
  assert.deepEqual(result.missing, ["packages/rsc/package.json"]);
  assert.deepEqual(result.unrecorded, ["README.md"]);
});

test("tombstones reject tracked, ignored, and empty retired roots", () => {
  const scratch = mkdtempSync("/var/tmp/platos-win253-tombstone-");
  try {
    assert.deepEqual(existingRetiredRoots(scratch), []);
    mkdirSync(resolve(scratch, "packages/build"), { recursive: true });
    assert.deepEqual(existingRetiredRoots(scratch), ["packages/build"], "empty retired root must fail");
    rmSync(resolve(scratch, "packages/build"), { recursive: true, force: true });

    mkdirSync(resolve(scratch, "packages/build/node_modules"), { recursive: true });
    writeFileSync(resolve(scratch, "packages/build/node_modules/ignored.js"), "export {};\n");
    assert.deepEqual(existingRetiredRoots(scratch), ["packages/build"], "ignored retired content must fail");
    const retiredSdkRoot = candidateRoots[0];
    mkdirSync(resolve(scratch, retiredSdkRoot, "src"), { recursive: true });
    writeFileSync(resolve(scratch, retiredSdkRoot, "src/reintroduced.ts"), "export {};\n");
    assert.deepEqual(
      existingRetiredRoots(scratch),
      ["packages/build", retiredSdkRoot],
      "tracked or untracked retired content must fail"
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

const cleanAudit = auditRepository(root);

test("live audit is green and derives every deletion from the exact primary base", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  assert.equal(report.integrationBase.sha, INTEGRATION_BASE);
  assert.equal(report.deletion.workspaceCount, 6);
  assert.equal(report.deletion.actualFileCount, 122);
  assert.equal(report.reviewedSource.base, REVIEWED_SOURCE_BASE);
  assert.equal(report.reviewedSource.commit, REVIEWED_SOURCE_COMMIT);
  assert.equal(report.reviewedSource.deletion.workspaceCount, 6);
  assert.equal(report.reviewedSource.deletion.actualFileCount, 120);
  assert.equal(report.reviewedSource.integrationCoverage.representedReviewedDeletionCount, 120);
  assert.deepEqual(report.reviewedSource.integrationCoverage.missingReviewedDeletions, []);
  assert.deepEqual(
    report.reviewedSource.integrationCoverage.primaryBaseAdditions.map(({ path }) => path),
    ["packages/rsc/LICENSE", "packages/schema-to-json/LICENSE"]
  );
  assert.ok(
    report.reviewedSource.integrationCoverage.primaryBaseAdditions.every(({ reason }) => reason.includes("WIN-252")),
    "every primary-base addition must carry an explicit explanation"
  );
  const actual = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", INTEGRATION_BASE, "--"],
    { cwd: root, encoding: "utf8" }
  ).split("\0").filter(Boolean).sort();
  assert.deepEqual(report.deletion.files.map(({ path }) => path), actual);
  assert.deepEqual(report.restore.pathspec, actual);
  assert.deepEqual(report.restore.argv.slice(0, 4), ["git", "restore", `--source=${INTEGRATION_BASE}`, "--"]);
  const reviewedDeleted = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", REVIEWED_SOURCE_BASE, REVIEWED_SOURCE_COMMIT, "--"],
    { cwd: root, encoding: "utf8" }
  ).split("\0").filter(Boolean).sort();
  assert.deepEqual(report.reviewedSource.deletion.pathspec, reviewedDeleted);
  assert.ok(reviewedDeleted.every((path) => actual.includes(path)));
});

test("reviewed-source provenance rejects incorrect source SHAs and pathsets", () => {
  for (const [label, options] of [
    ["base SHA", { reviewedSourceBase: INTEGRATION_BASE }],
    ["commit SHA", { reviewedSourceCommit: REVIEWED_SOURCE_BASE }],
    ["pathset", { reviewedSourceRoots: candidateRoots.slice(1) }],
    ["missing primary-base explanation", { allowedPrimaryBaseAdditions: [] }],
  ]) {
    const mutated = auditRepository(root, options);
    assert.ok(
      mutated.violations.some((violation) => violation.includes("reviewed source") || violation.includes("primary-base")),
      `${label} mutation must fail provenance validation: ${mutated.violations.join("; ")}`
    );
  }
});

test("reported restore argv recreates every deletion byte-for-byte", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  withDetachedWorktree("platos-win253-vendored-restore", INTEGRATION_BASE, (worktree) => {
    for (const candidateRoot of candidateRoots) rmSync(resolve(worktree, candidateRoot), { recursive: true, force: true });
    const [command, ...args] = report.restore.argv;
    execFileSync(command, args, { cwd: worktree, stdio: "ignore" });
    execFileSync("git", ["diff", "--exit-code", INTEGRATION_BASE, "--", ...candidateRoots], {
      cwd: worktree,
      stdio: "ignore",
    });
  });
});

test("all protected Platos SDK trees remain byte-identical to the primary base", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  assert.equal(report.protectedTrees.length, 7);
  for (const tree of report.protectedTrees) {
    assert.equal(tree.byteIdentical, true, tree.path);
    assert.equal(
      tree.integrationBaseTreeOid,
      execFileSync("git", ["rev-parse", `${INTEGRATION_BASE}:${tree.path}`], { cwd: root, encoding: "utf8" }).trim(),
      tree.path
    );
  }
});

test("committed receipts are exact executable audit output", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  assert.equal(readFileSync(resolve(root, REPORT_PATH), "utf8"), reportText(report));
  assert.equal(readFileSync(resolve(root, MARKDOWN_PATH), "utf8"), markdownText(report));

  const tampered = structuredClone(report);
  tampered.deletion.files.pop();
  assert.notEqual(reportText(tampered), reportText(report), "deletion mutation must change the receipt");
});
