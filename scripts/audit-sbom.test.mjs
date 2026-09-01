// SPDX-License-Identifier: Apache-2.0
//
// audit-sbom.test.mjs — CI gate for the M0.5 closure contract. WIN-250.
// Runs with `node --test scripts/audit-sbom.test.mjs` (pnpm test:sbom).
//
// Deterministic + offline: parses the committed pnpm-lock.yaml, checks the
// closure walker against the M0.5 audit's numbers, verifies the SBOMs match the
// lockfile (no drift), and runs the non-vacuity proof so the licence gate is
// demonstrably able to fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadLockfile, computeClosure, componentsFromSnapshots, parseKey, toSnapKey, IMAGES,
} from './lib/pnpm-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const SBOM = path.join(ROOT, 'scripts/audit-sbom.mjs');
const RECEIPTS = path.join(ROOT, 'docs/audits/sbom/closure-receipts.json');
const WEBAPP_INVENTORY = path.join(ROOT, 'docs/audits/sbom/platos-webapp.image-inventory.json');
const WEBAPP_SBOM = path.join(ROOT, 'docs/audits/sbom/platos-webapp.cdx.json');
const REVIEWED_LOCK_ONLY = [
  '@sentry/cli-darwin@2.50.2',
  '@sentry/cli-linux-arm@2.50.2',
  '@sentry/cli-linux-arm64@2.50.2',
  '@sentry/cli-linux-i686@2.50.2',
  '@sentry/cli-win32-arm64@2.50.2',
  '@sentry/cli-win32-i686@2.50.2',
  '@sentry/cli-win32-x64@2.50.2',
];

function names(components) { return new Set(components.map((c) => c.name)); }
function hasPkg(components, name, version) {
  return components.some((c) => c.name === name && (version ? c.version === version : true));
}

test('parseKey splits scoped, plain and peer-qualified keys', () => {
  assert.deepEqual(parseKey('zod@3.25.76'), { name: 'zod', version: '3.25.76' });
  assert.deepEqual(parseKey('@ai-sdk/provider@4.0.3'), { name: '@ai-sdk/provider', version: '4.0.3' });
  assert.deepEqual(parseKey('@ai-sdk/provider-utils@5.0.10(zod@3.25.76)'), { name: '@ai-sdk/provider-utils', version: '5.0.10' });
});

test('toSnapKey resolves npm aliases to the aliased target, plain versions to name@version', () => {
  assert.equal(toSnapKey('zod', '3.25.76'), 'zod@3.25.76');
  assert.equal(toSnapKey('string-width-cjs', 'string-width@4.2.3'), 'string-width@4.2.3');
  assert.equal(toSnapKey('lru-cache', '@wolfy1339/lru-cache@11.0.2-patch.1'), '@wolfy1339/lru-cache@11.0.2-patch.1');
});

test('agent closure reproduces the exact lockfile audit (718 nodes / 657 names) without React 19', () => {
  const { parsed } = loadLockfile(LOCK);
  const comps = componentsFromSnapshots(computeClosure(IMAGES.agent.roots, parsed));
  assert.equal(comps.length, 718, 'agent node count');
  assert.equal(names(comps).size, 657, 'agent distinct names');
  assert.ok(hasPkg(comps, 'react', '18.3.1'), 'Agent SDK optional React peer remains pinned to 18.3.1');
  assert.ok(!comps.some((component) => component.name === 'react' && component.version.startsWith('19.')), 'React 19 requires separate Agent production-closure approval');
  // Undeclared-but-shipping (M0.5 §1.4)
  assert.ok(hasPkg(comps, 'express', '5.2.1'), 'agent ships express 5.2.1');
  assert.ok(hasPkg(comps, 'multer', '2.1.1'), 'agent ships multer');
  assert.ok(hasPkg(comps, 'cors'), 'agent ships cors');
  // Three zod builds across images: agent carries 3.25.76 + 4.4.3 (M0.5 §2 invisible-breakage)
  assert.ok(hasPkg(comps, 'zod', '4.4.3'), 'agent ships zod 4.4.3 transitively');
  // Root deps must NOT reach the agent image
  assert.ok(!hasPkg(comps, 'breakword'), 'agent must not carry root-only breakword');
  assert.ok(!hasPkg(comps, '@changesets/cli'), 'agent must not carry root-only @changesets/cli');
});

test('webapp image inventory exactly matches its SBOM, receipt, and retained/pruned package contract', () => {
  const { parsed } = loadLockfile(LOCK);
  const comps = componentsFromSnapshots(computeClosure(IMAGES.webapp.roots, parsed));
  const receipts = JSON.parse(fs.readFileSync(RECEIPTS, 'utf8'));
  const inventory = JSON.parse(fs.readFileSync(WEBAPP_INVENTORY, 'utf8'));
  const sbom = JSON.parse(fs.readFileSync(WEBAPP_SBOM, 'utf8'));
  assert.equal(comps.length, 335, 'webapp production lock closure remains 335 package pairs');
  assert.equal(names(comps).size, 308, 'webapp production lock closure remains 308 names');
  assert.equal(receipts.images.webapp.lockClosureComponentCount, 335, 'receipt records lock closure count');
  assert.equal(receipts.images.webapp.lockClosureDistinctNames, 308, 'receipt records lock closure names');
  assert.equal(inventory.componentCount, 330, 'reviewed exact Docker image package count');
  assert.equal(inventory.distinctNames, 303, 'reviewed exact Docker image distinct-name count');
  assert.equal(inventory.targetPlatform, 'linux/amd64', 'inventory records the reviewed target platform');
  const inventoryIds = new Set(inventory.components.map(({ name, version }) => `${name}@${version}`));
  const lockOnly = comps
    .map(({ name, version }) => `${name}@${version}`)
    .filter((id) => !inventoryIds.has(id));
  assert.deepEqual(lockOnly, REVIEWED_LOCK_ONLY, 'only the seven reviewed non-linux/amd64 Sentry optionals are lock-only');
  assert.deepEqual(receipts.images.webapp.reviewedLockOnlyComponents, REVIEWED_LOCK_ONLY);
  assert.equal(receipts.images.webapp.targetPlatform, 'linux/amd64');
  assert.equal(receipts.images.webapp.componentCount, inventory.componentCount, 'receipt uses image count');
  assert.equal(receipts.images.webapp.distinctNames, inventory.distinctNames, 'receipt uses image names');
  assert.deepEqual(
    sbom.components.map(({ name, version }) => ({ name, version })),
    inventory.components,
    'webapp SBOM package pairs exactly equal the production image inventory',
  );
  assert.ok(!hasPkg(inventory.components, 'breakword'), 'webapp image must not ship root-only GPL tooling');
  assert.ok(!hasPkg(inventory.components, '@changesets/cli'), 'webapp image must not ship root release tooling');
  assert.ok(!hasPkg(inventory.components, '@fingerprintjs/fingerprintjs-pro'), 'removed fingerprint SDK stays absent');
  assert.ok(!hasPkg(inventory.components, 'posthog-js'), 'removed analytics SDK stays absent');
  assert.ok(!hasPkg(inventory.components, '@ai-sdk/openai'), 'removed AI SDK stays absent');
  assert.ok(!hasPkg(inventory.components, '@upstash/ratelimit'), 'removed ratelimit patch target stays absent');
  assert.ok(!hasPkg(inventory.components, '@window-splitter/state'), 'removed splitter patch target stays absent');
  assert.ok(!hasPkg(inventory.components, 'tailwindcss-animate'), 'build-only Tailwind plugin stays absent');
  assert.ok(hasPkg(inventory.components, 'express', '4.20.0'), 'webapp ships express 4.20.0');
  assert.ok(hasPkg(inventory.components, 'socket.io-client', '4.7.5'), 'webapp ships operational websocket client');
  assert.ok(hasPkg(inventory.components, 'react-grid-layout', '2.2.2'), 'webapp ships imported grid styles');
  assert.ok(hasPkg(inventory.components, '@internal/workload-identity', '0.0.1'), 'webapp ships linked workload identity workspace');
  assert.ok(hasPkg(inventory.components, '@platos/tenancy-database', '0.0.1'), 'webapp ships linked tenancy database workspace');
  assert.deepEqual(inventory.source.linkedWorkspaces, [
    { name: '@internal/workload-identity', version: '0.0.1' },
    { name: '@platos/tenancy-database', version: '0.0.1' },
  ]);
  assert.deepEqual(receipts.images.webapp.linkedWorkspaceComponents, inventory.source.linkedWorkspaces);
});

test('cookie CVE surface: 0.4.2 in both images, 0.7.2 (fixed) also present', () => {
  const { parsed } = loadLockfile(LOCK);
  const agent = componentsFromSnapshots(computeClosure(IMAGES.agent.roots, parsed));
  const webapp = componentsFromSnapshots(computeClosure(IMAGES.webapp.roots, parsed));
  assert.ok(hasPkg(agent, 'cookie', '0.4.2'), 'agent ships cookie 0.4.2 (CVE-2024-47764)');
  assert.ok(hasPkg(webapp, 'cookie', '0.4.2'), 'webapp ships cookie 0.4.2 (CVE-2024-47764)');
});

test('committed SBOMs match their lock/image sources (no drift) + licence gate passes', () => {
  const res = spawnSync('node', [SBOM, 'check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `audit:sbom:check must pass\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /audit:sbom check PASSED/);
});

test('licence gate is non-vacuous for copyleft and commercial canaries', () => {
  const res = spawnSync('node', [path.join(ROOT, 'scripts/verify-sbom-nonvacuity.mjs')], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, `non-vacuity proof must hold\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /NON-VACUITY PROVEN/);
});

test('committed closure receipts hash the committed SBOM bytes', () => {
  const receipts = JSON.parse(fs.readFileSync(RECEIPTS, 'utf8'));
  for (const image of Object.keys(IMAGES)) {
    const file = path.join(ROOT, receipts.images[image].file);
    assert.ok(fs.existsSync(file), `${receipts.images[image].file} exists`);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(hash, receipts.images[image].sha256, `${image} SBOM bytes match receipt`);
  }
  const inventoryHash = crypto.createHash('sha256').update(fs.readFileSync(WEBAPP_INVENTORY)).digest('hex');
  assert.equal(
    receipts.images.webapp.inventorySha256,
    inventoryHash,
    'webapp receipt hashes the exact production image inventory bytes',
  );
});

function withMutatedReceipts(mutate, callback) {
  const receipts = JSON.parse(fs.readFileSync(RECEIPTS, 'utf8'));
  mutate(receipts);
  const scratchRoot = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'platos-sbom-receipt-'));
  const file = path.join(directory, 'closure-receipts.json');
  fs.writeFileSync(file, `${JSON.stringify(receipts, null, 2)}\n`);
  try {
    callback(file);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('receipt count drift mutation is rejected', () => {
  withMutatedReceipts(
    (receipts) => { receipts.images.webapp.componentCount += 1; },
    (file) => {
      const res = spawnSync('node', [SBOM, 'check', '--receipts', file], { cwd: ROOT, encoding: 'utf8' });
      assert.notEqual(res.status, 0, 'mutated component count must fail');
      assert.match(res.stderr, /DRIFT: receipt componentCount for webapp is 331; shipping inventory is 330/);
    },
  );
});

for (const [field, file] of [
  ['licenseIndexSha256', 'license-index.json'],
  ['licenseOverlaySha256', 'license-overlay.json'],
  ['licensePolicySha256', 'license-policy.json'],
]) {
  test(`receipt ${field} drift mutation is rejected`, () => {
    withMutatedReceipts(
      (receipts) => { receipts[field] = '0'.repeat(64); },
      (receiptsFile) => {
        const res = spawnSync('node', [SBOM, 'check', '--receipts', receiptsFile], { cwd: ROOT, encoding: 'utf8' });
        assert.notEqual(res.status, 0, `mutated ${field} must fail`);
        assert.match(res.stderr, new RegExp(`DRIFT: receipt ${field} does not match ${file.replace('.', '\\.')}`));
      },
    );
  });
}

test('root-tooling image inventory mutation is rejected by closure and GPL licence gates', () => {
  const inventory = JSON.parse(fs.readFileSync(WEBAPP_INVENTORY, 'utf8'));
  inventory.components.push({ name: 'breakword', version: '1.0.5' });
  inventory.components.sort((a, b) => {
    const left = a.name === b.name ? a.version : a.name;
    const right = a.name === b.name ? b.version : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  inventory.componentCount = inventory.components.length;
  inventory.distinctNames = names(inventory.components).size;
  const scratchRoot = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'platos-image-inventory-'));
  const file = path.join(directory, 'platos-webapp.image-inventory.json');
  fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
  try {
    const res = spawnSync('node', [SBOM, 'check', '--inventory', file], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'root release tooling package must fail the image audit');
    assert.match(res.stderr, /IMAGE INVENTORY FAILURE[\s\S]*breakword@1\.0\.5/);
    assert.match(res.stderr, /LICENCE POLICY FAILURE[\s\S]*\[copyleft\] breakword@1\.0\.5/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removing a legitimately installed package fails reverse reconciliation', () => {
  const inventory = JSON.parse(fs.readFileSync(WEBAPP_INVENTORY, 'utf8'));
  inventory.components = inventory.components.filter(
    ({ name, version }) => !(name === 'express' && version === '4.20.0'),
  );
  inventory.componentCount = inventory.components.length;
  inventory.distinctNames = names(inventory.components).size;
  const scratchRoot = fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(scratchRoot, 'platos-incomplete-image-inventory-'));
  const file = path.join(directory, 'platos-webapp.image-inventory.json');
  fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
  try {
    const res = spawnSync('node', [SBOM, 'check', '--inventory', file], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'missing installed package must fail reverse reconciliation');
    assert.match(res.stderr, /IMAGE INVENTORY FAILURE[\s\S]*unreviewed lock-only packages: express@4\.20\.0/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('removing a linked first-party workspace fails exact importer reconciliation', () => {
  const inventory = JSON.parse(fs.readFileSync(WEBAPP_INVENTORY, 'utf8'));
  inventory.components = inventory.components.filter(({ name }) => name !== '@internal/workload-identity');
  inventory.source.linkedWorkspaces = inventory.source.linkedWorkspaces.filter(
    ({ name }) => name !== '@internal/workload-identity',
  );
  inventory.source.linkedWorkspaceCount = inventory.source.linkedWorkspaces.length;
  inventory.componentCount = inventory.components.length;
  inventory.distinctNames = names(inventory.components).size;
  const directory = fs.mkdtempSync('/var/tmp/platos-linked-image-inventory-');
  const file = path.join(directory, 'platos-webapp.image-inventory.json');
  fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
  try {
    const res = spawnSync('node', [SBOM, 'check', '--inventory', file], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(res.status, 0, 'missing linked workspace must fail reverse reconciliation');
    assert.match(res.stderr, /linked workspace components differ from the lock\/importer manifests/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing image receipt mutation is rejected', () => {
  withMutatedReceipts(
    (receipts) => { delete receipts.images.webapp; },
    (file) => {
      const res = spawnSync('node', [SBOM, 'check', '--receipts', file], { cwd: ROOT, encoding: 'utf8' });
      assert.notEqual(res.status, 0, 'missing image receipt must fail');
      assert.match(res.stderr, /DRIFT: receipt is missing image closure: webapp/);
    },
  );
});
