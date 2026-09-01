#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listRepositoryFiles } from "./root-entry-manifest.mjs";

export const OWNER_AUTHORIZATION_BASE = "fcf39fa227cb9265b7e532f14ef181a3b65ff061";
export const INTEGRATION_BASE = "0e3a86661dcaeae1ef8932fb1371a55ff3614c15";
export const COEXISTING_INTEGRATION_BASE = "5eb2d48d82c049e68e53b33701356e3091af532a";
export const REPORT_PATH = "docs/audits/win253-removals/clickhouse-split.json";
export const ADDITIONAL_INTEGRATION_DELETIONS = Object.freeze([
  {
    path: "patches/@upstash__ratelimit.patch",
    reason: "WIN-253 webapp dependency pruning removed the retired, unconfigured Upstash patch.",
  },
  {
    path: "patches/@window-splitter__state@0.4.1.patch",
    reason: "WIN-253 webapp dependency pruning removed the retired window-splitter patch.",
  },
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidateRoots = [
  "internal-packages/clickhouse",
  "internal-packages/replication",
  "internal-packages/tsql",
];
const exactRemovedPaths = new Set(["patches/antlr4ts@0.5.0-alpha.4.patch"]);
const schemaRoot = "internal-packages/clickhouse/schema/";
const auditOwnedPaths = new Set([
  REPORT_PATH,
  "docs/audits/win253-removals/clickhouse-split.md",
  "scripts/clickhouse-split-audit.mjs",
  "scripts/clickhouse-split-audit.test.mjs",
]);
const immutableConsumers = [
  "apps/agent/src/observability/observability-erasure-contract.test.ts",
  "apps/webapp/scripts/entrypoint.sh",
  "docker-compose.deploy.yml",
  "internal-packages/tenancy-database/Dockerfile.migrations",
  "internal-packages/testcontainers/src/utils.ts",
];
const integrationConsumers = new Map([
  [
    "apps/webapp/Dockerfile.platos",
    [
      "COPY --chown=node:node internal-packages/clickhouse/schema /platos/internal-packages/clickhouse/schema",
      "COPY --from=builder --chown=node:node /platos/internal-packages/clickhouse/schema /platos/internal-packages/clickhouse/schema",
    ],
  ],
  [
    "docker-compose.platos.yml",
    [
      "dockerfile: internal-packages/tenancy-database/Dockerfile.migrations",
      "PLATOS_CLICKHOUSE_TIMEOUT_MS",
    ],
  ],
]);
const sourceConsumer = "apps/agent/src/observability/clickhouse-observability-sink.ts";
const sourceConsumerNeedle = "internal-packages/clickhouse/schema/033_create_platos_observability_v1.sql";
const observabilityMigration =
  "internal-packages/tenancy-database/prisma/migrations/20260824010000_win144_observability_retry_vocabulary/migration.sql";

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

export function isAuthorizedRemoval(path) {
  if (exactRemovedPaths.has(path)) return true;
  if (path.startsWith(schemaRoot)) return false;
  return candidateRoots.some((root) => path.startsWith(`${root}/`));
}

export function isTombstonedPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const marker = normalized.indexOf("internal-packages/");
  const repositoryPath = marker === -1 ? normalized.replace(/^\.\//u, "") : normalized.slice(marker);
  if (repositoryPath === schemaRoot.slice(0, -1) || repositoryPath.startsWith(schemaRoot)) return false;
  return candidateRoots.some((root) => repositoryPath === root || repositoryPath.startsWith(`${root}/`));
}

export function validateCurrentTreeTombstones(paths) {
  return paths.filter(isTombstonedPath).sort();
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

function treeEntries(root, revision) {
  return parseTreeEntries(git(root, ["ls-tree", "-r", "-l", "-z", revision]));
}

function readBlobBatch(root, entries) {
  if (entries.length === 0) return new Map();
  const child = spawnSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${entries.map(({ oid }) => oid).join("\n")}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(child.stderr.toString("utf8"));
  const output = child.stdout;
  const blobs = new Map();
  let offset = 0;
  for (const entry of entries) {
    const newline = output.indexOf(10, offset);
    if (newline === -1) throw new Error(`missing cat-file header for ${entry.path}`);
    const header = output.subarray(offset, newline).toString("utf8").split(" ");
    const size = Number(header[2]);
    const start = newline + 1;
    const end = start + size;
    blobs.set(entry.path, output.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

function currentPaths(root) {
  return listRepositoryFiles(root);
}

function retiredRootFilesystemPaths(root) {
  const paths = [];
  const walk = (repositoryPath) => {
    const absolute = resolve(root, repositoryPath);
    if (!existsSync(absolute)) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const path = `${repositoryPath}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  for (const candidateRoot of candidateRoots) walk(candidateRoot);
  return paths.sort();
}

function actualDeletedPaths(root, base) {
  return git(root, ["diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", base, "--"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

function deletedPathsBetween(root, base, target) {
  return git(root, ["diff", "--no-renames", "--name-only", "--diff-filter=D", "-z", base, target, "--"])
    .split("\0")
    .filter(Boolean)
    .sort();
}

export function validateDeletionSet(ownerAuthorizedPaths, actualPaths) {
  const expected = ownerAuthorizedPaths.filter(isAuthorizedRemoval).sort();
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

function isRelevant(path) {
  const name = path.split("/").at(-1);
  return (
    name === "package.json" ||
    name === "LICENSE" ||
    name === "NOTICE" ||
    name === "NOTICE.md" ||
    /(?:^|\/)(?:Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml)$/u.test(path) ||
    /(?:^|\/)(?:tsconfig[^/]*\.json|vitest\.config\.[^/]+|playwright[^/]*\.[^/]+)$/u.test(path) ||
    /\.(?:[cm]?[jt]sx?|mdx?|g4|interp|tokens|ya?ml|sh)$/u.test(path) ||
    path.startsWith(".github/")
  );
}

function textEntriesFromTree(root, entries) {
  const selected = entries.filter(({ path, bytes }) => isRelevant(path) && bytes <= 2 * 1024 * 1024);
  const blobs = readBlobBatch(root, selected);
  return selected.flatMap(({ path }) => {
    const blob = blobs.get(path);
    return blob.includes(0) ? [] : [{ path, content: blob.toString("utf8") }];
  });
}

function textEntriesFromWorktree(root, paths) {
  return paths.flatMap((path) => {
    if (!isRelevant(path) || auditOwnedPaths.has(path)) return [];
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return [];
    const value = readFileSync(absolute);
    return value.includes(0) || value.length > 2 * 1024 * 1024
      ? []
      : [{ path, content: value.toString("utf8") }];
  });
}

function candidateTokens(candidateNames) {
  return [
    ...candidateNames,
    "internal-packages/clickhouse/Dockerfile",
    "internal-packages/clickhouse/package.json",
    "internal-packages/clickhouse/src",
    "internal-packages/replication",
    "internal-packages/tsql",
    "antlr4ts",
  ];
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
  const patterns = [
    ["side-effect-import", /\bimport\s*["']([^"']+)["']/gu],
    ["dynamic-import", /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu],
    ["static-import", /\b(?:import|export)\s+(?:type\s+)?[^;\n]*?\sfrom\s*["']([^"']+)["']/gu],
    ["static-import", /\brequire(?:\.resolve)?\s*\(\s*["']([^"']+)["']\s*\)/gu],
  ];
  const rows = [];
  for (const [kind, pattern] of patterns) {
    for (const match of entry.content.matchAll(pattern)) {
      if (!candidateNames.some((name) => match[1] === name || match[1].startsWith(`${name}/`))) continue;
      rows.push({
        path: entry.path,
        line: entry.content.slice(0, match.index).split("\n").length,
        kind,
        specifier: match[1],
      });
    }
  }
  return rows;
}

function matchesCandidateName(specifier, candidateNames) {
  return candidateNames.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function filesystemLoaderReferences(entry, candidateNames) {
  const loaderPattern = /\b(?:access|accessSync|createReadStream|createRequire|existsSync|join|lstat|lstatSync|open|openSync|readFile|readFileSync|readdir|readdirSync|realpath|realpathSync|require\.resolve|resolve|stat|statSync)\s*\(([^;\n]*)\)/gu;
  const rows = [];
  for (const match of entry.content.matchAll(loaderPattern)) {
    const literals = [...match[1].matchAll(/["'`]([^"'`\n]+)["'`]/gu)].map((literal) => literal[1]);
    const candidates = [...literals, literals.join("/")];
    const retiredPath = candidates.find(isTombstonedPath);
    if (!retiredPath) continue;
    rows.push({
      path: entry.path,
      line: entry.content.slice(0, match.index).split("\n").length,
      kind: "filesystem-loader",
      value: retiredPath,
    });
  }

  const packageLoaderPatterns = [
    ["create-require-resolve", /\bcreateRequire\s*\([^)]*\)\s*\.resolve\s*\(\s*["']([^"']+)["']\s*\)/gu],
    ["create-require", /\bcreateRequire\s*\([^)]*\)\s*\(\s*["']([^"']+)["']\s*\)/gu],
    ["import-meta-resolve", /\bimport\.meta\.resolve\s*\(\s*["']([^"']+)["']\s*\)/gu],
  ];
  for (const [kind, pattern] of packageLoaderPatterns) {
    for (const match of entry.content.matchAll(pattern)) {
      if (!matchesCandidateName(match[1], candidateNames)) continue;
      rows.push({
        path: entry.path,
        line: entry.content.slice(0, match.index).split("\n").length,
        kind,
        specifier: match[1],
      });
    }
  }

  const aliases = [...entry.content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createRequire\s*\([^)]*\)/gu
  )].map((match) => match[1]);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const aliasPatterns = [
      ["create-require-alias", new RegExp(`\\b${escaped}\\s*\\(\\s*["']([^"']+)["']\\s*\\)`, "gu")],
      ["create-require-alias-resolve", new RegExp(`\\b${escaped}\\s*\\.resolve\\s*\\(\\s*["']([^"']+)["']\\s*\\)`, "gu")],
    ];
    for (const [kind, pattern] of aliasPatterns) {
      for (const match of entry.content.matchAll(pattern)) {
        if (!matchesCandidateName(match[1], candidateNames)) continue;
        rows.push({
          path: entry.path,
          line: entry.content.slice(0, match.index).split("\n").length,
          kind,
          alias,
          specifier: match[1],
        });
      }
    }
  }
  return rows;
}

function walkStrings(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach((entry) => walkStrings(entry, visit));
  else if (value && typeof value === "object") Object.entries(value).forEach(([key, entry]) => {
    visit(key);
    walkStrings(entry, visit);
  });
}

export function scanReachability(entries, candidateNames) {
  const tokens = candidateTokens(candidateNames);
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
      "licenses",
      "generated",
    ].map((channel) => [channel, []])
  );

  for (const entry of entries) {
    const name = entry.path.split("/").at(-1);
    if (name === "package.json") {
      try {
        const manifest = JSON.parse(entry.content);
        for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
          for (const dependency of Object.keys(manifest[section] ?? {})) {
            if (candidateNames.includes(dependency)) {
              channels["package-dependencies"].push({ path: entry.path, section, dependency });
            }
          }
        }
        for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
          for (const reference of tokenReferences({ path: entry.path, content: String(command) }, tokens, "package-script")) {
            channels.scripts.push({ ...reference, script });
          }
        }
      } catch {
        // Invalid manifests are handled by install and package-policy gates.
      }
    }

    if (/\.[cm]?[jt]sx?$/u.test(entry.path)) {
      for (const reference of moduleReferences(entry, candidateNames)) channels[`${reference.kind}s`].push(reference);
      channels["filesystem-loaders"].push(...filesystemLoaderReferences(entry, candidateNames));
    }

    if (/\/(?:tsconfig[^/]*\.json)$/u.test(`/${entry.path}`)) {
      try {
        const parsed = JSON.parse(entry.content);
        walkStrings(parsed, (value) => {
          if (tokens.some((token) => value.includes(token))) {
            channels["ts-references"].push({ path: entry.path, kind: "ts-reference", value });
          }
        });
      } catch {
        // TypeScript itself reports malformed configs.
      }
    }

    const genericChannels = [];
    if (entry.path.startsWith(".github/")) genericChannels.push("ci");
    if (entry.path.startsWith("scripts/") || /\.sh$/u.test(entry.path)) genericChannels.push("scripts");
    if (/(?:^|\/)(?:Dockerfile[^/]*|[^/]*compose[^/]*\.ya?ml)$/u.test(entry.path)) genericChannels.push("docker");
    if (/(?:vitest|playwright|jest|test[^/]*config|tsconfig\.test)/u.test(name)) genericChannels.push("test-config");
    if (/\.(?:md|mdx)$/u.test(entry.path)) genericChannels.push("docs");
    if (/^(?:LICENSE|NOTICE|NOTICE\.md)$/u.test(name)) genericChannels.push("licenses");
    if (/(?:generated|\.interp$|\.tokens$|TSQL(?:Lexer|Parser)(?:Visitor)?\.ts$)/u.test(entry.path)) {
      genericChannels.push("generated");
    }
    for (const channel of genericChannels) channels[channel].push(...tokenReferences(entry, tokens, channel));
  }

  for (const references of Object.values(channels)) {
    references.sort((left, right) =>
      left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0) || JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  return channels;
}

function withScope(channels) {
  return Object.fromEntries(Object.entries(channels).map(([channel, references]) => [
    channel,
    references.map((reference) => ({
      ...reference,
      scope: isAuthorizedRemoval(reference.path) ? "removed-cluster" : "external",
    })),
  ]));
}

function ownerAuthorizationFileRecord(entry, content) {
  return {
    path: entry.path,
    mode: entry.mode,
    ownerAuthorizationBlobOid: entry.oid,
    ownerAuthorizationSha256: sha256(content),
    bytes: entry.bytes,
  };
}

function integrationBaseFileRecord(entry, content) {
  return {
    path: entry.path,
    mode: entry.mode,
    integrationBaseBlobOid: entry.oid,
    integrationBaseSha256: sha256(content),
    bytes: entry.bytes,
  };
}

function validateProtected(root, ownerAuthorizationEntries, ownerAuthorizationBlobs, violations) {
  const schemaEntries = ownerAuthorizationEntries.filter(({ path }) => path.startsWith(schemaRoot));
  const protectedEntries = [...schemaEntries, ownerAuthorizationEntries.find(({ path }) => path === observabilityMigration)];
  const records = [];
  for (const entry of protectedEntries) {
    if (!entry) throw new Error(`owner authorization baseline is missing ${observabilityMigration}`);
    const current = resolve(root, entry.path);
    if (!existsSync(current)) violations.push(`protected file is missing: ${entry.path}`);
    else if (sha256(readFileSync(current)) !== sha256(ownerAuthorizationBlobs.get(entry.path))) {
      violations.push(`protected file changed from owner authorization baseline: ${entry.path}`);
    }
    records.push(ownerAuthorizationFileRecord(entry, ownerAuthorizationBlobs.get(entry.path)));
  }
  return records;
}

function validateConsumers(root, ownerAuthorizationByPath, ownerAuthorizationBlobs, violations) {
  const records = [];
  for (const path of immutableConsumers) {
    const entry = ownerAuthorizationByPath.get(path);
    const current = readFileSync(resolve(root, path));
    if (sha256(current) !== sha256(ownerAuthorizationBlobs.get(path))) {
      violations.push(`shipping schema consumer changed from owner authorization baseline: ${path}`);
    }
    records.push({ path, ownerAuthorizationSha256: sha256(ownerAuthorizationBlobs.get(path)), currentSha256: sha256(current) });
  }
  for (const [path, requiredReferences] of integrationConsumers) {
    const entry = ownerAuthorizationByPath.get(path);
    const current = readFileSync(resolve(root, path));
    const text = current.toString("utf8");
    for (const reference of requiredReferences) {
      if (!text.includes(reference)) violations.push(`${path} no longer retains ${reference}`);
    }
    records.push({
      path,
      ownerAuthorizationSha256: sha256(ownerAuthorizationBlobs.get(path)),
      currentSha256: sha256(current),
      requiredReferences,
    });
  }
  const source = readFileSync(resolve(root, sourceConsumer));
  if (!source.toString("utf8").includes(sourceConsumerNeedle)) {
    violations.push(`${sourceConsumer} no longer points operators to the retained schema`);
  }
  records.push({
    path: sourceConsumer,
    ownerAuthorizationSha256: sha256(ownerAuthorizationBlobs.get(sourceConsumer)),
    currentSha256: sha256(source),
    requiredReference: sourceConsumerNeedle,
  });
  return records;
}

function validateIntegration(root, actualDeleted, ownerAuthorizationBlobs, violations) {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (Object.hasOwn(packageJson.pnpm?.patchedDependencies ?? {}, "antlr4ts@0.5.0-alpha.4")) {
    violations.push("package.json still declares the retired antlr4ts patch");
  }
  if (existsSync(resolve(root, "patches/antlr4ts@0.5.0-alpha.4.patch"))) {
    violations.push("retired antlr4ts patch file still exists");
  }
  const lockfile = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  for (const token of ["internal-packages/clickhouse:", "internal-packages/replication:", "internal-packages/tsql:", "antlr4ts"] ) {
    if (lockfile.includes(token)) violations.push(`pnpm-lock.yaml retains ${token}`);
  }

  const ownerAuthorizationVocabulary = JSON.parse(ownerAuthorizationBlobs.get("docs/vocabulary-boundary-exceptions.json").toString("utf8"));
  const currentVocabulary = JSON.parse(readFileSync(resolve(root, "docs/vocabulary-boundary-exceptions.json"), "utf8"));
  const deleted = new Set(actualDeleted);
  const staleRows = currentVocabulary.exceptions.filter(({ path }) => deleted.has(path));
  if (staleRows.length > 0) violations.push(`vocabulary manifest retains ${staleRows.length} deleted-path row(s)`);
  const previousSchemaRows = ownerAuthorizationVocabulary.exceptions.filter(({ path }) => path.startsWith(schemaRoot));
  const currentSchemaRows = currentVocabulary.exceptions.filter(({ path }) => path.startsWith(schemaRoot));
  if (JSON.stringify(currentSchemaRows) !== JSON.stringify(previousSchemaRows)) {
    violations.push("vocabulary schema exception rows changed instead of being retained exactly");
  }
  return {
    lockfileSha256: sha256(lockfile),
    vocabularySha256: sha256(readFileSync(resolve(root, "docs/vocabulary-boundary-exceptions.json"))),
    retainedSchemaVocabularyRows: currentSchemaRows.length,
    deletedPathVocabularyRows: staleRows.length,
  };
}

export function auditRepository(root = repositoryRoot) {
  const violations = [];
  const ownerAuthorizationEntries = treeEntries(root, OWNER_AUTHORIZATION_BASE);
  const ownerAuthorizationByPath = new Map(ownerAuthorizationEntries.map((entry) => [entry.path, entry]));
  const integrationBaseEntries = treeEntries(root, INTEGRATION_BASE);
  const integrationBaseByPath = new Map(integrationBaseEntries.map((entry) => [entry.path, entry]));
  const deleted = actualDeletedPaths(root, INTEGRATION_BASE);
  const coexistingDeleted = deletedPathsBetween(root, INTEGRATION_BASE, COEXISTING_INTEGRATION_BASE)
    .filter((path) => !isAuthorizedRemoval(path));
  const coexistingDeletedSet = new Set(coexistingDeleted);
  const additionalDeletionSet = new Set(ADDITIONAL_INTEGRATION_DELETIONS.map(({ path }) => path));
  const deletedSet = new Set(deleted);
  for (const { path } of ADDITIONAL_INTEGRATION_DELETIONS) {
    if (!deletedSet.has(path)) violations.push(`reviewed additional integration deletion is absent: ${path}`);
  }
  const clickhouseDeleted = deleted.filter(
    (path) => isAuthorizedRemoval(path) || (!coexistingDeletedSet.has(path) && !additionalDeletionSet.has(path))
  );
  const currentTreePaths = currentPaths(root);
  const currentTreePathSet = new Set(currentTreePaths);
  const ignoredRetiredRootPaths = retiredRootFilesystemPaths(root)
    .filter((path) => !currentTreePathSet.has(path));
  const tombstoneInventory = [...new Set([...currentTreePaths, ...ignoredRetiredRootPaths])];
  const deletionSet = validateDeletionSet(ownerAuthorizationEntries.map(({ path }) => path), clickhouseDeleted);
  for (const path of deletionSet.missing) violations.push(`owner-authorized path was not deleted: ${path}`);
  for (const path of deletionSet.unrecorded) violations.push(`unrecorded deletion outside cluster authorization: ${path}`);
  const tombstoneViolations = validateCurrentTreeTombstones(tombstoneInventory);
  for (const path of tombstoneViolations) violations.push(`current-tree tombstone violated: ${path}`);

  const missingIntegrationBasePaths = deletionSet.actual.filter((path) => !integrationBaseByPath.has(path));
  for (const path of missingIntegrationBasePaths) {
    violations.push(`deleted path is missing from integration base: ${path}`);
  }
  const deletionEntries = deletionSet.actual.map((path) => integrationBaseByPath.get(path)).filter(Boolean);
  const integrationBaseBlobs = readBlobBatch(root, deletionEntries);

  const ownerAuthorizationMetadataEntries = [
    ...ownerAuthorizationEntries.filter(({ path }) => path.startsWith(schemaRoot) || path === observabilityMigration),
    ...immutableConsumers.map((path) => ownerAuthorizationByPath.get(path)),
    ...[...integrationConsumers.keys()].map((path) => ownerAuthorizationByPath.get(path)),
    ownerAuthorizationByPath.get(sourceConsumer),
    ownerAuthorizationByPath.get("docs/vocabulary-boundary-exceptions.json"),
  ];
  const ownerAuthorizationBlobs = readBlobBatch(root, [...new Map(ownerAuthorizationMetadataEntries.map((entry) => [entry.path, entry])).values()]);
  const removedFiles = deletionEntries.map((entry) => integrationBaseFileRecord(entry, integrationBaseBlobs.get(entry.path)));
  const manifest = removedFiles
    .map(({ path, integrationBaseBlobOid, integrationBaseSha256, bytes }) => `${path}\0${integrationBaseBlobOid}\0${integrationBaseSha256}\0${bytes}\n`)
    .join("");

  const relevantOwnerAuthorization = textEntriesFromTree(root, ownerAuthorizationEntries);
  const candidateManifests = candidateRoots.map((path) => {
    const manifestPath = `${path}/package.json`;
    const manifest = JSON.parse(relevantOwnerAuthorization.find((entry) => entry.path === manifestPath).content);
    return { path: manifestPath, name: manifest.name, dependencies: Object.fromEntries(
      ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
        .filter((section) => manifest[section])
        .map((section) => [section, manifest[section]])
    ) };
  });
  const candidateNames = candidateManifests.map(({ name }) => name);
  const ownerAuthorizationChannels = withScope(scanReachability(relevantOwnerAuthorization, candidateNames));
  const currentChannels = withScope(scanReachability(textEntriesFromWorktree(root, currentTreePaths), candidateNames));
  for (const channel of [
    "package-dependencies", "static-imports", "side-effect-imports", "dynamic-imports", "filesystem-loaders", "ts-references", "ci", "scripts", "docker", "test-config", "licenses", "generated",
  ]) {
    const external = currentChannels[channel].filter(({ scope }) => scope === "external");
    if (external.length > 0) violations.push(`current executable channel ${channel} retains ${external.length} candidate reference(s)`);
  }

  const protectedFiles = validateProtected(root, ownerAuthorizationEntries, ownerAuthorizationBlobs, violations);
  const consumers = validateConsumers(root, ownerAuthorizationByPath, ownerAuthorizationBlobs, violations);
  const integration = validateIntegration(root, deletionSet.actual, ownerAuthorizationBlobs, violations);
  const report = {
    schemaVersion: 5,
    workItem: "WIN-253",
    cluster: "clickhouse-split",
    ownerAuthorization: {
      sha: OWNER_AUTHORIZATION_BASE,
      treeOid: git(root, ["rev-parse", `${OWNER_AUTHORIZATION_BASE}^{tree}`]).trim(),
      trackedFiles: ownerAuthorizationEntries.length,
    },
    integrationBase: {
      sha: INTEGRATION_BASE,
      treeOid: git(root, ["rev-parse", `${INTEGRATION_BASE}^{tree}`]).trim(),
      trackedFiles: integrationBaseEntries.length,
    },
    coexistingIntegrationBase: {
      sha: COEXISTING_INTEGRATION_BASE,
      treeOid: git(root, ["rev-parse", `${COEXISTING_INTEGRATION_BASE}^{tree}`]).trim(),
      authorizedExternalDeletionCount: coexistingDeleted.length,
      authorizedExternalDeletionManifestSha256: sha256(
        coexistingDeleted.map((path) => `${path}\n`).join("")
      ),
    },
    reviewedAdditionalIntegrationDeletions: ADDITIONAL_INTEGRATION_DELETIONS,
    deletion: {
      actualFileCount: removedFiles.length,
      actualBytes: removedFiles.reduce((total, file) => total + file.bytes, 0),
      manifestSha256: sha256(manifest),
      files: removedFiles,
    },
    tombstones: {
      roots: candidateRoots,
      schemaException: schemaRoot,
      inventory: "listRepositoryFiles plus retired-root filesystem walk for ignored files and symlinks",
      ignoredRetiredRootPaths,
      currentTreeViolations: tombstoneViolations,
    },
    restore: {
      argv: ["git", "restore", `--source=${INTEGRATION_BASE}`, "--", ...removedFiles.map(({ path }) => path)],
      pathspec: removedFiles.map(({ path }) => path),
    },
    packages: { candidates: candidateManifests },
    reachability: {
      ownerAuthorization: ownerAuthorizationChannels,
      current: currentChannels,
    },
    protected: {
      ownerAuthorizationSchemaTreeOid: git(root, ["rev-parse", `${OWNER_AUTHORIZATION_BASE}:internal-packages/clickhouse/schema`]).trim(),
      files: protectedFiles,
      consumers,
    },
    integration,
  };
  return { report, violations };
}

export function reportText(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function main() {
  const mode = process.argv[2] ?? "--check";
  if (!["--check", "--write"].includes(mode) || process.argv.length > 3) {
    console.error("usage: node scripts/clickhouse-split-audit.mjs [--check|--write]");
    process.exitCode = 2;
    return;
  }
  const { report, violations } = auditRepository(repositoryRoot);
  if (violations.length > 0) {
    for (const violation of violations) console.error(`WIN-253: ${violation}`);
    process.exitCode = 1;
    return;
  }
  const expected = reportText(report);
  const reportFile = resolve(repositoryRoot, REPORT_PATH);
  if (mode === "--write") {
    writeFileSync(reportFile, expected);
    console.log(`wrote ${relative(repositoryRoot, reportFile)} (${report.deletion.actualFileCount} deletions)`);
    return;
  }
  if (!existsSync(reportFile) || readFileSync(reportFile, "utf8") !== expected) {
    console.error(`${REPORT_PATH} is stale; run pnpm audit:win253-clickhouse-split -- --write`);
    process.exitCode = 1;
    return;
  }
  console.log(`WIN-253 ClickHouse split audit passed (${report.deletion.actualFileCount} exact deletions)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
