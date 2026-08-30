#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listRepositoryFiles } from "./root-entry-manifest.mjs";

export const REVIEWED_SOURCE_BASE = "fcf39fa227cb9265b7e532f14ef181a3b65ff061";
export const REVIEWED_SOURCE_COMMIT = "e720b7618e58b27d3ff4f9aff5a5ca9ac6670130";
export const INTEGRATION_BASE = "34c41bc10bd23c90271e83592148fab3bf26aa38";
export const REPORT_PATH = "docs/audits/win253-removals/vendored-build.json";
export const MARKDOWN_PATH = "docs/audits/win253-removals/vendored-build.md";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateRoots = [
  "packages/trigger-sdk",
  "internal-packages/sdk-compat-tests",
  "packages/build",
  "packages/python",
  "packages/rsc",
  "packages/schema-to-json",
];
const allowedPrimaryBaseAdditions = [
  {
    path: "packages/rsc/LICENSE",
    reason: "WIN-252 added the package-local Apache-2.0 license after the reviewed source base.",
  },
  {
    path: "packages/schema-to-json/LICENSE",
    reason: "WIN-252 added the package-local Apache-2.0 license after the reviewed source base.",
  },
];
const allowedAdditionalIntegrationDeletions = [
  {
    path: "patches/@upstash__ratelimit.patch",
    reason: "WIN-253 removed the unreachable @upstash/ratelimit package and its obsolete tracked patch.",
  },
  {
    path: "patches/@window-splitter__state@0.4.1.patch",
    reason: "WIN-253 removed react-window-splitter and its obsolete transitive patch.",
  },
];
const protectedRoots = [
  "packages/platools-js",
  "packages/platos-client",
  "packages/platos-embed",
  "packages/platos-react-widget",
  "packages/platos-token-mint",
  "packages/platools-py",
  "packages/platos-client-py",
];
const auditOwnedPaths = new Set([
  REPORT_PATH,
  MARKDOWN_PATH,
  "scripts/vendored-build-audit.mjs",
  "scripts/vendored-build-audit.test.mjs",
]);
const generatedEvidencePaths = new Set([
  "docs/audits/M0.5-dependency-sbom.md",
  "docs/audits/win-252-root-entry-manifest.json",
  "docs/audits/win-252-root-entry-manifest.md",
  "docs/audits/win-253-workspace-reachability.json",
  "docs/audits/win-253-workspace-reachability.md",
  "docs/vocabulary-boundary-exceptions.json",
]);
const allowedNegativeGuards = new Map([
  ["apps/agent/scripts/audit-production-dependencies.mjs", "@platos/sdk"],
  ["scripts/audit-platos-build.mjs", "@platos/sdk"],
]);
const runtimeSymbols = new Set(["task", "tasks", "runs", "schedules", "wait"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
  });
}

export function parseTreeEntries(output) {
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) blob ([0-9a-f]+)\s+(\d+)\t([\s\S]+)$/u.exec(line);
      if (!match) throw new Error(`unexpected git ls-tree row: ${JSON.stringify(line)}`);
      return { mode: match[1], oid: match[2], bytes: Number(match[3]), path: match[4] };
    });
}

function treeEntries(root, revision, roots = []) {
  return parseTreeEntries(git(root, ["ls-tree", "-r", "-l", "-z", revision, "--", ...roots]));
}

function readBlobBatch(root, entries) {
  if (entries.length === 0) return new Map();
  const child = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${entries.map(({ oid }) => oid).join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr.toString("utf8"));
  const blobs = new Map();
  let offset = 0;
  for (const entry of entries) {
    const newline = child.stdout.indexOf(10, offset);
    if (newline === -1) throw new Error(`missing cat-file header for ${entry.path}`);
    const size = Number(child.stdout.subarray(offset, newline).toString("utf8").split(" ")[2]);
    const start = newline + 1;
    const end = start + size;
    blobs.set(entry.path, child.stdout.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

function actualDeletedPaths(root) {
  return git(root, ["diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", INTEGRATION_BASE, "--"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function changedPaths(root, from, to, roots = [], filter) {
  const args = ["diff", "--no-renames", "--name-only"];
  if (filter) args.push(`--diff-filter=${filter}`);
  args.push("-z", from, to, "--", ...roots);
  return git(root, args).split("\0").filter(Boolean).sort();
}

export function isTombstonedPath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return candidateRoots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

export function validateDeletionSet(expectedPaths, actualPaths) {
  const expected = [...expectedPaths].sort();
  const actual = [...actualPaths].sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    expected,
    actual,
    missing: expected.filter((path) => !actualSet.has(path)),
    unrecorded: actual.filter((path) => !expectedSet.has(path)),
  };
}

export function existingRetiredRoots(root) {
  return candidateRoots.filter((path) => {
    try {
      lstatSync(resolve(root, path));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }).sort();
}

function isRelevant(path) {
  const name = path.split("/").at(-1);
  return (
    name === "package.json" ||
    /(?:^|\/)(?:Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml)$/u.test(path) ||
    /\.(?:[cm]?[jt]sx?|json|mdx?|toml|ya?ml|sh)$/u.test(path) ||
    path.startsWith(".github/")
  );
}

function textEntriesFromWorktree(root, paths) {
  return paths.flatMap((path) => {
    if (!isRelevant(path) || auditOwnedPaths.has(path) || generatedEvidencePaths.has(path)) return [];
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return [];
    const value = readFileSync(absolute);
    return value.includes(0) || value.length > 2 * 1024 * 1024
      ? []
      : [{ path, content: value.toString("utf8") }];
  });
}

function matchesCandidateName(specifier, candidateNames) {
  return candidateNames.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function tokenReferences(entry, tokens, kind) {
  const rows = [];
  const lines = entry.content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (const token of tokens) {
      if (lines[index].includes(token)) rows.push({ path: entry.path, line: index + 1, kind, token });
    }
  }
  return rows;
}

function moduleReferences(entry, candidateNames) {
  const rows = [];
  const patterns = [
    ["side-effect-imports", /\bimport\s*["']([^"']+)["']/gu],
    ["dynamic-imports", /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu],
    ["static-imports", /\b(?:import|export)\s+(?:type\s+)?[^;\n]*?\sfrom\s*["']([^"']+)["']/gu],
    ["static-imports", /\brequire(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gu],
    ["filesystem-loaders", /\bimport\.meta\.resolve\s*\(\s*["']([^"']+)["']\s*\)/gu],
    ["filesystem-loaders", /\bcreateRequire\s*\([^)]*\)\s*(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gu],
  ];
  for (const [channel, pattern] of patterns) {
    for (const match of entry.content.matchAll(pattern)) {
      if (!matchesCandidateName(match[1], candidateNames)) continue;
      rows.push({
        path: entry.path,
        line: entry.content.slice(0, match.index).split("\n").length,
        channel,
        specifier: match[1],
      });
    }
  }
  for (const match of entry.content.matchAll(/\b(?:readFile|readFileSync|readdir|readdirSync|resolve|join|existsSync)\s*\(([^;\n]*)\)/gu)) {
    const literals = [...match[1].matchAll(/["'`]([^"'`\n]+)["'`]/gu)].map((literal) => literal[1]);
    const value = [...literals, literals.join("/")].find(isTombstonedPath);
    if (value) {
      rows.push({
        path: entry.path,
        line: entry.content.slice(0, match.index).split("\n").length,
        channel: "filesystem-loaders",
        value,
      });
    }
  }
  return rows;
}

export function scanReachability(entries, candidateNames, roots = candidateRoots) {
  const tokens = [...candidateNames, ...roots];
  const channels = Object.fromEntries(
    [
      "package-dependencies",
      "static-imports",
      "side-effect-imports",
      "dynamic-imports",
      "filesystem-loaders",
      "ts-references",
      "ci",
      "scripts",
      "docker",
      "test-config",
      "docs",
    ].map((channel) => [channel, []])
  );

  for (const entry of entries) {
    const name = entry.path.split("/").at(-1);
    if (name === "package.json") {
      try {
        const manifest = JSON.parse(entry.content);
        for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
          for (const dependency of Object.keys(manifest[section] ?? {})) {
            if (matchesCandidateName(dependency, candidateNames)) {
              channels["package-dependencies"].push({ path: entry.path, section, dependency });
            }
          }
        }
        for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
          channels.scripts.push(...tokenReferences({ path: entry.path, content: String(command) }, tokens, "package-script").map((row) => ({ ...row, script })));
        }
      } catch {
        // Package and install gates report malformed manifests.
      }
    }

    if (/\.[cm]?[jt]sx?$/u.test(entry.path)) {
      for (const reference of moduleReferences(entry, candidateNames)) channels[reference.channel].push(reference);
    }

    if (/\/tsconfig[^/]*\.json$/u.test(`/${entry.path}`)) {
      channels["ts-references"].push(...tokenReferences(entry, roots, "ts-reference"));
    }

    const genericChannels = [];
    if (entry.path.startsWith(".github/")) genericChannels.push("ci");
    if (entry.path.startsWith("scripts/") || entry.path.includes("/scripts/") || /\.sh$/u.test(entry.path)) genericChannels.push("scripts");
    if (/(?:^|\/)(?:Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml)$/u.test(entry.path)) genericChannels.push("docker");
    if (/(?:vitest|playwright|jest|test[^/]*config|tsconfig\.test)/u.test(name)) genericChannels.push("test-config");
    if (/\.(?:md|mdx)$/u.test(entry.path)) genericChannels.push("docs");
    for (const channel of genericChannels) channels[channel].push(...tokenReferences(entry, tokens, channel));
  }

  for (const references of Object.values(channels)) {
    references.sort((left, right) =>
      left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0) || JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  return channels;
}

function importedSymbols(clause) {
  const braces = /\{([^}]+)\}/u.exec(clause)?.[1] ?? "";
  return braces.split(",").map((part) => part.trim().split(/\s+as\s+/u)[0]).filter(Boolean);
}

export function scanApiBoundary(entries, options = {}) {
  const permittedHistoricalPaths = options.permittedHistoricalPaths ?? new Set();
  const result = {
    legacyImports: [],
    runtimeImports: [],
    clientImports: [],
    deprecatedSubpathImports: [],
    permittedHistoricalDeprecatedSubpathImports: [],
    misroutedRuntimeImports: [],
    misroutedClientImports: [],
  };
  const pattern = /\bimport\s+([^;\n]+?)\s+from\s+["'](@platos\/sdk(?:\/v3)?|@trigger\.dev\/sdk(?:\/v3)?|@platosdev\/client)["']/gu;
  for (const entry of entries) {
    for (const match of entry.content.matchAll(pattern)) {
      const symbols = importedSymbols(match[1]);
      const row = {
        path: entry.path,
        line: entry.content.slice(0, match.index).split("\n").length,
        specifier: match[2],
        symbols,
      };
      if (match[2].startsWith("@platos/sdk")) result.legacyImports.push(row);
      if (match[2] === "@trigger.dev/sdk/v3") {
        if (entry.path.endsWith("/CHANGELOG.md") && permittedHistoricalPaths.has(entry.path)) {
          result.permittedHistoricalDeprecatedSubpathImports.push(row);
        } else {
          result.deprecatedSubpathImports.push(row);
        }
      }
      if (symbols.some((symbol) => runtimeSymbols.has(symbol))) {
        result.runtimeImports.push(row);
        if (!["@trigger.dev/sdk", "@trigger.dev/sdk/v3"].includes(match[2])) {
          result.misroutedRuntimeImports.push(row);
        }
      }
      if (symbols.includes("PlatosClient")) {
        result.clientImports.push(row);
        if (match[2] !== "@platosdev/client") result.misroutedClientImports.push(row);
      }
    }
  }
  return result;
}

function candidateManifests(entries, blobs) {
  return candidateRoots.map((path) => {
    const entry = entries.find((candidate) => candidate.path === `${path}/package.json`);
    if (!entry) throw new Error(`integration base is missing ${path}/package.json`);
    const manifest = JSON.parse(blobs.get(entry.path).toString("utf8"));
    return { path, name: manifest.name, private: manifest.private === true };
  });
}

function protectedTreeOids(root) {
  return new Map(
    git(root, ["ls-tree", "-z", INTEGRATION_BASE, "--", ...protectedRoots])
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const match = /^\d+ tree ([0-9a-f]+)\t(.+)$/u.exec(row);
        if (!match) throw new Error(`unexpected protected tree row: ${JSON.stringify(row)}`);
        return [match[2], match[1]];
      })
  );
}

function validateProtectedTrees(root, currentPaths, violations) {
  const allEntries = treeEntries(root, INTEGRATION_BASE, protectedRoots);
  const allBlobs = readBlobBatch(root, allEntries);
  const treeOids = protectedTreeOids(root);
  return protectedRoots.map((path) => {
    const entries = allEntries.filter(({ path: entryPath }) => entryPath.startsWith(`${path}/`));
    for (const entry of entries) {
      const absolute = resolve(root, entry.path);
      if (!existsSync(absolute)) violations.push(`protected SDK file is missing: ${entry.path}`);
      else if (sha256(readFileSync(absolute)) !== sha256(allBlobs.get(entry.path))) {
        violations.push(`protected SDK file changed from integration base: ${entry.path}`);
      }
    }
    const basePaths = new Set(entries.map(({ path: entryPath }) => entryPath));
    for (const currentPath of currentPaths.filter((entryPath) => entryPath === path || entryPath.startsWith(`${path}/`))) {
      if (!basePaths.has(currentPath)) violations.push(`protected SDK tree gained a path: ${currentPath}`);
    }
    return {
      path,
      integrationBaseTreeOid: treeOids.get(path),
      trackedFiles: entries.length,
      trackedBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      byteIdentical: !violations.some((violation) => violation.includes(path)),
    };
  });
}

export function validateReviewedSourceProvenance(root, {
  reviewedSourceBase = REVIEWED_SOURCE_BASE,
  reviewedSourceCommit = REVIEWED_SOURCE_COMMIT,
  reviewedSourceRoots = candidateRoots,
  integrationDeletedPaths,
  integrationBaseEntries,
  allowedAdditions = allowedPrimaryBaseAdditions,
  allowedAdditionalDeletions = allowedAdditionalIntegrationDeletions,
} = {}) {
  const violations = [];
  const resolvedBase = git(root, ["rev-parse", `${reviewedSourceBase}^{commit}`]).trim();
  const resolvedCommit = git(root, ["rev-parse", `${reviewedSourceCommit}^{commit}`]).trim();
  if (resolvedBase !== reviewedSourceBase) violations.push("reviewed source base is not the exact configured commit SHA");
  if (resolvedCommit !== reviewedSourceCommit) violations.push("reviewed source commit is not the exact configured commit SHA");
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", reviewedSourceBase, reviewedSourceCommit], { cwd: root });
  if (ancestry.status !== 0) violations.push("reviewed source base is not an ancestor of reviewed source commit");

  const rootSet = validateDeletionSet(candidateRoots, reviewedSourceRoots);
  for (const path of rootSet.missing) violations.push(`reviewed source pathset omits authorized root: ${path}`);
  for (const path of rootSet.unrecorded) violations.push(`reviewed source pathset adds unauthorized root: ${path}`);

  const sourceBaseEntries = treeEntries(root, reviewedSourceBase, reviewedSourceRoots);
  const sourceCommitEntries = treeEntries(root, reviewedSourceCommit, reviewedSourceRoots);
  const sourceDeletedPaths = changedPaths(root, reviewedSourceBase, reviewedSourceCommit, [], "D");
  const sourceCandidateChanges = changedPaths(root, reviewedSourceBase, reviewedSourceCommit, reviewedSourceRoots);
  const sourceDeletionSet = validateDeletionSet(sourceBaseEntries.map(({ path }) => path), sourceDeletedPaths);
  const sourceChangeSet = validateDeletionSet(sourceDeletedPaths, sourceCandidateChanges);
  for (const path of sourceDeletionSet.missing) violations.push(`reviewed source retained configured cluster path: ${path}`);
  for (const path of sourceDeletionSet.unrecorded) violations.push(`reviewed source deleted path outside configured cluster: ${path}`);
  for (const path of sourceChangeSet.missing) violations.push(`reviewed source deletion is absent from candidate-root diff: ${path}`);
  for (const path of sourceChangeSet.unrecorded) violations.push(`reviewed source candidate-root change is not a deletion: ${path}`);
  for (const entry of sourceCommitEntries) violations.push(`reviewed source commit retains candidate path: ${entry.path}`);

  const coverage = validateDeletionSet(sourceDeletedPaths, integrationDeletedPaths);
  for (const path of coverage.missing) violations.push(`reviewed source deletion is absent from current integration deletion set: ${path}`);

  const sourceBasePaths = new Set(sourceBaseEntries.map(({ path }) => path));
  const actualAdditions = integrationBaseEntries
    .map(({ path }) => path)
    .filter((path) => !sourceBasePaths.has(path))
    .sort();
  const allowedPaths = allowedAdditions.map(({ path }) => path);
  const additionSet = validateDeletionSet(allowedPaths, actualAdditions);
  for (const path of additionSet.missing) violations.push(`explained primary-base addition is absent: ${path}`);
  for (const path of additionSet.unrecorded) violations.push(`primary base adds unexplained candidate path: ${path}`);
  const allowedDeletionPaths = allowedAdditionalDeletions.map(({ path }) => path);
  const coverageAdditions = validateDeletionSet(
    [...allowedPaths, ...allowedDeletionPaths],
    coverage.unrecorded,
  );
  for (const path of coverageAdditions.missing) violations.push(`explained primary-base addition is absent from current deletion set: ${path}`);
  for (const path of coverageAdditions.unrecorded) violations.push(`current integration deletion lacks a primary-base addition explanation: ${path}`);
  for (const addition of allowedAdditions) {
    if (!addition.reason?.trim()) violations.push(`primary-base addition lacks an explanation: ${addition.path}`);
  }
  for (const deletion of allowedAdditionalDeletions) {
    if (!deletion.reason?.trim()) violations.push(`additional integration deletion lacks an explanation: ${deletion.path}`);
  }

  const sourceEntriesByPath = new Map(sourceBaseEntries.map((entry) => [entry.path, entry]));
  const integrationEntriesByPath = new Map(integrationBaseEntries.map((entry) => [entry.path, entry]));
  const deletionManifest = sourceDeletedPaths
    .map((path) => {
      const entry = sourceEntriesByPath.get(path);
      return `${path}\0${entry?.mode ?? "missing"}\0${entry?.oid ?? "missing"}\0${entry?.bytes ?? "missing"}\n`;
    })
    .join("");
  return {
    violations,
    receipt: {
      base: reviewedSourceBase,
      baseTreeOid: git(root, ["rev-parse", `${reviewedSourceBase}^{tree}`]).trim(),
      commit: reviewedSourceCommit,
      commitTreeOid: git(root, ["rev-parse", `${reviewedSourceCommit}^{tree}`]).trim(),
      branch: "vorflux/win253-vendored-build",
      deletion: {
        workspaceCount: reviewedSourceRoots.length,
        actualFileCount: sourceDeletedPaths.length,
        actualBytes: sourceDeletedPaths.reduce((total, path) => total + (sourceEntriesByPath.get(path)?.bytes ?? 0), 0),
        manifestSha256: sha256(deletionManifest),
        pathspec: sourceDeletedPaths,
      },
      integrationCoverage: {
        representedReviewedDeletionCount: sourceDeletedPaths.length - coverage.missing.length,
        missingReviewedDeletions: coverage.missing,
        primaryBaseAdditions: actualAdditions.map((path) => {
          const entry = integrationEntriesByPath.get(path);
          return {
            path,
            reason: allowedAdditions.find((addition) => addition.path === path)?.reason ?? null,
            mode: entry?.mode ?? null,
            integrationBaseBlobOid: entry?.oid ?? null,
            bytes: entry?.bytes ?? null,
          };
        }),
        additionalReviewedDeletions: allowedAdditionalDeletions,
      },
    },
  };
}

function validateIntegration(root, deleted, candidateNames, currentPaths, violations) {
  const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  for (const token of [...candidateRoots.map((path) => `${path}:`), ...candidateNames]) {
    if (lockfile.includes(token)) violations.push(`pnpm-lock.yaml retains ${token}`);
  }

  const changesets = currentPaths.filter((path) => path.startsWith(".changeset/") && path.endsWith(".md"));
  for (const path of changesets) {
    const content = readFileSync(resolve(root, path), "utf8");
    for (const name of candidateNames) if (content.includes(name)) violations.push(`${path} retains retired package ${name}`);
  }

  for (const path of [".gitignore", ".cursorignore", ".dockerignore"]) {
    const content = readFileSync(resolve(root, path), "utf8");
    for (const candidateRoot of candidateRoots) {
      if (content.includes(candidateRoot)) violations.push(`${path} retains retired path ${candidateRoot}`);
    }
  }

  const vocabulary = JSON.parse(readFileSync(resolve(root, "docs/vocabulary-boundary-exceptions.json"), "utf8"));
  const deletedSet = new Set(deleted);
  const staleVocabularyRows = vocabulary.exceptions.filter(({ path }) => deletedSet.has(path));
  if (staleVocabularyRows.length > 0) violations.push(`vocabulary manifest retains ${staleVocabularyRows.length} deleted-path row(s)`);

  const ledgerRules = JSON.parse(readFileSync(resolve(root, "docs/v1-ledger-rules.json"), "utf8"));
  const obsoletePins = Object.values(ledgerRules.areas).flat().filter(({ id }) => id === "packages.pin.browser-entry");
  if (obsoletePins.length > 0) violations.push("V1 ledger retains obsolete packages.pin.browser-entry rule");

  const reachability = JSON.parse(readFileSync(resolve(root, "docs/audits/win-253-workspace-reachability.json"), "utf8"));
  const staleWorkspaces = reachability.workspaces.filter(({ path }) => candidateRoots.includes(path));
  if (staleWorkspaces.length > 0) violations.push(`workspace reachability retains ${staleWorkspaces.length} retired workspace(s)`);

  return {
    lockfileSha256: sha256(lockfile),
    vocabularySha256: sha256(readFileSync(resolve(root, "docs/vocabulary-boundary-exceptions.json"))),
    ledgerRulesSha256: sha256(readFileSync(resolve(root, "docs/v1-ledger-rules.json"))),
    reachabilitySha256: sha256(readFileSync(resolve(root, "docs/audits/win-253-workspace-reachability.json"))),
    staleVocabularyRows: staleVocabularyRows.length,
    obsoleteLedgerPins: obsoletePins.length,
    staleReachabilityWorkspaces: staleWorkspaces.length,
  };
}

export function auditRepository(root = repositoryRoot, options = {}) {
  const violations = [];
  const baseEntries = treeEntries(root, INTEGRATION_BASE, candidateRoots);
  const additionalDeletionEntries = treeEntries(
    root,
    INTEGRATION_BASE,
    allowedAdditionalIntegrationDeletions.map(({ path }) => path),
  );
  const deletionBaseEntries = [...baseEntries, ...additionalDeletionEntries];
  const baseBlobs = readBlobBatch(root, deletionBaseEntries);
  const manifests = candidateManifests(baseEntries, baseBlobs);
  const candidateNames = manifests.map(({ name }) => name);
  const deleted = actualDeletedPaths(root);
  const deletionSet = validateDeletionSet(deletionBaseEntries.map(({ path }) => path), deleted);
  for (const path of deletionSet.missing) violations.push(`integration-base cluster path was not deleted: ${path}`);
  for (const path of deletionSet.unrecorded) violations.push(`unrecorded deletion outside the six-workspace cluster: ${path}`);

  const currentPaths = listRepositoryFiles(root);
  const tombstoneViolations = existingRetiredRoots(root);
  for (const path of tombstoneViolations) violations.push(`current-tree tombstone violated: ${path}`);

  const deletedEntries = deletionSet.actual
    .map((path) => deletionBaseEntries.find((entry) => entry.path === path))
    .filter(Boolean);
  const deletedFiles = deletedEntries.map((entry) => ({
    path: entry.path,
    mode: entry.mode,
    integrationBaseBlobOid: entry.oid,
    integrationBaseSha256: sha256(baseBlobs.get(entry.path)),
    bytes: entry.bytes,
  }));
  const deletionManifest = deletedFiles
    .map(({ path, integrationBaseBlobOid, integrationBaseSha256, bytes }) => `${path}\0${integrationBaseBlobOid}\0${integrationBaseSha256}\0${bytes}\n`)
    .join("");

  const textEntries = textEntriesFromWorktree(root, currentPaths);
  const reachability = scanReachability(textEntries, candidateNames);
  const allowedGuardRows = [];
  for (const [channel, references] of Object.entries(reachability)) {
    for (const reference of references) {
      const allowedToken = allowedNegativeGuards.get(reference.path);
      if (allowedToken && reference.token === allowedToken && ["scripts"].includes(channel)) {
        allowedGuardRows.push({ channel, ...reference });
      } else {
        violations.push(`current ${channel} channel retains candidate reference at ${reference.path}:${reference.line ?? 0}`);
      }
    }
  }
  for (const [path, token] of allowedNegativeGuards) {
    const matches = allowedGuardRows.filter((row) => row.path === path && row.token === token);
    if (matches.length !== 1) violations.push(`${path} must retain exactly one explicit ${token} negative guard`);
  }

  const vocabulary = JSON.parse(readFileSync(resolve(root, "docs/vocabulary-boundary-exceptions.json"), "utf8"));
  const permittedHistoricalPaths = new Set(
    vocabulary.exclusions
      .filter(({ classification, path }) => classification === "vendor" && path.endsWith("/CHANGELOG.md"))
      .map(({ path }) => path)
  );
  const apiBoundary = scanApiBoundary(textEntries, { permittedHistoricalPaths });
  for (const row of apiBoundary.legacyImports) violations.push(`legacy @platos/sdk import remains at ${row.path}:${row.line}`);
  for (const row of apiBoundary.deprecatedSubpathImports) violations.push(`deprecated @trigger.dev/sdk/v3 import remains at ${row.path}:${row.line}`);
  for (const row of apiBoundary.misroutedRuntimeImports) violations.push(`durable runtime API is misrouted at ${row.path}:${row.line}`);
  for (const row of apiBoundary.misroutedClientImports) violations.push(`Platos client API is misrouted at ${row.path}:${row.line}`);
  if (apiBoundary.runtimeImports.length === 0) violations.push("runtime API boundary scan is vacuous");
  if (apiBoundary.clientImports.length === 0) violations.push("Platos client API boundary scan is vacuous");

  let reviewedSource;
  try {
    const provenance = validateReviewedSourceProvenance(root, {
      reviewedSourceBase: options.reviewedSourceBase,
      reviewedSourceCommit: options.reviewedSourceCommit,
      reviewedSourceRoots: options.reviewedSourceRoots,
      allowedAdditions: options.allowedPrimaryBaseAdditions,
      allowedAdditionalDeletions: options.allowedAdditionalIntegrationDeletions,
      integrationDeletedPaths: deletionSet.actual,
      integrationBaseEntries: baseEntries,
    });
    reviewedSource = provenance.receipt;
    violations.push(...provenance.violations);
  } catch (error) {
    reviewedSource = {
      base: options.reviewedSourceBase ?? REVIEWED_SOURCE_BASE,
      commit: options.reviewedSourceCommit ?? REVIEWED_SOURCE_COMMIT,
      branch: "vorflux/win253-vendored-build",
      derivationError: error.message.split("\n")[0],
    };
    violations.push(`reviewed source provenance could not be derived: ${reviewedSource.derivationError}`);
  }

  const protectedTrees = validateProtectedTrees(root, currentPaths, violations);
  const integration = validateIntegration(root, deletionSet.actual, candidateNames, currentPaths, violations);
  const report = {
    schemaVersion: 1,
    workItem: "WIN-253",
    cluster: "vendored-build-sdk",
    reviewedSource,
    integrationBase: {
      sha: INTEGRATION_BASE,
      treeOid: git(root, ["rev-parse", `${INTEGRATION_BASE}^{tree}`]).trim(),
      trackedFiles: treeEntries(root, INTEGRATION_BASE).length,
    },
    packages: manifests,
    deletion: {
      workspaceCount: candidateRoots.length,
      actualFileCount: deletedFiles.length,
      actualBytes: deletedFiles.reduce((total, file) => total + file.bytes, 0),
      manifestSha256: sha256(deletionManifest),
      files: deletedFiles,
    },
    tombstones: {
      roots: candidateRoots,
      inventory: "direct candidate-root existence checks, including tracked, untracked, ignored, and empty retired roots",
      currentTreeViolations: tombstoneViolations,
    },
    restore: {
      argv: ["git", "restore", `--source=${INTEGRATION_BASE}`, "--", ...deletedFiles.map(({ path }) => path)],
      pathspec: deletedFiles.map(({ path }) => path),
    },
    reachability: {
      candidateNames,
      channels: reachability,
      allowedNegativeGuards: allowedGuardRows,
    },
    apiBoundary,
    protectedTrees,
    integration,
    licensing: {
      removedPackageLocalLicenseFiles: deletedFiles.filter(({ path }) => path.endsWith("/LICENSE")).map(({ path }) => path),
      repositoryLicenseSha256: sha256(readFileSync(resolve(root, "LICENSE"))),
      repositoryNoticeSha256: sha256(readFileSync(resolve(root, "NOTICE"))),
    },
  };
  return { report, violations };
}

export function reportText(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function markdownText(report) {
  const protectedRows = report.protectedTrees
    .map(({ path, integrationBaseTreeOid, trackedFiles, byteIdentical }) => `| \`${path}\` | \`${integrationBaseTreeOid}\` | ${trackedFiles} | ${byteIdentical ? "yes" : "no"} |`)
    .join("\n");
  return `# WIN-253 vendored build/SDK retirement\n\n## Result\n\nThe assembled tree removes exactly six inherited Trigger workspaces from integration base \`${report.integrationBase.sha}\`:\n\n${report.packages.map(({ path, name }) => `- \`${path}\` (\`${name}\`)`).join("\n")}\n\nThe executable receipt derives ${report.deletion.actualFileCount} deleted files and ${report.deletion.actualBytes} bytes from Git. The restore argv in \`${REPORT_PATH}\` restores every deleted blob from the integration base and is exercised byte-for-byte by \`scripts/vendored-build-audit.test.mjs\`.\n\n## Reviewed-source provenance\n\nGit derives ${report.reviewedSource.deletion.actualFileCount} reviewed deletions from \`${report.reviewedSource.base}..${report.reviewedSource.commit}\`; all ${report.reviewedSource.integrationCoverage.representedReviewedDeletionCount} are represented in the current integration-base deletion set. The only primary-base path additions are ${report.reviewedSource.integrationCoverage.primaryBaseAdditions.map(({ path }) => `\`${path}\``).join(" and ")}, each explicitly explained in the JSON receipt.\n\n## Consumer and tombstone proof\n\nAll manifest, import, dynamic-load, filesystem-load, TypeScript-reference, script, CI, Docker, test-config, and active-doc channels are empty. The only surviving retired package-name references are the two explicit production negative guards recorded in the JSON receipt. Tombstone checks inspect tracked, untracked, ignored, and empty retired roots.\n\nDurable runtime examples map \`task\`, \`tasks\`, \`runs\`, \`schedules\`, and \`wait\` to \`@trigger.dev/sdk\`. \`PlatosClient\` and the Platos REST/WebSocket surface map to \`@platosdev/client\`; the audit rejects either boundary when routed through the other package.\n\n## Protected Platos SDKs\n\n| Tree | Integration-base tree | Files | Byte-identical |\n| --- | --- | ---: | --- |\n${protectedRows}\n\n## Shared artifacts\n\nThe current lockfile, changesets, vocabulary exceptions, V1 ledger fingerprint, workspace reachability report, SBOM/licence receipts, root manifest, docs, and ignore files are regenerated or checked on the assembled tree. The obsolete \`packages.pin.browser-entry\` ledger rule is absent.\n\n## Rollback\n\nExecute the exact \`restore.argv\` array from \`${REPORT_PATH}\` without shell interpolation. It restores only the ${report.deletion.actualFileCount} Git-derived deletion paths from \`${report.integrationBase.sha}\`.\n`;
}

function main() {
  const mode = process.argv[2] ?? "--check";
  if (!["--check", "--write"].includes(mode) || process.argv.length > 3) {
    console.error("usage: node scripts/vendored-build-audit.mjs [--check|--write]");
    process.exitCode = 2;
    return;
  }
  const { report, violations } = auditRepository(repositoryRoot);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`WIN-253: ${violation}`);
    process.exitCode = 1;
    return;
  }
  const json = reportText(report);
  const markdown = markdownText(report);
  if (mode === "--write") {
    writeFileSync(resolve(repositoryRoot, REPORT_PATH), json);
    writeFileSync(resolve(repositoryRoot, MARKDOWN_PATH), markdown);
    console.log(`wrote ${REPORT_PATH} and ${MARKDOWN_PATH} (${report.deletion.actualFileCount} deletions)`);
    return;
  }
  for (const [path, expected] of [[REPORT_PATH, json], [MARKDOWN_PATH, markdown]]) {
    const file = resolve(repositoryRoot, path);
    if (!existsSync(file) || readFileSync(file, "utf8") !== expected) {
      console.error(`${path} is stale; run pnpm audit:win253-vendored-build --write`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`WIN-253 vendored build audit passed (${report.deletion.actualFileCount} exact deletions)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
