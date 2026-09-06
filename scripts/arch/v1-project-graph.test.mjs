import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkAdapterOwnerCounts,
  EXPECTED_ADAPTER_OWNERS,
  EXPECTED_MULTI_OWNER_ADAPTERS,
  EXPECTED_ALIASES,
  EXPECTED_CONTEXT_DEPENDS_ON,
  EXPECTED_EDGE_COUNT,
  EXPECTED_EXTERNAL_DEPENDENCIES,
  EXPECTED_PROJECT_COUNT,
  checkV1ProjectGraph,
} from "./v1-project-graph.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = [];

after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync("/var/tmp/platos-v1-graph-");
  fixtures.push(root);
  cpSync(join(repositoryRoot, "tsconfig.json"), join(root, "tsconfig.json"));
  for (const path of ["packages/kernel", "packages/contexts", "packages/adapters", "apps/core-api", "apps/mcp-stdio"]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  return root;
}

function mutateJson(root, path, mutate) {
  const absolute = join(root, path);
  const value = JSON.parse(readFileSync(absolute, "utf8"));
  mutate(value);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function errorIncludes(result, text) {
  return result.errors.some((error) => error.includes(text));
}

test("the live graph has exact aliases, 32 projects and 96 edges in all three representations", () => {
  const result = checkV1ProjectGraph(repositoryRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.projectCount, EXPECTED_PROJECT_COUNT);
  assert.equal(result.referenceEdgeCount, EXPECTED_EDGE_COUNT);
  assert.equal(result.dependencyEdgeCount, EXPECTED_EDGE_COUNT);
  assert.equal(result.sourceEdgeCount, EXPECTED_EDGE_COUNT);
  assert.deepEqual(EXPECTED_ALIASES, {
    "@platos/kernel": ["packages/kernel/src/index.ts"],
    "@platos/kernel/*": ["packages/kernel/src/*"],
    "@platos/context-*": ["packages/contexts/*"],
    "@platos/adapter-*": ["packages/adapters/*"],
  });
  assert.equal(Object.keys(EXPECTED_CONTEXT_DEPENDS_ON).length, 17);
});

// ---------------------------------------------------------------------------
// WIN-297 — the external-dependency axis.
//
// Before the split, every entry in every V1 manifest's `dependencies` had to be
// `workspace:*` and had to appear in the workspace edge count. That made
// `apps/core-api` — the project ADR M0.3 §4 defines as the NEST composition root
// — unable to depend on Nest. The workspace property is unchanged and still
// tested above; these prove the new property is not merely permissive.
// ---------------------------------------------------------------------------

test("the composition root's declared external dependencies are exactly the reviewed set", () => {
  assert.deepEqual(EXPECTED_EXTERNAL_DEPENDENCIES["apps/core-api"], {
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/platform-express": "^11.0.0",
    "reflect-metadata": "^0.2.2",
    rxjs: "^7.8.1",
  });
});

test("exactly THREE projects may hold an external dependency, and they are named", () => {
  // The list is short on purpose and its shortness is the property. A fourth
  // entry appearing here is a reviewed decision to let a registry package into
  // the V1 layout, and it has to be made by moving this line.
  //
  // WIN-258 made the third: `packages/adapters/postgres-tenancy` declares the
  // generated PostgreSQL client. It is the only V1 project entitled to, and the
  // case below says so on the DECLARE axis exactly as the inference-SDK case
  // does, because a boundary rule that governs imports alone leaves a manifest
  // entry legal until the day somebody imports it.
  assert.deepEqual(Object.keys(EXPECTED_EXTERNAL_DEPENDENCIES).sort(), [
    "apps/core-api",
    "packages/adapters/model-router-providers",
    "packages/adapters/postgres-tenancy",
  ]);
});

test("the PostgreSQL client is declared in exactly ONE project, as a workspace link", () => {
  assert.deepEqual(EXPECTED_EXTERNAL_DEPENDENCIES["packages/adapters/postgres-tenancy"], {
    "@platos/tenancy-database": "workspace:*",
  });
  const holders = Object.entries(EXPECTED_EXTERNAL_DEPENDENCIES)
    .filter(([, declared]) => Object.keys(declared).some((name) => name.includes("tenancy-database")))
    .map(([project]) => project);
  assert.deepEqual(holders, ["packages/adapters/postgres-tenancy"]);
});

test("the inference SDK is declared in exactly ONE project, at exactly one range each", () => {
  // ADR M0.3 §5.1 rule (h) says the SDK may only be IMPORTED in this directory;
  // this says it may only be DECLARED here. Without the second half a context
  // could carry `ai` in its manifest and pass the import rule by not importing
  // it -- and the next file that did would be one review away from legal.
  assert.deepEqual(EXPECTED_EXTERNAL_DEPENDENCIES["packages/adapters/model-router-providers"], {
    "@ai-sdk/anthropic": "^4.0.15",
    "@ai-sdk/google": "^4.0.16",
    "@ai-sdk/google-vertex": "^5.0.20",
    "@ai-sdk/openai": "^4.0.14",
    ai: "^7.0.28",
    ajv: "8.18.0",
    zod: "3.25.76",
  });
  const holders = Object.entries(EXPECTED_EXTERNAL_DEPENDENCIES)
    .filter(([, declared]) => Object.keys(declared).some((name) => name === "ai" || name.startsWith("@ai-sdk/")))
    .map(([project]) => project);
  assert.deepEqual(holders, ["packages/adapters/model-router-providers"]);
});

test("an UNDECLARED external dependency fails, wherever it is added", () => {
  const root = fixture();
  mutateJson(root, "packages/contexts/identity-access/package.json", (manifest) => {
    manifest.dependencies["ioredis"] = "^5.0.0";
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "packages/contexts/identity-access external dependencies"));
  assert.ok(errorIncludes(result, "declare it in EXPECTED_EXTERNAL_DEPENDENCIES or remove it"));
});

test("an external dependency added to the composition root beyond the reviewed set fails", () => {
  const root = fixture();
  mutateJson(root, "apps/core-api/package.json", (manifest) => {
    manifest.dependencies["express"] = "^4.0.0";
  });
  assert.ok(errorIncludes(checkV1ProjectGraph(root), "apps/core-api external dependencies"));
});

test("a declared external dependency whose RANGE drifts fails", () => {
  // The range is the supply-chain decision. Without this, `^11.0.0` could become
  // `*` and the audit would still be green.
  const root = fixture();
  mutateJson(root, "apps/core-api/package.json", (manifest) => {
    manifest.dependencies["@nestjs/core"] = "*";
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "@nestjs/core is *; expected the reviewed range ^11.0.0"));
});

test("REMOVING a declared external dependency also fails", () => {
  // Declaration is exact in both directions: the audit describes reality, and a
  // stale entry left behind after a real removal is itself a defect.
  const root = fixture();
  mutateJson(root, "apps/core-api/package.json", (manifest) => {
    delete manifest.dependencies["reflect-metadata"];
  });
  assert.ok(errorIncludes(checkV1ProjectGraph(root), "apps/core-api external dependencies"));
});

test("an external dependency does NOT inflate the workspace edge count", () => {
  const root = fixture();
  mutateJson(root, "apps/core-api/package.json", (manifest) => {
    manifest.dependencies["express"] = "^4.0.0";
  });
  const result = checkV1ProjectGraph(root);
  assert.equal(result.dependencyEdgeCount, EXPECTED_EDGE_COUNT);
});

test("a workspace dependency pinned to a version rather than workspace:* still fails", () => {
  // The half of the original rule that must survive the split.
  const root = fixture();
  mutateJson(root, "apps/core-api/package.json", (manifest) => {
    manifest.dependencies["@platos/kernel"] = "0.0.0";
  });
  assert.ok(errorIncludes(checkV1ProjectGraph(root), "@platos/kernel must be workspace:*"));
});

test("the composition root's kernel edge is present in all three representations", () => {
  // The 94 -> 95 delta, asserted directly rather than only through the total.
  const root = fixture();
  mutateJson(root, "apps/core-api/tsconfig.json", (config) => {
    config.references = config.references.filter((reference) => reference.path !== "../../packages/kernel");
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "apps/core-api references"));
  assert.equal(result.referenceEdgeCount, EXPECTED_EDGE_COUNT - 1);
});

test("removing a root solution reference fails independently", () => {
  const root = fixture();
  mutateJson(root, "tsconfig.json", (config) => config.references.pop());
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "root references must list the exact 32 projects"));
});

test("removing a project reference fails even when source and dependencies still declare the edge", () => {
  const root = fixture();
  mutateJson(root, "packages/contexts/conversations/tsconfig.json", (config) => {
    config.references = config.references.filter((reference) => reference.path !== "../tools");
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "packages/contexts/conversations references"));
  assert.equal(result.referenceEdgeCount, EXPECTED_EDGE_COUNT - 1);
});

test("an aligned but forbidden wrong-way extra edge still fails the architecture expectation", () => {
  const root = fixture();
  mutateJson(root, "packages/contexts/identity-access/tsconfig.json", (config) => {
    config.references.push({ path: "../tenancy" });
  });
  mutateJson(root, "packages/contexts/identity-access/package.json", (manifest) => {
    manifest.dependencies["@platos/context-tenancy"] = "workspace:*";
  });
  const sourcePath = join(root, "packages/contexts/identity-access/application/index.ts");
  writeFileSync(
    sourcePath,
    `${readFileSync(sourcePath, "utf8")}import type { TenancyContract } from "@platos/context-tenancy";\nexport type WrongWay = TenancyContract;\n`
  );
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "packages/contexts/identity-access references"));
  assert.ok(errorIncludes(result, "packages/contexts/identity-access dependencies"));
  assert.ok(errorIncludes(result, "packages/contexts/identity-access source edges"));
  assert.equal(result.referenceEdgeCount, EXPECTED_EDGE_COUNT + 1);
  assert.equal(result.dependencyEdgeCount, EXPECTED_EDGE_COUNT + 1);
  assert.equal(result.sourceEdgeCount, EXPECTED_EDGE_COUNT + 1);
});

test("alias drift fails even when every project file is otherwise intact", () => {
  const root = fixture();
  mutateJson(root, "tsconfig.json", (config) => {
    config.compilerOptions.paths["@platos/kernel"] = ["packages/kernel/src"];
  });
  assert.ok(errorIncludes(checkV1ProjectGraph(root), "exact four WIN-251 aliases"));
});

test("workspace dependency and project-reference drift is detected", () => {
  const root = fixture();
  mutateJson(root, "packages/adapters/redis-cache/package.json", (manifest) => {
    delete manifest.dependencies["@platos/context-memory"];
    manifest.dependencies["@platos/kernel"] = "workspace:*";
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "packages/adapters/redis-cache dependencies"));
});

test("a syntactically non-empty include that matches zero source files fails", () => {
  const root = fixture();
  mutateJson(root, "packages/kernel/tsconfig.json", (config) => {
    config.include = ["missing/**/*.ts"];
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "packages/kernel include missing/**/*.ts is vacuous"));
  assert.ok(errorIncludes(result, "packages/kernel source src/index.ts is outside every include"));
});

test("an extra discovered project fails the exact project-count contract", () => {
  const root = fixture();
  const rogue = "packages/contexts/rogue";
  mkdirSync(join(root, rogue, "src"), { recursive: true });
  writeFileSync(join(root, rogue, "src/index.ts"), "export interface Rogue {}\n");
  writeFileSync(join(root, rogue, "package.json"), '{"name":"@platos/context-rogue"}\n');
  writeFileSync(join(root, rogue, "tsconfig.json"), '{"compilerOptions":{"composite":true},"include":["src/**/*.ts"],"references":[]}\n');
  mutateJson(root, "tsconfig.json", (config) => config.references.push({ path: `./${rogue}` }));
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "root references must list the exact 32 projects"));
  assert.ok(errorIncludes(result, "discovered project set"));
});

test("removing a source import cannot hide behind matching manifest and reference edges", () => {
  const root = fixture();
  // WIN-297: apps/mcp-stdio is no longer one file. Emptying main.ts alone left
  // `runtime.ts` and the testing runtime still importing @platos/context-tools,
  // so the edge survived and this mutation silently stopped testing anything —
  // the same vacuity class WIN-256 found in workspace-reachability. The mutation
  // now removes the specifier from EVERY file in the project, which is what
  // "removing the source import" has to mean once a project has more than one.
  const source = join(root, "apps/mcp-stdio/src");
  const strip = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) strip(child);
      else if (entry.name.endsWith(".ts")) {
        writeFileSync(child, readFileSync(child, "utf8").replaceAll("@platos/context-tools", "./local-stub.js"));
      }
    }
  };
  strip(source);
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "apps/mcp-stdio source edges"));
  assert.equal(result.sourceEdgeCount, EXPECTED_EDGE_COUNT - 1);
});

test("a count-preserving shared-map edge replacement fails exact acceptance identity", () => {
  const root = fixture();
  mutateJson(root, "packages/contexts/tenancy/tsconfig.json", (config) => {
    config.references = config.references.map((reference) =>
      reference.path === "../identity-access" ? { path: "../secrets" } : reference
    );
  });
  mutateJson(root, "packages/contexts/tenancy/package.json", (manifest) => {
    delete manifest.dependencies["@platos/context-identity-access"];
    manifest.dependencies["@platos/context-secrets"] = "workspace:*";
  });
  const sourcePath = join(root, "packages/contexts/tenancy/application/index.ts");
  writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replaceAll("@platos/context-identity-access", "@platos/context-secrets"));
  const result = checkV1ProjectGraph(root);
  assert.equal(result.referenceEdgeCount, EXPECTED_EDGE_COUNT);
  assert.equal(result.dependencyEdgeCount, EXPECTED_EDGE_COUNT);
  assert.equal(result.sourceEdgeCount, EXPECTED_EDGE_COUNT);
  assert.ok(errorIncludes(result, "packages/contexts/tenancy references"));
  assert.ok(errorIncludes(result, "packages/contexts/tenancy dependencies"));
  assert.ok(errorIncludes(result, "packages/contexts/tenancy source edges"));
});

test("an import through an undeclared package subpath fails package-surface auditing", () => {
  const root = fixture();
  const sourcePath = join(root, "apps/mcp-stdio/src/main.ts");
  writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace("@platos/context-tools", "@platos/context-tools/contracts/index.js"));
  assert.ok(errorIncludes(checkV1ProjectGraph(root), "imports unexported package subpath @platos/context-tools/contracts/index.js"));
});

test("root export drift from declared main and types fails", () => {
  const root = fixture();
  mutateJson(root, "packages/contexts/tools/package.json", (manifest) => {
    manifest.exports["."].import = "./dist/contracts/not-index.js";
  });
  const result = checkV1ProjectGraph(root);
  assert.ok(errorIncludes(result, "root export must agree with main and types"));
});

test("an export target without a corresponding emitted source path fails", () => {
  const root = fixture();
  mutateJson(root, "packages/adapters/redis-cache/package.json", (manifest) => {
    manifest.exports["."].import = "./dist/missing.js";
  });
  assert.ok(errorIncludes(checkV1ProjectGraph(root), "does not map to an emitted source path under dist"));
});

test("NodeNext consumers resolve bare roots and the explicit exported adapter-port subpath", () => {
  const build = spawnSync(join(repositoryRoot, "node_modules/.bin/tsc"), ["-b"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const root = mkdtempSync("/var/tmp/platos-nodenext-consumer-");
  fixtures.push(root);
  try {
    const scope = join(root, "node_modules/@platos");
    mkdirSync(scope, { recursive: true });
    for (const [name, target] of [
      ["kernel", "packages/kernel"],
      ["context-tools", "packages/contexts/tools"],
      ["context-memory", "packages/contexts/memory"],
      ["adapter-redis-cache", "packages/adapters/redis-cache"],
    ]) symlinkSync(join(repositoryRoot, target), join(scope, name), "dir");
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(join(root, "consumer.ts"), [
      'import type { ToolsContract } from "@platos/context-tools";',
      'import type { RedisCacheAdapter } from "@platos/adapter-redis-cache";',
      'import type { Cache } from "@platos/context-memory/application/ports/index.js";',
      "export type Consumer = [ToolsContract, RedisCacheAdapter, Cache];",
      "",
    ].join("\n"));
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      strict: true, noEmit: true, module: "NodeNext", moduleResolution: "NodeNext", preserveSymlinks: true,
    }, include: ["consumer.ts"] }, null, 2));
    const consumer = spawnSync(join(repositoryRoot, "node_modules/.bin/tsc"), ["-p", root], { cwd: root, encoding: "utf8" });
    assert.equal(consumer.status, 0, consumer.stdout + consumer.stderr);
  } finally {
    spawnSync("pnpm", ["clean:v1"], { cwd: repositoryRoot });
  }
});

// ---------------------------------------------------------------------------
// WIN-258 T2 (ADR M0.3 §15) — an adapter's owner map became a LIST, and these
// are the refusals that widening did not take with it. The default is still
// exactly one owner edge; every departure is named and counted.
// ---------------------------------------------------------------------------

test("the live owner map passes its own check", () => {
  // Non-vacuity for everything below.
  assert.deepEqual(checkAdapterOwnerCounts(), []);
  // 2 -> 13 (WIN-258 T5, eleven times). `tools` is the THIRD owner delegated to
  // this one directory, `agents` the FOURTH, `cost-monitoring` the FIFTH,
  // `channels` the SIXTH, `governance` the SEVENTH, `secrets` the EIGHTH,
  // `providers` the NINTH, `conversations` the TENTH, `skills` the ELEVENTH,
  // `memory` the TWELFTH, `privacy` the THIRTEENTH, `jobs` the FOURTEENTH,
  // `files` the FIFTEENTH, `observability` the SIXTEENTH and `eventing` the
  // SEVENTEENTH — which is every context ADR M0.3 §1 names.
  // None of `agents`, `governance`, `secrets` or `conversations` is more than one
  // owner edge even though they publish two ports, five, two and four, and
  // neither is `skills`, whose ONE port covers three tables: this map counts
  // OWNERS, and the project reference the adapter needs is per package, not per
  // port. `providers` is the converse and the sharpest case: it publishes THREE
  // ports and gets ONE edge, because only one of the three is a canonical store —
  // `ModelRouter` belongs to `model-router-providers` and `ProviderProbeCache` to
  // no adapter at all.
  // `memory` is a second converse: it publishes SIX ports and gets ONE edge,
  // because only two of the six are canonical stores — `Cache` is bound to
  // `redis-cache`, and the other three write no row at all.
  // 12 -> 13 (WIN-258 T5). `privacy` is the THIRTEENTH owner delegated to this
  // one directory, and it is the THIRD converse and the sharpest of the three:
  // it publishes FOUR ports and gets ONE edge, because only one of the four is a
  // canonical store. `SubjectDirectory` reads `identity-access`' identity graph —
  // a peer read this directory could physically serve and that port is not
  // entitled to — `SubjectHasher` is a synchronous salted digest with a secret in
  // it, and `LegalHoldRegister` is installation configuration with no canonical
  // row in the schema at all.
  // 13 -> 14 (WIN-258 T5). `jobs` is a FOURTH: it publishes FOUR ports and gets
  // ONE edge, because only two of the four are canonical stores —
  // `IdempotencyStore` is a reserve-once keyspace and `JobHandlerRuntime` is an
  // isolate, and neither writes a row.
  assert.deepEqual(EXPECTED_MULTI_OWNER_ADAPTERS, { "postgres-tenancy": 17 });
  assert.equal(Object.keys(EXPECTED_ADAPTER_OWNERS).length, 12);
});

test("§15 refusal: an adapter granted an owner edge it was not given fails", () => {
  const errors = checkAdapterOwnerCounts(
    { ...EXPECTED_ADAPTER_OWNERS, "redis-cache": ["memory", "tenancy"] },
    EXPECTED_MULTI_OWNER_ADAPTERS,
  );
  assert.ok(
    errors.some((error) =>
      error.includes("packages/adapters/redis-cache expects 2 owner edge(s); 1 is what ADR M0.3 §4/§15 grants it")
    )
  );
});

test("§15 refusal: the multi-owner adapter LOSING an edge it was granted fails too", () => {
  const errors = checkAdapterOwnerCounts(
    { ...EXPECTED_ADAPTER_OWNERS, "postgres-tenancy": ["tenancy"] },
    EXPECTED_MULTI_OWNER_ADAPTERS,
  );
  assert.ok(
    errors.some((error) =>
      error.includes("packages/adapters/postgres-tenancy expects 1 owner edge(s); 17 is what ADR M0.3 §4/§15 grants it")
    )
  );
});

test("§15 refusal: the same owner listed twice is not two edges", () => {
  const errors = checkAdapterOwnerCounts(
    { ...EXPECTED_ADAPTER_OWNERS, "postgres-tenancy": ["tenancy", "tenancy"] },
    EXPECTED_MULTI_OWNER_ADAPTERS,
  );
  assert.ok(
    errors.some((error) => error.includes("packages/adapters/postgres-tenancy names the same owner more than once"))
  );
});

test("§15 refusal: the multi-owner allow-list may not name something that is not an adapter", () => {
  const errors = checkAdapterOwnerCounts(EXPECTED_ADAPTER_OWNERS, {
    ...EXPECTED_MULTI_OWNER_ADAPTERS,
    "postgres-auth": 2,
  });
  assert.ok(
    errors.some((error) => error.includes("EXPECTED_MULTI_OWNER_ADAPTERS names postgres-auth, which is not an adapter"))
  );
});
