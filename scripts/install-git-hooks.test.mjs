import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LINKED_WORKTREE_OPT_OUT,
  inspectGitMetadata,
  installGitHooks,
} from "./install-git-hooks.mjs";

const temporaryRoots = [];

test.afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "platos-install-git-hooks-"));
  temporaryRoots.push(root);
  return root;
}

function executableAt(root) {
  const executable = join(root, "node_modules", ".bin", "lefthook");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  chmodSync(executable, 0o755);
  return executable;
}

function repositoryFixture({ linked = false } = {}) {
  const root = temporaryRoot();
  const gitDir = linked ? join(root, ".git-worktree") : join(root, ".git");
  const commonDir = linked ? join(root, ".git-common") : gitDir;
  mkdirSync(gitDir);
  if (linked) {
    mkdirSync(commonDir);
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
  }
  const gitCalls = [];
  const runGit = (command, args, options) => {
    gitCalls.push({ command, args, options });
    const value = args[1] === "--git-dir" ? gitDir : commonDir;
    return { status: 0, stdout: `${value}\n` };
  };
  return { root, gitDir, commonDir, gitCalls, runGit };
}

test("genuine Git metadata absence skips installation", () => {
  const root = temporaryRoot();
  let called = false;
  const result = installGitHooks({
    root,
    env: {},
    runGit() {
      called = true;
      throw new Error("Git must not run when .git is absent");
    },
    runLefthook() {
      called = true;
      throw new Error("Lefthook must not run when .git is absent");
    },
  });
  assert.deepEqual(result, { installed: false, reason: "git-metadata-absent" });
  assert.equal(called, false);
});

test("malformed .git metadata fails closed", () => {
  const root = temporaryRoot();
  writeFileSync(join(root, ".git"), "gitdir: one\ngitdir: two\n");
  assert.throws(
    () => inspectGitMetadata(root),
    /malformed \.git file; expected exactly one gitdir: path/u,
  );
});

test("missing Lefthook executable fails closed", () => {
  const fixture = repositoryFixture();
  assert.throws(
    () => installGitHooks({ root: fixture.root, env: {}, runGit: fixture.runGit }),
    /lefthook executable is missing or not executable/u,
  );
});

test("non-executable Lefthook path fails closed", () => {
  const fixture = repositoryFixture();
  const executable = executableAt(fixture.root);
  chmodSync(executable, 0o644);
  assert.throws(
    () => installGitHooks({ root: fixture.root, env: {}, runGit: fixture.runGit }),
    /lefthook executable is missing or not executable/u,
  );
});

test("nonzero Lefthook exit fails closed", () => {
  const fixture = repositoryFixture();
  executableAt(fixture.root);
  assert.throws(
    () =>
      installGitHooks({
        root: fixture.root,
        env: {},
        runGit: fixture.runGit,
        runLefthook: () => ({ status: 17 }),
      }),
    /lefthook install exited with status 17/u,
  );
});

test("Lefthook spawn errors fail closed", () => {
  const fixture = repositoryFixture();
  executableAt(fixture.root);
  assert.throws(
    () =>
      installGitHooks({
        root: fixture.root,
        env: {},
        runGit: fixture.runGit,
        runLefthook: () => ({ error: new Error("spawn denied"), status: null }),
      }),
    /lefthook install failed to start: spawn denied/u,
  );
});

test("installer invokes only the local Lefthook executable with install", () => {
  const fixture = repositoryFixture();
  const executable = executableAt(fixture.root);
  const calls = [];
  const result = installGitHooks({
    root: fixture.root,
    env: {},
    runGit: fixture.runGit,
    runLefthook(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { installed: true, reason: "installed" });
  assert.deepEqual(calls, [
    {
      command: executable,
      args: ["install"],
      options: { cwd: fixture.root, stdio: "inherit" },
    },
  ]);
  assert.deepEqual(
    fixture.gitCalls.map(({ command, args }) => ({ command, args })),
    [
      { command: "git", args: ["rev-parse", "--git-dir"] },
      { command: "git", args: ["rev-parse", "--git-common-dir"] },
    ],
  );
});

test("linked-worktree opt-out skips only a genuine linked worktree", () => {
  const fixture = repositoryFixture({ linked: true });
  let lefthookCalled = false;
  assert.deepEqual(inspectGitMetadata(fixture.root, fixture.runGit), {
    kind: "linked-worktree",
    gitDir: fixture.gitDir,
    commonDir: fixture.commonDir,
  });
  const result = installGitHooks({
    root: fixture.root,
    env: { [LINKED_WORKTREE_OPT_OUT]: "1" },
    runGit: fixture.runGit,
    runLefthook() {
      lefthookCalled = true;
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { installed: false, reason: "linked-worktree-opt-out" });
  assert.equal(lefthookCalled, false);
});

test("linked-worktree opt-out on a normal repository fails closed", () => {
  const fixture = repositoryFixture();
  assert.throws(
    () =>
      installGitHooks({
        root: fixture.root,
        env: { [LINKED_WORKTREE_OPT_OUT]: "1" },
        runGit: fixture.runGit,
      }),
    /valid only in a genuine linked worktree/u,
  );
});

test("any linked-worktree opt-out value other than 1 fails closed", () => {
  const fixture = repositoryFixture({ linked: true });
  assert.throws(
    () =>
      installGitHooks({
        root: fixture.root,
        env: { [LINKED_WORKTREE_OPT_OUT]: "true" },
        runGit: fixture.runGit,
      }),
    /must be exactly 1 when used/u,
  );
});
