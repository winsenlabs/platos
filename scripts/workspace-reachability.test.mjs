// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseLockfile } from "./lib/pnpm-closure.mjs";
import {
  buildReachabilityReport,
  checkArtifacts,
  generateArtifacts,
  patchesForImporter,
  reconcileConfiguredPatches,
} from "./workspace-reachability.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];
const repositoryReport = (() => {
  let report;
  return () => (report ??= buildReachabilityReport(ROOT));
})();

test.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function write(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "platos-win253-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(
    root,
    ".gitignore",
    ".env\napps/**/public/build/\n.tshy*\n*.tsbuildinfo\n"
  );
  write(root, "pnpm-workspace.yaml", 'packages:\n  - "apps/**"\n  - "packages/*"\n');
  write(
    root,
    "package.json",
    json({
      name: "fixture-root",
      private: true,
      pnpm: { patchedDependencies: {} },
      scripts: {},
    })
  );
  write(root, "tsconfig.json", json({ files: [], references: [] }));
  write(
    root,
    "apps/ship/package.json",
    json({
      name: "shipping-app",
      private: true,
      scripts: {},
      devDependencies: { "@internal/dev-only": "workspace:*" },
    })
  );
  write(
    root,
    "packages/dev-only/package.json",
    json({
      name: "@internal/dev-only",
      private: true,
      scripts: {},
    })
  );
  write(
    root,
    "packages/target/package.json",
    json({
      name: "@internal/run-engine",
      private: true,
      scripts: {},
    })
  );
  write(
    root,
    "apps/ship/Dockerfile",
    "FROM scratch\nRUN pnpm --filter shipping-app deploy --prod\n"
  );
  write(
    root,
    ".github/workflows/build.yml",
    [
      "jobs:",
      "  build:",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - dockerfile: apps/ship/Dockerfile",
      "",
    ].join("\n")
  );
  write(root, "pnpm-lock.yaml", fixtureLockfile());
  return root;
}

function fixtureLockfile({ productionTarget = false } = {}) {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .: {}",
    "",
    "  apps/ship:",
    ...(productionTarget
      ? [
          "    dependencies:",
          "      '@internal/run-engine':",
          "        specifier: workspace:*",
          "        version: link:../../packages/target",
        ]
      : []),
    "    devDependencies:",
    "      '@internal/dev-only':",
    "        specifier: workspace:*",
    "        version: link:../../packages/dev-only",
    "",
    "  packages/dev-only: {}",
    "",
    "  packages/target: {}",
    "",
    "packages: {}",
    "",
    "snapshots: {}",
    "",
  ].join("\n");
}

function target(report) {
  return report.workspaces.find((workspace) => workspace.name === "@internal/run-engine");
}

function channelCanary(channel) {
  const root = fixture();
  const mutations = {
    sourceStatic: ["apps/ship/src/static.ts", 'import "@internal/run-engine";\n'],
    sourceDynamic: ["apps/ship/src/dynamic.ts", 'await import("@internal/run-engine");\n'],
    packageScripts: [
      "package.json",
      json({
        name: "fixture-root",
        private: true,
        pnpm: { patchedDependencies: {} },
        scripts: { canary: "pnpm --filter @internal/run-engine test" },
      }),
    ],
    ci: [
      ".github/workflows/reference.yml",
      "jobs:\n  canary:\n    steps:\n      - run: pnpm --filter @internal/run-engine test\n",
    ],
    dockerImage: [
      "apps/ship/Dockerfile",
      "FROM scratch\nRUN pnpm --filter shipping-app deploy --prod\nCOPY packages/target /target\n",
    ],
    testsFixtures: ["apps/ship/test/canary.test.ts", 'import "@internal/run-engine";\n'],
    docsExamples: ["docs/example.md", "Install `@internal/run-engine` for this example.\n"],
    license: ["NOTICE", "This distribution contains @internal/run-engine.\n"],
  };
  const [relativePath, canary] = mutations[channel];
  const before = fs.existsSync(path.join(root, relativePath))
    ? fs.readFileSync(path.join(root, relativePath), "utf8")
    : null;
  write(root, relativePath, canary);
  assert.equal(
    target(buildReachabilityReport(root)).channels[channel].reachable,
    true,
    `${channel} canary must reach target`
  );
  if (before === null) fs.rmSync(path.join(root, relativePath));
  else write(root, relativePath, before);
  assert.equal(
    target(buildReachabilityReport(root)).channels[channel].reachable,
    false,
    `hiding ${channel} must remove its verdict`
  );
}

test("lockfile importer parser accepts both block and empty-map keys", () => {
  const parsed = parseLockfile(
    "lockfileVersion: '9.0'\nimporters:\n  apps/a:\n  apps/b: {}\npackages: {}\nsnapshots: {}\n"
  );
  assert.deepEqual(Object.keys(parsed.importers), ["apps/a", "apps/b"]);
  assert.equal(Object.hasOwn(parsed.importers, "apps/b: {}"), false);
});

test("lockfile importer parser rejects malformed and duplicate keys", () => {
  assert.throws(
    () => parseLockfile("importers:\n  apps/a: malformed\n"),
    /Malformed importer entry/
  );
  assert.throws(
    () => parseLockfile("importers:\n  apps/a: {}\n  apps/a:\n"),
    /Duplicate importer entry/
  );
});

test("committed baseline independently captures OCI, application/deployable, and migrations-union closures", () => {
  const report = repositoryReport();
  assert.equal(report.summary.registeredWorkspaceCount, 60);
  assert.equal(report.summary.ociImageWorkspaceCount, 6);
  assert.equal(report.summary.applicationDeployableWorkspaceCount, 37);
  assert.equal(report.summary.deploymentUnionWorkspaceCount, 38);
  assert.equal(report.summary.repositoryDevWorkspaceCount, 10);
  assert.equal(report.summary.installTraversalWorkspaceCount, 60);
  assert.equal(report.summary.reviewCandidateCount, 22);
  const applicationRootKinds = new Set(
    Object.values(report.roots.applicationDeployable.reasons)
      .flat()
      .map((reason) => reason.kind)
  );
  assert.ok(applicationRootKinds.has("executable-manifest"));
  assert.ok(applicationRootKinds.has("root-typescript-reference"));
  assert.ok(applicationRootKinds.has("ci-build-entrypoint"));
  assert.deepEqual(report.summary.externalProductionSnapshotNodesByImage, {
    agent: 718,
    webapp: 335,
  });
  assert.equal(
    report.inputs.files.some((file) => file.path === ".git"),
    false
  );
  assert.equal(report.derivation.manualReachabilityAssertionsAccepted, false);
  assert.equal(report.derivation.deletionAuthorized, false);
  const evidenceDataPaths = new Set([
    "docs/audits/win253-removals/vendored-build.json",
    "docs/audits/win253-removals/vendored-build.md",
    "docs/audits/win-254-protected-paths.json",
    "docs/audits/win-254-evidence-lifecycle.json",
  ]);
  assert.equal(
    report.inputs.files.some((file) => evidenceDataPaths.has(file.path)),
    false,
    "generated evidence data must not enter the reachability input fingerprint"
  );
  for (const workspace of report.workspaces) {
    for (const channel of Object.values(workspace.channels)) {
      assert.equal(
        channel.reasons.some(({ from }) => evidenceDataPaths.has(from)),
        false,
        `${workspace.path} reachability must not derive from generated evidence data`
      );
    }
  }
});

test("the entire root-referenced V1 application graph is retained, never classified as review candidates", () => {
  const report = repositoryReport();
  const rootConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8"));
  const v1Projects = rootConfig.references.map((reference) => reference.path.replace(/^\.\//, ""));
  assert.equal(v1Projects.length, 32);
  for (const project of v1Projects) {
    const workspace = report.workspaces.find((entry) => entry.path === project);
    assert.equal(workspace.applicationDeployableClosure.reachable, true, project);
    assert.equal(workspace.deploymentUnionClosure.reachable, true, project);
    assert.equal(workspace.candidate.reviewCandidate, false, project);
    assert.match(workspace.candidate.status, /^retain-/);
  }
});

test("hiding a root TypeScript application reference flips its independently derived retention", () => {
  const root = fixture();
  write(root, "tsconfig.json", json({ files: [], references: [{ path: "./packages/target" }] }));
  let report = buildReachabilityReport(root);
  assert.equal(target(report).applicationDeployableClosure.reachable, true);
  assert.equal(target(report).candidate.reviewCandidate, false);

  write(root, "tsconfig.json", json({ files: [], references: [] }));
  report = buildReachabilityReport(root);
  assert.equal(target(report).applicationDeployableClosure.reachable, false);
  assert.equal(target(report).candidate.reviewCandidate, true);
});

test("a development dependency remains excluded from every production image closure", () => {
  const report = repositoryReport();
  const core = report.workspaces.find((workspace) => workspace.name === "@platos/core");
  assert.equal(core.ociImageClosure.reachable, false);
  assert.equal(core.repositoryDevClosure.reachable, true);
  assert.deepEqual(core.repositoryDevClosure.reversePaths, [
    ["apps/agent", "internal-packages/testcontainers", "packages/core"],
  ]);
});

test("published package and embedded server implementation boundaries stay distinct", () => {
  const report = repositoryReport();
  const publishedSdk = report.workspaces.find(
    (workspace) => workspace.path === "packages/platos-client"
  );
  const embeddedEngine = report.workspaces.find(
    (workspace) => workspace.path === "internal-packages/run-engine"
  );
  assert.equal(publishedSdk.boundaries.kind, "external-public-package");
  assert.equal(publishedSdk.boundaries.externalPublic, true);
  assert.equal(embeddedEngine.boundaries.kind, "embedded-private-implementation");
  assert.equal(embeddedEngine.boundaries.externalPublic, false);
});

test("repository candidates preserve NUL-safe untracked paths and ignore local artifacts", () => {
  const root = fixture();
  const baseline = buildReachabilityReport(root);
  const newlinePath = "notes/untracked\ncandidate.md";
  write(root, newlinePath, "candidate evidence\n");
  const withCandidate = buildReachabilityReport(root);
  assert.ok(withCandidate.inputs.files.some((file) => file.path === newlinePath));

  const ignoredMutations = [
    [".env", "@internal/run-engine\n"],
    ["apps/ship/public/build/reachability.json", '"@internal/run-engine"\n'],
    ["packages/target/.tshy/index.js", 'export const name = "@internal/run-engine";\n'],
    ["packages/target/tsconfig.tsbuildinfo", "@internal/run-engine\n"],
  ];
  for (const [relativePath, content] of ignoredMutations) {
    write(root, relativePath, content);
    assert.deepEqual(buildReachabilityReport(root), withCandidate, relativePath);
  }
  assert.notDeepEqual(withCandidate, baseline);
});

test("reintroducing @internal/run-engine into a shipping app flips the derived production verdict", () => {
  const root = fixture();
  const baseline = buildReachabilityReport(root);
  assert.equal(target(baseline).ociImageClosure.reachable, false);
  assert.equal(target(baseline).candidate.reviewCandidate, true);

  const appManifest = JSON.parse(
    fs.readFileSync(path.join(root, "apps/ship/package.json"), "utf8")
  );
  appManifest.dependencies = { "@internal/run-engine": "workspace:*" };
  write(root, "apps/ship/package.json", json(appManifest));
  write(root, "pnpm-lock.yaml", fixtureLockfile({ productionTarget: true }));
  const mutation = buildReachabilityReport(root);
  assert.equal(target(mutation).ociImageClosure.reachable, true);
  assert.equal(target(mutation).candidate.reviewCandidate, false);
  assert.deepEqual(target(mutation).ociImageClosure.reversePaths, [
    ["apps/ship", "packages/target"],
  ]);
});

test("dropping a registered workspace importer fails closed", () => {
  const root = fixture();
  write(root, "pnpm-lock.yaml", fixtureLockfile().replace("\n  packages/target: {}\n", "\n"));
  assert.throws(() => buildReachabilityReport(root), /Missing lockfile importer.*packages\/target/);
});

for (const channel of [
  "sourceStatic",
  "sourceDynamic",
  "packageScripts",
  "ci",
  "dockerImage",
  "testsFixtures",
  "docsExamples",
  "license",
]) {
  test(`the ${channel} channel is non-vacuous and fails when its evidence is hidden`, () => {
    channelCanary(channel);
  });
}

test("patch reachability uses each importer lockfile snapshot closure and detects concrete agent/webapp patches", () => {
  const lockText = fs.readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8");
  const parsed = parseLockfile(lockText);
  const patched = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).pnpm
    .patchedDependencies;
  const dependencies = (importer, lock = parsed, groups = ["prod", "opt"]) =>
    patchesForImporter(importer, lock, patched, groups).map((patch) => patch.dependencyAtVersion);

  assert.deepEqual(dependencies("apps/agent"), ["engine.io-parser@5.2.2"]);
  assert.deepEqual(dependencies("apps/webapp"), [
    "@sentry/remix@9.46.0",
    "engine.io-parser@5.2.2",
  ]);
  assert.equal(
    Object.hasOwn(
      JSON.parse(fs.readFileSync(path.join(ROOT, "apps/agent/package.json"), "utf8")).dependencies,
      "engine.io-parser"
    ),
    false,
    "agent patch evidence must be transitive, not a manifest-name match"
  );

  const hiddenPatchResolution = parseLockfile(
    lockText.replaceAll("(patch_hash=", "(hidden_patch_hash=")
  );
  assert.throws(
    () => reconcileConfiguredPatches(hiddenPatchResolution, patched),
    /Configured patch lacks concrete lockfile snapshot reconciliation carrying patch_hash/
  );
});

test("the report distinguishes production and dev-only importer patch closures", () => {
  const report = repositoryReport();
  const agent = report.workspaces.find((workspace) => workspace.path === "apps/agent");
  const webapp = report.workspaces.find((workspace) => workspace.path === "apps/webapp");
  const testcontainers = report.workspaces.find(
    (workspace) => workspace.path === "internal-packages/testcontainers"
  );
  assert.equal(report.patchReconciliation.configuredPatchCount, 5);
  assert.equal(report.patchReconciliation.reconciledPatchCount, 5);
  assert.equal(report.patchReconciliation.patches.length, 5);
  const changesets = report.patchReconciliation.patches.find(
    (patch) => patch.dependencyAtVersion === "@changesets/assemble-release-plan@5.2.4"
  );
  assert.deepEqual(
    changesets.importerClosures.map((closure) => closure.importer),
    ["."]
  );
  assert.ok(
    changesets.importerClosures[0].snapshotKeys.every((snapshotKey) =>
      snapshotKey.includes("(patch_hash=")
    )
  );
  for (const patch of report.patchReconciliation.patches) {
    assert.ok(patch.importerClosures.length > 0, patch.dependencyAtVersion);
    assert.ok(
      patch.importerClosures.every((closure) =>
        closure.snapshotKeys.every((snapshotKey) => snapshotKey.includes("(patch_hash="))
      ),
      patch.dependencyAtVersion
    );
  }
  assert.deepEqual(
    agent.channels.patches.reasons.map((reason) => reason.dependency),
    ["engine.io-parser@5.2.2"]
  );
  assert.ok(
    agent.channels.patches.reversePaths.some(
      (route) =>
        route[0] === "apps/agent" &&
        route.at(-1).startsWith("snapshot:engine.io-parser@5.2.2(patch_hash=")
    )
  );
  assert.deepEqual(
    webapp.channels.patches.reasons.map((reason) => reason.dependency),
    ["@sentry/remix@9.46.0", "engine.io-parser@5.2.2"]
  );
  assert.deepEqual(
    testcontainers.channels.patches.reasons.map((reason) => ({
      dependency: reason.dependency,
      kind: reason.kind,
    })),
    [
      {
        dependency: "engine.io-parser@5.2.2",
        kind: "lockfile-dev-only-snapshot-closure",
      },
    ]
  );
});

test("generated ownership includes the generator's exact 125 outputs across 32 V1 projects", () => {
  const report = repositoryReport();
  // M2 INTEGRATION DELTA — 201 -> 125. Adoption RELEASES placeholders, so this
  // count only ever falls, and the adopting slices release placeholders from
  // DISJOINT projects. The integrated count is therefore the SUM of every
  // reduction, never the smallest of the branch pins:
  //
  //   201 -> 182  WIN-256 slices 1-5 adopt 5 projects (packages/kernel and the
  //               secrets, files, tenancy and identity-access contexts),
  //               releasing 19 placeholders.
  //   182 -> 178  WIN-256 adopts `providers` (context 6), releasing its 4 —
  //               domain/index.ts, application/index.ts,
  //               application/ports/index.ts and contracts/index.ts.
  //   178 -> 169  WIN-297 adopts the two apps, releasing 9: apps/core-api's 8
  //               (main.ts, app.module.ts and the six transport seams) and
  //               apps/mcp-stdio's 1 (main.ts).
  //   169 -> 165  WIN-256 adopts `eventing` (ADR M0.3 §1 row 17), releasing the
  //               same 4 entry points every context adoption releases.
  //   165 -> 161  WIN-256 adopts `skills` (M2.1), releasing its own 4.
  //   161 -> 157  WIN-256 adopts `jobs` (ADR M0.3 §1 row 11), releasing its own
  //               4 — domain/index.ts, application/index.ts,
  //               application/ports/index.ts and contracts/index.ts.
  //   157 -> 153  WIN-256 adopts `memory` (ADR M0.3 §1 row 8), releasing the
  //               same 4 barrels.
  //   153 -> 149  WIN-256 adopts `cost-monitoring` (ADR M0.3 §1 row 13),
  //               releasing the same 4 barrels.
  //   149 -> 145  WIN-256 adopts `privacy` (ADR M0.3 §1 row 18), releasing the
  //               same 4 barrels.
  //   145 -> 141  WIN-256 adopts `observability` (ADR M0.3 §1 row 16),
  //               releasing the same 4 barrels.
  //   141 -> 137  WIN-256 adopts `agents` (ADR M0.3 §1 context 5), releasing the
  //               same 4 barrels.
  //   137 -> 133  WIN-256 adopts `tools` (ADR M0.3 §1 row 6), releasing the same
  //               4 barrels.
  //   133 -> 129  WIN-256 adopts `channels` (ADR M0.3 §1 row 7), releasing the
  //               same 4 barrels.
  //   129 -> 125  WIN-256 adopts `governance` (ADR M0.3 §1 row 14), releasing
  //               the same 4 barrels, from a project no slice above touched.
  //
  // Each branch pinned only what its own lineage could see: WIN-297 branched
  // from WIN-256 at 3ed8f3ce, BEFORE the providers commit, so it pinned
  // 182 - 9 = 173; WIN-256's providers tip pinned 178 and never saw the apps;
  // the eventing, skills, jobs, memory, cost-monitoring, privacy, observability,
  // agents, tools and channels branches EACH pinned 165, because each saw the
  // two apps and providers but not the other contexts. 165 is therefore the pin
  // of TEN different trees, and it is correct for none of them merged. The
  // governance branch is the one exception in shape but not in kind: it branched
  // from the agents branch at e602cb0b, so it could see agents' reduction and
  // pinned 165 - 4 = 161 — still partial, because the eventing, skills, jobs,
  // memory, cost-monitoring, privacy, observability, tools and channels
  // reductions were all invisible to it. None of those pins is correct here.
  // 201 - 19 - 4 - 9 - 4 - 4 - 4 - 4 - 4 - 4 - 4 - 4 - 4 - 4 - 4 = 125: nineteen
  // released by slices 1-5, four by providers, nine by the two apps, and four
  // each by the ELEVEN contexts adopted since. That is 165 - 40 read from any of
  // the ten branches that pinned 165, and 161 - 36 read from the governance
  // branch that pinned 161.
  //
  // THAT IS THE WHOLE POINT OF THIS COMMENT. `eventing`, `skills`, `jobs`,
  // `memory`, `cost-monitoring`, `privacy`, `observability`, `agents`, `tools`,
  // `channels` and `governance` move the SAME constant on INDEPENDENT axes, so
  // the reconciliation is arithmetic on every delta and not a choice between
  // green branches. Side-picking 161 would leave the tree with thirty-six
  // unaccounted released placeholders and the canary would be quietly wrong
  // while staying green on each branch alone.
  //
  // THE DELTA IS ALWAYS EXACTLY 4 PER ADOPTION, and that is the property to
  // check rather than the total: adoption releases a project's PLACEHOLDERS and
  // never its scaffolding, so a delta of anything but 4 means a scaffolding
  // file was moved or a fifth placeholder was invented. Written out so a
  // DELETION CANNOT HIDE INSIDE AN ADDITION: fourteen reductions, 76
  // placeholders released, 125 owned outputs left.
  //
  // The generator now owns the same 97 SCAFFOLDING files plus the 28
  // placeholders of the 13 still-unadopted projects (1 context x 4 +
  // 12 adapters x 2). The ONE context still on placeholders is
  // `conversations`. The scaffolding tier is
  // untouched and stays byte-compared: adoption releases only a project's
  // source tree, so every adopted project still owes its generated
  // package.json, tsconfig.json and README.md. The project count is unchanged
  // at 32 for the same reason — adoption releases a project's PLACEHOLDERS,
  // not its scaffolding, so an adopted project keeps three owned outputs and
  // never leaves this set. A drop THERE would mean a project stopped being
  // generated at all, a different event that must not be absorbed silently by
  // this constant. It is also what lets the generator carry apps/core-api's new
  // @nestjs runtime dependencies and its two decorator compiler options, which
  // scaffolding a hand edit could not have added.
  //
  // THIS CANARY IS THE FIRST STEP OF THE ci.yml TYPECHECK JOB, and adopting a
  // context ALWAYS drops the count by exactly 4, so a branch that adopts one
  // and does not reconcile the number here is red before any of its own code is
  // compiled. `tejas/win-256-providers-context` at 25b231b asserted 182 while
  // its own committed evidence recorded 178. The 125 below was READ BACK from a
  // regenerated `docs/audits/win-253-workspace-reachability.json`, not derived
  // from the chain above; the chain is the explanation, the report is the
  // authority, and they agree. Every number here moves with its delta and is
  // never forced, and `pnpm audit:workspace-reachability` is regenerated to a
  // fixpoint beside it.
  //
  // `node scripts/arch/gen-v1-skeleton.mjs --check` prints the same arithmetic
  // from the other side: "97 scaffolding + 28 placeholder = 125 generated
  // file(s) for 32 V1 projects and 95 project edges (19 project(s) adopted,
  // 76 placeholder(s) released)". The two 52s that sentence once carried were the
  // same number by coincidence and are not any more: 28 placeholders REMAIN owned
  // and 76 have been RELEASED.
  assert.equal(report.generatedOwnership.ownedOutputCount, 125);
  assert.equal(report.generatedOwnership.ownedOutputProjectCount, 32);
  assert.equal(report.generatedOwnership.generators.length, 1);
  assert.equal(
    report.generatedOwnership.generators[0].generator,
    "scripts/arch/gen-v1-skeleton.mjs"
  );
  // Same 125 as above, re-derived from the single generator's own output list.
  assert.equal(report.generatedOwnership.generators[0].outputCount, 125);
  assert.match(report.generatedOwnership.generators[0].sha256, /^[a-f0-9]{64}$/);
  for (const project of report.generatedOwnership.ownedOutputProjects) {
    const workspace = report.workspaces.find((entry) => entry.path === project);
    assert.ok(
      workspace.channels.generated.reasons.some(
        (reason) => reason.kind === "generator-owned-output"
      ),
      project
    );
  }
});

test("an explicit generated header, not a generated-looking path, owns generated evidence", () => {
  const root = fixture();
  const file = "apps/ship/src/client.ts";
  // Source the header from a file the generator still OWNS. This previously read
  // packages/kernel/src/index.ts, which WIN-256 adopted out of generator
  // ownership — its first line became real source, so the fixture silently
  // stopped carrying a generated header and the assertion below inverted.
  // CORRECTION, 2026-09-04. This said "one of the 27 projects still
  // generator-owned", which was written when WIN-256 slice 5 had adopted five
  // projects (32 - 5 = 27) and was silently false from the sixth adoption on:
  // 19 projects are adopted here, so 13 still carry generator-owned source. The
  // count is dropped rather than re-pinned because it rots on every adoption
  // and nothing checks it. What the fixture actually needs is the property, and
  // that is asserted: conversations is now the ONLY context still on
  // generator-owned placeholders — governance was the other, and WIN-256
  // adopted it here — so its domain/index.ts still carries the generated
  // header, and the assertion right after this one fails the moment that stops
  // being true.
  const realHeader = fs
    .readFileSync(path.join(ROOT, "packages/contexts/conversations/domain/index.ts"), "utf8")
    .split("\n", 1)[0];
  assert.match(realHeader, /generated by scripts\/arch\/gen-v1-skeleton\.mjs/u,
    "the header fixture must come from a file the generator still owns");
  write(root, file, `${realHeader}\nexport const packageName = "@internal/run-engine";\n`);
  assert.equal(target(buildReachabilityReport(root)).channels.generated.reachable, true);
  write(root, file, 'export const packageName = "@internal/run-engine";\n');
  assert.equal(target(buildReachabilityReport(root)).channels.generated.reachable, false);

  write(
    root,
    "apps/ship/src/generated/client.ts",
    'export const packageName = "@internal/run-engine";\n'
  );
  assert.equal(
    target(buildReachabilityReport(root)).channels.generated.reachable,
    false,
    "generated-looking path must not assert ownership"
  );
});

test("generator-owned output lists require actual files and fail when ownership is hidden", () => {
  const root = fixture();
  const generator = "scripts/arch/gen-v1-skeleton.mjs";
  const owned = "packages/target/owned.txt";
  write(root, owned, "ordinary bytes without a generated header\n");
  write(
    root,
    generator,
    'if (process.argv.includes("--list")) process.stdout.write("packages/target/owned.txt\\n");\n'
  );
  let report = buildReachabilityReport(root);
  assert.equal(report.generatedOwnership.ownedOutputCount, 1);
  assert.equal(target(report).channels.generated.reachable, true);

  fs.rmSync(path.join(root, owned));
  assert.throws(
    () => buildReachabilityReport(root),
    /--list owned output is missing or not a regular in-repository file: packages\/target\/owned\.txt/
  );
  write(root, owned, "ordinary bytes without a generated header\n");

  write(root, generator, 'if (process.argv.includes("--list")) process.stdout.write("");\n');
  report = buildReachabilityReport(root);
  assert.equal(report.generatedOwnership.ownedOutputCount, 0);
  assert.equal(target(report).channels.generated.reachable, false);
});

test("malformed manifest/importer synchronization fails before a verdict can be asserted", () => {
  const root = fixture();
  const appManifest = JSON.parse(
    fs.readFileSync(path.join(root, "apps/ship/package.json"), "utf8")
  );
  appManifest.dependencies = { "@internal/run-engine": "workspace:*" };
  write(root, "apps/ship/package.json", json(appManifest));
  assert.throws(
    () => buildReachabilityReport(root),
    /declares local dependencies.*lockfile importer does not/
  );
});

test("artifact drift fails with expected and actual hashes", () => {
  const root = fixture();
  generateArtifacts(root);
  const artifact = path.join(root, "docs/audits/win-253-workspace-reachability.json");
  fs.appendFileSync(artifact, "drift\n");
  assert.throws(
    () => checkArtifacts(root),
    /artifact drift:[\s\S]*expected [a-f0-9]{64}, actual [a-f0-9]{64}/i
  );
});
