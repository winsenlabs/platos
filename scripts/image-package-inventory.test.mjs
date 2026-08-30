// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inventoryBytes, scanImagePackages } from './image-package-inventory.mjs';

function fixture() {
  const scratch = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const root = fs.mkdtempSync(path.join(scratch, 'image-package-inventory-'));
  const store = path.join(root, 'node_modules/.pnpm');
  const importer = path.join(root, 'apps/webapp/node_modules');
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(importer, { recursive: true });
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { root, store, importer, cleanup };
}

function writeManifest(packagePath, name, version, raw = null) {
  fs.mkdirSync(packagePath, { recursive: true });
  fs.writeFileSync(
    path.join(packagePath, 'package.json'),
    raw ?? `${JSON.stringify({ name, version })}\n`,
  );
}

function addStorePackage(store, virtualName, packageName, version) {
  const packagePath = packageName.startsWith('@')
    ? path.join(store, virtualName, 'node_modules', ...packageName.split('/'))
    : path.join(store, virtualName, 'node_modules', packageName);
  writeManifest(packagePath, packageName, version);
}

function linkPackage(nodeModulesPath, packageName, target) {
  const linkPath = packageName.startsWith('@')
    ? path.join(nodeModulesPath, ...packageName.split('/'))
    : path.join(nodeModulesPath, packageName);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(linkPath), target), linkPath, 'dir');
}

test('scans external packages plus scoped linked workspaces with deterministic sorting and dedupe', () => {
  const f = fixture();
  try {
    addStorePackage(f.store, 'zeta@2.0.0', 'zeta', '2.0.0');
    addStorePackage(f.store, 'alpha@1.0.0', 'alpha', '1.0.0');
    fs.mkdirSync(path.join(f.store, 'alpha@1.0.0/node_modules/.generated-without-manifest'), {
      recursive: true,
    });
    addStorePackage(f.store, 'duplicate-alpha@1.0.0', 'alpha', '1.0.0');
    const workspace = path.join(f.root, 'internal-packages/workload-identity');
    writeManifest(workspace, '@internal/workload-identity', '0.0.1');
    linkPackage(f.importer, '@internal/workload-identity', workspace);
    const inventory = scanImagePackages({
      storePath: f.store,
      importerNodeModulesPath: f.importer,
      repositoryRoot: f.root,
      targetPlatform: 'linux/amd64',
    });
    assert.deepEqual(inventory.components, [
      { name: '@internal/workload-identity', version: '0.0.1' },
      { name: 'alpha', version: '1.0.0' },
      { name: 'zeta', version: '2.0.0' },
    ]);
    assert.deepEqual(inventory.source.linkedWorkspaces, [
      { name: '@internal/workload-identity', version: '0.0.1' },
    ]);
    assert.equal(inventory.componentCount, 3);
    assert.equal(inventory.distinctNames, 3);
    assert.equal(inventoryBytes(inventory), inventoryBytes(scanImagePackages({
      storePath: f.store,
      importerNodeModulesPath: f.importer,
      repositoryRoot: f.root,
      targetPlatform: 'linux/amd64',
    })));
  } finally {
    f.cleanup();
  }
});

test('rejects a missing linked workspace manifest', () => {
  const f = fixture();
  try {
    addStorePackage(f.store, 'alpha@1.0.0', 'alpha', '1.0.0');
    const workspace = path.join(f.root, 'internal-packages/missing');
    fs.mkdirSync(workspace, { recursive: true });
    linkPackage(f.importer, '@internal/missing', workspace);
    assert.throws(
      () => scanImagePackages({ storePath: f.store, importerNodeModulesPath: f.importer, repositoryRoot: f.root }),
      /linked workspace @internal\/missing package manifest is missing/,
    );
  } finally {
    f.cleanup();
  }
});

test('rejects malformed and name-less package manifests', () => {
  const f = fixture();
  try {
    const malformed = path.join(f.store, 'bad@1.0.0/node_modules/bad');
    writeManifest(malformed, 'bad', '1.0.0', '{not-json');
    assert.throws(
      () => scanImagePackages({ storePath: f.store, importerNodeModulesPath: f.importer, repositoryRoot: f.root }),
      /package manifest is malformed/,
    );
    fs.rmSync(path.join(f.store, 'bad@1.0.0'), { recursive: true, force: true });
    const incomplete = path.join(f.store, 'incomplete@1.0.0/node_modules/incomplete');
    writeManifest(incomplete, '', '', '{}');
    assert.throws(
      () => scanImagePackages({ storePath: f.store, importerNodeModulesPath: f.importer, repositoryRoot: f.root }),
      /package manifest lacks name\/version/,
    );
  } finally {
    f.cleanup();
  }
});

test('rejects linked-package symlinks that traverse outside the inventory root', () => {
  const f = fixture();
  const outside = fs.mkdtempSync('/var/tmp/image-package-outside-');
  try {
    addStorePackage(f.store, 'alpha@1.0.0', 'alpha', '1.0.0');
    writeManifest(outside, '@internal/outside', '0.0.1');
    linkPackage(f.importer, '@internal/outside', outside);
    assert.throws(
      () => scanImagePackages({ storePath: f.store, importerNodeModulesPath: f.importer, repositoryRoot: f.root }),
      /resolves outside inventory root/,
    );
  } finally {
    f.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('rejects a scoped linked workspace whose manifest name does not match its link', () => {
  const f = fixture();
  try {
    addStorePackage(f.store, 'alpha@1.0.0', 'alpha', '1.0.0');
    const workspace = path.join(f.root, 'internal-packages/wrong');
    writeManifest(workspace, '@internal/actual', '0.0.1');
    linkPackage(f.importer, '@internal/expected', workspace);
    assert.throws(
      () => scanImagePackages({ storePath: f.store, importerNodeModulesPath: f.importer, repositoryRoot: f.root }),
      /linked workspace name mismatch: @internal\/expected -> @internal\/actual/,
    );
  } finally {
    f.cleanup();
  }
});
