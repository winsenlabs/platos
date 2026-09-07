#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
// WIN-259 (M2.4) 32 -> 33. `packages/adapters/keyring-envelope`, the
// thirteenth adapter directory and the first V1 project added since this
// list was drawn. The list below is ORDERED and the root tsconfig's
// references must match it exactly, so the entry goes where the generator
// emits it: after `notifier-webhook` and before the two apps.
export const EXPECTED_V1_PROJECT_COUNT = 33;
export const EXPECTED_V1_PROJECTS = [
  "packages/kernel",
  "packages/contexts/identity-access", "packages/contexts/tenancy", "packages/contexts/secrets",
  "packages/contexts/providers", "packages/contexts/agents", "packages/contexts/skills",
  "packages/contexts/tools", "packages/contexts/memory", "packages/contexts/channels",
  "packages/contexts/files", "packages/contexts/observability", "packages/contexts/cost-monitoring",
  "packages/contexts/governance", "packages/contexts/jobs", "packages/contexts/conversations",
  "packages/contexts/eventing", "packages/contexts/privacy",
  "packages/adapters/postgres-tenancy", "packages/adapters/outbox", "packages/adapters/durable-runtime",
  "packages/adapters/clickhouse-observability", "packages/adapters/objectstore-minio",
  "packages/adapters/redis-ratelimit", "packages/adapters/redis-cache", "packages/adapters/redis-streams",
  "packages/adapters/model-router-providers", "packages/adapters/channel-slack",
  "packages/adapters/notifier-email", "packages/adapters/notifier-webhook",
  "packages/adapters/keyring-envelope",
  "apps/core-api", "apps/mcp-stdio",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function normalizedReferencePath(path) {
  return path.replace(/^\.\//u, "").replaceAll("\\", "/");
}

function assertNoSymlinkComponents(root, candidate, label) {
  if (lstatSync(root).isSymbolicLink()) throw new Error(`unsafe symbolic repository root for ${label}`);
  const path = relative(root, candidate);
  let current = root;
  for (const segment of path.split(/[\\/]/u)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`unsafe symbolic path component for ${label}: ${relative(root, current)}`);
    }
  }
}

export function v1DistDirectories(root = repositoryRoot) {
  const solutionPath = join(root, "tsconfig.json");
  const solution = readJson(solutionPath);
  const references = solution.references;
  if (!Array.isArray(references) || references.length !== EXPECTED_V1_PROJECT_COUNT) {
    throw new Error(`root tsconfig must contain exactly ${EXPECTED_V1_PROJECT_COUNT} V1 project references`);
  }
  for (const reference of references) {
    if (typeof reference?.path !== "string" || reference.path.trim() === "") {
      throw new Error("every root tsconfig project reference must have a non-empty path");
    }
    if (isAbsolute(reference.path) || reference.path.split(/[\\/]/u).includes("..")) {
      throw new Error(`unsafe V1 project reference: ${reference.path}`);
    }
  }
  const actualProjectPaths = references.map((reference) =>
    typeof reference?.path === "string" ? normalizedReferencePath(reference.path) : null
  );
  if (JSON.stringify(actualProjectPaths) !== JSON.stringify(EXPECTED_V1_PROJECTS)) {
    throw new Error("root tsconfig references must be the exact ordered 33-project V1 target set");
  }

  const projects = [];
  const seen = new Set();
  for (const reference of references) {
    const project = resolve(root, reference.path);
    if (!isWithin(root, project)) throw new Error(`unsafe V1 project reference outside repository: ${reference.path}`);
    assertNoSymlinkComponents(root, project, reference.path);
    if (seen.has(project)) throw new Error(`duplicate V1 project reference: ${reference.path}`);
    seen.add(project);

    const configPath = join(project, "tsconfig.json");
    if (!existsSync(configPath)) throw new Error(`V1 project is missing tsconfig.json: ${reference.path}`);
    assertNoSymlinkComponents(root, configPath, `${reference.path}/tsconfig.json`);
    const config = readJson(configPath);
    const compilerOptions = config.compilerOptions ?? {};
    for (const forbidden of ["declarationDir", "outFile"]) {
      if (Object.hasOwn(compilerOptions, forbidden)) {
        throw new Error(`V1 project ${reference.path} must not set alternate output option ${forbidden}`);
      }
    }
    // The six OUTPUT options every V1 project must set identically. This check
    // exists so `clean:v1` can only ever delete a `dist/` it fully understands;
    // an unexpected output option could point emitted files somewhere this
    // script would then remove, or fail to remove.
    //
    // WIN-297 allows ONE project a strictly non-output addition. Nest 11's
    // dependency injection reads metadata only the legacy decorator transform
    // emits, and `.configs/tsconfig.base.json` sets `experimentalDecorators:
    // false` repository-wide. `apps/core-api` — the Nest composition root, and
    // the only project ADR M0.3 §4 puts a framework in — overrides both flags
    // for itself. Neither affects where output goes, so the safety property this
    // check protects is untouched, and allowing them HERE rather than widening
    // `expectedCompilerOptionKeys` for all 33 projects keeps the exception
    // named, reviewable and impossible to inherit by accident.
    const expectedCompilerOptionKeys = [
      "composite", "declaration", "declarationMap", "outDir", "rootDir", "tsBuildInfoFile",
      ...(normalizedReferencePath(reference.path) === "apps/core-api"
        ? ["emitDecoratorMetadata", "experimentalDecorators"]
        : []),
    ];
    const expectedRootDir = normalizedReferencePath(reference.path).startsWith("packages/contexts/") ? "." : "src";
    if (
      JSON.stringify(Object.keys(compilerOptions).sort()) !== JSON.stringify(expectedCompilerOptionKeys.sort()) ||
      compilerOptions.composite !== true ||
      compilerOptions.declaration !== true ||
      compilerOptions.declarationMap !== true ||
      compilerOptions.rootDir !== expectedRootDir ||
      compilerOptions.outDir !== "dist" ||
      compilerOptions.tsBuildInfoFile !== "dist/.tsbuildinfo"
    ) {
      throw new Error(`V1 project ${reference.path} must use the exact generated dist output options`);
    }
    const dist = resolve(dirname(configPath), config.compilerOptions.outDir);
    if (!isWithin(root, dist) || dirname(dist) !== project || dist !== join(project, "dist")) {
      throw new Error(`unsafe V1 dist target for ${reference.path}`);
    }
    assertNoSymlinkComponents(root, dist, `${reference.path}/dist`);
    projects.push({ project, dist });
  }
  return projects;
}

function removeValidatedDistDirectories(projects) {
  for (const { dist } of projects) rmSync(dist, { recursive: true, force: true });
}

export function cleanV1(root = repositoryRoot) {
  const projects = v1DistDirectories(root);
  removeValidatedDistDirectories(projects);
  return projects;
}

function main() {
  const projects = cleanV1(repositoryRoot);
  process.stdout.write(`clean:v1 removed exactly ${projects.length} project dist director${projects.length === 1 ? "y" : "ies"}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
