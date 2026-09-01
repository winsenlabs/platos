import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_ALIASES,
  EXPECTED_CONTEXT_DEPENDS_ON,
  EXPECTED_EDGE_COUNT,
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

test("the live graph has exact aliases, 32 projects and 94 edges in all three representations", () => {
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
  const sourcePath = join(root, "apps/mcp-stdio/src/main.ts");
  writeFileSync(sourcePath, "export type StdioBootstrap = () => Promise<unknown>;\n");
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
