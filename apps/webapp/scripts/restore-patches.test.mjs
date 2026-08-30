import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./restore-patches.cjs", import.meta.url));

const originalPackage = {
  name: "root",
  dependencies: { "node-fetch": "2.6.12" },
  devDependencies: { typescript: "5.5.4" },
  pnpm: {
    patchedDependencies: {
      "@sentry/remix@9.46.0": "patches/sentry.patch",
      "graphile-worker@0.16.6": "patches/graphile.patch",
    },
  },
};

const canonicalLock = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
patchedDependencies:
  '@sentry/remix@9.46.0':
    path: patches/sentry.patch
    hash: sentry-hash
  graphile-worker@0.16.6:
    path: patches/graphile.patch
    hash: graphile-hash
importers:
  .:
    dependencies:
      node-fetch:
        specifier: 2.6.12
        version: 2.6.12
    devDependencies:
      typescript:
        specifier: 5.5.4
        version: 5.5.4
  apps/webapp:
    dependencies:
      '@sentry/remix':
        specifier: 9.46.0
        version: 9.46.0(patch_hash=abc)
packages:
  '@sentry/remix@9.46.0': {}
  graphile-worker@0.16.6: {}
  node-fetch@2.6.12: {}
  typescript@5.5.4: {}
snapshots:
  '@sentry/remix@9.46.0(patch_hash=abc)': {}
  graphile-worker@0.16.6: {}
  node-fetch@2.6.12: {}
  typescript@5.5.4: {}
`;

function fixture() {
  const root = mkdtempSync("/var/tmp/webapp-patches-");
  const originalPackagePath = path.join(root, "original-package.json");
  const targetPackagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "pnpm-lock.yaml");
  writeFileSync(originalPackagePath, JSON.stringify(originalPackage));
  writeFileSync(targetPackagePath, JSON.stringify(originalPackage));
  writeFileSync(lockPath, canonicalLock);
  return { root, originalPackagePath, targetPackagePath, lockPath };
}

test("preserves canonical root importers and all snapshot-backed active patches", () => {
  const files = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [script, files.originalPackagePath, files.targetPackagePath, files.lockPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /preserved canonical root dependencies/);
    assert.match(result.stdout, /restored patchedDependencies: 2\/2 entries kept/);
    assert.deepEqual(JSON.parse(readFileSync(files.targetPackagePath, "utf8")), originalPackage);
    const lock = readFileSync(files.lockPath, "utf8");
    assert.match(lock, /node-fetch:\n\s+specifier: 2\.6\.12/);
    assert.match(lock, /sentry-hash/);
    assert.match(lock, /graphile-hash/);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("strips the production root importer and retains only webapp-reachable patches", () => {
  const files = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [script, files.originalPackagePath, files.targetPackagePath, files.lockPath, "--production-root", "apps/webapp"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /removed 2 root dependency declarations for production importer apps\/webapp/);
    assert.match(result.stdout, /restored patchedDependencies: 1\/2 entries kept/);

    const normalizedPackage = JSON.parse(readFileSync(files.targetPackagePath, "utf8"));
    assert.equal(Object.hasOwn(normalizedPackage, "dependencies"), false);
    assert.equal(Object.hasOwn(normalizedPackage, "devDependencies"), false);
    assert.deepEqual(normalizedPackage.pnpm.patchedDependencies, {
      "@sentry/remix@9.46.0": "patches/sentry.patch",
    });

    const normalizedLock = readFileSync(files.lockPath, "utf8");
    assert.match(normalizedLock, /importers:\n  \.: \{\}\n  apps\/webapp:/);
    assert.doesNotMatch(normalizedLock, /node-fetch:\n\s+specifier:/);
    assert.doesNotMatch(normalizedLock, /typescript:\n\s+specifier:/);
    assert.match(normalizedLock, /sentry-hash/);
    assert.doesNotMatch(normalizedLock, /graphile-hash/);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});

test("fails closed on importers-only lockfiles", () => {
  const files = fixture();
  try {
    writeFileSync(files.lockPath, canonicalLock.slice(0, canonicalLock.indexOf("snapshots:")));
    const result = spawnSync(
      process.execPath,
      [script, files.originalPackagePath, files.targetPackagePath, files.lockPath],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lockfile has no snapshots; use the canonical frozen lockfile/);
  } finally {
    rmSync(files.root, { recursive: true, force: true });
  }
});
