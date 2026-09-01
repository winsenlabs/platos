import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { auditHookPolicy, policyViolations } from "./hook-policy.mjs";

const repositoryRoot = join(import.meta.dirname, "..");
const localBin = join(repositoryRoot, "node_modules", ".bin");
const lefthook = join(localBin, "lefthook");
const temporaryRoots = [];
test.after(() => temporaryRoots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function git(root, args, options = {}) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
}

function fixture(branch = "work") {
  const root = mkdtempSync(join(tmpdir(), "platos-hook-policy-"));
  temporaryRoots.push(root);
  execFileSync("git", ["init", "-q", "-b", branch], { cwd: root });
  execFileSync("git", ["config", "user.name", "Hook Policy Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "hook-policy@example.invalid"], { cwd: root });
  copyFileSync(join(repositoryRoot, "lefthook.yml"), join(root, "lefthook.yml"));
  writeFileSync(join(root, "policy.txt"), "baseline\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: root, env: { ...process.env, PATH: `${localBin}${delimiter}${process.env.PATH}` } });
  const install = spawnSync(lefthook, ["install", "-f"], { cwd: root, encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  return root;
}

function stageChange(root, text) {
  writeFileSync(join(root, "policy.txt"), `${text}\n`);
  execFileSync("git", ["add", "policy.txt"], { cwd: root });
}

function protectedCommit(ref) {
  const root = fixture();
  execFileSync("git", ["branch", "-M", ref], { cwd: root });
  stageChange(root, ref);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const staged = execFileSync("git", ["rev-parse", ":policy.txt"], { cwd: root, encoding: "utf8" }).trim();
  const result = git(root, ["commit", "-m", `blocked ${ref}`], { env: { ...process.env, PATH: `${localBin}${delimiter}${process.env.PATH}` } });
  assert.notEqual(result.status, 0, `${ref} commit unexpectedly succeeded`);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["rev-parse", ":policy.txt"], { cwd: root, encoding: "utf8" }).trim(), staged);
  assert.match(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: root, encoding: "utf8" }), /^policy\.txt$/mu);
}

test("committed hook policy and pinned local runtime validate", () => {
  assert.deepEqual(auditHookPolicy(repositoryRoot), []);
});

test("main commit fails without moving HEAD or consuming staged content", () => protectedCommit("main"));
test("v1 commit fails without moving HEAD or consuming staged content", () => protectedCommit("v1"));

test("an allowed branch commit succeeds", () => {
  const root = fixture("feature/win-252");
  stageChange(root, "allowed");
  const result = git(root, ["commit", "-m", "allowed"], { env: { ...process.env, PATH: `${localBin}${delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }), "");
});

test("a protected commit fails when the Lefthook runtime is hidden", () => {
  const root = fixture();
  execFileSync("git", ["branch", "-M", "main"], { cwd: root });
  stageChange(root, "hidden-runtime");
  const result = git(root, ["commit", "-m", "hidden runtime"], { env: { ...process.env, PATH: "/usr/bin:/bin" } });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /lefthook|not found|not installed/iu);
});

test("--no-verify bypasses the local hook and is therefore not authorization", () => {
  const root = fixture();
  execFileSync("git", ["branch", "-M", "main"], { cwd: root });
  stageChange(root, "documented-bypass");
  const result = git(root, ["commit", "--no-verify", "-m", "local bypass evidence"], { env: { ...process.env, PATH: `${localBin}${delimiter}${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
});

test("policy mutations removing v1, changing the exit, or removing assert turn red", () => {
  const config = readFileSync(join(repositoryRoot, "lefthook.yml"), "utf8");
  const manifest = readFileSync(join(repositoryRoot, "package.json"), "utf8");
  const controls = [
    [config.replace("    - ref: v1\n", ""), "exactly main then v1"],
    [config.replace("run: exit 1", "run: exit 0"), "single exact failing command exit 1"],
    [config.replace("assert_lefthook_installed: true\n\n", ""), "assert_lefthook_installed must be exactly true"],
  ];
  for (const [mutation, expected] of controls) {
    assert.notEqual(mutation, config);
    assert.ok(policyViolations(mutation, manifest).some((violation) => violation.includes(expected)));
  }
});
