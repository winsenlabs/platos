#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const PROTECTED_REFS = ["main", "v1"];
export const LEFTHOOK_VERSION = "1.11.3";

export function policyViolations(configSource, packageSource) {
  const violations = [];
  const document = parseDocument(configSource, { uniqueKeys: true, prettyErrors: false });
  if (document.errors.length) return ["lefthook.yml must remain valid uniquely-keyed YAML"];
  const config = document.toJS();
  if (config?.assert_lefthook_installed !== true) violations.push("assert_lefthook_installed must be exactly true");
  const preCommit = config?.["pre-commit"];
  const refs = Array.isArray(preCommit?.only) ? preCommit.only.map((condition) => condition?.ref) : [];
  if (JSON.stringify(refs) !== JSON.stringify(PROTECTED_REFS) || new Set(refs).size !== PROTECTED_REFS.length) {
    violations.push("pre-commit refs must be unique and exactly main then v1");
  }
  const jobs = Array.isArray(preCommit?.jobs) ? preCommit.jobs : [];
  if (jobs.length !== 1 || jobs[0]?.run !== "exit 1") violations.push("protected-ref job must be the single exact failing command exit 1");
  if (preCommit?.skip !== undefined || jobs.some((job) => job?.skip !== undefined || job?.only !== undefined)) {
    violations.push("protected-ref hook must not add skip or per-job reachability conditions");
  }
  let manifest = {};
  try { manifest = JSON.parse(packageSource); }
  catch { violations.push("package.json must remain valid JSON"); }
  if (manifest.devDependencies?.lefthook !== LEFTHOOK_VERSION) violations.push(`package.json must pin local Lefthook exactly ${LEFTHOOK_VERSION}`);
  return violations;
}

export function localRuntimeViolations(root = repositoryRoot) {
  const executable = join(root, "node_modules", ".bin", "lefthook");
  const result = spawnSync(executable, ["version"], { cwd: root, encoding: "utf8" });
  if (result.error) return [`local Lefthook runtime is unavailable: ${result.error.message}`];
  if (result.status !== 0) return [`local Lefthook version check exited ${result.status}`];
  if (result.stdout.trim() !== LEFTHOOK_VERSION) return [`local Lefthook must resolve to ${LEFTHOOK_VERSION}, received ${result.stdout.trim()}`];
  return [];
}

export function auditHookPolicy(root = repositoryRoot) {
  return [
    ...policyViolations(readFileSync(join(root, "lefthook.yml"), "utf8"), readFileSync(join(root, "package.json"), "utf8")),
    ...localRuntimeViolations(root),
  ];
}

function main() {
  const violations = auditHookPolicy();
  if (violations.length) {
    process.stderr.write(`hook-policy: FAIL\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`hook-policy: exact protected refs ${PROTECTED_REFS.join(", ")}; pinned local Lefthook ${LEFTHOOK_VERSION}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
