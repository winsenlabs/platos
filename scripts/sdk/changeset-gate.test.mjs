// THE CHANGESET GATE, PROVEN ABLE TO FAIL.
//
// WIN-270 (M4.4), semver automation; founder decision D15 (version automation, no
// publication). Every case joins the rule to something this file does not
// control:
//
//   the committed package manifests       read at HEAD, not a list written here;
//   Changesets' own workspace discovery    `@manypkg/get-packages`, the library
//                                          `changeset` itself uses, must agree with
//                                          the gate about which packages publish;
//   Changesets' own parser and planner     front matter and the release plan;
//   `scripts/sdk/v1-contract.mjs`          the generated SDK artifacts it writes;
//   real history                           a planted commit in a throwaway worktree
//                                          of this repository, driven through the
//                                          CLI exactly as CI invokes it.

import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  ARCHIVED_CHANGESETS,
  CHANGESET_DIRECTORY,
  GENERATED_SDK_ARTIFACTS,
  GOVERNING_LICENSE,
  NON_SHIPPING,
  PYTHON_SDK_TWINS,
  citedCommits,
  classifyPath,
  evaluate,
  fixtureSurface,
  isLicenseReconciliation,
  pyprojectName,
  readDeletedChangesets,
  readPackages,
  repositoryRoot,
  runGate,
  versionSetAt,
} from "./changeset-gate.mjs";
import { FIXTURE_OUTPUT, PYTHON_OUTPUT, TYPESCRIPT_OUTPUT, buildArtifacts } from "./v1-contract.mjs";

const gate = join(repositoryRoot, "scripts", "sdk", "changeset-gate.mjs");
const packages = readPackages("HEAD", repositoryRoot);
const publishable = (list) => list.filter((entry) => !entry.private && !entry.python).map((entry) => entry.name).sort();

const git = (args, cwd) =>
  execFileSync(
    "git",
    ["-c", "user.name=changeset-gate-test", "-c", "user.email=changeset-gate-test@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

test("the gate's publishable set is the one Changesets itself discovers", async () => {
  const cliRequire = createRequire(createRequire(import.meta.url).resolve("@changesets/cli/package.json"));
  const { getPackages } = cliRequire("@manypkg/get-packages");
  const discovered = await getPackages(repositoryRoot);
  const underGlob = discovered.packages
    .filter((entry) => /^packages\/[^/]+$/u.test(relative(repositoryRoot, entry.dir)))
    .map((entry) => ({ name: entry.packageJson.name, private: entry.packageJson.private === true }));
  assert.deepEqual(publishable(packages), publishable(underGlob));
  assert.ok(publishable(packages).length > 0, "no publishable package found; the inventory is wrong");
  assert.ok(packages.some((entry) => entry.private), "no private package found; the private branch is untested");
});

test("the generated SDK artifacts are the files the generator writes, owned by the TypeScript client", () => {
  const written = Object.keys(buildArtifacts()).map((path) => relative(repositoryRoot, path)).sort();
  assert.deepEqual([...GENERATED_SDK_ARTIFACTS].sort(), written);
  assert.deepEqual(
    GENERATED_SDK_ARTIFACTS,
    [TYPESCRIPT_OUTPUT, PYTHON_OUTPUT, FIXTURE_OUTPUT].map((path) => relative(repositoryRoot, path)),
  );
  assert.equal(classifyPath(GENERATED_SDK_ARTIFACTS[0], packages)?.package.name, "@platosdev/client");
  // The emitted Python client sits in the Python SDK tree, which carries the same npm name.
  const emittedPython = classifyPath(GENERATED_SDK_ARTIFACTS[1], packages)?.package;
  assert.equal(emittedPython?.python, "platos-client");
  assert.equal(emittedPython?.name, "@platosdev/client");
  assert.equal(classifyPath(GENERATED_SDK_ARTIFACTS[2], packages), null, "the shared fixture is in no package");
});

test("a fixture diff confined to its source digests is provenance, and any other fixture change is surface", () => {
  const committed = readFileSync(join(repositoryRoot, GENERATED_SDK_ARTIFACTS[2]), "utf8");
  const parsed = JSON.parse(committed);
  assert.ok(Object.keys(parsed.sourceDigests ?? {}).length > 0, "the fixture no longer records source digests");
  const digestsMoved = { ...parsed, sourceDigests: Object.fromEntries(Object.keys(parsed.sourceDigests).map((key) => [key, "0000000000000000"])) };
  assert.equal(fixtureSurface(JSON.stringify(digestsMoved)), fixtureSurface(committed));
  const surfaceMoved = { ...parsed, operations: parsed.operations.slice(1) };
  assert.notEqual(fixtureSurface(JSON.stringify(surfaceMoved)), fixtureSurface(committed));
  const streamMoved = { ...parsed, stream: { ...parsed.stream, resumeHeader: "x-probe" } };
  assert.notEqual(fixtureSurface(JSON.stringify(streamMoved)), fixtureSurface(committed));
});

test("shipped and test-only paths are told apart, rule by rule", () => {
  const embed = packages.find((entry) => entry.name === "@platosdev/embed");
  assert.ok(embed, "@platosdev/embed is gone; pick another publishable package");
  const at = (path) => classifyPath(`${embed.directory}/${path}`, packages);
  for (const shipped of ["src/embed.ts", "package.json", "README.md", "LICENSE", "tsconfig.json"]) {
    assert.equal(at(shipped).shipping, true, shipped);
  }
  const reasons = new Set();
  for (const testOnly of ["tests/embed.test.ts", "src/__tests__/a.ts", "src/embed.spec.ts", "vitest.config.ts", "CHANGELOG.md"]) {
    const classified = at(testOnly);
    assert.equal(classified.shipping, false, testOnly);
    reasons.add(classified.reason);
  }
  const platoolsPy = (path) => classifyPath(`packages/platools-py/${path}`, packages);
  for (const testOnly of ["requirements-ci.txt", "requirements-ci.in", "tests/test_protocol_fixture.py"]) {
    assert.equal(platoolsPy(testOnly).shipping, false, testOnly);
    reasons.add(platoolsPy(testOnly).reason);
  }
  for (const shipped of ["platools/context.py", "pyproject.toml", "README.md", "requirements.txt"]) {
    assert.equal(platoolsPy(shipped).shipping, true, shipped);
  }
  // Every exclusion rule is exercised by at least one path above.
  assert.deepEqual([...reasons].sort(), NON_SHIPPING.map((rule) => rule.reason).sort());
});

test("the Python SDKs are gated under their npm twins, joined to their pyproject names and to the recorded SDK pairing", () => {
  // Every `packages/*` directory with no npm manifest is a mapped Python SDK or a
  // workspace container, read from the committed tree rather than listed here.
  const directories = git(["ls-tree", "--name-only", "-d", "HEAD", "packages/"], repositoryRoot).split("\n").filter(Boolean);
  const unmanifested = directories.filter((directory) => !packages.some((entry) => entry.directory === directory && !entry.python));
  const containers = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8")
    .split("\n")
    .map((line) => /^\s*-\s*["']?([^"'\s]+)\/\*["']?\s*$/u.exec(line)?.[1])
    .filter((value) => value !== undefined && value.startsWith("packages/") && value !== "packages");
  assert.deepEqual(
    unmanifested.filter((directory) => !containers.includes(directory)).sort(),
    PYTHON_SDK_TWINS.map((entry) => entry.directory).sort(),
  );
  assert.equal(PYTHON_SDK_TWINS.length, 2, "two Python SDKs publish from packages/*");

  // Each maps to the npm package in its twin directory, under the PyPI name its pyproject declares.
  const python = packages.filter((entry) => entry.python);
  for (const { directory, twin } of PYTHON_SDK_TWINS) {
    const entry = python.find((candidate) => candidate.directory === directory);
    const npm = packages.find((candidate) => candidate.directory === twin && !candidate.python);
    assert.ok(entry && npm && !npm.private, directory);
    assert.equal(entry.name, npm.name, directory);
    assert.equal(entry.python, pyprojectName(readFileSync(join(repositoryRoot, directory, "pyproject.toml"), "utf8")));
  }
  assert.deepEqual(python.map((entry) => entry.python).sort(), ["platools", "platos-client"]);
  // The migration guide's version policy names the same two PyPI distributions.
  const guide = readFileSync(join(repositoryRoot, "docs", "sdk-v1-migration.md"), "utf8");
  for (const entry of python) assert.match(guide, new RegExp(`\`${entry.python}\``, "u"), entry.python);

  // The pairing `scripts/capability-matrix.mjs` records lists each Python SDK
  // directly after its TypeScript twin; the map must agree with it.
  const matrix = readFileSync(join(repositoryRoot, "scripts", "capability-matrix.mjs"), "utf8");
  const listed = JSON.parse(/sdkPackages:\s*(\[[^\]]*\])/u.exec(matrix)[1]);
  for (const { directory, twin } of PYTHON_SDK_TWINS) {
    const npmName = packages.find((candidate) => candidate.directory === twin && !candidate.python).name;
    assert.equal(listed[listed.indexOf(directory.split("/")[1]) - 1], npmName, directory);
  }

  // And the rule: a hand-written Python change needs the twin's intent; a test does not.
  const verdict = (path) => evaluate({ changedPaths: [path], packages, changesets: [] }).violations.map((entry) => entry.package);
  assert.deepEqual(verdict("packages/platos-client-py/platos_client/v1_stream.py"), ["@platosdev/client"]);
  assert.deepEqual(verdict("packages/platools-py/platools/context.py"), ["@platosdev/platools-sdk"]);
  assert.deepEqual(verdict("packages/platools-py/tests/test_protocol_fixture.py"), []);
  assert.deepEqual(verdict("packages/platools-py/requirements-ci.txt"), []);
  assert.deepEqual(
    evaluate({
      changedPaths: ["packages/platools-py/platools/context.py"],
      packages,
      changesets: [{ path: ".changeset/a.md", releases: [{ name: "@platosdev/platools-sdk", type: "patch" }], summary: "", cited: [] }],
    }).violations,
    [],
  );
  assert.match(pyprojectName('[tool.x]\nname = "no"\n\n[project]\nversion = "1"\nname = "yes"\n\n[build]\nname = "no"\n'), /^yes$/u);
  assert.equal(pyprojectName('[tool.x]\nname = "no"\n'), null);
});

test("legal metadata reconciled to the governing licence is not version intent, and nothing wider is exempt", () => {
  // The governing SPDX id is the one the licence-distribution gate enforces.
  const distribution = readFileSync(join(repositoryRoot, "scripts", "license-distribution.test.mjs"), "utf8");
  assert.match(distribution, new RegExp(`manifest\\.license !== "${GOVERNING_LICENSE.replace(".", "\\.")}"`, "u"));
  assert.match(readFileSync(join(repositoryRoot, "CHANGESETS.md"), "utf8"), /legal metadata correction does not itself create package-version intent/u);

  const rootLicense = readFileSync(join(repositoryRoot, "LICENSE"));
  const manifest = (fields) => Buffer.from(`${JSON.stringify({ name: "@platos/react-hooks", version: "4.4.4", ...fields }, null, 2)}\n`);
  const at = (path, before, after) => isLicenseReconciliation({ path, before, after, rootLicense, packages });

  assert.equal(at("packages/react-hooks/LICENSE", null, rootLicense), true, "a new LICENSE with the root's bytes");
  assert.equal(at("packages/react-hooks/LICENSE", Buffer.from("MIT"), Buffer.from(`${rootLicense}\n`)), false, "one byte more");
  assert.equal(at("packages/react-hooks/LICENSE", rootLicense, null), false, "a deleted LICENSE");
  assert.equal(at("packages/react-hooks/package.json", manifest({ license: "MIT" }), manifest({ license: GOVERNING_LICENSE })), true);
  assert.equal(
    at("packages/react-hooks/package.json", manifest({ license: GOVERNING_LICENSE }), manifest({ license: "MIT" })),
    false,
    "a licence moved AWAY from the governing one",
  );
  assert.equal(
    at("packages/react-hooks/package.json", manifest({ license: "MIT" }), manifest({ license: GOVERNING_LICENSE, description: "x" })),
    false,
    "the licence plus any other field",
  );
  assert.equal(at("packages/react-hooks/package.json", null, manifest({ license: GOVERNING_LICENSE })), false, "a new manifest");
  assert.equal(at("packages/react-hooks/src/index.ts", null, rootLicense), false, "only LICENSE and package.json");
  assert.equal(at("packages/react-hooks/NOTICE", null, rootLicense), false);
  assert.equal(at("packages/platools-py/LICENSE", null, rootLicense), false, "a Python SDK's LICENSE is not an npm manifest's metadata");
  assert.equal(at("apps/agent/LICENSE", null, rootLicense), false);
});

test("against the frozen oracle, the licence reconciliation asks for no intent (real history)", (t) => {
  const oracle = "89c12b8aa8da75c561dc879f370aaefb6e3359bc";
  try {
    git(["cat-file", "-e", `${oracle}^{commit}`], repositoryRoot);
  } catch {
    t.skip(`the frozen oracle ${oracle.slice(0, 8)} is not in this clone (shallow checkout), so there is no real history to join`);
    return;
  }
  const result = runGate({ base: oracle, root: repositoryRoot });
  for (const path of ["packages/react-hooks/LICENSE", "packages/react-hooks/package.json"]) {
    assert.ok(result.licenseOnly.has(path), `${path} is a licence reconciliation against the oracle`);
    assert.ok(!result.changedPaths.includes(path), path);
  }
  assert.deepEqual(result.violations.filter((entry) => entry.package === "@platos/react-hooks"), []);
});

test("the rule in both directions, over the real package inventory", () => {
  const changeset = (path, names, cited = []) => ({
    path,
    releases: names.map((name) => ({ name, type: "patch" })),
    summary: "",
    cited,
  });

  // CHANGED -> NAMED.
  const unnamed = evaluate({ changedPaths: ["packages/platos-embed/src/embed.ts"], packages, changesets: [] });
  assert.deepEqual(unnamed.violations.map((entry) => [entry.kind, entry.package]), [
    ["changed-without-changeset", "@platosdev/embed"],
  ]);
  assert.deepEqual(
    evaluate({ changedPaths: ["packages/platos-embed/tests/embed.test.ts"], packages, changesets: [] }).violations,
    [],
  );
  assert.deepEqual(
    evaluate({ changedPaths: ["packages/kernel/src/index.ts"], packages, changesets: [] }).violations,
    [],
    "a private package needs no changeset",
  );
  for (const artifact of GENERATED_SDK_ARTIFACTS) {
    const verdict = evaluate({ changedPaths: [artifact], packages, changesets: [] });
    assert.deepEqual(verdict.violations.map((entry) => entry.package), ["@platosdev/client"], artifact);
  }

  // NAMED -> CHANGED.
  assert.deepEqual(
    evaluate({
      changedPaths: ["packages/platos-embed/src/embed.ts"],
      packages,
      changesets: [changeset(".changeset/a.md", ["@platosdev/embed"])],
    }).violations,
    [],
  );
  assert.deepEqual(
    evaluate({
      changedPaths: ["packages/kernel/src/index.ts"],
      packages,
      changesets: [changeset(".changeset/a.md", ["@platos/kernel"])],
    }).violations.map((entry) => entry.kind),
    ["names-non-publishable"],
  );
  assert.deepEqual(
    evaluate({ changedPaths: [], packages, changesets: [changeset(".changeset/a.md", ["@platosdev/not-a-package"])] })
      .violations.map((entry) => entry.kind),
    ["names-non-publishable"],
  );
  assert.deepEqual(
    evaluate({ changedPaths: [], packages, changesets: [changeset(".changeset/a.md", ["@platosdev/token-mint"])] })
      .violations.map((entry) => entry.kind),
    ["names-unchanged"],
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [
        changeset(".changeset/a.md", ["@platosdev/token-mint"], [{ sha: "x", touched: ["packages/platos-embed/src/embed.ts"] }]),
      ],
    }).violations.map((entry) => entry.kind),
    ["names-unchanged"],
    "a citation of a commit that moved ANOTHER package does not count",
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [
        changeset(".changeset/a.md", ["@platosdev/token-mint"], [{ sha: "x", touched: ["packages/platos-token-mint/src/index.ts"] }]),
      ],
    }).violations,
    [],
  );
  // An EDITED changeset's releases that the merge base already declared are carried
  // intent; a new release in it, or a changed bump, is a new claim.
  const carried = (names, carriedSet) => ({ ...changeset(".changeset/old.md", names), carried: new Set(carriedSet) });
  assert.deepEqual(
    evaluate({ changedPaths: [], packages, changesets: [carried(["@platosdev/token-mint"], ["@platosdev/token-mint:patch"])] }).violations,
    [],
  );
  assert.deepEqual(
    evaluate({ changedPaths: [], packages, changesets: [carried(["@platosdev/token-mint"], ["@platosdev/token-mint:minor"])] })
      .violations.map((entry) => entry.kind),
    ["names-unchanged"],
  );
  assert.deepEqual(
    evaluate({ changedPaths: [], packages, changesets: [carried(["@platos/kernel"], ["@platos/kernel:patch"])] })
      .violations.map((entry) => entry.kind),
    ["names-non-publishable"],
    "carried or not, a name that does not publish is refused",
  );

  // A CITATION OLDER THAN THE PACKAGE'S LAST VERSION BUMP IS NOT A REASON TO MOVE THE
  // VERSION AGAIN. Reachability alone used to clear the gate here.
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [
        changeset(".changeset/a.md", ["@platosdev/token-mint"], [
          { sha: "abcdef0123456", touched: ["packages/platos-token-mint/src/index.ts"], staleFor: ["@platosdev/token-mint"] },
        ]),
      ],
    }).violations.map((entry) => entry.kind),
    ["names-released-change"],
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [
        changeset(".changeset/a.md", ["@platosdev/token-mint"], [
          { sha: "abcdef0123456", touched: ["packages/platos-token-mint/src/index.ts"], staleFor: ["@platosdev/token-mint"] },
          { sha: "0123456abcdef", touched: ["packages/platos-token-mint/src/index.ts"], staleFor: [] },
        ]),
      ],
    }).violations,
    [],
    "one live citation is enough, however many stale ones sit beside it",
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [
        changeset(".changeset/a.md", ["@platosdev/token-mint"], [
          { sha: "abcdef0123456", touched: ["packages/platos-embed/src/embed.ts"], staleFor: ["@platosdev/embed"] },
        ]),
      ],
    }).violations.map((entry) => entry.kind),
    ["names-unchanged"],
    "stale for ANOTHER package is still simply not a citation of this one",
  );

  // DELETED -> STILL PENDING.
  const deleted = (names) => ({
    path: ".changeset/dropped.md",
    releases: names.map((name) => ({ name, type: "patch" })),
  });
  assert.deepEqual(
    evaluate({ changedPaths: [], packages, changesets: [], deletedChangesets: [deleted(["@platosdev/token-mint"])] })
      .violations.map((entry) => [entry.kind, entry.package]),
    [["deletes-pending-intent", "@platosdev/token-mint"]],
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [],
      deletedChangesets: [deleted(["@platosdev/token-mint"])],
      versionBumped: new Set(["@platosdev/token-mint"]),
    }).violations,
    [],
    "a version step that SPENDS the intent moves the manifest version in the same diff",
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [],
      deletedChangesets: [{ ...deleted(["@platosdev/token-mint"]), preserved: new Set(["@platosdev/token-mint:patch"]) }],
    }).violations,
    [],
    "an entry kept under the archive CHANGESETS.md names is relocated history, not dropped intent",
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [],
      deletedChangesets: [{ ...deleted(["@platosdev/token-mint"]), preserved: new Set(["@platosdev/token-mint:minor"]) }],
    }).violations.map((entry) => entry.kind),
    ["deletes-pending-intent"],
    "the archived copy has to preserve the same BUMP, not merely the same name",
  );
});

test("the two named->changed leniencies are closed, against real history", () => {
  // `versionSetAt` reads the package's OWN manifest history, so the commit it names is
  // checked against that manifest rather than against a list written here.
  const mint = packages.find((entry) => entry.name === "@platosdev/token-mint" && entry.python === null);
  assert.ok(mint, "@platosdev/token-mint is gone; pick another publishable package");
  const bump = versionSetAt(mint, "HEAD", repositoryRoot);
  assert.match(bump ?? "", /^[0-9a-f]{40}$/u, "no commit in history set this package's version");
  const manifest = `${mint.directory}/package.json`;
  const at = (revision) => JSON.parse(git(["show", `${revision}:${manifest}`], repositoryRoot)).version;
  let parent = null;
  try {
    parent = git(["rev-parse", "--verify", "--quiet", `${bump}^1`], repositoryRoot).trim();
  } catch {
    parent = null;
  }
  if (parent === null) {
    // A ROOT COMMIT counts: the version it introduced is the one it set. This
    // repository's import squashed its pre-V1 history, so several manifests are of
    // that shape and the rule has to say what it means for them.
    assert.equal(
      git(["log", "--max-count=1", "--diff-filter=A", "--format=%H", bump, "--", manifest], repositoryRoot).trim(),
      bump,
      "versionSetAt named a parentless commit that did not add the manifest",
    );
  } else {
    assert.notEqual(at(bump), at(parent), "versionSetAt named a commit that did not move the version");
  }
  assert.equal(
    at(bump),
    JSON.parse(readFileSync(join(repositoryRoot, manifest), "utf8")).version,
    "versionSetAt must name the commit that set the CURRENT version",
  );

  // A commit at or before that bump is stale for this package.
  const older = git(["log", "-1", "--format=%H", bump, "--", `${mint.directory}/src`], repositoryRoot).trim();
  assert.match(older, /^[0-9a-f]{40}$/u);
  const staleCite = citedCommits(`Records ${older.slice(0, 10)}.`, "HEAD", repositoryRoot, packages);
  assert.equal(staleCite.length, 1, "the planted hash did not resolve");
  assert.ok(
    staleCite[0].staleFor.includes("@platosdev/token-mint"),
    `${older.slice(0, 10)} is at or before ${bump.slice(0, 10)} and must be stale for the package it touched`,
  );
  assert.deepEqual(
    evaluate({
      changedPaths: [],
      packages,
      changesets: [
        { path: ".changeset/a.md", releases: [{ name: "@platosdev/token-mint", type: "patch" }], summary: "", cited: staleCite },
      ],
    }).violations.map((entry) => entry.kind),
    ["names-released-change"],
    "the gate passed on exactly this citation before the rule existed",
  );

  // THE ARCHIVE CARVE-OUT IS MEASURED AGAINST THE TREE, not asserted: the entry the
  // frozen oracle still carries is the one this repository moved into history, and the
  // comparison is by declared release because `generate:evidence-lifecycle` stamps
  // front matter onto everything under `docs/`.
  const oracle = "89c12b8aa8da75c561dc879f370aaefb6e3359bc";
  let haveOracle = true;
  try {
    git(["cat-file", "-e", `${oracle}^{commit}`], repositoryRoot);
  } catch {
    haveOracle = false;
  }
  if (haveOracle) {
    const mergeBase = git(["merge-base", oracle, "HEAD"], repositoryRoot).trim();
    // The names come from the ARCHIVE ITSELF, never written here: a literal naming a
    // path this repository removed is exactly what `audit:root-manifest` refuses.
    const archived = git(["ls-tree", "--name-only", "HEAD", `${ARCHIVED_CHANGESETS}/`], repositoryRoot)
      .split("\n")
      .filter(Boolean)
      .map((path) => path.slice(ARCHIVED_CHANGESETS.length + 1))
      .filter((name) => name.endsWith(".md") && name !== "README.md");
    assert.ok(archived.length > 0, `nothing is archived under ${ARCHIVED_CHANGESETS}/`);
    const rows = archived.map((name) => ({ status: "D", path: `${CHANGESET_DIRECTORY}/${name}` }));
    const dropped = readDeletedChangesets(rows, mergeBase, "HEAD", repositoryRoot);
    assert.ok(dropped.length > 0, "none of the archived entries existed at the merge base");
    for (const entry of dropped) {
      assert.ok(entry.releases.length > 0, `${entry.path} declared no release at the merge base`);
      for (const release of entry.releases) {
        assert.ok(
          entry.preserved.has(`${release.name}:${release.type}`),
          `${entry.path}: ${release.name}:${release.type} is not preserved under ${ARCHIVED_CHANGESETS}/`,
        );
      }
    }
    // And the whole run is clean: no archived relocation is reported as a drop.
    assert.deepEqual(
      runGate({ base: oracle, root: repositoryRoot }).violations.filter((entry) => entry.kind === "deletes-pending-intent"),
      [],
    );
  }
  // And the carve-out is not a blanket pass: a live entry has no archived twin.
  const live = readDeletedChangesets(
    [{ status: "D", path: ".changeset/platools-sdk-tenancy-id-docs.md" }],
    "HEAD",
    "HEAD",
    repositoryRoot,
  );
  assert.equal(live.length, 1);
  assert.ok(live[0].releases.length > 0);
  assert.equal(live[0].preserved.size, 0);
});

test("a licence reconciliation in a real worktree needs no changeset, and a licence change of any other shape does", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "platos-changeset-gate-legal-"));
  const worktree = join(directory, "tree");
  git(["worktree", "add", "--detach", worktree, "HEAD"], repositoryRoot);
  t.after(() => {
    git(["worktree", "remove", "--force", worktree], repositoryRoot);
    rmSync(directory, { recursive: true, force: true });
  });
  const runHere = () =>
    spawnSync(process.execPath, [gate, "--root", worktree, "--base", "HEAD~1"], { cwd: worktree, encoding: "utf8" });
  const commit = (message) => {
    git(["add", "-A"], worktree);
    git(["commit", "-q", "-m", message], worktree);
  };
  const manifestPath = join(worktree, "packages", "platos-embed", "package.json");
  const licensePath = join(worktree, "packages", "platos-embed", "LICENSE");
  const original = readFileSync(manifestPath, "utf8");
  const governing = readFileSync(licensePath);
  assert.ok(governing.equals(readFileSync(join(worktree, "LICENSE"))), "the planted package starts on the root LICENSE");

  // The BASE: the package as it was before the reconciliation (an MIT manifest and licence).
  writeFileSync(manifestPath, original.replace(`"license": "${GOVERNING_LICENSE}"`, '"license": "MIT"'));
  writeFileSync(licensePath, "MIT License\n\nPermission is hereby granted, free of charge.\n");
  commit("base: an MIT package");

  // The reconciliation alone: exempt.
  writeFileSync(manifestPath, original);
  writeFileSync(licensePath, governing);
  commit("reconcile to the governing licence");
  const reconciled = runHere();
  assert.equal(reconciled.status, 0, reconciled.stderr);
  assert.match(reconciled.stderr, /packages\/platos-embed\/LICENSE: reconciled to the governing Apache-2\.0 licence metadata/u);
  assert.match(reconciled.stderr, /packages\/platos-embed\/package\.json: reconciled to the governing Apache-2\.0 licence metadata/u);

  // The same commit with one more manifest field: the manifest needs intent.
  writeFileSync(manifestPath, original.replace('"name": "@platosdev/embed"', '"name": "@platosdev/embed",\n  "sideEffects": false'));
  git(["add", "-A"], worktree);
  git(["commit", "-q", "--amend", "--no-edit"], worktree);
  const widened = runHere();
  assert.equal(widened.status, 1, widened.stderr);
  assert.match(widened.stderr, /@platosdev\/embed changed without a changeset naming it: packages\/platos-embed\/package\.json/u);

  // A LICENSE that is not the root's bytes: needs intent.
  writeFileSync(manifestPath, original);
  writeFileSync(licensePath, Buffer.concat([governing, Buffer.from("\nAdditional terms.\n")]));
  git(["add", "-A"], worktree);
  git(["commit", "-q", "--amend", "--no-edit"], worktree);
  const otherText = runHere();
  assert.equal(otherText.status, 1, otherText.stderr);
  assert.match(otherText.stderr, /@platosdev\/embed changed without a changeset naming it: packages\/platos-embed\/LICENSE/u);
});

test("a planted change in a real worktree fires the CLI, and version intent clears it", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "platos-changeset-gate-"));
  const worktree = join(directory, "tree");
  git(["worktree", "add", "--detach", worktree, "HEAD"], repositoryRoot);
  t.after(() => {
    git(["worktree", "remove", "--force", worktree], repositoryRoot);
    rmSync(directory, { recursive: true, force: true });
  });

  // THE REPOSITORY'S OWN GATE, POINTED AT THE WORKTREE. It resolves Changesets
  // from this checkout, so the worktree needs no install.
  const runHere = (...extra) =>
    spawnSync(process.execPath, [gate, "--root", worktree, "--base", "HEAD~1", ...extra], {
      cwd: worktree,
      encoding: "utf8",
    });
  const commit = (message) => {
    git(["add", "-A"], worktree);
    git(["commit", "-q", "-m", message], worktree);
  };

  appendFileSync(join(worktree, "packages", "platos-embed", "src", "embed.ts"), "\n// planted by changeset-gate.test.mjs\n");
  commit("plant a shipped change with no changeset");
  const planted = runHere();
  assert.equal(planted.status, 1, planted.stderr);
  assert.match(planted.stderr, /@platosdev\/embed changed without a changeset naming it: packages\/platos-embed\/src\/embed\.ts/u);

  mkdirSync(join(worktree, ".changeset"), { recursive: true });
  writeFileSync(join(worktree, ".changeset", "gate-test-embed.md"), '---\n"@platosdev/embed": patch\n---\n\nPlanted.\n');
  git(["add", "-A"], worktree);
  git(["commit", "-q", "--amend", "--no-edit"], worktree);
  const cleared = runHere("--release-plan");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.match(cleared.stderr, /plan @platosdev\/embed \d+\.\d+\.\d+ -> \d+\.\d+\.\d+ \(patch\)/u);

  writeFileSync(join(worktree, "packages", "platos-client-py", "platos_client", "generated", "v1.py"), "# planted\n", { flag: "a" });
  commit("plant a generated Python client change");
  const generated = runHere();
  assert.equal(generated.status, 1, generated.stderr);
  assert.match(generated.stderr, /@platosdev\/client changed without a changeset naming it: packages\/platos-client-py\/platos_client\/generated\/v1\.py/u);

  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  const fixturePath = join(worktree, "tests", "sdk-contract", "v1-fixtures.json");
  const provenance = JSON.parse(readFileSync(fixturePath, "utf8"));
  const firstInput = Object.keys(provenance.sourceDigests)[0];
  provenance.sourceDigests[firstInput] = "ffffffffffffffff";
  writeFileSync(fixturePath, `${JSON.stringify(provenance, null, 2)}\n`);
  commit("move only the fixture's provenance digests");
  const digestOnly = runHere();
  assert.equal(digestOnly.status, 0, digestOnly.stderr);
  assert.match(digestOnly.stderr, /only its sourceDigests moved/u);

  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  writeFileSync(join(worktree, ".changeset", "gate-test-kernel.md"), '---\n"@platos/kernel": patch\n---\n\nPrivate.\n');
  commit("a changeset naming a private package");
  const privateName = runHere();
  assert.equal(privateName.status, 1, privateName.stderr);
  assert.match(privateName.stderr, /names @platos\/kernel, which is not a current non-private packages\/\* package/u);

  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  writeFileSync(join(worktree, ".changeset", "gate-test-mint.md"), '---\n"@platosdev/token-mint": patch\n---\n\nNothing changed.\n');
  commit("a changeset naming an unchanged package");
  const unchanged = runHere();
  assert.equal(unchanged.status, 1, unchanged.stderr);
  assert.match(unchanged.stderr, /names @platosdev\/token-mint, but nothing @platosdev\/token-mint ships changed/u);

  const earlier = git(["log", "-1", "--format=%H", "--", "packages/platos-token-mint/src/index.ts"], repositoryRoot).trim();
  assert.match(earlier, /^[0-9a-f]{40}$/u);
  writeFileSync(join(worktree, ".changeset", "gate-test-mint.md"), `---\n"@platosdev/token-mint": patch\n---\n\nRecords ${earlier.slice(0, 8)}.\n`);
  git(["add", "-A"], worktree);
  git(["commit", "-q", "--amend", "--no-edit"], worktree);
  const cited = runHere();
  assert.equal(cited.status, 0, cited.stderr);

  const noBase = spawnSync(process.execPath, [gate, "--root", worktree, "--base", ""], { cwd: worktree, encoding: "utf8" });
  assert.equal(noBase.status, 2, noBase.stderr);
  assert.match(noBase.stderr, /refuses to compare against nothing/u);

  // THE PYTHON SDK TREES ARE GATED. Before the twin map, both of these exited 0.
  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  appendFileSync(join(worktree, "packages", "platos-client-py", "platos_client", "v1_stream.py"), "\n# planted by changeset-gate.test.mjs\n");
  commit("plant a hand-written Python client change");
  const pythonClient = runHere();
  assert.equal(pythonClient.status, 1, pythonClient.stderr);
  assert.match(pythonClient.stderr, /@platosdev\/client changed without a changeset naming it: packages\/platos-client-py\/platos_client\/v1_stream\.py/u);
  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  appendFileSync(join(worktree, "packages", "platools-py", "platools", "context.py"), "\n# planted by changeset-gate.test.mjs\n");
  commit("plant a platools Python change");
  const platoolsPy = runHere();
  assert.equal(platoolsPy.status, 1, platoolsPy.stderr);
  assert.match(platoolsPy.stderr, /@platosdev\/platools-sdk changed without a changeset naming it: packages\/platools-py\/platools\/context\.py/u);

  // DELETING PENDING INTENT IS REFUSED. Before this rule the gate skipped every
  // deleted changeset, so a diff could remove a recorded release and exit 0.
  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  const pending = join(worktree, ".changeset", "platos-client-post-retry-guard.md");
  const pendingSource = readFileSync(pending, "utf8");
  assert.match(pendingSource, /@platosdev\/client/u, "the entry this case deletes no longer names the client");
  rmSync(pending);
  commit("delete a pending changeset");
  const dropped = runHere();
  assert.equal(dropped.status, 1, dropped.stderr);
  assert.match(
    dropped.stderr,
    /\.changeset\/platos-client-post-retry-guard\.md is deleted, and it declared pending \w+ intent for @platosdev\/client/u,
  );
  // The same deletion passes once the package's own version moves, which is what a
  // version step that SPENDS the entry does.
  const clientManifest = join(worktree, "packages", "platos-client", "package.json");
  const manifestSource = JSON.parse(readFileSync(clientManifest, "utf8"));
  writeFileSync(clientManifest, `${JSON.stringify({ ...manifestSource, version: `${manifestSource.version}-planted.1` }, null, 2)}\n`);
  writeFileSync(join(worktree, ".changeset", "gate-test-client.md"), '---\n"@platosdev/client": patch\n---\n\nPlanted.\n');
  git(["add", "-A"], worktree);
  git(["commit", "-q", "--amend", "--no-edit"], worktree);
  const spent = runHere();
  assert.equal(spent.status, 0, spent.stderr);
  assert.match(spent.stderr, /deleted \.changeset\/platos-client-post-retry-guard\.md, which declared @platosdev\/client:/u);

  // A THIRD packages/* directory with no npm manifest is a refusal, not a pass.
  git(["reset", "-q", "--hard", "HEAD~1"], worktree);
  mkdirSync(join(worktree, "packages", "planted-py"), { recursive: true });
  writeFileSync(join(worktree, "packages", "planted-py", "pyproject.toml"), '[project]\nname = "planted"\n');
  commit("plant an unmapped Python SDK");
  const unmapped = runHere();
  assert.equal(unmapped.status, 2, unmapped.stderr);
  assert.match(unmapped.stderr, /packages\/planted-py has no package\.json and is not a Python SDK in PYTHON_SDK_TWINS/u);
  git(["reset", "-q", "--hard", "HEAD~1"], worktree);

  // INVOKED THROUGH A SYMLINK, the gate still runs. A string comparison of
  // `process.argv[1]` with `import.meta.url` skipped `runCli()` under macOS's
  // `/tmp -> /private/tmp` and exited 0 having checked nothing.
  const link = join(directory, "linked-checkout");
  symlinkSync(repositoryRoot, link);
  const linked = spawnSync(
    process.execPath,
    [join(link, "scripts", "sdk", "changeset-gate.mjs"), "--root", worktree, "--base", "HEAD~1"],
    { cwd: worktree, encoding: "utf8" },
  );
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stderr, /\[changeset-gate\] ok:/u);
});
