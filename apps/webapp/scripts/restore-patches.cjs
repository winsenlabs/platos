#!/usr/bin/env node
/**
 * Restore only patch registrations whose targets remain in the canonical
 * lockfile or selected production graph.
 *
 * Turbo can also strip `pnpm.patchedDependencies`. The matching package.json
 * registrations and lockfile metadata are copied from the root manifest and
 * canonical lock only when the exact patch target has a retained snapshot.
 *
 * Production images must additionally pass `--production-root <importer>`. In
 * that mode every root dependency section is removed from package.json and the
 * root lock importer before pnpm runs, and patch reachability is computed from
 * the named production importer rather than from all snapshots retained in the
 * canonical lockfile.
 *
 * Usage:
 *   node restore-patches.cjs <orig-root-pkg> <target-pkg> <canonical-lock> [--production-root <importer>]
 */

const fs = require("fs");

const [, , origPackagePath, targetPackagePath, canonicalLockPath, ...options] = process.argv;
if (!origPackagePath || !targetPackagePath || !canonicalLockPath) {
  console.error(
    "usage: restore-patches.cjs <orig-root-pkg> <target-pkg> <canonical-lock> [--production-root <importer>]",
  );
  process.exit(1);
}
const productionRootIndex = options.indexOf("--production-root");
const productionRoot = productionRootIndex === -1 ? null : options[productionRootIndex + 1];
if (productionRootIndex !== -1 && !productionRoot) {
  throw new Error("--production-root requires an importer path");
}

function yamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

function topLevelRange(lines, name) {
  const start = lines.findIndex((line) => line === `${name}:` || line === `${name}: {}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end]))) end += 1;
  return { start, end };
}

function mapEntries(lines, range, indent) {
  const entries = new Map();
  if (!range) return entries;
  const prefix = " ".repeat(indent);
  for (let index = range.start + 1; index < range.end; index += 1) {
    const line = lines[index];
    if (!line.startsWith(prefix) || line.startsWith(`${prefix} `)) {
      continue;
    }
    const entryMatch = line.slice(indent).match(/^(.+?):(?:\s+\{\})?$/);
    if (!entryMatch) continue;
    const key = yamlScalar(entryMatch[1]);
    let end = index + 1;
    while (
      end < range.end &&
      (lines[end] === "" || lines[end].startsWith(`${prefix} `))
    ) {
      end += 1;
    }
    entries.set(key, { start: index, end, lines: lines.slice(index, end) });
    index = end - 1;
  }
  return entries;
}

function snapshotSet(lockLines) {
  return new Set(mapEntries(lockLines, topLevelRange(lockLines, "snapshots"), 2).keys());
}

function splitPatchKey(key) {
  const lastAt = key.lastIndexOf("@");
  if (lastAt <= 0) return null;
  return { name: key.slice(0, lastAt), version: key.slice(lastAt + 1) };
}

function snapshotTarget(name, resolvedVersion) {
  let targetName = name;
  let version = yamlScalar(resolvedVersion).split("(")[0];
  if (version.startsWith("npm:")) {
    const alias = version.slice(4);
    const lastAt = alias.lastIndexOf("@");
    if (lastAt <= 0) return null;
    targetName = alias.slice(0, lastAt);
    version = alias.slice(lastAt + 1);
  }
  return { targetName, version };
}

function hasSnapshot(snapshots, name, resolvedVersion) {
  const value = yamlScalar(resolvedVersion);
  if (/^(?:link|workspace|file):/.test(value)) return true;
  const target = snapshotTarget(name, value);
  if (!target) return false;
  const prefix = `${target.targetName}@${target.version}`;
  return [...snapshots].some((key) => key === prefix || key.startsWith(`${prefix}(`));
}

function rootImporterRange(lines) {
  const importers = topLevelRange(lines, "importers");
  if (!importers) throw new Error("pruned lockfile has no importers section");
  const start = lines.findIndex(
    (line, index) => index > importers.start && index < importers.end && line === "  .:",
  );
  if (start === -1) throw new Error("pruned lockfile has no root importer");
  let end = start + 1;
  while (end < importers.end && (lines[end] === "" || lines[end].startsWith("    "))) end += 1;
  return { start, end };
}

function importerSections(lines, importerRange) {
  const sections = new Map();
  for (let index = importerRange.start + 1; index < importerRange.end; index += 1) {
    const match = lines[index].match(/^    (dependencies|devDependencies|optionalDependencies):$/);
    if (!match) continue;
    let end = index + 1;
    while (end < importerRange.end && (lines[end] === "" || lines[end].startsWith("      "))) {
      end += 1;
    }
    sections.set(match[1], { start: index, end });
    index = end - 1;
  }
  return sections;
}

function stripRootDependencies(lockLines, targetPackage) {
  const importerRange = rootImporterRange(lockLines);
  const sections = importerSections(lockLines, importerRange);
  const removals = [];
  let removed = 0;
  for (const sectionName of ["dependencies", "devDependencies", "optionalDependencies"]) {
    removed += Object.keys(targetPackage[sectionName] || {}).length;
    delete targetPackage[sectionName];
    const section = sections.get(sectionName);
    if (section) removals.push(section);
  }
  removals.sort((a, b) => b.start - a.start);
  for (const { start, end } of removals) lockLines.splice(start, end - start);

  const normalizedRoot = rootImporterRange(lockLines);
  const hasContent = lockLines
    .slice(normalizedRoot.start + 1, normalizedRoot.end)
    .some((line) => line.trim() !== "");
  if (!hasContent) lockLines.splice(normalizedRoot.start, normalizedRoot.end - normalizedRoot.start, "  .: {}");
  return removed;
}

function importerProductionDependencies(entry) {
  const dependencies = new Map();
  let group = null;
  let dependency = null;
  for (const line of entry.lines.slice(1)) {
    const section = line.match(/^    (dependencies|optionalDependencies|devDependencies):$/);
    if (section) {
      group = section[1];
      dependency = null;
      continue;
    }
    const dependencyMatch = line.match(/^      (.+):$/);
    if (dependencyMatch) {
      dependency = yamlScalar(dependencyMatch[1]);
      continue;
    }
    const version = line.match(/^        version:\s+(.+)$/);
    if (version && dependency && (group === "dependencies" || group === "optionalDependencies")) {
      dependencies.set(dependency, yamlScalar(version[1]));
    }
  }
  return dependencies;
}

function snapshotDependencies(entry) {
  const dependencies = new Map();
  let group = null;
  for (const line of entry.lines.slice(1)) {
    const section = line.match(/^    (dependencies|optionalDependencies|devDependencies):$/);
    if (section) {
      group = section[1];
      continue;
    }
    if (group !== "dependencies" && group !== "optionalDependencies") continue;
    const dependency = line.match(/^      (.+?):\s+(.+)$/);
    if (dependency) dependencies.set(yamlScalar(dependency[1]), yamlScalar(dependency[2]));
  }
  return dependencies;
}

function snapshotKey(name, version) {
  const value = yamlScalar(version);
  if (/^[0-9]/.test(value)) return `${name}@${value}`;
  if (value.startsWith("npm:")) return value.slice(4);
  return value;
}

function productionSnapshotClosure(lockLines, rootImporter) {
  const importers = mapEntries(lockLines, topLevelRange(lockLines, "importers"), 2);
  const snapshots = mapEntries(lockLines, topLevelRange(lockLines, "snapshots"), 2);
  if (!importers.has(rootImporter)) throw new Error(`lockfile has no production importer: ${rootImporter}`);

  const visitedImporters = new Set();
  const visitedSnapshots = new Set();
  const queue = [];
  const enqueueSnapshot = (key) => {
    if (!visitedSnapshots.has(key)) {
      visitedSnapshots.add(key);
      queue.push(key);
    }
  };
  const addImporter = (importer) => {
    if (visitedImporters.has(importer)) return;
    const entry = importers.get(importer);
    if (!entry) throw new Error(`linked production importer is missing: ${importer}`);
    visitedImporters.add(importer);
    for (const [name, version] of importerProductionDependencies(entry)) {
      if (version.startsWith("link:")) {
        const target = require("path").posix.normalize(
          require("path").posix.join(importer, version.slice("link:".length)),
        );
        if (importers.has(target)) addImporter(target);
      } else {
        enqueueSnapshot(snapshotKey(name, version));
      }
    }
  };

  addImporter(rootImporter);
  while (queue.length) {
    const key = queue.shift();
    const entry = snapshots.get(key);
    if (!entry) throw new Error(`production snapshot is missing: ${key}`);
    for (const [name, version] of snapshotDependencies(entry)) {
      enqueueSnapshot(snapshotKey(name, version));
    }
  }
  return visitedSnapshots;
}

function originalPatchEntries(originalLockLines) {
  return mapEntries(
    originalLockLines,
    topLevelRange(originalLockLines, "patchedDependencies"),
    2,
  );
}

function replacePatchMetadata(lockLines, patchKeys, originalEntries) {
  const existing = topLevelRange(lockLines, "patchedDependencies");
  const replacement = [];
  if (patchKeys.length === 0) {
    replacement.push("patchedDependencies: {}");
  } else {
    replacement.push("patchedDependencies:");
    for (const key of patchKeys) {
      const entry = originalEntries.get(key);
      if (!entry) throw new Error(`original lockfile has no patch metadata for ${key}`);
      replacement.push(...entry.lines);
    }
  }
  if (existing) lockLines.splice(existing.start, existing.end - existing.start, ...replacement);
  else {
    const importers = topLevelRange(lockLines, "importers");
    lockLines.splice(importers ? importers.start : 0, 0, ...replacement);
  }
}

const originalPackage = JSON.parse(fs.readFileSync(origPackagePath, "utf8"));
const targetPackage = JSON.parse(fs.readFileSync(targetPackagePath, "utf8"));
const canonicalLockLines = fs.readFileSync(canonicalLockPath, "utf8").split(/\r?\n/);
const originalLockLines = [...canonicalLockLines];
const snapshots = snapshotSet(canonicalLockLines);
if (snapshots.size === 0) {
  throw new Error(
    "lockfile has no snapshots; use the canonical frozen lockfile instead of Turbo's importers-only output",
  );
}

const productionClosure = productionRoot
  ? productionSnapshotClosure(canonicalLockLines, productionRoot)
  : null;
const removedDependencies = productionRoot
  ? stripRootDependencies(canonicalLockLines, targetPackage)
  : 0;
const allPatches = originalPackage.pnpm?.patchedDependencies || {};
const retainedPatches = Object.keys(allPatches).filter((key) => {
  const target = splitPatchKey(key);
  if (!target) return false;
  if (!productionClosure) return hasSnapshot(snapshots, target.name, target.version);
  const prefix = `${target.name}@${target.version}`;
  return [...productionClosure].some((key) => key === prefix || key.startsWith(`${prefix}(`));
});

const filteredPatches = Object.fromEntries(retainedPatches.map((key) => [key, allPatches[key]]));
targetPackage.pnpm = targetPackage.pnpm || {};
targetPackage.pnpm.patchedDependencies = filteredPatches;
replacePatchMetadata(canonicalLockLines, retainedPatches, originalPatchEntries(originalLockLines));

fs.writeFileSync(targetPackagePath, `${JSON.stringify(targetPackage, null, 2)}\n`);
fs.writeFileSync(canonicalLockPath, `${canonicalLockLines.join("\n").replace(/\n+$/, "")}\n`);

console.log(
  productionRoot
    ? `removed ${removedDependencies} root dependency declarations for production importer ${productionRoot}`
    : "preserved canonical root dependencies",
);
console.log(
  `restored patchedDependencies: ${retainedPatches.length}/${Object.keys(allPatches).length} ` +
    "entries kept (rest pruned out of webapp tree)",
);
if (retainedPatches.length) console.log(`  kept: ${retainedPatches.join(", ")}`);
const droppedPatches = Object.keys(allPatches).filter((key) => !retainedPatches.includes(key));
if (droppedPatches.length) console.log(`  dropped: ${droppedPatches.join(", ")}`);
