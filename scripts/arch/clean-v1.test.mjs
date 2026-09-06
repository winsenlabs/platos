import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { EXPECTED_V1_PROJECT_COUNT, EXPECTED_V1_PROJECTS, cleanV1, v1DistDirectories } from "./clean-v1.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = [];
after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function run(script) {
  const result = spawnSync("pnpm", [script], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

function fixture() {
  const root = mkdtempSync("/var/tmp/platos-clean-v1-");
  fixtures.push(root);
  cpSync(join(repositoryRoot, "tsconfig.json"), join(root, "tsconfig.json"));
  for (const { project } of v1DistDirectories(repositoryRoot)) {
    const path = relative(repositoryRoot, project);
    cpSync(join(project, "tsconfig.json"), join(root, path, "tsconfig.json"), { recursive: true });
    const dist = join(root, path, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "sentinel"), "must survive validation failure\n");
  }
  return root;
}

function assertAllSentinelsRemain(root) {
  for (const project of EXPECTED_V1_PROJECTS) {
    assert.equal(readFileSync(join(root, project, "dist/sentinel"), "utf8"), "must survive validation failure\n");
  }
}

function mutateJson(path, mutate) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  mutate(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("build:v1 emits every project and clean:v1 removes every dist tree", () => {
  run("build:v1");
  const projects = v1DistDirectories(repositoryRoot);
  assert.equal(projects.length, EXPECTED_V1_PROJECT_COUNT);
  for (const { project, dist } of projects) {
    assert.ok(existsSync(dist), `${relative(repositoryRoot, project)} dist exists`);
    const files = readdirSync(dist, { recursive: true }).map(String);
    assert.ok(files.some((path) => path.endsWith(".js")), `${relative(repositoryRoot, project)} emitted JavaScript`);
    assert.ok(files.some((path) => path.endsWith(".d.ts")), `${relative(repositoryRoot, project)} emitted declarations`);
    assert.ok(files.some((path) => path.endsWith(".tsbuildinfo")), `${relative(repositoryRoot, project)} emitted buildinfo`);
  }
  run("clean:v1");
  for (const { dist } of projects) assert.equal(existsSync(dist), false, dist);
});

test("cleanup rejects an incomplete root project reference set", () => {
  const root = fixture();
  mutateJson(join(root, "tsconfig.json"), (config) => config.references.pop());
  assert.throws(() => cleanV1(root), /exactly 33 V1 project references/u);
  assertAllSentinelsRemain(root);
});

test("cleanup rejects direct retargeting to a non-V1 project before deletion", () => {
  const root = fixture();
  const client = join(root, "packages/platos-client");
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, "tsconfig.json"), '{"compilerOptions":{"outDir":"dist"}}\n');
  mutateJson(join(root, "tsconfig.json"), (config) => { config.references[18].path = "./packages/platos-client"; });
  assert.throws(() => cleanV1(root), /exact ordered 33-project V1 target set/u);
  assertAllSentinelsRemain(root);
});

test("cleanup rejects retargeted paths before deleting anything", () => {
  for (const mutate of [
    (root) => mutateJson(join(root, "tsconfig.json"), (config) => { config.references[0].path = "../outside"; }),
    (root) => mutateJson(join(root, "packages/kernel/tsconfig.json"), (config) => { config.compilerOptions.outDir = "../dist"; }),
  ]) {
    const root = fixture();
    mutate(root);
    assert.throws(() => cleanV1(root), /unsafe|exact generated dist output options/u);
    assertAllSentinelsRemain(root);
  }
});

test("cleanup rejects a symlink in any project ancestor before deletion", () => {
  const root = fixture();
  const contexts = join(root, "packages/contexts");
  const realContexts = join(root, "packages/contexts-real");
  renameSync(contexts, realContexts);
  symlinkSync(realContexts, contexts, "dir");
  assert.throws(() => cleanV1(root), /unsafe symbolic path component/u);
  for (const project of EXPECTED_V1_PROJECTS.filter((path) => !path.startsWith("packages/contexts/"))) {
    assert.ok(existsSync(join(root, project, "dist/sentinel")));
  }
  for (const project of EXPECTED_V1_PROJECTS.filter((path) => path.startsWith("packages/contexts/"))) {
    const suffix = project.slice("packages/contexts/".length);
    assert.ok(existsSync(join(realContexts, suffix, "dist/sentinel")));
  }
});

test("the decorator exception is scoped to apps/core-api and nowhere else", () => {
  // WIN-297 lets ONE project set experimentalDecorators/emitDecoratorMetadata:
  // apps/core-api, because Nest 11's DI reads metadata only the legacy transform
  // emits and the repository base config turns it off. Without this control the
  // exception would be indistinguishable from having widened the allowed option
  // set for all 32 projects — which would make @nestjs compilable inside a
  // context, one directory from code ADR M0.3 §2 bans it from.
  for (const project of ["packages/kernel", "packages/contexts/tenancy", "apps/mcp-stdio"]) {
    const root = fixture();
    mutateJson(join(root, project, "tsconfig.json"), (config) => {
      config.compilerOptions.experimentalDecorators = true;
    });
    assert.throws(() => cleanV1(root), /exact generated dist output options/u, project);
    assertAllSentinelsRemain(root);
  }

  // And the exception really is exercised: core-api sets both, and passes.
  const clean = fixture();
  const coreApi = JSON.parse(readFileSync(join(clean, "apps/core-api/tsconfig.json"), "utf8"));
  assert.equal(coreApi.compilerOptions.experimentalDecorators, true);
  assert.equal(coreApi.compilerOptions.emitDecoratorMetadata, true);
  assert.doesNotThrow(() => v1DistDirectories(clean));
});

test("apps/core-api still fails if it drops a required OUTPUT option", () => {
  // The exception adds two keys; it does not make the set optional.
  const root = fixture();
  mutateJson(join(root, "apps/core-api/tsconfig.json"), (config) => {
    delete config.compilerOptions.declarationMap;
  });
  assert.throws(() => cleanV1(root), /exact generated dist output options/u);
  assertAllSentinelsRemain(root);
});

test("alternate TypeScript output settings fail before any internal or external deletion", () => {
  for (const [option, expected] of [
    ["declarationDir", /alternate output option declarationDir/u],
    ["outFile", /alternate output option outFile/u],
    ["tsBuildInfoFile", /exact generated dist output options/u],
  ]) {
    const root = fixture();
    const project = join(root, "packages/kernel");
    const outside = join("/var/tmp", `${basename(root)}-${option}-outside-sentinel`);
    const configuredTarget = relative(project, outside).replaceAll("\\", "/");
    assert.equal(resolve(project, configuredTarget), outside);
    assert.ok(relative(root, outside).startsWith(".."), `${outside} must be outside ${root}`);
    try {
      writeFileSync(outside, "outside must survive\n");
      mutateJson(join(project, "tsconfig.json"), (config) => { config.compilerOptions[option] = configuredTarget; });
      assert.throws(() => cleanV1(root), expected);
      assert.equal(readFileSync(resolve(project, configuredTarget), "utf8"), "outside must survive\n");
      assertAllSentinelsRemain(root);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }
});
