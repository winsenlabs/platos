#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export const WIN254_COMMANDS = Object.freeze([
  ["pnpm", ["audit:docs-link-integrity"]],
  ["pnpm", ["audit:design-provenance"]],
  ["pnpm", ["audit:contract-map"]],
  ["pnpm", ["audit:protected-paths"]],
  ["pnpm", ["audit:evidence-lifecycle"]],
  ["pnpm", ["audit:docs-build"]],
  ["pnpm", ["audit:root-manifest"]],
  ["node", ["--test", "scripts/v1-ledger.test.mjs"]],
  ["pnpm", ["audit:v1-ledger"]],
  ["pnpm", ["test:vocabulary"]],
  ["pnpm", ["audit:vocabulary"]],
  ["pnpm", ["audit:win253-clickhouse-split"]],
  ["pnpm", ["audit:sbom:check"]],
  ["pnpm", ["audit:workspace-reachability"]],
  ["pnpm", ["audit:win253-vendored-build"]],
  ["pnpm", ["audit:advisory:check"]],
]);

export const WIN254_REGENERATION_COMMANDS = Object.freeze([
  Object.freeze({
    name: "vocabulary",
    command: Object.freeze(["node", Object.freeze(["scripts/vocabulary-boundary.mjs", "--write"])]),
  }),
  Object.freeze({
    name: "clickhouse",
    command: Object.freeze(["node", Object.freeze(["scripts/clickhouse-split-audit.mjs", "--write"])]),
  }),
  Object.freeze({
    name: "sbom",
    command: Object.freeze(["node", Object.freeze(["scripts/audit-sbom.mjs", "generate"])]),
  }),
  Object.freeze({
    name: "workspaceReachability",
    command: Object.freeze(["node", Object.freeze(["scripts/workspace-reachability.mjs", "generate"])]),
  }),
  Object.freeze({
    name: "vendoredBuild",
    command: Object.freeze(["node", Object.freeze(["scripts/vendored-build-audit.mjs", "--write"])]),
  }),
  Object.freeze({
    name: "protectedPaths",
    command: Object.freeze(["node", Object.freeze(["scripts/protected-paths.mjs", "write"])]),
  }),
  Object.freeze({
    name: "evidenceLifecycle",
    command: Object.freeze(["node", Object.freeze(["scripts/evidence-lifecycle.mjs", "write"])]),
  }),
]);

export const WIN254_REGENERATION_DEPENDENCIES = Object.freeze({
  vocabulary: Object.freeze([]),
  clickhouse: Object.freeze([]),
  sbom: Object.freeze([]),
  workspaceReachability: Object.freeze(["clickhouse", "sbom"]),
  vendoredBuild: Object.freeze(["workspaceReachability"]),
  protectedPaths: Object.freeze(["vendoredBuild"]),
  evidenceLifecycle: Object.freeze(["protectedPaths"]),
});

export function commandLine([executable, args]) {
  return [executable, ...args].join(" ");
}

export function validateRegenerationOrder(steps = WIN254_REGENERATION_COMMANDS) {
  const names = steps.map((step) => step.name);
  const expectedNames = Object.keys(WIN254_REGENERATION_DEPENDENCIES);
  if (new Set(names).size !== names.length) throw new Error("regeneration order contains duplicate step names");
  if (names.length !== expectedNames.length || expectedNames.some((name) => !names.includes(name))) {
    throw new Error("regeneration order must contain every canonical step exactly once");
  }
  for (const [name, dependencies] of Object.entries(WIN254_REGENERATION_DEPENDENCIES)) {
    const stepIndex = names.indexOf(name);
    for (const dependency of dependencies) {
      if (names.indexOf(dependency) > stepIndex) {
        throw new Error(`regeneration step ${name} must follow dependency ${dependency}`);
      }
    }
  }
  return names;
}

function runCommands(commands, root, run) {
  for (const command of commands) {
    const [executable, args] = command;
    console.log(`WIN-254: ${commandLine(command)}`);
    const result = run(executable, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return { ok: false, command: commandLine(command), status: result.status };
  }
  return { ok: true, commandCount: commands.length };
}

export function verifyWin254(root = repositoryRoot, options = {}) {
  const run = options.spawn ?? spawnSync;
  return runCommands(WIN254_COMMANDS, root, run);
}

export function regenerateWin254(root = repositoryRoot, options = {}) {
  validateRegenerationOrder();
  const run = options.spawn ?? spawnSync;
  return runCommands(
    WIN254_REGENERATION_COMMANDS.map((step) => step.command),
    root,
    run,
  );
}

function main(argv) {
  if (argv.includes("--list")) {
    if (argv.length !== 1) {
      console.error("usage: node scripts/verify-win254.mjs [--list|--regenerate]");
      process.exitCode = 1;
      return;
    }
    for (const command of WIN254_COMMANDS) console.log(commandLine(command));
    return;
  }
  if (argv.includes("--regenerate")) {
    if (argv.length !== 1) {
      console.error("usage: node scripts/verify-win254.mjs [--list|--regenerate]");
      process.exitCode = 1;
      return;
    }
    const result = regenerateWin254(repositoryRoot);
    if (!result.ok) {
      console.error(`WIN-254 regeneration failed at ${result.command} (status ${result.status})`);
      process.exitCode = result.status || 1;
      return;
    }
    console.log(`WIN-254 regeneration passed (${result.commandCount} ordered generators).`);
    return;
  }
  if (argv.length !== 0) {
    console.error("usage: node scripts/verify-win254.mjs [--list|--regenerate]");
    process.exitCode = 1;
    return;
  }
  const result = verifyWin254(repositoryRoot);
  if (!result.ok) {
    console.error(`WIN-254 verification failed at ${result.command} (status ${result.status})`);
    process.exitCode = result.status || 1;
    return;
  }
  console.log(`WIN-254 verification passed (${result.commandCount} composed checks).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
