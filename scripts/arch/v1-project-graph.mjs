#!/usr/bin/env node
// Independent acceptance checker for the generated WIN-251 TypeScript graph.
// It reads committed tsconfigs, manifests and source imports directly; it does
// not call renderSkeleton(), so a generator defect cannot certify itself.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export const EXPECTED_PROJECT_COUNT = 32;
// 94 -> 95 (WIN-297). `apps/core-api` gained one workspace edge, to
// `packages/kernel`.
//
// The composition root binds twelve adapters to the ports they implement, and
// THREE of those ports — OutboxWriter, DurableRuntime, EventBus — are
// kernel-hosted (ADR M0.3 §4/§13). Without this edge the root cannot name them,
// so a quarter of its one job is inexpressible. It is also the only place that
// can implement the kernel ports with no adapter of their own: `Clock`,
// `IdGenerator` and `Logger` have no vendor SDK, so ADR M0.3 §4's "one adapter,
// one port, one SDK" does not describe them, and §5.3 forbids the kernel from
// implementing itself.
//
// This is an edge to the kernel, which every project may import by construction
// (rule (f) makes the kernel a leaf, so it can never create a cycle). It does
// not widen the context DAG, and `EXPECTED_CONTEXT_DEPENDS_ON` below is
// unchanged.
export const EXPECTED_EDGE_COUNT = 95;

// EXTERNAL (registry) dependencies, per project. Deliberately a SECOND axis.
//
// WIN-297 finding: before this split, `checkV1ProjectGraph` required every entry
// in every V1 manifest's `dependencies` to be `workspace:*` AND to appear in the
// 94-edge workspace graph. Both halves are right for a skeleton of declaration
// files. Together they also said "no V1 project may ever have a runtime
// dependency", which makes `apps/core-api` — the project ADR M0.3 §4 defines as
// the NEST composition root — uninhabitable by the framework that definition
// names.
//
// The workspace property is preserved in full: workspace edges are still exact,
// still `workspace:*`, still counted, still cross-checked against references and
// source imports. What is added is a new property that did not exist: an
// external dependency must be DECLARED HERE, with its exact range, or the audit
// fails — so an SDK cannot appear in a context, and a range cannot drift,
// without moving a reviewed line in this file.
//
// Every project not named here must have zero external dependencies.
export const EXPECTED_EXTERNAL_DEPENDENCIES = {
  "apps/core-api": {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "reflect-metadata": "^0.2.2",
    rxjs: "^7.8.1",
  },
  // WIN-256. The inference framework, its four provider bindings, the JSON
  // Schema validator the structured-output surface needs, and the framework's
  // own zod peer.
  //
  // This is the SECOND half of ADR M0.3's cutting rule made executable. §5.1
  // rule (h) and the `inference-sdk-only` / `provider-sdk-only` rules in
  // scripts/arch/boundary-rules.mjs say the SDK may only be IMPORTED here; this
  // line is where it may only be DECLARED here. Without it a context could add
  // `ai` to its own manifest and pass the import rule by never importing it —
  // and then the next file that did would be one review away from legal.
  //
  // The ranges are byte-identical to apps/agent's, on purpose: pnpm then
  // resolves them to the entries already in pnpm-lock.yaml rather than opening a
  // second resolution, so extracting a context cannot become a supply-chain
  // change. Changing a range here is a reviewed line, which is the point.
  "packages/adapters/model-router-providers": {
    "@ai-sdk/anthropic": "^4.0.15",
    "@ai-sdk/google": "^4.0.16",
    "@ai-sdk/google-vertex": "^5.0.20",
    "@ai-sdk/openai": "^4.0.14",
    ai: "^7.0.28",
    ajv: "8.18.0",
    zod: "3.25.76",
  },
};
export const EXPECTED_ALIASES = {
  "@platos/kernel": ["packages/kernel/src/index.ts"],
  "@platos/kernel/*": ["packages/kernel/src/*"],
  "@platos/context-*": ["packages/contexts/*"],
  "@platos/adapter-*": ["packages/adapters/*"],
};

// Acceptance fixture deliberately repeated rather than imported from
// boundary-rules.mjs or the generator. A shared-map defect must not be able to
// change both production output and its acceptance expectation.
export const EXPECTED_CONTEXT_DEPENDS_ON = {
  "identity-access": [],
  tenancy: ["identity-access"],
  secrets: [],
  providers: ["tenancy", "secrets"],
  agents: ["tenancy", "providers", "skills"],
  skills: ["tenancy", "files"],
  tools: ["tenancy", "identity-access", "secrets", "providers"],
  memory: ["tenancy", "providers"],
  channels: ["tenancy", "identity-access"],
  files: ["tenancy"],
  observability: ["tenancy"],
  "cost-monitoring": ["tenancy", "providers"],
  governance: ["tenancy", "agents"],
  jobs: ["tenancy"],
  conversations: ["agents", "skills", "tools", "memory", "providers", "files", "cost-monitoring", "jobs", "secrets", "tenancy"],
  eventing: ["tenancy"],
  privacy: ["tenancy"],
};
export const EXPECTED_CONTEXT_NAMES = Object.keys(EXPECTED_CONTEXT_DEPENDS_ON);

// Deliberately repeated here rather than imported from the generator. This is
// the independent reviewed expectation that catches generator/map mutations.
export const EXPECTED_ADAPTER_OWNERS = {
  "postgres-tenancy": "tenancy",
  outbox: "kernel",
  "durable-runtime": "kernel",
  "clickhouse-observability": "observability",
  "objectstore-minio": "files",
  "redis-ratelimit": "identity-access",
  "redis-cache": "memory",
  "redis-streams": "kernel",
  "model-router-providers": "providers",
  "channel-slack": "channels",
  "notifier-email": "cost-monitoring",
  "notifier-webhook": "cost-monitoring",
};

function expectedProjects() {
  return [
    "packages/kernel",
    ...EXPECTED_CONTEXT_NAMES.map((name) => `packages/contexts/${name}`),
    ...Object.keys(EXPECTED_ADAPTER_OWNERS).map((name) => `packages/adapters/${name}`),
    "apps/core-api",
    "apps/mcp-stdio",
  ];
}

function expectedReferences() {
  const graph = new Map([["packages/kernel", []]]);
  for (const name of EXPECTED_CONTEXT_NAMES) {
    graph.set(`packages/contexts/${name}`, [
      "packages/kernel",
      ...EXPECTED_CONTEXT_DEPENDS_ON[name].map((dependency) => `packages/contexts/${dependency}`),
    ]);
  }
  for (const [adapter, owner] of Object.entries(EXPECTED_ADAPTER_OWNERS)) {
    graph.set(`packages/adapters/${adapter}`, [owner === "kernel" ? "packages/kernel" : `packages/contexts/${owner}`]);
  }
  graph.set("apps/core-api", [
    // WIN-297: the composition root names kernel ports directly. See the note on
    // EXPECTED_EDGE_COUNT.
    "packages/kernel",
    ...EXPECTED_CONTEXT_NAMES.map((name) => `packages/contexts/${name}`),
    ...Object.keys(EXPECTED_ADAPTER_OWNERS).map((name) => `packages/adapters/${name}`),
  ]);
  graph.set("apps/mcp-stdio", ["packages/contexts/tools"]);
  return graph;
}

function packageName(project) {
  if (project === "packages/kernel") return "@platos/kernel";
  if (project.startsWith("packages/contexts/")) return `@platos/context-${project.slice("packages/contexts/".length)}`;
  if (project.startsWith("packages/adapters/")) return `@platos/adapter-${project.slice("packages/adapters/".length)}`;
  if (project === "apps/core-api") return "@platos/core-api";
  if (project === "apps/mcp-stdio") return "@platos/mcp-stdio";
  return null;
}

function projectForSpecifier(specifier) {
  if (specifier === "@platos/kernel" || specifier.startsWith("@platos/kernel/")) return "packages/kernel";
  let match = /^@platos\/context-([^/]+)/u.exec(specifier);
  if (match) return `packages/contexts/${match[1]}`;
  match = /^@platos\/adapter-([^/]+)/u.exec(specifier);
  if (match) return `packages/adapters/${match[1]}`;
  if (specifier === "@platos/core-api" || specifier.startsWith("@platos/core-api/")) return "apps/core-api";
  if (specifier === "@platos/mcp-stdio" || specifier.startsWith("@platos/mcp-stdio/")) return "apps/mcp-stdio";
  return null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

function describeSet(values) {
  return `[${sorted(values).join(", ")}]`;
}

function listFiles(root) {
  const files = [];
  const walk = (directory) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ["dist", "node_modules"].includes(entry.name)) continue;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  };
  walk(root);
  return files;
}

function sourceFiles(root, project) {
  return listFiles(join(root, project)).filter((path) => /\.(?:cts|mts|tsx?|jsx?)$/u.test(path) && !path.endsWith(".d.ts"));
}

function globMatcher(glob) {
  const segments = glob.split("/");
  let source = "";
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === "**") {
      source += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    source += segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*");
    if (!last) source += "/";
  }
  return new RegExp(`^${source}$`, "u");
}

function sourceEdges(root, projects) {
  const graph = new Map(projects.map((project) => [project, new Set()]));
  const importPattern = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/gu;
  for (const project of projects) {
    for (const absolute of sourceFiles(root, project)) {
      const source = readFileSync(absolute, "utf8");
      importPattern.lastIndex = 0;
      let match;
      while ((match = importPattern.exec(source)) !== null) {
        const target = projectForSpecifier(match[1]);
        if (target && target !== project) graph.get(project).add(target);
      }
    }
  }
  return graph;
}

function packageImports(root, projects) {
  const imports = [];
  const importPattern = /\b(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/gu;
  for (const project of projects) {
    for (const absolute of sourceFiles(root, project)) {
      const source = readFileSync(absolute, "utf8");
      importPattern.lastIndex = 0;
      let match;
      while ((match = importPattern.exec(source)) !== null) {
        const target = projectForSpecifier(match[1]);
        if (target) imports.push({ project, path: relative(root, absolute).split("\\").join("/"), specifier: match[1], target });
      }
    }
  }
  return imports;
}

function sourceForEmittedTarget(project, config, target) {
  if (typeof target !== "string" || !target.startsWith("./dist/")) return null;
  const emitted = target.slice("./dist/".length).replace(/\.d\.ts$/u, ".ts").replace(/\.js$/u, ".ts");
  const rootDir = config.compilerOptions?.rootDir ?? ".";
  return posix.normalize(posix.join(project, rootDir, emitted));
}

function validateExportTarget(root, project, config, label, target, errors) {
  const source = sourceForEmittedTarget(project, config, target);
  if (source === null || !existsSync(join(root, source))) {
    errors.push(`${project} ${label} target ${String(target)} does not map to an emitted source path under dist`);
  }
}

function discoverProjectPaths(root) {
  const paths = [];
  for (const base of ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"]) {
    const absolute = join(root, base);
    if (!existsSync(absolute)) continue;
    if (existsSync(join(absolute, "tsconfig.json"))) paths.push(base);
    for (const file of listFiles(absolute)) {
      if (file.endsWith("/tsconfig.json") || file.endsWith("\\tsconfig.json")) {
        const project = relative(root, file.slice(0, -"/tsconfig.json".length)).split("\\").join("/");
        if (!paths.includes(project)) paths.push(project);
      }
    }
  }
  return sorted(paths);
}

function expectedManifestEntry(project) {
  if (project.startsWith("packages/contexts/")) {
    return { main: "./dist/contracts/index.js", types: "./dist/contracts/index.d.ts" };
  }
  if (project.startsWith("apps/")) return { main: "./dist/main.js", types: "./dist/main.d.ts" };
  return { main: "./dist/index.js", types: "./dist/index.d.ts" };
}

export function checkV1ProjectGraph(root = repositoryRoot) {
  const errors = [];
  const projects = expectedProjects();
  const expectedGraph = expectedReferences();
  const rootConfigPath = join(root, "tsconfig.json");
  if (!existsSync(rootConfigPath)) {
    return { projectCount: 0, referenceEdgeCount: 0, dependencyEdgeCount: 0, sourceEdgeCount: 0, errors: ["root tsconfig.json is missing"] };
  }

  const rootConfig = readJson(rootConfigPath);
  if (JSON.stringify(rootConfig.files) !== "[]") errors.push("root tsconfig files must be exactly []");
  if (JSON.stringify(rootConfig.compilerOptions?.paths) !== JSON.stringify(EXPECTED_ALIASES)) {
    errors.push("root tsconfig path aliases must be the exact four WIN-251 aliases");
  }

  const actualRootReferences = (rootConfig.references ?? []).map((reference) => posix.normalize(reference.path.replace(/^\.\//u, "")));
  if (JSON.stringify(actualRootReferences) !== JSON.stringify(projects)) {
    errors.push(`root references must list the exact ${EXPECTED_PROJECT_COUNT} projects in architecture order`);
  }

  const discovered = discoverProjectPaths(root);
  if (!sameSet(discovered, projects)) {
    errors.push(`discovered project set ${describeSet(discovered)} does not equal expected ${describeSet(projects)}`);
  }

  let referenceEdgeCount = 0;
  let dependencyEdgeCount = 0;
  for (const project of projects) {
    const configPath = join(root, project, "tsconfig.json");
    const manifestPath = join(root, project, "package.json");
    if (!existsSync(configPath)) {
      errors.push(`${project} is missing tsconfig.json`);
      continue;
    }
    if (!existsSync(manifestPath)) {
      errors.push(`${project} is missing package.json`);
      continue;
    }

    const config = readJson(configPath);
    const manifest = readJson(manifestPath);
    const expected = expectedGraph.get(project);
    const actualReferences = (config.references ?? []).map((reference) =>
      posix.normalize(posix.join(project, reference.path))
    );
    referenceEdgeCount += actualReferences.length;
    if (!sameSet(actualReferences, expected)) {
      errors.push(`${project} references ${describeSet(actualReferences)}; expected ${describeSet(expected)}`);
    }
    if (config.compilerOptions?.composite !== true) errors.push(`${project} must set compilerOptions.composite=true`);

    const includes = config.include;
    const files = sourceFiles(root, project).map((path) => relative(join(root, project), path).split("\\").join("/"));
    if (!Array.isArray(includes) || includes.length === 0) {
      errors.push(`${project} include must be non-empty`);
    } else {
      for (const include of includes) {
        const matches = files.filter((file) => globMatcher(include).test(file));
        if (matches.length === 0) errors.push(`${project} include ${include} is vacuous`);
      }
      const matchers = includes.map(globMatcher);
      for (const file of files) {
        if (!matchers.some((matcher) => matcher.test(file))) errors.push(`${project} source ${file} is outside every include`);
      }
    }

    // Two axes, judged separately (WIN-297). A dependency is a WORKSPACE edge
    // when its name resolves to a V1 project; everything else is EXTERNAL and is
    // held to the declared allow-list instead of to the graph.
    const declaredDependencies = Object.keys(manifest.dependencies ?? {});
    const expectedDependencyNames = expected.map(packageName);
    const actualDependencies = declaredDependencies.filter((name) => projectForSpecifier(name) !== null);
    const actualExternal = declaredDependencies.filter((name) => projectForSpecifier(name) === null);
    dependencyEdgeCount += actualDependencies.length;
    if (!sameSet(actualDependencies, expectedDependencyNames)) {
      errors.push(`${project} dependencies ${describeSet(actualDependencies)}; expected ${describeSet(expectedDependencyNames)}`);
    }
    for (const dependency of actualDependencies) {
      if (manifest.dependencies[dependency] !== "workspace:*") errors.push(`${project} dependency ${dependency} must be workspace:*`);
    }

    const expectedExternal = EXPECTED_EXTERNAL_DEPENDENCIES[project] ?? {};
    if (!sameSet(actualExternal, Object.keys(expectedExternal))) {
      errors.push(
        `${project} external dependencies ${describeSet(actualExternal)}; expected ${describeSet(Object.keys(expectedExternal))}` +
          ` — declare it in EXPECTED_EXTERNAL_DEPENDENCIES or remove it`
      );
    }
    for (const dependency of actualExternal) {
      const range = expectedExternal[dependency];
      if (range !== undefined && manifest.dependencies[dependency] !== range) {
        errors.push(
          `${project} external dependency ${dependency} is ${manifest.dependencies[dependency]}; expected the reviewed range ${range}`
        );
      }
    }
    const expectedEntry = expectedManifestEntry(project);
    if (manifest.main !== expectedEntry.main || manifest.types !== expectedEntry.types) {
      errors.push(`${project} package entrypoints must be ${expectedEntry.main} and ${expectedEntry.types}`);
    }
    if (manifest.scripts?.build !== "tsc -b" || manifest.scripts?.clean !== "tsc -b --clean") {
      errors.push(`${project} must expose generated build and clean scripts`);
    }
    const rootExport = manifest.exports?.["."];
    if (rootExport?.import !== manifest.main || rootExport?.types !== manifest.types) {
      errors.push(`${project} root export must agree with main and types`);
    }
    for (const [subpath, conditions] of Object.entries(manifest.exports ?? {})) {
      if (conditions === null || typeof conditions !== "object") {
        errors.push(`${project} export ${subpath} must declare import and types targets`);
        continue;
      }
      validateExportTarget(root, project, config, `export ${subpath} import`, conditions.import, errors);
      validateExportTarget(root, project, config, `export ${subpath} types`, conditions.types, errors);
    }
  }

  for (const imported of packageImports(root, projects)) {
    const targetManifest = readJson(join(root, imported.target, "package.json"));
    const targetName = packageName(imported.target);
    const subpath = imported.specifier === targetName ? "." : `.${imported.specifier.slice(targetName.length)}`;
    if (!Object.hasOwn(targetManifest.exports ?? {}, subpath)) {
      errors.push(`${imported.path} imports unexported package subpath ${imported.specifier}`);
    }
  }

  const actualSourceGraph = sourceEdges(root, projects);
  let sourceEdgeCount = 0;
  for (const project of projects) {
    const actual = actualSourceGraph.get(project);
    const expected = expectedGraph.get(project);
    sourceEdgeCount += actual.size;
    if (!sameSet(actual, expected)) {
      errors.push(`${project} source edges ${describeSet(actual)}; expected ${describeSet(expected)}`);
    }
  }

  for (const [label, count] of [
    ["project-reference", referenceEdgeCount],
    ["workspace-dependency", dependencyEdgeCount],
    ["source-import", sourceEdgeCount],
  ]) {
    if (count !== EXPECTED_EDGE_COUNT) errors.push(`${label} edge count is ${count}, expected ${EXPECTED_EDGE_COUNT}`);
  }
  if (projects.length !== EXPECTED_PROJECT_COUNT) errors.push(`expected project registry count is ${projects.length}, expected ${EXPECTED_PROJECT_COUNT}`);

  return {
    projectCount: projects.length,
    referenceEdgeCount,
    dependencyEdgeCount,
    sourceEdgeCount,
    errors,
  };
}

function main() {
  const result = checkV1ProjectGraph(repositoryRoot);
  process.stdout.write(
    `v1-project-graph: ${result.projectCount} projects; ` +
      `${result.referenceEdgeCount}/${result.dependencyEdgeCount}/${result.sourceEdgeCount} reference/dependency/source edges\n`
  );
  for (const error of result.errors) process.stdout.write(`FAIL ${error}\n`);
  if (result.errors.length === 0) {
    process.stdout.write(`ok: exact non-vacuous ${EXPECTED_PROJECT_COUNT}-project, ${EXPECTED_EDGE_COUNT}-edge graph\n`);
  } else {
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
