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
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import {
  GENERATED_SDK_ARTIFACTS,
  NON_SHIPPING,
  classifyPath,
  evaluate,
  readPackages,
  repositoryRoot,
} from "./changeset-gate.mjs";
import { FIXTURE_OUTPUT, PYTHON_OUTPUT, TYPESCRIPT_OUTPUT, buildArtifacts } from "./v1-contract.mjs";

const gate = join(repositoryRoot, "scripts", "sdk", "changeset-gate.mjs");
const packages = readPackages("HEAD", repositoryRoot);
const publishable = (list) => list.filter((entry) => !entry.private).map((entry) => entry.name).sort();

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
  assert.equal(classifyPath(GENERATED_SDK_ARTIFACTS[1], packages)?.package.private ?? null, null);
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
  // Every exclusion rule is exercised by at least one path above.
  assert.deepEqual([...reasons].sort(), NON_SHIPPING.map((rule) => rule.reason).sort());
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
