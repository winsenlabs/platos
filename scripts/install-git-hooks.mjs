#!/usr/bin/env node
// Repository-owned fail-closed Lefthook installation for package.json prepare.

import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const LINKED_WORKTREE_OPT_OUT = "PLATOS_SKIP_GIT_HOOKS_IN_LINKED_WORKTREE";

function metadataPath(root, value) {
  const trimmed = value.trim();
  return resolve(root, isAbsolute(trimmed) ? trimmed : trimmed);
}

function gitPath(root, argument, runGit) {
  const result = runGit("git", ["rev-parse", argument], { cwd: root, encoding: "utf8" });
  if (result.error) throw new Error(`cannot inspect Git metadata: ${result.error.message}`);
  if (result.status !== 0 || typeof result.stdout !== "string" || result.stdout.trim() === "") {
    throw new Error(`Git metadata exists but git rev-parse ${argument} failed`);
  }
  return metadataPath(root, result.stdout);
}

export function inspectGitMetadata(root, runGit = spawnSync) {
  const dotGit = join(root, ".git");
  let metadata;
  try {
    metadata = lstatSync(dotGit);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "absent" };
    throw new Error(`cannot inspect .git metadata: ${error.message}`);
  }

  let declaredGitDir = null;
  if (metadata.isFile()) {
    const content = readFileSync(dotGit, "utf8");
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(content);
    if (!match) throw new Error("malformed .git file; expected exactly one gitdir: path");
    declaredGitDir = metadataPath(root, match[1]);
    try {
      if (!statSync(declaredGitDir).isDirectory()) throw new Error("target is not a directory");
    } catch (error) {
      throw new Error(`malformed .git file; gitdir target is unavailable: ${error.message}`);
    }
  } else if (!metadata.isDirectory()) {
    throw new Error("malformed .git metadata; expected a directory or gitdir file");
  }

  const gitDir = gitPath(root, "--git-dir", runGit);
  const commonDir = gitPath(root, "--git-common-dir", runGit);
  if (declaredGitDir !== null && resolve(declaredGitDir) !== resolve(gitDir)) {
    throw new Error("malformed .git file; declared gitdir disagrees with git rev-parse");
  }
  return { kind: gitDir === commonDir ? "repository" : "linked-worktree", gitDir, commonDir };
}

export function installGitHooks(options = {}) {
  const root = options.root ?? repositoryRoot;
  const env = options.env ?? process.env;
  const runGit = options.runGit ?? spawnSync;
  const runLefthook = options.runLefthook ?? spawnSync;
  const executable = options.executable ?? join(root, "node_modules", ".bin", "lefthook");
  const metadata = inspectGitMetadata(root, runGit);

  if (metadata.kind === "absent") {
    return { installed: false, reason: "git-metadata-absent" };
  }

  const optOut = env[LINKED_WORKTREE_OPT_OUT];
  if (optOut !== undefined && optOut !== "1") {
    throw new Error(`${LINKED_WORKTREE_OPT_OUT} must be exactly 1 when used`);
  }
  if (optOut === "1") {
    if (metadata.kind !== "linked-worktree") {
      throw new Error(`${LINKED_WORKTREE_OPT_OUT}=1 is valid only in a genuine linked worktree`);
    }
    return { installed: false, reason: "linked-worktree-opt-out" };
  }

  try {
    accessSync(executable, constants.X_OK);
  } catch (error) {
    throw new Error(`lefthook executable is missing or not executable at node_modules/.bin/lefthook: ${error.message}`);
  }

  const result = runLefthook(executable, ["install"], { cwd: root, stdio: "inherit" });
  if (result.error) throw new Error(`lefthook install failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`lefthook install exited with status ${result.status ?? "unknown"}`);
  return { installed: true, reason: "installed" };
}

function main() {
  try {
    const result = installGitHooks();
    if (result.installed) process.stdout.write("installed Git hooks with lefthook install\n");
    else if (result.reason === "git-metadata-absent") process.stdout.write("skipped Git hooks: Git metadata is genuinely absent\n");
    else process.stdout.write(`skipped Git hooks: ${LINKED_WORKTREE_OPT_OUT}=1 in a linked worktree\n`);
  } catch (error) {
    process.stderr.write(`install-git-hooks: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
