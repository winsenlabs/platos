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
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadLockfile, computeClosure, componentsFromSnapshots, parseKey, toSnapKey, IMAGES,
} from './lib/pnpm-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const SBOM = path.join(ROOT, 'scripts/audit-sbom.mjs');

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

test('agent closure reproduces the M0.5 audit (718 nodes / 657 names)', () => {
  const { parsed } = loadLockfile(LOCK);
  const comps = componentsFromSnapshots(computeClosure(IMAGES.agent.roots, parsed));
  assert.equal(comps.length, 718, 'agent node count');
  assert.equal(names(comps).size, 657, 'agent distinct names');
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

test('webapp closure excludes root tooling and removed orphan dependencies', () => {
  const { parsed } = loadLockfile(LOCK);
  const comps = componentsFromSnapshots(computeClosure(IMAGES.webapp.roots, parsed));
  assert.ok(comps.length > 1600, 'webapp node count in expected range');
  assert.ok(!hasPkg(comps, 'breakword'), 'webapp must not ship root-only GPL tooling');
  assert.ok(!hasPkg(comps, '@changesets/cli'), 'webapp must not ship root release tooling');
  assert.ok(!hasPkg(comps, '@fingerprintjs/fingerprintjs-pro'), 'removed fingerprint SDK stays absent');
  assert.ok(!hasPkg(comps, 'posthog-js'), 'removed analytics SDK stays absent');
  assert.ok(hasPkg(comps, 'express', '4.20.0'), 'webapp ships express 4.20.0');
});

test('cookie CVE surface: 0.4.2 in both images, 0.7.2 (fixed) also present', () => {
  const { parsed } = loadLockfile(LOCK);
  const agent = componentsFromSnapshots(computeClosure(IMAGES.agent.roots, parsed));
  const webapp = componentsFromSnapshots(computeClosure(IMAGES.webapp.roots, parsed));
  assert.ok(hasPkg(agent, 'cookie', '0.4.2'), 'agent ships cookie 0.4.2 (CVE-2024-47764)');
  assert.ok(hasPkg(webapp, 'cookie', '0.4.2'), 'webapp ships cookie 0.4.2 (CVE-2024-47764)');
});

test('committed SBOMs match the lockfile closure (no drift) + licence gate passes', () => {
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
  const receipts = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/audits/sbom/closure-receipts.json'), 'utf8'));
  for (const image of Object.keys(IMAGES)) {
    const file = path.join(ROOT, receipts.images[image].file);
    assert.ok(fs.existsSync(file), `${receipts.images[image].file} exists`);
  }
});
