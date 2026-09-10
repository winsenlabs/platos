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
  isTombstonedPath,
  markdownText,
  reportText,
  scanApiBoundary,
  scanReachability,
  validateDeletionComposition,
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
  assert.equal(report.deletion.actualFileCount, 124);
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
  assert.deepEqual(
    report.reviewedSource.integrationCoverage.separatelyAuthorizedOutsideRootDeletions.map(({ path }) => path),
    ["patches/@upstash__ratelimit.patch", "patches/@window-splitter__state@0.4.1.patch"]
  );
  assert.deepEqual(report.deletion.composition, {
    reviewedSourceSixRootFileCount: 120,
    primaryBaseSixRootAdditionCount: 2,
    separatelyAuthorizedOutsideRootFileCount: 2,
    totalFileCount: 124,
  });
  assert.ok(
    report.reviewedSource.integrationCoverage.primaryBaseAdditions.every(({ path }) => isTombstonedPath(path)),
    "the later LICENSE additions must remain inside the six-root cluster"
  );
  assert.ok(
    report.reviewedSource.integrationCoverage.separatelyAuthorizedOutsideRootDeletions.every(
      ({ path }) => !isTombstonedPath(path)
    ),
    "the obsolete patch deletions must remain outside the six-root cluster"
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
  const authorizedOutsideRootDeletions =
    cleanAudit.report.reviewedSource.integrationCoverage.separatelyAuthorizedOutsideRootDeletions;
  for (const [label, options] of [
    ["base SHA", { reviewedSourceBase: INTEGRATION_BASE }],
    ["commit SHA", { reviewedSourceCommit: REVIEWED_SOURCE_BASE }],
    ["pathset", { reviewedSourceRoots: candidateRoots.slice(1) }],
    ["missing primary-base explanation", { allowedPrimaryBaseAdditions: [] }],
    ["patch paths treated as reviewed-source roots", { reviewedSourceRoots: [...candidateRoots, "patches"] }],
    ["missing first outside-root authorization", { allowedAdditionalIntegrationDeletions: authorizedOutsideRootDeletions.slice(1) }],
    ["missing second outside-root authorization", { allowedAdditionalIntegrationDeletions: authorizedOutsideRootDeletions.slice(0, 1) }],
    ["outside-root deletion mislabeled as six-root", {
      allowedAdditionalIntegrationDeletions: [
        cleanAudit.report.reviewedSource.integrationCoverage.primaryBaseAdditions[0],
        ...authorizedOutsideRootDeletions,
      ],
    }],
  ]) {
    const mutated = auditRepository(root, options);
    assert.ok(
      mutated.violations.some((violation) => violation.includes("reviewed source") || violation.includes("primary-base")),
      `${label} mutation must fail provenance validation: ${mutated.violations.join("; ")}`
    );
  }
});

test("reviewed-source provenance fails closed when the pinned commit object is unavailable", () => {
  const unavailableCommit = "0".repeat(40);
  const { report, violations } = auditRepository(root, {
    reviewedSourceCommit: unavailableCommit,
  });
  assert.equal(report.reviewedSource.commit, unavailableCommit);
  assert.ok(report.reviewedSource.derivationError, "the unavailable object must not be tolerated");
  assert.ok(
    violations.some((violation) =>
      violation.startsWith("reviewed source provenance could not be derived:")
    ),
    violations.join("; ")
  );
  assert.equal(report.deletion.composition.reviewedSourceSixRootFileCount, null);
});

test("deletion composition rejects an unauthorized outside-root path", () => {
  const reviewedSourcePaths = cleanAudit.report.reviewedSource.deletion.pathspec;
  const primaryBaseAdditionPaths =
    cleanAudit.report.reviewedSource.integrationCoverage.primaryBaseAdditions.map(({ path }) => path);
  const separatelyAuthorizedOutsideRootPaths =
    cleanAudit.report.reviewedSource.integrationCoverage.separatelyAuthorizedOutsideRootDeletions.map(
      ({ path }) => path
    );
  const clean = validateDeletionComposition({
    reviewedSourcePaths,
    primaryBaseAdditionPaths,
    separatelyAuthorizedOutsideRootPaths,
    actualPaths: cleanAudit.report.deletion.files.map(({ path }) => path),
  });
  assert.deepEqual(clean.violations, []);

  const mutated = validateDeletionComposition({
    reviewedSourcePaths,
    primaryBaseAdditionPaths,
    separatelyAuthorizedOutsideRootPaths,
    actualPaths: [...clean.actual, "patches/unauthorized.patch"],
  });
  assert.ok(
    mutated.violations.includes("unauthorized deletion is present: patches/unauthorized.patch")
  );
});

test("reported restore argv recreates every deletion byte-for-byte", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  withDetachedWorktree("platos-win253-vendored-restore", INTEGRATION_BASE, (worktree) => {
    for (const path of report.restore.pathspec) rmSync(resolve(worktree, path), { force: true });
    const [command, ...args] = report.restore.argv;
    execFileSync(command, args, { cwd: worktree, stdio: "ignore" });
    execFileSync("git", ["diff", "--exit-code", INTEGRATION_BASE, "--", ...report.restore.pathspec], {
      cwd: worktree,
      stdio: "ignore",
    });
  });
});

// PROTECTED SDK TREES: WHAT THE RULE IS AFTER WIN-270 (M4.4).
//
// WIN-253 pinned all seven trees byte-identical to the integration base. That
// was right for a removal audit — its worst failure is collateral damage — but
// written as a standing invariant it also forbade the deliberate SDK work M4.4
// exists to do, which is a gate measuring elapsed time rather than damage.
//
// The rule is now: deviation is a violation UNLESS a reviewed entry in
// `allowedProtectedSdkChanges` names the exact path and says why. The three
// cases below are the negative controls that make that a gate rather than a
// preference — an unlisted change, a stale permission, and a deletion, which has
// no reviewed form at all. Each runs against a real worktree of the integration
// base, so none of them asserts against a value this file also wrote.
test("protected Platos SDK trees deviate only where a reviewed entry says so", () => {
  const { report, violations } = cleanAudit;
  assert.deepEqual(violations, []);
  assert.equal(report.protectedTrees.length, 7);
  let reviewedTotal = 0;
  for (const tree of report.protectedTrees) {
    assert.equal(
      tree.integrationBaseTreeOid,
      execFileSync("git", ["rev-parse", `${INTEGRATION_BASE}:${tree.path}`], { cwd: root, encoding: "utf8" }).trim(),
      tree.path
    );
    const reviewed = tree.reviewedChanges ?? [];
    reviewedTotal += reviewed.length;
    // `byteIdentical` still means byte-identical. It is now the COMPLEMENT of
    // the reviewed set rather than an unconditional `true`, so a tree cannot
    // report both a clean bill and a reviewed deviation.
    assert.equal(tree.byteIdentical, reviewed.length === 0, tree.path);
    for (const change of reviewed) {
      assert.ok(change.path.startsWith(`${tree.path}/`), `${change.path} is not under ${tree.path}`);
      assert.ok(["added", "changed"].includes(change.kind), change.path);
      assert.match(change.reason, /\S/u, change.path);
    }
  }
  // The four trees WIN-270 did not touch are still byte-identical, which is the
  // half of WIN-253's claim that has not moved.
  const untouched = report.protectedTrees.filter((tree) => tree.byteIdentical).map((tree) => tree.path);
  assert.deepEqual(untouched, ["packages/platools-js", "packages/platools-py"]);
  assert.ok(reviewedTotal > 0, "the reviewed-change mechanism must be exercised by the live tree");
});

test("an unreviewed change to a protected SDK tree is a violation", () => {
  withDetachedWorktree("platos-win253-protected-change", INTEGRATION_BASE, (worktree) => {
    const target = resolve(worktree, "packages/platools-js/package.json");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n`);
    const { violations } = auditRepository(worktree, { allowedProtectedSdkChanges: [] });
    assert.ok(
      violations.includes("protected SDK file changed from integration base: packages/platools-js/package.json"),
      JSON.stringify(violations)
    );
  });
});

test("an unreviewed addition to a protected SDK tree is a violation", () => {
  withDetachedWorktree("platos-win253-protected-add", INTEGRATION_BASE, (worktree) => {
    writeFileSync(resolve(worktree, "packages/platools-js/win270-probe.txt"), "probe\n");
    const { violations } = auditRepository(worktree, { allowedProtectedSdkChanges: [] });
    assert.ok(
      violations.includes("protected SDK tree gained a path: packages/platools-js/win270-probe.txt"),
      JSON.stringify(violations)
    );
  });
});

test("a reviewed path that is no longer deviating is itself a violation", () => {
  withDetachedWorktree("platos-win253-protected-stale", INTEGRATION_BASE, (worktree) => {
    const { violations } = auditRepository(worktree, {
      allowedProtectedSdkChanges: [
        { path: "packages/platools-js/package.json", reason: "a permission for a change nobody made" },
      ],
    });
    assert.ok(
      violations.includes(
        "reviewed protected SDK change no longer deviates from the integration base: packages/platools-js/package.json"
      ),
      JSON.stringify(violations)
    );
  });
});

test("deletion of a protected SDK file has no reviewed form", () => {
  withDetachedWorktree("platos-win253-protected-delete", INTEGRATION_BASE, (worktree) => {
    rmSync(resolve(worktree, "packages/platools-js/package.json"), { force: true });
    const { violations } = auditRepository(worktree, {
      // The strongest possible permission for that exact path, and it still
      // fails: a published SDK file may be edited, never deleted.
      allowedProtectedSdkChanges: [
        { path: "packages/platools-js/package.json", reason: "deliberately permitted, and still refused" },
      ],
    });
    assert.ok(
      violations.includes("protected SDK file is missing: packages/platools-js/package.json"),
      JSON.stringify(violations)
    );
  });
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
