// SPDX-License-Identifier: Apache-2.0
//
// deploy-bundle-closure.test.mjs — the prune and the check, each against a
// bundle laid out the way `pnpm deploy --legacy` lays one out, and each with the
// negative control that proves it can fail.
//
// The fixture is a real lockfile (parsed by the same walker the SBOM audit uses)
// and a real virtual store of directories and symlinks. The contamination it
// seeds is the one measured in the core-api image: a root-manifest dependency
// whose closure shares one package with the deployed importer's.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check, prune, REVIEWED_ABSENT } from "./deploy-bundle-closure.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "deploy-bundle-closure.mjs");

const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      rootonly:
        specifier: ^1.0.0
        version: 1.0.0

  apps/x:
    dependencies:
      '@ws/lib':
        specifier: workspace:*
        version: link:../../packages/lib
      a:
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      devonly:
        specifier: ^1.0.0
        version: 1.0.0

  packages/lib:
    dependencies:
      b:
        specifier: ^2.0.0
        version: 2.0.0

packages:

  a@1.0.0:
    resolution: {integrity: sha512-a}

  b@2.0.0:
    resolution: {integrity: sha512-b}

  c@1.0.0:
    resolution: {integrity: sha512-c}

  d@1.0.0:
    resolution: {integrity: sha512-d}

  devonly@1.0.0:
    resolution: {integrity: sha512-e}

  rootonly@1.0.0:
    resolution: {integrity: sha512-f}

snapshots:

  a@1.0.0:
    dependencies:
      c: 1.0.0

  b@2.0.0: {}

  c@1.0.0: {}

  d@1.0.0: {}

  devonly@1.0.0: {}

  rootonly@1.0.0:
    dependencies:
      c: 1.0.0
      d: 1.0.0
`;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function link(from, to) {
  fs.mkdirSync(path.dirname(from), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(from), to), from);
}

const fixtureRoots = [];
after(() => {
  for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** A repository with the lockfile above and a legacy-deploy bundle of apps/x. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-bundle-closure-"));
  fixtureRoots.push(root);
  write(path.join(root, "pnpm-lock.yaml"), LOCKFILE);
  write(path.join(root, "apps/x/package.json"), JSON.stringify({ name: "x", dependencies: { a: "^1.0.0", "@ws/lib": "workspace:*" } }));
  write(path.join(root, "packages/lib/package.json"), JSON.stringify({ name: "@ws/lib", dependencies: { b: "^2.0.0" } }));

  const bundle = path.join(root, "deploy");
  const store = path.join(bundle, "node_modules/.pnpm");
  write(path.join(bundle, "package.json"), JSON.stringify({ name: "x", dependencies: { a: "^1.0.0", "@ws/lib": "workspace:*" } }));
  const entry = (id, name, version, deps = []) => {
    const dir = path.join(store, id, "node_modules", name);
    write(path.join(dir, "package.json"), JSON.stringify({ name, version }));
    write(path.join(dir, "index.js"), "module.exports = 1;\n");
    for (const [depName, depId] of deps) {
      link(path.join(store, id, "node_modules", depName), path.join(store, depId, "node_modules", depName));
    }
    return dir;
  };
  entry("a@1.0.0", "a", "1.0.0", [["c", "c@1.0.0"]]);
  entry("b@2.0.0", "b", "2.0.0");
  entry("c@1.0.0", "c", "1.0.0");
  entry("d@1.0.0", "d", "1.0.0");
  entry("rootonly@1.0.0", "rootonly", "1.0.0", [["c", "c@1.0.0"], ["d", "d@1.0.0"]]);
  entry("@ws+lib@file+packages+lib", "@ws/lib", "0.0.0", [["b", "b@2.0.0"]]);

  // Top level: the deployed package's two dependencies AND the root's one.
  link(path.join(bundle, "node_modules/a"), path.join(store, "a@1.0.0/node_modules/a"));
  link(path.join(bundle, "node_modules/@ws/lib"), path.join(store, "@ws+lib@file+packages+lib/node_modules/@ws/lib"));
  link(path.join(bundle, "node_modules/rootonly"), path.join(store, "rootonly@1.0.0/node_modules/rootonly"));
  // Hidden hoist: every package, plus the deployed package's own name pointing
  // back at its workspace source directory.
  for (const [name, id] of [["a", "a@1.0.0"], ["b", "b@2.0.0"], ["c", "c@1.0.0"], ["d", "d@1.0.0"], ["rootonly", "rootonly@1.0.0"]]) {
    link(path.join(store, "node_modules", name), path.join(store, id, "node_modules", name));
  }
  link(path.join(store, "node_modules/x"), path.join(root, "apps/x"));
  write(path.join(bundle, "node_modules/.bin/rootonly"), '#!/bin/sh\nexec node  "$basedir/../rootonly/cli.js" "$@"\n');
  fs.writeFileSync(path.join(store, "rootonly@1.0.0/node_modules/rootonly/cli.js"), "\n");
  write(path.join(bundle, "node_modules/.bin/a"), '#!/bin/sh\nexec node  "$basedir/../a/index.js" "$@"\n');
  write(path.join(bundle, "node_modules/.modules.yaml"), "hoistPattern: ['*']\n");
  write(path.join(store, "lock.yaml"), "lockfileVersion: '9.0'\n");
  return { root, bundle, store, lockfile: path.join(root, "pnpm-lock.yaml") };
}

const noneReviewed = Object.freeze({});

test("NEGATIVE CONTROL: a bundle carrying the root manifest's closure fails the check", () => {
  const { root, bundle, lockfile } = fixture();
  assert.throws(
    () => check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: noneReviewed }),
    /node_modules\/x resolves outside the bundle's virtual store/,
    "a link back into the workspace must refuse before anything is compared",
  );
  fs.rmSync(path.join(bundle, "node_modules/.pnpm/node_modules/x"));
  const result = check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: noneReviewed });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /2 package\(s\) in the bundle are outside the lockfile closure: d@1\.0\.0, rootonly@1\.0\.0/);
});

test("prune keeps the shared package, removes the root-only closure, and the check then passes", () => {
  const { root, bundle, store, lockfile } = fixture();
  const result = prune(bundle);
  assert.deepEqual(result.removedEntries, ["d@1.0.0", "rootonly@1.0.0"]);
  assert.equal(result.kept, 4);
  for (const kept of ["a@1.0.0", "b@2.0.0", "c@1.0.0", "@ws+lib@file+packages+lib"]) {
    assert.ok(fs.existsSync(path.join(store, kept)), `${kept} is reachable and must stay`);
  }
  assert.equal(fs.existsSync(path.join(bundle, "node_modules/rootonly")), false, "the root's top-level link goes");
  assert.equal(fs.existsSync(path.join(bundle, "node_modules/.bin/rootonly")), false, "its bin shim goes");
  assert.ok(fs.existsSync(path.join(bundle, "node_modules/.bin/a")), "a shim whose package stays is kept");
  assert.equal(fs.lstatSync(path.join(store, "node_modules/c")).isSymbolicLink(), true, "a hoist link to a kept package stays");
  assert.equal(fs.existsSync(path.join(store, "node_modules/d")), false);
  assert.throws(() => fs.lstatSync(path.join(store, "node_modules/x")), /ENOENT/, "the link back into the workspace goes");
  assert.equal(fs.existsSync(path.join(bundle, "node_modules/.modules.yaml")), false);
  assert.equal(fs.existsSync(path.join(store, "lock.yaml")), false);
  const after = check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: noneReviewed });
  assert.deepEqual(after.problems, []);
  assert.deepEqual(after.counts, { bundleExternal: 3, closureExternal: 3, absentReviewed: 0, workspace: 1 });
});

test("NEGATIVE CONTROL: a closure package missing from the bundle fails unless reviewed, and a stale review fails", () => {
  const { root, bundle, store, lockfile } = fixture();
  prune(bundle);
  fs.rmSync(path.join(store, "b@2.0.0"), { recursive: true });
  fs.rmSync(path.join(store, "node_modules/b"));
  fs.rmSync(path.join(store, "@ws+lib@file+packages+lib/node_modules/b"));
  const missing = check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: noneReviewed });
  assert.match(missing.problems.join("\n"), /1 closure package\(s\) are absent from the bundle: b@2\.0\.0/);
  const reviewed = check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: { "apps/x": ["b@2.0.0"] } });
  assert.deepEqual(reviewed.problems, []);
  const stale = check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: { "apps/x": ["b@2.0.0", "c@1.0.0"] } });
  assert.match(stale.problems.join("\n"), /reviewed-absent entries that are not absent from this bundle: c@1\.0\.0/);
});

test("NEGATIVE CONTROL: a workspace package outside the importer graph fails", () => {
  const { root, bundle, store, lockfile } = fixture();
  prune(bundle);
  const stray = path.join(store, "@ws+stray@file+packages+stray/node_modules/@ws/stray");
  write(path.join(stray, "package.json"), JSON.stringify({ name: "@ws/stray", version: "0.0.0" }));
  const result = check({ bundle, importer: "apps/x", lockfile, root, reviewedAbsent: noneReviewed });
  assert.match(result.problems.join("\n"), /workspace packages differ from the importer graph: missing \[\], extra \[@ws\/stray\]/);
});

test("NEGATIVE CONTROL: a declared production dependency that does not resolve refuses the prune", () => {
  const { bundle } = fixture();
  fs.rmSync(path.join(bundle, "node_modules/a"));
  assert.throws(() => prune(bundle), /declared production dependency a does not resolve in the bundle/);
});

test("the CLI exits non-zero on a contaminated bundle and zero once pruned", () => {
  const { root, bundle } = fixture();
  fs.rmSync(path.join(bundle, "node_modules/.pnpm/node_modules/x"));
  const run = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: "utf8", stdio: "pipe" }) };
    } catch (error) {
      return { code: error.status, out: `${error.stdout}${error.stderr}` };
    }
  };
  // The CLI reads the REVIEWED_ABSENT table, which names no fixture importer.
  assert.equal(REVIEWED_ABSENT["apps/x"], undefined);
  const before = run(["check", "--bundle", bundle, "--importer", "apps/x"]);
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, /outside the lockfile closure: d@1\.0\.0, rootonly@1\.0\.0/);
  assert.equal(run(["prune", "--bundle", bundle]).code, 0);
  const after = run(["check", "--bundle", bundle, "--importer", "apps/x"]);
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /holds 3 external packages = lockfile closure 3 - 0 reviewed absent, and 1 workspace packages/);
});

test("the core-api review names exactly the three packages a legacy deploy does not install", () => {
  assert.deepEqual([...REVIEWED_ABSENT["apps/core-api"]], ["bufferutil@4.0.9", "node-gyp-build@4.8.4", "zod@4.4.3"]);
});
