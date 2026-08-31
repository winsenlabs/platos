// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  WEBAPP_BUILD_INPUTS,
  WEBAPP_INVENTORY_EVIDENCE_SCHEMA,
  WEBAPP_TARGET_PLATFORM,
  buildInputReceipts,
  buildInputsSha256,
  deriveOciArchiveIdentity,
  finalImageMatchesArchiveIdentity,
  sha256,
} from './lib/webapp-inventory-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const callers = [
  'scripts/audit-sbom.mjs',
  'scripts/verify-webapp-image-inventory.mjs',
  'scripts/verify-webapp-publication-provenance.mjs',
];

test('SBOM, image verification, and publication provenance import the shared contract', () => {
  for (const caller of callers) {
    const source = fs.readFileSync(path.join(root, caller), 'utf8');
    assert.match(source, /from ['"]\.\/lib\/webapp-inventory-contract\.mjs['"]/u, caller);
    assert.doesNotMatch(source, /const WEBAPP_TARGET_PLATFORM\s*=/u, caller);
    assert.doesNotMatch(source, /const WEBAPP_BUILD_INPUTS\s*=/u, caller);
  }
});

test('the shared platform, evidence schema, path list, and digest are deterministic', () => {
  assert.equal(WEBAPP_TARGET_PLATFORM, 'linux/amd64');
  assert.equal(
    WEBAPP_INVENTORY_EVIDENCE_SCHEMA,
    'platos.audit.webapp-image-inventory-evidence/v3',
  );
  assert.deepEqual([...WEBAPP_BUILD_INPUTS], [...WEBAPP_BUILD_INPUTS].sort());
  const receipts = buildInputReceipts(root);
  assert.deepEqual(receipts.map(({ file }) => file), [...WEBAPP_BUILD_INPUTS]);
  assert.match(buildInputsSha256(receipts), /^[a-f0-9]{64}$/u);
});

test('the shared archive derivation hashes the descriptor-bound manifest and derives config identity', () => {
  const configDigest = `sha256:${'7'.repeat(64)}`;
  const manifest = JSON.stringify({ config: { digest: configDigest } });
  const manifestDigest = `sha256:${sha256(manifest)}`;
  const archive = Buffer.from('exact archive bytes');
  const index = JSON.stringify({
    manifests: [{
      digest: manifestDigest,
      size: Buffer.byteLength(manifest),
      platform: { os: 'linux', architecture: 'amd64' },
    }],
  });
  const identity = deriveOciArchiveIdentity({
    candidateArchive: '/unused/candidate.oci.tar',
    expectedManifestDigest: manifestDigest,
    expectedArchiveSha256: sha256(archive),
    readFile: () => archive,
    extractArchiveFile: (_candidateArchive, entry) => entry === 'index.json' ? index : manifest,
  });

  assert.deepEqual(identity, {
    archiveSha256: sha256(archive),
    configDigest,
    descriptorSize: Buffer.byteLength(manifest),
    manifestDigest,
    platform: 'linux/amd64',
  });
  assert.equal(
    finalImageMatchesArchiveIdentity({ imageId: configDigest }, identity),
    true,
  );
  assert.equal(
    finalImageMatchesArchiveIdentity(
      { imageId: manifestDigest, imageDescriptorDigest: manifestDigest },
      identity,
    ),
    true,
  );
  assert.equal(
    finalImageMatchesArchiveIdentity(
      { imageId: manifestDigest, imageDescriptorDigest: null },
      identity,
    ),
    false,
  );
});
