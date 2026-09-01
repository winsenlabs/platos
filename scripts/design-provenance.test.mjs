// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, checkManifest } from './design-provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'scripts/design-provenance.mjs');
const MANIFEST_PATH = path.join(ROOT, 'design/platos-ui-refactor.provenance.json');

function manifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

test('committed design provenance manifest passes the checker', () => {
  const res = spawnSync('node', [TOOL, 'check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /design provenance check PASSED \(57 files, 1 duplicate set\)/);
});

test('manifest regeneration is deterministic', () => {
  assert.deepEqual(manifest(), buildManifest(ROOT));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'platos-design-provenance-'));
  const output = path.join(dir, 'manifest.json');
  try {
    const res = spawnSync('node', [TOOL, 'write', '--manifest', output], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.deepEqual(fs.readFileSync(output), fs.readFileSync(MANIFEST_PATH));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hash mutation is rejected independently', () => {
  const value = clone(manifest());
  value.files[0].sha256 = '0'.repeat(64);
  assert.ok(checkManifest(value, ROOT).some((error) => error.startsWith('HASH DRIFT:')));
});

test('source mutation is rejected independently', () => {
  const value = clone(manifest());
  const entry = value.files.find((item) => item.source.status !== 'unknown');
  entry.source.sourcePath = 'design/platos-ui-refactor/not-a-source';
  assert.ok(checkManifest(value, ROOT).some((error) => error.startsWith('SOURCE DRIFT:')));
});

test('license mutation is rejected independently', () => {
  const value = clone(manifest());
  value.files[0].license.spdx = 'NOASSERTION';
  assert.ok(checkManifest(value, ROOT).some((error) => error.startsWith('LICENSE DRIFT:')));
});

test('duplicate declaration mutation is rejected independently', () => {
  const value = clone(manifest());
  value.duplicateSets[0].paths.pop();
  assert.ok(checkManifest(value, ROOT).some((error) => error.startsWith('DUPLICATE DRIFT:')));
});

test('complete deterministic manifest shape rejects extra and changed provenance fields', () => {
  for (const field of ['ownership', 'copyright']) {
    const value = clone(manifest());
    value[field] = 'unverified claim';
    assert.ok(checkManifest(value, ROOT).some((error) => error.startsWith('MANIFEST SHAPE DRIFT:')), `${field} must fail`);
  }

  const generatedBy = clone(manifest());
  generatedBy.generatedBy = 'hand-edited';
  assert.ok(checkManifest(generatedBy, ROOT).some((error) => error.startsWith('MANIFEST DRIFT:')));

  const nestedGeneratedBy = clone(manifest());
  nestedGeneratedBy.files[0].generatedBy = 'unverified generator';
  assert.ok(checkManifest(nestedGeneratedBy, ROOT).some((error) => error.startsWith('MANIFEST SHAPE DRIFT:')));
});

test('unknown external provenance stays explicit without an invented source', () => {
  const entry = manifest().files.find((item) => item.path.endsWith('/assets/logo.png'));
  assert.equal(entry.source.status, 'unknown');
  assert.equal(entry.source.sourcePath, null);
  assert.equal(entry.source.sourceCommit, null);
  assert.equal(entry.license.externalOwnership, 'not-asserted');
});

test('missing, extra and untracked design files are rejected', () => {
  const missing = clone(manifest());
  missing.files.push({
    path: 'design/platos-ui-refactor/missing.asset',
    sha256: '0'.repeat(64),
    source: {},
    license: {},
  });
  missing.fileCount += 1;
  assert.ok(checkManifest(missing, ROOT).some((error) => error.startsWith('MISSING ASSET:')));

  const extra = clone(manifest());
  extra.files.pop();
  extra.fileCount -= 1;
  assert.ok(checkManifest(extra, ROOT).some((error) => error.startsWith('EXTRA ASSET:')));

  const untracked = path.join(ROOT, 'design/platos-ui-refactor/.provenance-negative-control');
  try {
    fs.writeFileSync(untracked, 'negative control\n');
    const errors = checkManifest(manifest(), ROOT);
    assert.ok(errors.some((error) => error.startsWith('EXTRA ASSET:')));
    assert.ok(errors.some((error) => error.startsWith('UNTRACKED ASSET:')));
  } finally {
    fs.rmSync(untracked, { force: true });
  }
});

test('tracked design symlink resolving outside the target is rejected by Git mode, lstat and containment', { concurrency: false }, () => {
  const relative = 'design/platos-ui-refactor/.outside-target-negative-control';
  const absolute = path.join(ROOT, relative);
  try {
    fs.symlinkSync('../README.md', absolute);
    const add = spawnSync('git', ['add', '--', relative], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    const index = spawnSync('git', ['ls-files', '--stage', '--', relative], { cwd: ROOT, encoding: 'utf8' });
    assert.match(index.stdout, /^120000 /, 'negative control must be tracked as a Git symlink');

    const errors = checkManifest(manifest(), ROOT);
    assert.ok(errors.some((error) => error.includes('non-regular Git mode 120000')));
    assert.ok(errors.some((error) => error.includes('symbolic link in the worktree')));
    assert.ok(errors.some((error) => error.startsWith('PATH ESCAPE:')));
  } finally {
    spawnSync('git', ['reset', '--quiet', 'HEAD', '--', relative], { cwd: ROOT, encoding: 'utf8' });
    fs.rmSync(absolute, { force: true });
  }
});
