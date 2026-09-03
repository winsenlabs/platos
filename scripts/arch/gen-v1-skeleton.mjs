#!/usr/bin/env node
// Generates the ADR M0.3 §4 V1 package skeleton and its complete TypeScript
// project graph.
//
// OWNERSHIP IS TWO-TIER (WIN-256).
//
//   Scaffolding — every project's package.json, tsconfig.json and README.md,
//   plus the root solution tsconfig. This tier is the ADR §1 context DAG made
//   executable: 32 projects, 94 project edges. It is generated and byte-compared
//   for the life of the V1 layout and is NEVER released.
//
//   Source — the declaration-only placeholder .ts files. This tier is generated
//   only until a project's source tree is ADOPTED by real implementation code.
//
// Until M2 there was one tier and the generator owned every file under the V1
// roots, so `--check` reported any newly added source file as EXTRA. That is
// correct for a skeleton and unworkable for real code: it made adding a single
// domain file a CI failure. Adoption is the seam. It is explicit, reviewed and
// monotonic — un-adopting a project that still holds real files fails closed,
// because its placeholders reappear MISSING and its real files become EXTRA.
//
// Adopting a project releases ONLY its source tree. Its three scaffolding files
// stay byte-compared, it keeps its place in the 32/94 graph, and every rule in
// scripts/arch/boundary-rules.mjs continues to police the real code that lands
// there.
//
//   node scripts/arch/gen-v1-skeleton.mjs            # write generated files
//   node scripts/arch/gen-v1-skeleton.mjs --check    # fail on generated drift
//   node scripts/arch/gen-v1-skeleton.mjs --list     # print emitted paths

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTEXT_DEPENDS_ON, CONTEXT_NAMES, SDK_CONTAINMENT } from "./boundary-rules.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

// Adapter-facing ports belong to their contexts. Only genuinely cross-cutting
// decoupling ports remain in the pure-leaf kernel (ADR M0.3 §13 amendment).
export const ADAPTERS = [
  { dir: "postgres-tenancy", port: "TenancyRepository", owner: "tenancy", note: "the tenancy-database client; per-context repositories, owner-tagged" },
  { dir: "outbox", port: "OutboxWriter", owner: "kernel", note: "THE single writer of the Event/outbox table" },
  { dir: "durable-runtime", port: "DurableRuntime", owner: "kernel", note: "the durable job runtime behind one kernel port (ADR M0.3 §12)" },
  { dir: "clickhouse-observability", port: "ObservabilitySink", owner: "observability", note: "the column-store observability client" },
  { dir: "objectstore-minio", port: "ObjectStore", owner: "files", note: "the S3-compatible object store client" },
  { dir: "redis-ratelimit", port: "RateLimiter", owner: "identity-access", note: "one namespaced keyspace, one owner" },
  { dir: "redis-cache", port: "Cache", owner: "memory", note: "one namespaced keyspace, one owner" },
  { dir: "redis-streams", port: "EventBus", owner: "kernel", note: "one namespaced keyspace, one owner" },
  { dir: "model-router-providers", port: "ModelRouter", owner: "providers", note: "the model-provider clients" },
  { dir: "channel-slack", port: "ChannelAdapter", owner: "channels", note: "one channel client" },
  { dir: "notifier-email", port: "Notifier", owner: "cost-monitoring", note: "outbound email" },
  { dir: "notifier-webhook", port: "Notifier", owner: "cost-monitoring", note: "outbound HTTP callbacks" },
];

export const TRANSPORTS = ["rest", "mcp", "ws", "webhook", "channels-ingress", "bff"];

const KERNEL_PORTS = [
  "EventBus", "OutboxWriter", "UnitOfWork", "Clock", "IdGenerator", "Logger",
  "DurableRuntime", "SafetyEventSink", "ErasureTarget",
];

export const OWNED_ROOTS = ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"];
export const ROOT_SOLUTION_PATH = "tsconfig.json";
export const EXPECTED_PROJECT_COUNT = 32;
// 94 -> 95 (WIN-297): apps/core-api -> packages/kernel. The composition root
// binds twelve adapters to the ports they implement and three of those ports
// (OutboxWriter, DurableRuntime, EventBus) are kernel-hosted, so without this
// edge a quarter of its one job cannot be typed. It is also the only project
// that can implement Clock, IdGenerator and Logger — kernel ports with no vendor
// SDK and therefore no adapter of their own. The kernel is a leaf (rule (f)), so
// this edge cannot create a cycle, and the 17-context DAG is unchanged. The
// independent expectation in scripts/arch/v1-project-graph.mjs carries the same
// delta and is maintained separately on purpose.
export const EXPECTED_EDGE_COUNT = 95;

// The three per-project files that make up the SCAFFOLDING tier. Adoption never
// releases these: a project's manifest, its tsconfig (which carries the project
// references that ARE the 94-edge DAG) and its README stay generated forever.
export const SCAFFOLDING_BASENAMES = ["package.json", "tsconfig.json", "README.md"];

// Scaffolding is invariant for the life of the V1 layout:
// 32 projects x 3 files + the root solution tsconfig.
export const EXPECTED_SCAFFOLDING_FILE_COUNT = 97;

// Declaration-only source placeholders in a fully unadopted skeleton:
// kernel 3 + contexts 17x4 + adapters 12x2 + core-api 8 + mcp-stdio 1.
// This is the same 104-file set the architecture gate scans.
export const EXPECTED_PLACEHOLDER_FILE_COUNT = 104;

// ---------------------------------------------------------------------------
// ADOPTED PROJECTS (WIN-256). Append-only, one project path per entry, each with
// the issue that adopted it.
//
// Adopting a project means: real implementation code now owns its source tree.
// The generator stops emitting that project's source placeholders and `--check`
// stops reporting files under its source tree as EXTRA. Its scaffolding is still
// byte-compared, and boundary-rules.mjs still polices every file that lands there.
//
// DO NOT REMOVE AN ENTRY to make a failure go away. Un-adopting a project whose
// real files are still on disk fails closed by construction (MISSING placeholders
// + EXTRA real files), and `gen-v1-skeleton.test.mjs` asserts exactly that.
// ---------------------------------------------------------------------------
export const ADOPTED_PROJECTS = [
  "packages/kernel", // WIN-256 — the nine decoupling ports and the value objects
  "packages/contexts/identity-access", // WIN-256 — the DAG leaf that kills the wrong-way auth edges
  "packages/contexts/tenancy", // WIN-256 — the org/project/environment tree and its authorization
  "packages/contexts/secrets", // WIN-256 — the credential vault and the encryption boundary
  "packages/contexts/files", // WIN-256 — attachments + artifacts, and the ObjectStore port it owns
  "packages/contexts/providers", // WIN-256 — provider keys, the model catalogue, rate cards, and the ModelRouter port it owns
  "packages/contexts/eventing", // WIN-256 — the outbox drain, NotificationRule, and NotificationRequested
  "packages/contexts/skills", // WIN-256 — the skill catalogue, its install pair, and the manifest parser
  "packages/contexts/jobs", // WIN-256 — Job definitions and the AgentApproval suspension seam
  "packages/contexts/memory", // WIN-256 — memories, the knowledge graph, extraction, and the Cache port it owns
  "packages/contexts/cost-monitoring", // WIN-256 — budgets, the spend ledger, threshold alerting, and the Notifier port it owns
  "packages/contexts/privacy", // WIN-256 — right-to-erasure orchestration over the kernel ErasureTarget[]
  "packages/contexts/observability", // WIN-256 — the analytical projection, the drain, and the AdminAudit trail
  "apps/core-api", // WIN-297 — the bootable process and THE composition root
  "apps/mcp-stdio", // WIN-297 — the thin stdio binary and its host-injected runtime seam
];

// Every entry point below takes an optional `adopted` override so the adoption
// path itself is exercisable. Production callers pass nothing and get
// ADOPTED_PROJECTS. An untestable adoption seam would be an unproven gate.
function adoptedSet(adopted = ADOPTED_PROJECTS) {
  return adopted instanceof Set ? adopted : new Set(adopted);
}

/** The project path that owns `path`, or null when no V1 project does. */
export function owningProject(path) {
  for (const project of projectPaths()) {
    if (path === project || path.startsWith(`${project}/`)) return project;
  }
  return null;
}

/** True when `path` is one of a project's three scaffolding files. */
export function isScaffoldingPath(path) {
  const project = owningProject(path);
  if (!project) return path === ROOT_SOLUTION_PATH;
  return SCAFFOLDING_BASENAMES.includes(path.slice(project.length + 1));
}

/** True when `path` sits in the released source tree of an adopted project. */
export function isAdoptedSourcePath(path, adopted) {
  const project = owningProject(path);
  if (!project || !adoptedSet(adopted).has(project)) return false;
  return !isScaffoldingPath(path);
}

/** Split a rendered file map into its two ownership tiers. */
export function tierCounts(files) {
  const scaffolding = [...files.keys()].filter((path) => isScaffoldingPath(path)).length;
  return { scaffolding, placeholders: files.size - scaffolding, total: files.size };
}

const HEADER = "// PLACEHOLDER — generated by scripts/arch/gen-v1-skeleton.mjs. Do not edit by hand.\n";
const BUILD_SCRIPTS = { build: "tsc -b", clean: "tsc -b --clean" };

// An adopted project holds real code, so it gets the scripts real code needs.
// Tests live beside the source they cover and are compiled by the project's own
// composite tsconfig, so they are typechecked under the same `strict` +
// `noUncheckedIndexedAccess` settings as the code — a test that only runs under
// esbuild is not holding the domain to the standard the domain is held to.
// These packages are `private`, so the emitted test JavaScript in dist/ is inert.
const ADOPTED_SCRIPTS = { ...BUILD_SCRIPTS, test: "vitest run" };

// An adopted APP is additionally a process, so it gets the one script that
// starts it. `start` runs the built entry point rather than a bundler or a
// watcher: the thing CI proves and the thing an operator runs must be the same
// artifact, or the executable start/stop evidence is about something that never
// ships (WIN-297).
const ADOPTED_APP_SCRIPTS = { ...ADOPTED_SCRIPTS, start: "node dist/main.js" };

// Projects whose adopted script set is the app set rather than the library set.
const APP_PROJECTS = new Set(["apps/core-api", "apps/mcp-stdio"]);

function scriptsFor(project, adopted) {
  if (!adoptedSet(adopted).has(project)) return BUILD_SCRIPTS;
  return APP_PROJECTS.has(project) ? ADOPTED_APP_SCRIPTS : ADOPTED_SCRIPTS;
}

function pascal(name) {
  return name.split(/[-_]/u).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function camel(name) {
  return name.replace(/-(.)/gu, (_match, character) => character.toUpperCase());
}

function workspaceDependencies(names) {
  return Object.fromEntries(names.map((name) => [name, "workspace:*"]));
}

function packageManifest({ name, description, main, types, dependencies = {}, exports = undefined, scripts = BUILD_SCRIPTS }) {
  const manifest = {
    name,
    version: "0.0.0",
    private: true,
    description,
    license: "Apache-2.0",
    type: "module",
    main,
    types,
    exports: exports ?? { ".": { types, import: main } },
    scripts,
  };
  if (Object.keys(dependencies).length) manifest.dependencies = dependencies;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function kernelManifest(adopted) {
  return packageManifest({
    scripts: scriptsFor("packages/kernel", adopted),
    name: "@platos/kernel",
    description: "Port interfaces and pure value objects. Zero runtime dependencies.",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
  });
}

function contextManifest(name, adopted) {
  const dependencies = workspaceDependencies([
    "@platos/kernel",
    ...CONTEXT_DEPENDS_ON[name].map((dependency) => `@platos/context-${dependency}`),
  ]);
  return packageManifest({
    scripts: scriptsFor(`packages/contexts/${name}`, adopted),
    name: `@platos/context-${name}`,
    description: `ADR M0.3 bounded context: ${name}.`,
    main: "./dist/contracts/index.js",
    types: "./dist/contracts/index.d.ts",
    exports: {
      ".": { types: "./dist/contracts/index.d.ts", import: "./dist/contracts/index.js" },
      "./application/ports/index.js": {
        types: "./dist/application/ports/index.d.ts",
        import: "./dist/application/ports/index.js",
      },
    },
    dependencies,
  });
}

function adapterManifest(adapter, adopted) {
  const dependency = adapter.owner === "kernel" ? "@platos/kernel" : `@platos/context-${adapter.owner}`;
  return packageManifest({
    scripts: scriptsFor(`packages/adapters/${adapter.dir}`, adopted),
    name: `@platos/adapter-${adapter.dir}`,
    description: `Implements the ${adapter.owner} ${adapter.port} port.`,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    dependencies: workspaceDependencies([dependency]),
  });
}

// The external runtime dependencies apps/core-api needs to BE a process
// (WIN-297). They are declared here, in the generator, because a project's
// manifest is SCAFFOLDING: adoption releases a project's source tree and never
// its package.json, so the only honest place to add a runtime dependency is the
// generator that owns the file.
//
// Specifiers are byte-identical to apps/agent's, so pnpm resolves them to the
// entries already in pnpm-lock.yaml (@nestjs 11.1.18) instead of opening a new
// resolution. A composition root that forced a second major of the framework
// into the lockfile would be a supply-chain change disguised as a bootstrap.
//
// ADR M0.3 §4 names Nest as the composition-root framework. It appears HERE and
// in apps/core-api only: `no-infra-in-core` (rule (a)) keeps it out of every
// context's domain/ and application/, and WIN-297 adds the negative control that
// proves that rule can still fail.
const CORE_API_RUNTIME_DEPENDENCIES = {
  "@nestjs/common": "^11.0.0",
  "@nestjs/core": "^11.0.0",
  "@nestjs/platform-express": "^11.0.0",
  "reflect-metadata": "^0.2.2",
  rxjs: "^7.8.1",
};

function appManifest({ name, description, dependencies, scripts, externalDependencies = {} }) {
  return packageManifest({
    scripts,
    name,
    description,
    main: "./dist/main.js",
    types: "./dist/main.d.ts",
    dependencies: { ...workspaceDependencies(dependencies), ...externalDependencies },
  });
}

export function projectPaths() {
  return [
    "packages/kernel",
    ...CONTEXT_NAMES.map((name) => `packages/contexts/${name}`),
    ...ADAPTERS.map((adapter) => `packages/adapters/${adapter.dir}`),
    "apps/core-api",
    "apps/mcp-stdio",
  ];
}

export function projectReferences() {
  const references = new Map();
  references.set("packages/kernel", []);
  for (const name of CONTEXT_NAMES) {
    references.set(`packages/contexts/${name}`, [
      "packages/kernel",
      ...CONTEXT_DEPENDS_ON[name].map((dependency) => `packages/contexts/${dependency}`),
    ]);
  }
  for (const adapter of ADAPTERS) {
    references.set(
      `packages/adapters/${adapter.dir}`,
      [adapter.owner === "kernel" ? "packages/kernel" : `packages/contexts/${adapter.owner}`]
    );
  }
  references.set("apps/core-api", [
    "packages/kernel",
    ...CONTEXT_NAMES.map((name) => `packages/contexts/${name}`),
    ...ADAPTERS.map((adapter) => `packages/adapters/${adapter.dir}`),
  ]);
  references.set("apps/mcp-stdio", ["packages/contexts/tools"]);
  return references;
}

function relativeReference(fromProject, toProject) {
  const path = relative(fromProject, toProject).split("\\").join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

// apps/core-api hosts Nest, and Nest 11's dependency injection reads metadata
// that only the LEGACY decorator transform emits. `.configs/tsconfig.base.json`
// sets `experimentalDecorators: false` repository-wide, which selects the TC39
// standard decorators Nest does not support, so the composition root overrides
// both flags for its own project and nothing else.
//
// This is deliberately the narrowest possible blast radius: no context, no
// adapter and no other app can see these options, so `@nestjs/*` cannot become
// compilable inside a layer that ADR M0.3 §2 bans it from. Flipping them in the
// base config instead would have made the framework legal everywhere in order to
// make it legal in one place.
const PROJECT_COMPILER_OPTION_OVERRIDES = {
  "apps/core-api": { experimentalDecorators: true, emitDecoratorMetadata: true },
};

function projectTsconfig(project, include, references, rootDir) {
  const extendsPath = relative(project, ROOT_SOLUTION_PATH).split("\\").join("/");
  return `${JSON.stringify({
    extends: extendsPath,
    compilerOptions: {
      composite: true,
      declaration: true,
      declarationMap: true,
      rootDir,
      outDir: "dist",
      tsBuildInfoFile: "dist/.tsbuildinfo",
      ...(PROJECT_COMPILER_OPTION_OVERRIDES[project] ?? {}),
    },
    include,
    exclude: ["dist", "node_modules"],
    references: references.map((dependency) => ({ path: relativeReference(project, dependency) })),
  }, null, 2)}\n`;
}

function rootSolutionTsconfig() {
  return `${JSON.stringify({
    extends: "./.configs/tsconfig.base.json",
    files: [],
    compilerOptions: {
      baseUrl: ".",
      paths: {
        "@platos/kernel": ["packages/kernel/src/index.ts"],
        "@platos/kernel/*": ["packages/kernel/src/*"],
        "@platos/context-*": ["packages/contexts/*"],
        "@platos/adapter-*": ["packages/adapters/*"],
      },
    },
    references: projectPaths().map((path) => ({ path: `./${path}` })),
  }, null, 2)}\n`;
}

function contextAdapterPorts(name) {
  const ports = [];
  for (const adapter of ADAPTERS) {
    if (adapter.owner === name && adapter.port !== `${pascal(name)}Repository` && !ports.includes(adapter.port)) {
      ports.push(adapter.port);
    }
  }
  return ports;
}

export function renderSkeleton(adopted) {
  const files = new Map();
  const references = projectReferences();
  const put = (path, text) => {
    if (files.has(path)) throw new Error(`duplicate emitted path ${path}`);
    // An adopted project's source tree belongs to real implementation code.
    // Its scaffolding still flows through unchanged.
    if (isAdoptedSourcePath(path, adopted)) return;
    files.set(path, text);
  };

  put(ROOT_SOLUTION_PATH, rootSolutionTsconfig());

  put("packages/kernel/package.json", kernelManifest(adopted));
  put("packages/kernel/tsconfig.json", projectTsconfig("packages/kernel", ["src/**/*.ts"], references.get("packages/kernel"), "src"));
  put(
    "packages/kernel/README.md",
    `# @platos/kernel\n\nADR M0.3 §4 \`packages/kernel\`: the ONLY cross-cutting package. It holds port\ninterfaces and pure value objects and nothing else — no service, no adapter, no\nvendor client, no business rule. \`kernel-is-leaf\` in\n\`scripts/arch/boundary-rules.mjs\` enforces that it imports no context, no\nadapter and no infrastructure client.\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`
  );
  put("packages/kernel/src/index.ts", `${HEADER}export type * from "./ports/index.js";\nexport type * from "./vo/index.js";\n`);
  put(
    "packages/kernel/src/ports/index.ts",
    `${HEADER}// ADR M0.3 §4 kernel-hosted decoupling ports. Declarations only.\n` +
      KERNEL_PORTS.map((port) => `export interface ${port} {\n  readonly __port: "${port}";\n}\n`).join("\n")
  );
  put(
    "packages/kernel/src/vo/index.ts",
    `${HEADER}// ADR M0.3 §4 pure value objects. Declarations only.\n` +
      `export interface TenantScope {\n  readonly organizationId: string;\n}\n\n` +
      `export interface RequestScope {\n  readonly tenant: TenantScope;\n  readonly requestId: string;\n}\n\n` +
      `export interface Money {\n  readonly cents: number;\n  readonly currency: string;\n}\n\n` +
      `export interface DomainEvent {\n  readonly name: string;\n  readonly occurredAt: string;\n}\n`
  );

  for (const name of CONTEXT_NAMES) {
    const base = `packages/contexts/${name}`;
    const dependencies = CONTEXT_DEPENDS_ON[name];
    const Type = pascal(name);
    const adapterPorts = contextAdapterPorts(name);

    put(`${base}/package.json`, contextManifest(name, adopted));
    put(`${base}/tsconfig.json`, projectTsconfig(base, ["domain/**/*.ts", "application/**/*.ts", "contracts/**/*.ts"], references.get(base), "."));
    put(
      `${base}/README.md`,
      `# @platos/context-${name}\n\nADR M0.3 bounded context. Layers: \`domain/\`, \`application/\`,\n\`application/ports/\`, \`contracts/\`. Other contexts may import \`contracts/\` and\nnothing else (\`cross-context-contracts-only\`).\n\nMay depend on: ${dependencies.length ? dependencies.join(", ") : "nothing (leaf)"}.\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`
    );
    put(
      `${base}/domain/index.ts`,
      `${HEADER}// Pure domain. May import its own domain and @platos/kernel only.\n` +
        `import type { TenantScope } from "@platos/kernel";\n\n` +
        `export interface ${Type}Aggregate {\n  readonly scope: TenantScope;\n  readonly id: string;\n}\n`
    );
    put(
      `${base}/application/ports/index.ts`,
      `${HEADER}// Driven ports this context needs. Implemented by packages/adapters/*,\n` +
        `// wired in apps/core-api. Never imported by domain/.\n` +
        `import type { ${Type}Aggregate } from "../../domain/index.js";\n\n` +
        `export interface ${Type}Repository {\n  load(id: string): Promise<${Type}Aggregate | null>;\n}\n` +
        adapterPorts.map((port) => `\nexport interface ${port} {\n  readonly __port: "${port}";\n}\n`).join("")
    );
    put(
      `${base}/application/index.ts`,
      `${HEADER}// Use-cases. May import this context's domain and ports, and any allowed\n` +
        `// peer context's contracts/ (ADR M0.3 §1 domainDeps).\n` +
        `import type { ${Type}Repository } from "./ports/index.js";\n` +
        dependencies.map((dependency) => `import type { ${pascal(dependency)}Contract } from "@platos/context-${dependency}";`).join("\n") +
        (dependencies.length ? "\n" : "") +
        `\nexport interface ${Type}UseCases {\n  readonly repository: ${Type}Repository;\n` +
        dependencies.map((dependency) => `  readonly ${camel(dependency)}: ${pascal(dependency)}Contract;`).join("\n") +
        (dependencies.length ? "\n" : "") +
        `}\n`
    );
    put(
      `${base}/contracts/index.ts`,
      `${HEADER}// The ONLY surface other contexts and apps/core-api may import.\n` +
        `import type { ${Type}Aggregate } from "../domain/index.js";\n\n` +
        `export interface ${Type}Contract {\n  readonly name: "${name}";\n  describe(id: string): Promise<${Type}Aggregate | null>;\n}\n`
    );
  }

  for (const adapter of ADAPTERS) {
    const base = `packages/adapters/${adapter.dir}`;
    const Type = pascal(adapter.dir);
    const portModule = adapter.owner === "kernel"
      ? "@platos/kernel"
      : `@platos/context-${adapter.owner}/application/ports/index.js`;
    put(`${base}/package.json`, adapterManifest(adapter, adopted));
    put(`${base}/tsconfig.json`, projectTsconfig(base, ["src/**/*.ts"], references.get(base), "src"));
    put(
      `${base}/README.md`,
      adapter.owner === "kernel"
        ? `# @platos/adapter-${adapter.dir}\n\nImplements the kernel \`${adapter.port}\` port — ${adapter.note}.\n\nADR M0.3 §4: an adapter implements ONE port and is the sole holder of its vendor\nclient. Only \`apps/core-api\` may import it (\`adapters-only-from-core\`), and it\nmay import no other adapter (\`adapter-is-self-contained\`).\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`
        : `# @platos/adapter-${adapter.dir}\n\nImplements the ${adapter.owner} \`${adapter.port}\` port — ${adapter.note}.\n\nADR M0.3 §4/§13: an adapter implements ONE owner-supplied port and is the sole\nholder of its vendor client. Only \`apps/core-api\` may import it, and it may\nimport no other adapter.\n\nGenerated by \`scripts/arch/gen-v1-skeleton.mjs\`; M2 fills it in.\n`
    );
    put(`${base}/src/index.ts`, `${HEADER}export type { ${Type}Adapter } from "./adapter.js";\n`);
    put(
      `${base}/src/adapter.ts`,
      `${HEADER}// The single ${adapter.port} implementation. The vendor client is imported\n` +
        `// HERE and nowhere else in the repository.\n` +
        `import type { ${adapter.port} } from "${portModule}";\n\n` +
        `export interface ${Type}Adapter extends ${adapter.port} {\n  readonly adapterName: "${adapter.dir}";\n}\n`
    );
  }

  const coreDependencies = [
    "@platos/kernel",
    ...CONTEXT_NAMES.map((name) => `@platos/context-${name}`),
    ...ADAPTERS.map((adapter) => `@platos/adapter-${adapter.dir}`),
  ];
  put("apps/core-api/package.json", appManifest({
    scripts: scriptsFor("apps/core-api", adopted),
    name: "@platos/core-api",
    description: "THE single V1 deployable: the composition root and every transport.",
    dependencies: coreDependencies,
    externalDependencies: CORE_API_RUNTIME_DEPENDENCIES,
  }));
  put("apps/core-api/tsconfig.json", projectTsconfig("apps/core-api", ["src/**/*.ts"], references.get("apps/core-api"), "src"));
  put(
    "apps/core-api/README.md",
    `# @platos/core-api\n\nADR M0.3 §4: THE single V1 deployable. It is the composition root — the ONLY\nplace that may import \`packages/adapters/*\` — and it hosts every transport.\nTransports are thin: they call context use-cases and hold no business rule.\n\nThis project's SOURCE tree is adopted (WIN-297): \`src/\` is hand-written, and\n\`scripts/arch/composition-root.mjs\` narrows \`adapters-only-from-core\` further,\nto the one composition module inside it. Its \`package.json\`, \`tsconfig.json\` and\nthis README stay generated by \`scripts/arch/gen-v1-skeleton.mjs\`.\n\nRun it with \`pnpm --filter @platos/core-api start\` after \`pnpm build:v1\`.\n`
  );
  // The source placeholders below are still rendered for an UNADOPTED
  // apps/core-api — `put()` drops them once the project is adopted. Deleting the
  // emitters instead of letting adoption release them would break the
  // EXPECTED_PLACEHOLDER_FILE_COUNT invariant and, worse, silently disarm the
  // monotonicity lock: un-adopting would then produce no MISSING placeholder to
  // fail on.
  put(
    "apps/core-api/src/main.ts",
    `${HEADER}// Process entry point. Boots the composition root and nothing else.\n` +
      `import type { AppModule } from "./app.module.js";\n\n` +
      `export type Bootstrap = () => Promise<AppModule>;\n`
  );
  put(
    "apps/core-api/src/app.module.ts",
    `${HEADER}// THE composition root: the one place adapters are bound to context ports.\n` +
      CONTEXT_NAMES.map((name) => `import type { ${pascal(name)}Contract } from "@platos/context-${name}";`).join("\n") +
      "\n" +
      ADAPTERS.map((adapter) => `import type { ${pascal(adapter.dir)}Adapter } from "@platos/adapter-${adapter.dir}";`).join("\n") +
      "\n\nexport interface AppModule {\n" +
      CONTEXT_NAMES.map((name) => `  readonly ${camel(name)}: ${pascal(name)}Contract;`).join("\n") +
      "\n" +
      ADAPTERS.map((adapter) => `  readonly ${camel(adapter.dir)}: ${pascal(adapter.dir)}Adapter;`).join("\n") +
      "\n}\n"
  );
  for (const transport of TRANSPORTS) {
    put(
      `apps/core-api/src/transports/${transport}/index.ts`,
      `${HEADER}// Thin ${transport} transport. Calls context use-cases only.\n` +
        `import type { AppModule } from "../../app.module.js";\n\n` +
        `export interface ${pascal(transport)}Transport {\n  readonly kind: "${transport}";\n  readonly app: AppModule;\n}\n`
    );
  }

  put("apps/mcp-stdio/package.json", appManifest({
    scripts: scriptsFor("apps/mcp-stdio", adopted),
    name: "@platos/mcp-stdio",
    description: "Thin stdio binary; reuses the tools context transport.",
    dependencies: ["@platos/context-tools"],
  }));
  put("apps/mcp-stdio/tsconfig.json", projectTsconfig("apps/mcp-stdio", ["src/**/*.ts"], references.get("apps/mcp-stdio"), "src"));
  put(
    "apps/mcp-stdio/README.md",
    `# @platos/mcp-stdio\n\nADR M0.3 §4: a thin stdio binary. It owns no business logic; it reuses the\n\`tools\` context transport surface published through that context's\n\`contracts/\`.\n\nThis project's SOURCE tree is adopted (WIN-297). It is a real process with a\nfail-closed startup, but it holds no adapter: \`adapters-only-from-core\`\n(rule (j)) names \`apps/core-api\` alone, so this binary receives its\n\`ToolsContract\` from a host-supplied runtime module and refuses to start\nwithout one. Its \`package.json\`, \`tsconfig.json\` and this README stay generated\nby \`scripts/arch/gen-v1-skeleton.mjs\`.\n`
  );
  put(
    "apps/mcp-stdio/src/main.ts",
    `${HEADER}// Stdio entry point. Reuses the tools context contract surface.\n` +
      `import type { ToolsContract } from "@platos/context-tools";\n\n` +
      `export type StdioBootstrap = () => Promise<ToolsContract>;\n`
  );

  return files;
}

export function selfCheck(adopted = ADOPTED_PROJECTS) {
  const errors = [];
  const adapterDirectories = new Set(ADAPTERS.map((adapter) => adapter.dir));
  const references = projectReferences();
  const edgeCount = [...references.values()].reduce((count, dependencies) => count + dependencies.length, 0);

  for (const sdk of SDK_CONTAINMENT) {
    const match = /\^packages\/adapters\/([^/]+)\//u.exec(sdk.home);
    if (match && !adapterDirectories.has(match[1])) {
      errors.push(`SDK_CONTAINMENT ${sdk.id} names packages/adapters/${match[1]}/, which the skeleton does not create`);
    }
  }
  if (CONTEXT_NAMES.length !== 17) errors.push(`ADR M0.3 §4 names 17 contexts; CONTEXT_DEPENDS_ON has ${CONTEXT_NAMES.length}`);
  if (ADAPTERS.length !== 12) errors.push(`ADR M0.3 §4 names 12 concrete adapters; ADAPTERS has ${ADAPTERS.length}`);
  if (projectPaths().length !== EXPECTED_PROJECT_COUNT) errors.push(`V1 project count is ${projectPaths().length}, expected ${EXPECTED_PROJECT_COUNT}`);
  if (edgeCount !== EXPECTED_EDGE_COUNT) errors.push(`V1 project edge count is ${edgeCount}, expected ${EXPECTED_EDGE_COUNT}`);
  for (const name of CONTEXT_NAMES) {
    for (const dependency of CONTEXT_DEPENDS_ON[name]) {
      if (!CONTEXT_NAMES.includes(dependency)) errors.push(`${name} depends on unknown context ${dependency}`);
    }
  }
  for (const adapter of ADAPTERS) {
    if (adapter.owner !== "kernel" && !CONTEXT_NAMES.includes(adapter.owner)) {
      errors.push(`${adapter.dir} assigns ${adapter.port} to unknown owner ${adapter.owner}`);
    }
  }

  // The adoption registry may name only real V1 projects, and may name each once.
  const knownProjects = new Set(projectPaths());
  const seenAdoptions = new Set();
  for (const project of adopted) {
    if (!knownProjects.has(project)) errors.push(`ADOPTED_PROJECTS names ${project}, which is not a V1 project`);
    if (seenAdoptions.has(project)) errors.push(`ADOPTED_PROJECTS names ${project} more than once`);
    seenAdoptions.add(project);
  }

  // The two tiers must still account for the whole skeleton. Scaffolding is
  // invariant; placeholders shrink by exactly what adoption released.
  const { scaffolding, placeholders } = tierCounts(renderSkeleton(adopted));
  if (scaffolding !== EXPECTED_SCAFFOLDING_FILE_COUNT) {
    errors.push(`scaffolding file count is ${scaffolding}, expected ${EXPECTED_SCAFFOLDING_FILE_COUNT}`);
  }
  if (placeholders > EXPECTED_PLACEHOLDER_FILE_COUNT) {
    errors.push(`placeholder file count is ${placeholders}, which exceeds the unadopted maximum ${EXPECTED_PLACEHOLDER_FILE_COUNT}`);
  }
  return errors;
}

// Build output, never source. `.turbo` joins `dist` and `node_modules` here:
// all three are gitignored artifacts, and without `.turbo` a plain
// `turbo run build` leaves a turbo-build.log in every project and `--check`
// reports 30 phantom EXTRA files (WIN-256 finding; pre-existing since M1).
const ARTIFACT_DIRECTORIES = ["dist", "node_modules", ".turbo"];

export function listExistingOwnedFiles(root) {
  const found = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && ARTIFACT_DIRECTORIES.includes(entry.name)) continue;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (!entry.name.endsWith(".tsbuildinfo")) found.push(relative(root, child).split("\\").join("/"));
    }
  };
  for (const owned of OWNED_ROOTS) {
    const absolute = join(root, owned);
    if (existsSync(absolute) && statSync(absolute).isDirectory()) walk(absolute);
  }
  if (existsSync(join(root, ROOT_SOLUTION_PATH))) found.push(ROOT_SOLUTION_PATH);
  return found.sort();
}

export function checkSkeleton(root = repositoryRoot, adopted) {
  const problems = [];
  const files = renderSkeleton(adopted);
  for (const [path, text] of files) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) problems.push(`MISSING ${path}`);
    else if (readFileSync(absolute, "utf8") !== text) problems.push(`STALE   ${path}`);
  }
  for (const path of listExistingOwnedFiles(root)) {
    if (files.has(path) || isAdoptedSourcePath(path, adopted)) continue;
    problems.push(`EXTRA   ${path}`);
  }
  return problems;
}

export function writeSkeleton(root = repositoryRoot, adopted) {
  const files = renderSkeleton(adopted);
  for (const [path, text] of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, text, "utf8");
  }
  return files;
}

function main() {
  const root = repositoryRoot;
  const check = process.argv.includes("--check");
  const list = process.argv.includes("--list");

  const selfErrors = selfCheck();
  if (selfErrors.length) {
    for (const error of selfErrors) process.stderr.write(`FAIL ${error}\n`);
    process.exitCode = 1;
    return;
  }

  const files = renderSkeleton();
  const { scaffolding, placeholders } = tierCounts(files);
  const tiers =
    `${scaffolding} scaffolding + ${placeholders} placeholder = ${files.size} generated file(s)` +
    ` for ${EXPECTED_PROJECT_COUNT} V1 projects and ${EXPECTED_EDGE_COUNT} project edges` +
    ` (${ADOPTED_PROJECTS.length} project(s) adopted, ${EXPECTED_PLACEHOLDER_FILE_COUNT - placeholders} placeholder(s) released)`;

  if (list) {
    for (const path of [...files.keys()].sort()) process.stdout.write(`${path}\n`);
    return;
  }

  if (check) {
    const problems = checkSkeleton(root);
    if (problems.length) {
      for (const problem of problems) process.stdout.write(`${problem}\n`);
      process.stdout.write(`\n${problems.length} generated drift(s). Run: node scripts/arch/gen-v1-skeleton.mjs\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`ok: ${tiers}\n`);
    return;
  }

  writeSkeleton(root);
  process.stdout.write(`wrote ${tiers}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("gen-v1-skeleton.mjs")) main();
