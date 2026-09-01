import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { EXPECTED_GENERATED_FILE_COUNT, checkSkeleton, renderSkeleton, writeSkeleton } from "./gen-v1-skeleton.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(repositoryRoot, "scripts/arch/gen-v1-skeleton.mjs");
const fixtures = [];

after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync("/var/tmp/platos-generator-");
  fixtures.push(root);
  writeSkeleton(root);
  return root;
}

test("--list emits exactly 201 sorted unique generated paths", () => {
  const paths = execFileSync("node", [generator, "--list"], { cwd: repositoryRoot, encoding: "utf8" }).trim().split("\n");
  assert.equal(paths.length, EXPECTED_GENERATED_FILE_COUNT);
  assert.equal(new Set(paths).size, EXPECTED_GENERATED_FILE_COUNT);
  assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(paths, [...renderSkeleton().keys()].sort());
});

test("--check accepts the live generated tree", () => {
  const output = execFileSync("node", [generator, "--check"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.match(output, /ok: exactly 201 generated file/u);
});

test("writing a complete generated tree is byte-idempotent", () => {
  const root = fixture();
  const before = new Map([...renderSkeleton().keys()].map((path) => [path, readFileSync(join(root, path), "utf8")]));
  writeSkeleton(root);
  for (const [path, bytes] of before) assert.equal(readFileSync(join(root, path), "utf8"), bytes, path);
  assert.deepEqual(checkSkeleton(root), []);
});

test("stale, missing, and extra owned files each fail closed", () => {
  for (const [kind, mutate, expected] of [
    ["stale", (root) => writeFileSync(join(root, "packages/kernel/src/index.ts"), "stale\n"), "STALE   packages/kernel/src/index.ts"],
    ["missing", (root) => rmSync(join(root, "apps/mcp-stdio/src/main.ts")), "MISSING apps/mcp-stdio/src/main.ts"],
    ["extra", (root) => { const path = join(root, "packages/contexts/tools/extra.ts"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "export {};\n"); }, "EXTRA   packages/contexts/tools/extra.ts"],
  ]) {
    const root = fixture();
    mutate(root);
    assert.ok(checkSkeleton(root).includes(expected), kind);
  }
});
