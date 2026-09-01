import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ADOPTED_PROJECTS,
  EXPECTED_PLACEHOLDER_FILE_COUNT,
  EXPECTED_SCAFFOLDING_FILE_COUNT,
  SCAFFOLDING_BASENAMES,
  checkSkeleton,
  isScaffoldingPath,
  projectPaths,
  renderSkeleton,
  selfCheck,
  tierCounts,
  writeSkeleton,
} from "./gen-v1-skeleton.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(repositoryRoot, "scripts/arch/gen-v1-skeleton.mjs");
const fixtures = [];

after(() => fixtures.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(adopted) {
  const root = mkdtempSync("/var/tmp/platos-generator-");
  fixtures.push(root);
  writeSkeleton(root, adopted);
  return root;
}

function write(root, path, text) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

const liveTotal = EXPECTED_SCAFFOLDING_FILE_COUNT + EXPECTED_PLACEHOLDER_FILE_COUNT - releasedByLiveAdoptions();

function releasedByLiveAdoptions() {
  const full = renderSkeleton([]);
  return full.size - renderSkeleton().size;
}

test("--list emits exactly the live sorted unique generated paths", () => {
  const paths = execFileSync("node", [generator, "--list"], { cwd: repositoryRoot, encoding: "utf8" }).trim().split("\n");
  assert.equal(paths.length, liveTotal);
  assert.equal(new Set(paths).size, liveTotal);
  assert.deepEqual(paths, [...paths].sort());
  assert.deepEqual(paths, [...renderSkeleton().keys()].sort());
});

test("--check accepts the live generated tree and reports both ownership tiers", () => {
  const output = execFileSync("node", [generator, "--check"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.match(output, /^ok: /u);
  assert.match(output, new RegExp(`${EXPECTED_SCAFFOLDING_FILE_COUNT} scaffolding`, "u"));
  assert.match(output, new RegExp(`= ${liveTotal} generated file\\(s\\)`, "u"));
  assert.match(output, /32 V1 projects and 94 project edges/u);
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
    ["extra", (root) => write(root, "packages/contexts/tools/extra.ts", "export {};\n"), "EXTRA   packages/contexts/tools/extra.ts"],
  ]) {
    const root = fixture();
    mutate(root);
    assert.ok(checkSkeleton(root).includes(expected), kind);
  }
});

// ---------------------------------------------------------------------------
// Two-tier ownership (WIN-256). The scaffolding tier is never released; the
// source tier is released only by an explicit, monotonic adoption.
// ---------------------------------------------------------------------------

test("the scaffolding tier is exactly 97 files and is only ever manifests, tsconfigs and READMEs", () => {
  const files = renderSkeleton([]);
  const { scaffolding, placeholders, total } = tierCounts(files);
  assert.equal(scaffolding, EXPECTED_SCAFFOLDING_FILE_COUNT);
  assert.equal(placeholders, EXPECTED_PLACEHOLDER_FILE_COUNT);
  assert.equal(total, 201, "an unadopted skeleton is still the M1 201-file tree");

  const scaffoldingPaths = [...files.keys()].filter((path) => isScaffoldingPath(path));
  assert.equal(scaffoldingPaths.length, EXPECTED_SCAFFOLDING_FILE_COUNT);
  for (const path of scaffoldingPaths) {
    const basename = path.slice(path.lastIndexOf("/") + 1);
    assert.ok(
      path === "tsconfig.json" || SCAFFOLDING_BASENAMES.includes(basename),
      `${path} is counted as scaffolding but is not a scaffolding file`
    );
  }
  assert.equal(projectPaths().length * SCAFFOLDING_BASENAMES.length + 1, EXPECTED_SCAFFOLDING_FILE_COUNT);
});

test("adopting a project releases exactly that project's source placeholders and nothing else", () => {
  const adopted = ["packages/contexts/identity-access"];
  const before = renderSkeleton([]);
  const after = renderSkeleton(adopted);

  const released = [...before.keys()].filter((path) => !after.has(path));
  assert.deepEqual(released.sort(), [
    "packages/contexts/identity-access/application/index.ts",
    "packages/contexts/identity-access/application/ports/index.ts",
    "packages/contexts/identity-access/contracts/index.ts",
    "packages/contexts/identity-access/domain/index.ts",
  ]);
  assert.equal(tierCounts(after).scaffolding, EXPECTED_SCAFFOLDING_FILE_COUNT, "scaffolding is never released");
  for (const basename of SCAFFOLDING_BASENAMES) {
    assert.ok(after.has(`packages/contexts/identity-access/${basename}`), `${basename} stayed generated`);
  }
});

test("real source under an adopted project is accepted; the same file under a peer project is still EXTRA", () => {
  const adopted = ["packages/contexts/identity-access"];
  const root = fixture(adopted);

  write(root, "packages/contexts/identity-access/domain/session.ts", "export interface Session { readonly id: string; }\n");
  write(root, "packages/contexts/identity-access/domain/nested/deep.ts", "export {};\n");
  assert.deepEqual(checkSkeleton(root, adopted), [], "adopted source tree is released");

  // NEGATIVE CONTROL: adoption is per project. A peer context is untouched.
  write(root, "packages/contexts/secrets/domain/session.ts", "export interface Session { readonly id: string; }\n");
  assert.ok(
    checkSkeleton(root, adopted).includes("EXTRA   packages/contexts/secrets/domain/session.ts"),
    "adoption must not release a project that was not adopted"
  );
});

test("adoption releases the source tree only — scaffolding still fails closed on stale and missing", () => {
  const adopted = ["packages/contexts/identity-access"];

  const missing = fixture(adopted);
  rmSync(join(missing, "packages/contexts/identity-access/package.json"));
  assert.ok(
    checkSkeleton(missing, adopted).includes("MISSING packages/contexts/identity-access/package.json"),
    "an adopted project still owes its manifest"
  );

  const stale = fixture(adopted);
  writeFileSync(join(stale, "packages/contexts/identity-access/tsconfig.json"), "{}\n");
  assert.ok(
    checkSkeleton(stale, adopted).includes("STALE   packages/contexts/identity-access/tsconfig.json"),
    "an adopted project's tsconfig carries its project references and stays byte-compared"
  );
});

test("un-adopting a project that still holds real files fails closed (monotonicity)", () => {
  const adopted = ["packages/contexts/identity-access"];
  const root = fixture(adopted);
  write(root, "packages/contexts/identity-access/domain/session.ts", "export interface Session { readonly id: string; }\n");
  assert.deepEqual(checkSkeleton(root, adopted), []);

  // Removing the entry to make a failure go away cannot succeed: the real file
  // becomes EXTRA and every released placeholder comes back MISSING.
  const problems = checkSkeleton(root, []);
  assert.ok(problems.includes("EXTRA   packages/contexts/identity-access/domain/session.ts"));
  assert.ok(problems.includes("MISSING packages/contexts/identity-access/domain/index.ts"));
});

test("selfCheck rejects an adoption entry that is not a V1 project, and a duplicate entry", () => {
  assert.deepEqual(selfCheck(), [], "the live registry is valid");
  assert.deepEqual(selfCheck([]), [], "an empty registry is valid");

  assert.deepEqual(selfCheck(["packages/contexts/not-a-context"]), [
    "ADOPTED_PROJECTS names packages/contexts/not-a-context, which is not a V1 project",
  ]);
  assert.deepEqual(selfCheck(["apps/core-api", "apps/core-api"]), [
    "ADOPTED_PROJECTS names apps/core-api more than once",
  ]);
});

test("the live adoption registry is a subset of the real projects", () => {
  const known = new Set(projectPaths());
  for (const project of ADOPTED_PROJECTS) assert.ok(known.has(project), `${project} is not a V1 project`);
  assert.equal(new Set(ADOPTED_PROJECTS).size, ADOPTED_PROJECTS.length, "no duplicate adoptions");
});

// ---------------------------------------------------------------------------
// Build artifacts are not source (WIN-256 finding; latent since M1).
// ---------------------------------------------------------------------------

test("gitignored build artifacts are never reported as EXTRA", () => {
  const root = fixture();
  for (const artifact of [
    "packages/kernel/.turbo/turbo-build.log",
    "packages/contexts/tools/.turbo/turbo-build.log",
    "packages/kernel/dist/index.js",
    "packages/kernel/node_modules/x/index.js",
  ]) {
    write(root, artifact, "artifact\n");
  }
  assert.deepEqual(
    checkSkeleton(root),
    [],
    "a plain `turbo run build` must not turn every project into a phantom EXTRA"
  );
});
