import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const packageRoot = resolve(root, "internal-packages/workload-identity");

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
}

test("workload identity ships a compiled JavaScript package boundary", () => {
  const scratch = mkdtempSync(resolve(root, "internal-packages/.workload-identity-package-test-"));
  const isolatedPackage = resolve(scratch, "workload-identity");
  const packed = resolve(scratch, "packed");
  const extracted = resolve(scratch, "extracted");
  try {
    mkdirSync(isolatedPackage);
    mkdirSync(packed);
    mkdirSync(extracted);
    for (const path of ["package.json", "tsconfig.json", "tsconfig.build.json", "src"]) {
      cpSync(resolve(packageRoot, path), resolve(isolatedPackage, path), { recursive: true });
    }

    const manifest = JSON.parse(readFileSync(resolve(isolatedPackage, "package.json"), "utf8"));
    assert.equal(manifest.main, "./dist/index.js");
    assert.equal(manifest.types, "./dist/index.d.ts");
    assert.deepEqual(manifest.files, ["dist"]);
    assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
    assert.equal(manifest.exports["."].require, "./dist/index.js");
    assert.equal(manifest.exports["."].default, "./dist/index.js");

    const requireBeforeBuild = createRequire(resolve(isolatedPackage, "consumer.cjs"));
    assert.throws(() => requireBeforeBuild(isolatedPackage), /dist[\\/]index\.js|MODULE_NOT_FOUND/);

    run("pnpm", ["run", "build"], isolatedPackage);
    assert.equal(existsSync(resolve(isolatedPackage, "dist/index.js")), true);
    assert.equal(existsSync(resolve(isolatedPackage, "dist/index.d.ts")), true);
    assert.equal(existsSync(resolve(isolatedPackage, "dist/index.test.js")), false);

    run("pnpm", ["pack", "--pack-destination", packed], isolatedPackage);
    const archives = readdirSync(packed).filter((path) => path.endsWith(".tgz"));
    assert.equal(archives.length, 1);
    const archive = resolve(packed, archives[0]);
    run("tar", ["-xzf", archive, "-C", extracted], root);

    const shippedRoot = resolve(extracted, "package");
    const shippedFiles = run("tar", ["-tzf", archive], root).trim().split("\n");
    assert.ok(shippedFiles.includes("package/dist/index.js"));
    assert.ok(shippedFiles.includes("package/dist/index.d.ts"));
    assert.equal(shippedFiles.some((path) => path.startsWith("package/src/")), false);

    const shippedManifest = JSON.parse(readFileSync(resolve(shippedRoot, "package.json"), "utf8"));
    assert.equal(shippedManifest.main, "./dist/index.js");
    assert.equal(shippedManifest.types, "./dist/index.d.ts");
    const requireShipped = createRequire(resolve(dirname(shippedRoot), "consumer.cjs"));
    const shipped = requireShipped(shippedRoot);
    assert.equal(shipped.WORKLOAD_AUDIENCE, "platos-agent");
    assert.match(requireShipped.resolve(shippedRoot), /[\\/]dist[\\/]index\.js$/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
