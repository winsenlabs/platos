#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// deploy-bundle-closure.mjs — keep a `pnpm deploy --legacy` bundle to the
// production closure of the ONE importer it deploys, and prove the result
// against pnpm-lock.yaml.
//
// WHY A BUNDLE NEEDS THIS. `pnpm deploy --legacy` runs a recursive install over
// the workspace, and pnpm's recursive install ALWAYS adds the workspace root as
// an `install` mutation when the root is not among the selected projects
// (pnpm 10.23.0, plugin-commands-installation `recursive`). The deploy also
// points the install's modules directory at the deploy target for every
// importer, so the root manifest's `dependencies` land in the bundle beside the
// deployed package's. Measured on this lockfile before this script existed: the
// core-api bundle held 619 packages where its lockfile production closure has
// 326, and 262 of the extra packages are the closure of the root manifest's
// three dependencies (the changesets CLI with prettier 2, agentcrumbs,
// node-fetch). Nothing in the deployed process imports any of them.
//
// Removing the root's dependencies from the manifest is not the fix: the
// webapp image ships them on purpose (docs/audits/M0.5-dependency-sbom.md), and
// the non-legacy deploy needs `inject-workspace-packages=true`, a lockfile
// setting that changes how every workspace package installs.
//
// TWO SUBCOMMANDS, AND THEY ARE DELIBERATELY NOT ONE.
//
//   prune --bundle <dir>
//     Deletes every virtual-store entry that is not reachable from the bundle's
//     own package.json production dependencies by following the store's links,
//     then the links, bin shims and install metadata that described the deleted
//     entries. It only deletes. It never re-resolves or re-points anything, so
//     every package that stays is byte-for-byte what pnpm installed.
//
//   check --bundle <dir> --importer <dir> [--lockfile <path>] [--root <dir>]
//     Compares what the bundle holds with the importer's production closure as
//     pnpm-lock.yaml states it (scripts/lib/pnpm-closure.mjs, the walker the SBOM
//     audit already uses). The prune decides nothing the check trusts: a prune
//     that kept too much or removed too little fails here against the lockfile,
//     which neither this script nor the Dockerfile controls.
//
// The check fails on ANY package in the bundle that the closure does not name,
// on any workspace package set that differs from the importer graph, on a
// declared production dependency that does not resolve, and on a link that
// leaves the bundle. A closure package ABSENT from the bundle is allowed only if
// it is listed, exactly, in REVIEWED_ABSENT below; a listed package that is in
// fact present, or that the closure no longer names, also fails, so the list
// cannot go stale silently.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { computeClosure, componentsFromSnapshots, loadLockfile } from "./lib/pnpm-closure.mjs";

// Closure packages a legacy deploy does not install, per deployed importer.
//
// apps/core-api. The lockfile resolves the peers of the Slack channel adapter's
// `@chat-adapter/slack` (and through it `chat`, `ai`, `@ai-sdk/*`) against
// `zod@4.4.3`, and lists `bufferutil` as the optional peer of `ws`. A legacy
// deploy re-resolves the peers of injected workspace packages with
// peer-dependent deduplication disabled, so the bundle carries those packages
// resolved against `zod@3.25.76` and without the optional `bufferutil` (and its
// only dependency `node-gyp-build`). The divergence is real and is reported
// rather than hidden: the image runs that adapter against zod 3.25.76 while the
// workspace tests run it against zod 4.4.3.
export const REVIEWED_ABSENT = Object.freeze({
  "apps/core-api": Object.freeze(["bufferutil@4.0.9", "node-gyp-build@4.8.4", "zod@4.4.3"]),
});

const STORE = path.join("node_modules", ".pnpm");
const STORE_METADATA = new Set(["node_modules", "lock.yaml"]);

function fail(message) {
  const error = new Error(message);
  error.code = "DEPLOY_BUNDLE_CLOSURE";
  throw error;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function resolveOrNull(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** Children of a node_modules directory as package paths, scopes expanded. */
function packageSlots(modulesDir) {
  if (!fs.existsSync(modulesDir)) return [];
  const slots = [];
  for (const entry of fs.readdirSync(modulesDir).sort()) {
    if (entry.startsWith(".")) continue;
    const full = path.join(modulesDir, entry);
    if (entry.startsWith("@") && !isSymlink(full) && fs.statSync(full).isDirectory()) {
      for (const scoped of fs.readdirSync(full).sort()) slots.push(path.join(full, scoped));
    } else {
      slots.push(full);
    }
  }
  return slots;
}

function declaredProductionDependencies(bundle) {
  const manifest = readJson(path.join(bundle, "package.json"));
  return {
    required: Object.keys(manifest.dependencies ?? {}).sort(),
    optional: new Set(Object.keys(manifest.optionalDependencies ?? {})),
  };
}

/** The store entry a resolved package directory lives in, or a refusal. */
function storeEntryOf(bundle, resolved, from) {
  const store = fs.realpathSync(path.join(bundle, STORE));
  const relative = path.relative(store, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${from} resolves outside the bundle's virtual store: ${resolved}`);
  }
  const entry = relative.split(path.sep)[0];
  if (STORE_METADATA.has(entry)) fail(`${from} resolves into store metadata: ${resolved}`);
  return entry;
}

/** Store entries reachable from the bundle manifest's production dependencies. */
export function reachableStoreEntries(bundle) {
  const { required, optional } = declaredProductionDependencies(bundle);
  const reached = new Set();
  const queue = [];
  const visit = (slot, from) => {
    const resolved = resolveOrNull(slot);
    if (resolved === null) return false;
    const entry = storeEntryOf(bundle, resolved, from);
    if (!reached.has(entry)) {
      reached.add(entry);
      queue.push({ entry, self: resolved });
    }
    return true;
  };
  for (const name of [...required, ...optional].sort()) {
    const slot = path.join(bundle, "node_modules", name);
    if (!visit(slot, `dependency ${name}`) && !optional.has(name)) {
      fail(`declared production dependency ${name} does not resolve in the bundle`);
    }
  }
  const store = path.join(bundle, STORE);
  while (queue.length > 0) {
    const { entry, self } = queue.shift();
    for (const slot of packageSlots(path.join(store, entry, "node_modules"))) {
      if (resolveOrNull(slot) === self) continue;
      visit(slot, `${entry} -> ${path.relative(path.join(store, entry, "node_modules"), slot)}`);
    }
  }
  return reached;
}

/**
 * Links that cannot resolve once the bundle is copied on its own: dangling ones,
 * and ones that leave the bundle. pnpm's hidden hoist links the deployed
 * package's own name back to its WORKSPACE source directory, which the runtime
 * stage never receives, so in the image that link dangles anyway.
 */
function removeUnresolvableLinks(bundle, modulesDir, removed) {
  const bundleReal = fs.realpathSync(bundle);
  for (const slot of packageSlots(modulesDir)) {
    if (!isSymlink(slot)) continue;
    const resolved = resolveOrNull(slot);
    const relative = resolved === null ? null : path.relative(bundleReal, resolved);
    if (relative === null || relative.startsWith("..") || path.isAbsolute(relative)) {
      fs.rmSync(slot);
      removed.push(slot);
    }
  }
  if (!fs.existsSync(modulesDir)) return;
  for (const entry of fs.readdirSync(modulesDir)) {
    const full = path.join(modulesDir, entry);
    if (entry.startsWith("@") && !isSymlink(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full);
  }
}

/** A pnpm bin shim names its target as "$basedir/../<package path>". */
function removeOrphanShims(binDir, removed) {
  if (!fs.existsSync(binDir)) return;
  for (const shim of fs.readdirSync(binDir).sort()) {
    const full = path.join(binDir, shim);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      if (resolveOrNull(full) === null) {
        fs.rmSync(full);
        removed.push(full);
      }
      continue;
    }
    const targets = [...fs.readFileSync(full, "utf8").matchAll(/"\$basedir\/([^"]+)"/g)]
      .map((match) => match[1])
      .filter((target) => target !== "node");
    if (targets.length > 0 && targets.some((target) => !fs.existsSync(path.join(binDir, target)))) {
      fs.rmSync(full);
      removed.push(full);
    }
  }
}

export function prune(bundle) {
  const store = path.join(bundle, STORE);
  if (!fs.existsSync(store)) fail(`${bundle} has no virtual store at ${STORE}`);
  const reached = reachableStoreEntries(bundle);
  const removedEntries = [];
  for (const entry of fs.readdirSync(store).sort()) {
    if (STORE_METADATA.has(entry) || reached.has(entry)) continue;
    fs.rmSync(path.join(store, entry), { recursive: true, force: true });
    removedEntries.push(entry);
  }
  const removedLinks = [];
  removeUnresolvableLinks(bundle, path.join(bundle, "node_modules"), removedLinks);
  removeUnresolvableLinks(bundle, path.join(store, "node_modules"), removedLinks);
  removeOrphanShims(path.join(bundle, "node_modules", ".bin"), removedLinks);
  removeOrphanShims(path.join(store, "node_modules", ".bin"), removedLinks);
  // Install metadata that still lists the deleted entries. The runtime never
  // reads either file, and a scanner that did would report packages the image
  // does not contain.
  const removedMetadata = [];
  for (const file of [path.join(bundle, "node_modules", ".modules.yaml"), path.join(store, "lock.yaml")]) {
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removedMetadata.push(file);
    }
  }
  return { kept: reached.size, removedEntries, removedLinks, removedMetadata };
}

/** Every package directory the bundle's store holds, as name@version. */
export function bundleInventory(bundle) {
  const store = path.join(bundle, STORE);
  const external = new Set();
  const workspace = new Set();
  for (const entry of fs.readdirSync(store).sort()) {
    if (STORE_METADATA.has(entry)) continue;
    const owned = packageSlots(path.join(store, entry, "node_modules")).filter((slot) => !isSymlink(slot));
    if (owned.length !== 1) fail(`store entry ${entry} holds ${owned.length} package directories, expected 1`);
    const manifest = readJson(path.join(owned[0], "package.json"));
    if (entry.includes("@file+")) workspace.add(manifest.name);
    else external.add(`${manifest.name}@${manifest.version}`);
  }
  // Links the store did not create itself must not leave the bundle either.
  for (const modulesDir of [path.join(bundle, "node_modules"), path.join(store, "node_modules")]) {
    for (const slot of packageSlots(modulesDir)) {
      if (!isSymlink(slot)) continue;
      const resolved = resolveOrNull(slot);
      if (resolved === null) fail(`dangling link ${path.relative(bundle, slot)}`);
      storeEntryOf(bundle, resolved, path.relative(bundle, slot));
    }
  }
  return { external, workspace };
}

/** The importer's closure as the lockfile states it. */
export function lockfileClosure({ lockfile, root, importer }) {
  const { parsed } = loadLockfile(lockfile);
  if (!parsed.importers[importer]) fail(`${importer} is not an importer in ${lockfile}`);
  const external = new Set(
    componentsFromSnapshots(computeClosure([importer], parsed)).map((c) => `${c.name}@${c.version}`),
  );
  const importers = new Set();
  const walk = (dir) => {
    if (importers.has(dir)) return;
    importers.add(dir);
    for (const group of ["prod", "opt"]) {
      for (const version of Object.values(parsed.importers[dir]?.[group] ?? {})) {
        if (!version.startsWith("link:")) continue;
        const target = path.posix.normalize(path.posix.join(dir, version.slice("link:".length)));
        if (parsed.importers[target]) walk(target);
      }
    }
  };
  walk(importer);
  importers.delete(importer);
  const workspace = new Set(
    [...importers].map((dir) => readJson(path.join(root, dir, "package.json")).name),
  );
  return { external, workspace };
}

export function check({ bundle, importer, lockfile, root, reviewedAbsent = REVIEWED_ABSENT }) {
  reachableStoreEntries(bundle);
  const held = bundleInventory(bundle);
  const closure = lockfileClosure({ lockfile, root, importer });
  const problems = [];
  const extra = [...held.external].filter((id) => !closure.external.has(id)).sort();
  const absent = [...closure.external].filter((id) => !held.external.has(id)).sort();
  const reviewed = [...(reviewedAbsent[importer] ?? [])].sort();
  if (extra.length > 0) {
    problems.push(`${extra.length} package(s) in the bundle are outside the lockfile closure: ${extra.join(", ")}`);
  }
  const unreviewed = absent.filter((id) => !reviewed.includes(id));
  if (unreviewed.length > 0) {
    problems.push(`${unreviewed.length} closure package(s) are absent from the bundle: ${unreviewed.join(", ")}`);
  }
  const stale = reviewed.filter((id) => !absent.includes(id));
  if (stale.length > 0) {
    problems.push(`reviewed-absent entries that are not absent from this bundle: ${stale.join(", ")}`);
  }
  const heldWorkspace = [...held.workspace].sort();
  const closureWorkspace = [...closure.workspace].sort();
  if (JSON.stringify(heldWorkspace) !== JSON.stringify(closureWorkspace)) {
    const missing = closureWorkspace.filter((name) => !held.workspace.has(name));
    const surplus = heldWorkspace.filter((name) => !closure.workspace.has(name));
    problems.push(`workspace packages differ from the importer graph: missing [${missing.join(", ")}], extra [${surplus.join(", ")}]`);
  }
  return {
    ok: problems.length === 0,
    problems,
    counts: {
      bundleExternal: held.external.size,
      closureExternal: closure.external.size,
      absentReviewed: reviewed.length,
      workspace: held.workspace.size,
    },
  };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`malformed arguments: ${rest.join(" ")}`);
    options[flag.slice(2)] = value;
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (!options.bundle) fail("--bundle is required");
  const bundle = path.resolve(options.bundle);
  if (command === "prune") {
    const result = prune(bundle);
    console.log(
      `deploy-bundle-closure prune: kept ${result.kept} store entries, removed ${result.removedEntries.length} ` +
        `entries, ${result.removedLinks.length} links/shims and ${result.removedMetadata.length} metadata files`,
    );
    for (const entry of result.removedEntries) console.log(`  removed ${entry}`);
    return 0;
  }
  if (command === "check") {
    if (!options.importer) fail("--importer is required");
    const repositoryRoot = path.resolve(options.root ?? process.cwd());
    const result = check({
      bundle,
      importer: options.importer,
      lockfile: path.resolve(options.lockfile ?? path.join(repositoryRoot, "pnpm-lock.yaml")),
      root: repositoryRoot,
    });
    const { counts } = result;
    if (!result.ok) {
      console.error(`deploy-bundle-closure check FAILED for ${options.importer}:`);
      for (const problem of result.problems) console.error(`  ${problem}`);
      return 1;
    }
    console.log(
      `deploy-bundle-closure check: ${options.importer} bundle holds ${counts.bundleExternal} external packages ` +
        `= lockfile closure ${counts.closureExternal} - ${counts.absentReviewed} reviewed absent, ` +
        `and ${counts.workspace} workspace packages = the importer graph`,
    );
    return 0;
  }
  fail(`unknown command ${String(command)}; expected prune or check`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error?.code !== "DEPLOY_BUNDLE_CLOSURE") throw error;
    console.error(`deploy-bundle-closure: ${error.message}`);
    process.exitCode = 1;
  }
}
