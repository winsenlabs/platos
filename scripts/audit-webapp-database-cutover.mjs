#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PHASES = ["inventory", "webapp-cutover", "mode-c-removal", "final"];

export const DEFAULT_ALLOWLIST_PATH = "scripts/audit-webapp-database-cutover.allowlist.json";

export const SCOPES = Object.freeze({
  activeWebapp: {
    paths: ["apps/webapp/app", "apps/webapp/server.ts", "apps/webapp/sentry.server.ts"],
    reason:
      "Runtime webapp modules include Remix route registrations and all active database call sites.",
  },
  runtimeOwnership: {
    paths: [
      "apps/webapp/package.json",
      "apps/agent/src",
      "apps/agent/package.json",
      "docker-compose.platos.yml",
      "deploy",
      "internal-packages/run-engine/package.json",
    ],
    reason:
      "Package, agent, Compose, and deploy surfaces can keep local Mode-C workers or a second persistence owner active.",
  },
  cleanSchema: {
    paths: ["internal-packages/tenancy-database/prisma/schema.prisma"],
    reason: "The clean tenancy schema is the only allowed PostgreSQL target contract.",
  },
  referenceSchema: {
    paths: ["internal-packages/database/prisma/schema.prisma"],
    reason:
      "The inherited schema is read only to derive legacy-only model delegates and physical table names; it is never audited as active code.",
  },
});

export const EXCLUDED_PATH_PARTS = Object.freeze([
  "node_modules",
  "build",
  "dist",
  "generated",
  "__generated__",
  "__tests__",
  "fixtures",
  "legacy-prisma",
  "docs",
]);

// These are integrations owned outside the canonical PostgreSQL contract. Their
// vocabulary must not be mistaken for a forbidden second PostgreSQL database or
// a local Trigger persistence bridge.
export const ALLOWED_EXTERNAL_TRIGGER_VOCABULARY =
  /(?:@trigger\.dev\/(?:sdk|core|api)|\bexternal\s+Trigger\b|\bTrigger(?:SDK|Sdk|API|Api|Session)\b)/i;
export const ALLOWED_EXTERNAL_STORAGE_VOCABULARY =
  /(?:\bClickHouse\b|\bobject[-_ ]?stor(?:e|age)\b|\bS3\b|\bMinIO\b)/i;
const ALLOWED_NON_DATABASE_DUAL_WRITE_VOCABULARY =
  /(?:\bapproval\b|\bledger\b|\btransition\b|\bllm_metrics_v1\b|\b_llmMetrics\b)/i;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const OWNERSHIP_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".json",
  ".yaml",
  ".yml",
  ".sh",
  ".env",
]);
const TEST_FILE_RE = /\.(?:test|spec|stories)\.[^.]+$/;
const PRISMA_METHODS = [
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
];

const TRIGGER_MODEL_RE =
  /^(?:Trigger\w*|RuntimeEnvironment|OrgMember(?:Invite)?|Task|Run|Deployment|Schedule|Queue|Worker|BackgroundWorker.*|TaskRun.*|TaskEvent(?:Partitioned)?|TaskQueue|BatchTaskRun.*|Waitpoint.*|Checkpoint(?:RestoreEvent)?|Worker(?:Instance|InstanceGroup|GroupToken|Deployment|DeploymentPromotion).*|TaskSchedule(?:Instance)?|EnvironmentVariable(?:Value)?|RuntimeEnvironmentSession|RunEngine\w*)$/;

const ARCHITECTURE_PATTERNS = [
  {
    token: "second-database",
    regex:
      /\b(?:second(?:ary)?|parallel|additional)[-_ ]+(?:postgres(?:ql)?[-_ ]+)?(?:db|database|datastore)\b|\b(?:LEGACY|SECONDARY|PARALLEL|TENANCY)_DATABASE_URL\b/gi,
  },
  {
    token: "database-sync",
    regex:
      /\b(?:(?:database|datastore|postgres(?:ql)?|prisma)[-_ ]+sync(?:hroniz(?:e|ation))?|sync(?:hroniz(?:e|ation))?[-_ ]+(?:database|datastore|postgres(?:ql)?|prisma))\b/gi,
  },
  {
    token: "dual-write",
    regex: /\b(?:dual|double)[-_ ]+writ(?:e|es|ing)\b/gi,
  },
  {
    token: "database-fallback",
    regex:
      /\b(?:(?:database|datastore|postgres(?:ql)?|prisma)[-_ ]+fallback|fallback[-_ ]+(?:read[-_ ]+)?(?:database|datastore|postgres(?:ql)?|prisma))\b/gi,
  },
  {
    token: "database-bridge",
    regex:
      /\b(?:(?:database|datastore|postgres(?:ql)?|prisma|schema)[-_ ]+bridge|bridge[-_ ]+(?:database|datastore|postgres(?:ql)?|prisma|schema|client|store))\b/gi,
  },
];

function normalizePath(path) {
  return path.split(sep).join("/");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function isIgnoredPath(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  return EXCLUDED_PATH_PARTS.some((part) => parts.includes(part)) || TEST_FILE_RE.test(normalized);
}

function walkFiles(root, relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) return [];
  if (statSync(absolutePath).isFile()) return isIgnoredPath(relativePath) ? [] : [relativePath];

  const files = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const child = normalizePath(join(relativePath, entry.name));
    if (isIgnoredPath(child)) continue;
    if (entry.isDirectory()) files.push(...walkFiles(root, child));
    else files.push(child);
  }
  return files;
}

function sourceFiles(root, paths) {
  return paths
    .flatMap((path) => walkFiles(root, path))
    .filter((path) => SOURCE_EXTENSIONS.has(extname(path)))
    .sort();
}

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function lineAndExcerpt(source, index) {
  const line = source.slice(0, index).split("\n").length;
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  const lineEnd = source.indexOf("\n", index);
  return {
    line,
    excerpt: source
      .slice(lineStart, lineEnd === -1 ? source.length : lineEnd)
      .trim()
      .slice(0, 240),
  };
}

function finding(source, category, path, token, index = 0) {
  const location = lineAndExcerpt(source, index);
  return { category, path: normalizePath(path), token, ...location };
}

export function parsePrismaModels(source) {
  const models = [];
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mappedName = [...match[2].matchAll(/@@map\("([^"]+)"\)/g)].at(-1)?.[1];
    models.push({ name: match[1], table: mappedName ?? match[1], index: match.index });
  }
  return models;
}

function addImportFindings(findings, root, files) {
  const importRe =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["'](@platos\/database(?:\/[^"']*)?)["']/g;
  for (const path of files) {
    const source = read(root, path);
    for (const match of source.matchAll(importRe)) {
      findings.push(finding(source, "legacy-import", path, match[1], match.index));
    }
  }

  const packagePath = "apps/webapp/package.json";
  if (existsSync(join(root, packagePath))) {
    const source = read(root, packagePath);
    const packageJson = JSON.parse(source);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      if (packageJson[section]?.["@platos/database"]) {
        const index = source.indexOf('"@platos/database"');
        findings.push(
          finding(source, "legacy-import", packagePath, "@platos/database dependency", index)
        );
      }
    }
  }
}

function addDelegateFindings(findings, root, files, legacyModels, cleanModels) {
  const cleanNames = new Set(cleanModels.map((model) => model.name));
  const legacyOnly = legacyModels.filter((model) => !cleanNames.has(model.name));
  const methods = PRISMA_METHODS.join("|");

  for (const path of files) {
    const source = read(root, path);
    for (const model of legacyOnly) {
      const delegate = lowerFirst(model.name);
      const delegateRe = new RegExp(
        `(?:\\?\\.|\\.)${escapeRegex(delegate)}\\s*\\.\\s*(?:${methods})\\s*\\(`,
        "g"
      );
      for (const match of source.matchAll(delegateRe)) {
        findings.push(finding(source, "legacy-delegate", path, delegate, match.index));
      }
    }
  }
}

function addRawTableFindings(findings, root, files, legacyModels, cleanModels) {
  const cleanTables = new Set(cleanModels.map((model) => model.table));
  const legacyOnlyTables = [
    ...new Set(
      legacyModels.filter((model) => !cleanTables.has(model.table)).map((model) => model.table)
    ),
  ].sort();

  for (const path of files) {
    const source = read(root, path);
    for (const table of legacyOnlyTables) {
      const tableRe = new RegExp(
        `\\b(?:DELETE\\s+FROM|FROM|JOIN|UPDATE|INTO|TABLE|REFERENCES)\\s+` +
          `(?:(?:\\$\\{[^}]+\\}|["'\\w]+)\\s*\\.\\s*)?["']?(${escapeRegex(table)})["']?\\b`,
        "gi"
      );
      for (const match of source.matchAll(tableRe)) {
        const tableOffset = match[0].toLowerCase().lastIndexOf(table.toLowerCase());
        findings.push(
          finding(source, "legacy-raw-table", path, table, match.index + Math.max(tableOffset, 0))
        );
      }
    }
  }
}

function addRouteAndWorkerFindings(findings, root, webappFiles, ownershipFiles) {
  for (const path of webappFiles) {
    if (/^apps\/webapp\/app\/routes\/engine\.v\d+\./.test(path)) {
      findings.push({
        category: "local-engine-route",
        path,
        token: path.slice("apps/webapp/app/routes/".length),
        line: 1,
        excerpt: "Remix file-convention route registration",
      });
    }
    if (path.startsWith("apps/webapp/app/runEngine/")) {
      findings.push({
        category: "local-engine-surface",
        path,
        token: "apps/webapp/app/runEngine",
        line: 1,
        excerpt: "Active local run-engine module",
      });
    }
  }

  const allFiles = [...new Set([...webappFiles, ...ownershipFiles])].sort();
  const packageImportRe = /["'](@internal\/(?:run-engine|schedule-engine))["']/g;
  const workerTokenRe =
    /\b(WORKER_MODE|MANAGED_WORKER_SECRET)\b(?=\s*:)|\b(?:process\.env|env)\.(WORKER_MODE|MANAGED_WORKER_SECRET)\b|\$\{(WORKER_MODE|MANAGED_WORKER_SECRET)\b/g;
  for (const path of allFiles) {
    const source = read(root, path);
    for (const match of source.matchAll(packageImportRe)) {
      findings.push(finding(source, "local-engine-surface", path, match[1], match.index));
    }
    for (const match of source.matchAll(workerTokenRe)) {
      const token = match[1] ?? match[2] ?? match[3];
      findings.push(finding(source, "local-worker-surface", path, token, match.index));
    }
  }

  for (const path of [
    "apps/agent/src/trigger-worker.ts",
    "internal-packages/run-engine/package.json",
  ]) {
    if (existsSync(join(root, path))) {
      findings.push({
        category: "local-worker-surface",
        path,
        token: "file-exists",
        line: 1,
        excerpt: "Local Trigger/Mode-C worker surface exists",
      });
    }
  }

  const composePath = "docker-compose.platos.yml";
  if (existsSync(join(root, composePath))) {
    const source = read(root, composePath);
    for (const match of source.matchAll(/^  worker:\s*$/gm)) {
      findings.push(
        finding(source, "local-worker-surface", composePath, "worker service", match.index)
      );
    }
  }
}

function addArchitectureFindings(findings, root, files) {
  for (const path of files) {
    const source = read(root, path);
    for (const pattern of ARCHITECTURE_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(source))) {
        const context = source.slice(
          Math.max(0, match.index - 240),
          match.index + match[0].length + 240
        );
        if (
          ALLOWED_EXTERNAL_STORAGE_VOCABULARY.test(context) ||
          ALLOWED_EXTERNAL_STORAGE_VOCABULARY.test(path) ||
          (pattern.token === "dual-write" &&
            ALLOWED_NON_DATABASE_DUAL_WRITE_VOCABULARY.test(context))
        ) {
          continue;
        }
        findings.push(finding(source, "forbidden-architecture", path, pattern.token, match.index));
      }
    }
  }
}

function addCleanSchemaFindings(findings, schemaPath, schemaSource, cleanModels) {
  for (const model of cleanModels) {
    if (!TRIGGER_MODEL_RE.test(model.name)) continue;
    findings.push(
      finding(schemaSource, "trigger-owned-clean-model", schemaPath, model.name, model.index)
    );
  }
}

function sortFindings(findings) {
  return findings.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.path.localeCompare(b.path) ||
      a.token.localeCompare(b.token) ||
      a.line - b.line ||
      a.excerpt.localeCompare(b.excerpt)
  );
}

export function inventoryRepository(root) {
  const absoluteRoot = resolve(root);
  const webappFiles = sourceFiles(absoluteRoot, SCOPES.activeWebapp.paths);
  const ownershipFiles = SCOPES.runtimeOwnership.paths
    .flatMap((path) => walkFiles(absoluteRoot, path))
    .filter(
      (path) => OWNERSHIP_EXTENSIONS.has(extname(path)) || /(?:^|\/)Dockerfile(?:\.|$)/.test(path)
    )
    .filter((path) => !isIgnoredPath(path))
    .filter((path, index, values) => values.indexOf(path) === index)
    .sort();

  const legacySchemaPath = SCOPES.referenceSchema.paths[0];
  const cleanSchemaPath = SCOPES.cleanSchema.paths[0];
  const legacySchemaSource = existsSync(join(absoluteRoot, legacySchemaPath))
    ? read(absoluteRoot, legacySchemaPath)
    : "";
  const cleanSchemaSource = existsSync(join(absoluteRoot, cleanSchemaPath))
    ? read(absoluteRoot, cleanSchemaPath)
    : "";
  const legacyModels = parsePrismaModels(legacySchemaSource);
  const cleanModels = parsePrismaModels(cleanSchemaSource);
  const findings = [];

  addImportFindings(findings, absoluteRoot, webappFiles);
  addDelegateFindings(findings, absoluteRoot, webappFiles, legacyModels, cleanModels);
  addRawTableFindings(findings, absoluteRoot, webappFiles, legacyModels, cleanModels);
  addRouteAndWorkerFindings(findings, absoluteRoot, webappFiles, ownershipFiles);
  addArchitectureFindings(
    findings,
    absoluteRoot,
    [...new Set([...webappFiles, ...ownershipFiles])].sort()
  );
  addCleanSchemaFindings(findings, cleanSchemaPath, cleanSchemaSource, cleanModels);

  return {
    scopes: SCOPES,
    counts: {
      activeWebappFiles: webappFiles.length,
      runtimeOwnershipFiles: ownershipFiles.length,
      inheritedModels: legacyModels.length,
      cleanModels: cleanModels.length,
    },
    findings: sortFindings(findings),
  };
}

function fingerprint({ category, path, token }) {
  return `${category}\u0000${path}\u0000${token}`;
}

function allowanceFingerprint({ category, token }) {
  return `${category}\u0000${token}`;
}

export function aggregateFindings(findings) {
  const aggregate = new Map();
  for (const item of findings) {
    const key = fingerprint(item);
    const current = aggregate.get(key) ?? {
      category: item.category,
      path: item.path,
      token: item.token,
      count: 0,
      locations: [],
    };
    current.count += 1;
    current.locations.push({ line: item.line, excerpt: item.excerpt });
    aggregate.set(key, current);
  }
  return [...aggregate.values()].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.path.localeCompare(b.path) ||
      a.token.localeCompare(b.token)
  );
}

export function allowanceUnits(findings) {
  const units = new Map();
  for (const item of aggregateFindings(findings)) {
    const key = allowanceFingerprint(item);
    const current = units.get(key) ?? {
      category: item.category,
      token: item.token,
      count: 0,
      paths: [],
      locations: [],
    };
    current.count += item.count;
    current.paths.push([item.path, item.count]);
    current.locations.push(...item.locations);
    units.set(key, current);
  }
  return [...units.values()]
    .map((unit) => {
      unit.paths.sort(([a], [b]) => a.localeCompare(b));
      return {
        ...unit,
        pathDigest: createHash("sha256").update(JSON.stringify(unit.paths)).digest("hex"),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.token.localeCompare(b.token));
}

function validatePhase(phase) {
  if (!PHASES.includes(phase)) {
    throw new Error(`Unknown phase ${JSON.stringify(phase)}; expected one of ${PHASES.join(", ")}`);
  }
}

export function evaluateInventory(inventory, allowlist, phase = "inventory") {
  validatePhase(phase);
  if (
    allowlist.version !== 1 ||
    !Array.isArray(allowlist.entries) ||
    !allowlist.policies ||
    typeof allowlist.policies !== "object"
  ) {
    throw new Error("Cutover allowlist must have version 1, policies, and an entries array");
  }

  const phaseIndex = PHASES.indexOf(phase);
  const activeEntries = new Map();
  for (const entry of allowlist.entries) {
    const policy = allowlist.policies[entry.category];
    if (!policy) throw new Error(`Missing allowlist policy for ${entry.category}`);
    validatePhase(policy.allowedThrough);
    if (
      !policy.reason ||
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      !/^[a-f0-9]{64}$/.test(entry.pathDigest)
    ) {
      throw new Error(`Invalid allowlist entry ${JSON.stringify(entry)}`);
    }
    if (PHASES.indexOf(policy.allowedThrough) < phaseIndex) continue;
    const key = allowanceFingerprint(entry);
    if (activeEntries.has(key)) throw new Error(`Duplicate allowlist entry for ${key}`);
    activeEntries.set(key, { ...entry, ...policy });
  }

  const aggregated = aggregateFindings(inventory.findings);
  const units = allowanceUnits(inventory.findings);
  const actualByKey = new Map(units.map((item) => [allowanceFingerprint(item), item]));
  const allowed = [];
  const violations = [];
  const staleAllowances = [];

  for (const item of units) {
    const entry = activeEntries.get(allowanceFingerprint(item));
    if (!entry) {
      violations.push({ ...item, allowedCount: 0, excessCount: item.count });
      continue;
    }
    if (item.count !== entry.count || item.pathDigest !== entry.pathDigest) {
      violations.push({
        ...item,
        allowedCount: entry.count,
        excessCount: Math.max(0, item.count - entry.count),
        expectedPathDigest: entry.pathDigest,
      });
    } else {
      allowed.push({ ...item, allowedCount: entry.count, reason: entry.reason });
    }
  }

  for (const [key, entry] of activeEntries) {
    const actualCount = actualByKey.get(key)?.count ?? 0;
    if (actualCount < entry.count) {
      staleAllowances.push({ ...entry, actualCount, removableCount: entry.count - actualCount });
    }
  }

  return {
    phase,
    ...inventory,
    aggregate: aggregated,
    allowanceUnits: units,
    allowed,
    violations,
    staleAllowances,
    ok: violations.length === 0 && staleAllowances.length === 0,
  };
}

function allowancePolicy(item) {
  if (
    ["local-engine-route", "local-engine-surface", "local-worker-surface"].includes(item.category)
  ) {
    return {
      allowedThrough: "webapp-cutover",
      reason:
        "Existing local Mode-C/run-engine surface scheduled for removal in revised WIN-123 phase 7.",
    };
  }
  return {
    allowedThrough: "inventory",
    reason:
      "Existing inherited webapp database ownership scheduled for cutover in revised WIN-123 phases 5-6.",
  };
}

export function baselineForInventory(inventory) {
  const allowedCategories = [
    "legacy-import",
    "legacy-delegate",
    "legacy-raw-table",
    "local-engine-route",
    "local-engine-surface",
    "local-worker-surface",
  ];
  return {
    version: 1,
    phases: PHASES,
    policies: Object.fromEntries(
      allowedCategories.map((category) => [category, allowancePolicy({ category })])
    ),
    entries: allowanceUnits(inventory.findings)
      .filter((item) => allowedCategories.includes(item.category))
      .map(({ category, token, count, pathDigest }) => ({
        category,
        token,
        count,
        pathDigest,
      })),
  };
}

function parseArguments(argv) {
  const options = {
    phase: "inventory",
    json: false,
    printBaseline: false,
    explainScopes: false,
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--print-baseline") options.printBaseline = true;
    else if (argument === "--explain-scopes") options.explainScopes = true;
    else if (argument === "--phase") options.phase = argv[++index];
    else if (argument.startsWith("--phase=")) options.phase = argument.slice("--phase=".length);
    else if (argument === "--allowlist") options.allowlistPath = argv[++index];
    else if (argument.startsWith("--allowlist=")) {
      options.allowlistPath = argument.slice("--allowlist=".length);
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  validatePhase(options.phase);
  return options;
}

function printHuman(result) {
  console.log(`webapp-database-cutover-audit: phase=${result.phase}`);
  console.log(
    `inventory: ${result.counts.activeWebappFiles} active webapp files, ` +
      `${result.counts.runtimeOwnershipFiles} ownership files, ${result.findings.length} findings`
  );
  const categoryCounts = new Map();
  for (const item of result.findings) {
    categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
  }
  for (const [category, count] of [...categoryCounts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${category}: ${count}`);
  }
  console.log(`allowlisted baseline findings: ${result.allowed.length}`);

  for (const item of result.violations) {
    const location = item.locations[0] ?? { line: 1 };
    const path = item.paths?.[0]?.[0] ?? "<unknown>";
    console.error(
      `  FAIL new/changed/expired ${item.category}: ${path}:${location.line} ${item.token} ` +
        `(actual ${item.count}, allowed ${item.allowedCount})`
    );
  }
  for (const item of result.staleAllowances) {
    console.error(
      `  FAIL stale allowance: ${item.category} ${item.token} ` +
        `(baseline ${item.count}, actual ${item.actualCount}); shrink the checked-in allowance`
    );
  }
  if (result.ok) console.log("cutover ownership baseline is deterministic and unchanged");
}

export function runCli(
  argv = process.argv.slice(2),
  root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
) {
  const options = parseArguments(argv);
  const inventory = inventoryRepository(root);
  if (options.explainScopes) {
    console.log(
      JSON.stringify({ scopes: SCOPES, excludedPathParts: EXCLUDED_PATH_PARTS }, null, 2)
    );
    return 0;
  }
  if (options.printBaseline) {
    console.log(JSON.stringify(baselineForInventory(inventory), null, 2));
    return 0;
  }

  const allowlistPath = resolve(root, options.allowlistPath);
  if (!existsSync(allowlistPath)) {
    throw new Error(`Missing cutover allowlist: ${relative(root, allowlistPath)}`);
  }
  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
  const result = evaluateInventory(inventory, allowlist, options.phase);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  return result.ok ? 0 : 1;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(
      `webapp-database-cutover-audit: ${error instanceof Error ? error.message : error}`
    );
    process.exitCode = 1;
  }
}
