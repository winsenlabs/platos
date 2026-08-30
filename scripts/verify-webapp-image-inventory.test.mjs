// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  WEBAPP_BUILD_INPUTS,
  WEBAPP_TARGET_PLATFORM,
  assertDistinctStageImageIds,
  buildInputReceipts,
  buildInputsSha256,
  sha256,
} from './lib/webapp-inventory-contract.mjs';
import { verifyWebappImageInventory } from './verify-webapp-image-inventory.mjs';

const manifestDigest = `sha256:${'a'.repeat(64)}`;
const gitHead = 'b'.repeat(40);

function inventory(component = { name: 'alpha', version: '1.0.0' }) {
  return {
    $schema: 'platos.audit.image-package-inventory/v2',
    generatedBy: 'scripts/image-package-inventory.mjs',
    targetPlatform: WEBAPP_TARGET_PLATFORM,
    source: {
      dockerfile: 'apps/webapp/Dockerfile.platos',
      stage: 'production-deps',
      virtualStore: '/platos/node_modules/.pnpm',
      importerNodeModules: '/platos/apps/webapp/node_modules',
      linkedWorkspaceCount: 0,
      linkedWorkspaces: [],
    },
    componentCount: 1,
    distinctNames: 1,
    components: [component],
  };
}

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webapp-inventory-verifier-'));
  for (const file of WEBAPP_BUILD_INPUTS) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${file}\n`);
  }
  const archive = path.join(root, 'candidate.oci.tar');
  fs.writeFileSync(archive, 'candidate archive');
  const expectedInventoryPath = path.join(root, 'docs/audits/sbom/platos-webapp.image-inventory.json');
  fs.mkdirSync(path.dirname(expectedInventoryPath), { recursive: true });
  const committed = `${JSON.stringify(overrides.committedInventory ?? inventory(), null, 2)}\n`;
  fs.writeFileSync(expectedInventoryPath, committed);
  const scannerPath = path.join(root, 'scripts/image-package-inventory.mjs');
  const inputHash = buildInputsSha256(buildInputReceipts(root));
  const descriptor = {
    digest: overrides.archiveManifestDigest ?? manifestDigest,
    platform: overrides.archivePlatform ?? { os: 'linux', architecture: 'amd64' },
  };
  const index = { manifests: overrides.manifests ?? [descriptor] };
  const inspect = {
    Id: 'sha256:image',
    Os: overrides.imageOs ?? 'linux',
    Architecture: overrides.imageArchitecture ?? 'amd64',
    Config: {
      Labels: {
        'org.opencontainers.image.revision': gitHead,
        'dev.winsen.platos.webapp-inventory-inputs-sha256': inputHash,
        ...(overrides.labels ?? {}),
      },
    },
    RepoDigests: [],
    RootFS: { Layers: ['sha256:layer'] },
  };
  if (overrides.removeRevisionLabel) delete inspect.Config.Labels['org.opencontainers.image.revision'];
  if (overrides.removeInputLabel) delete inspect.Config.Labels['dev.winsen.platos.webapp-inventory-inputs-sha256'];
  const generated = `${JSON.stringify(overrides.generatedInventory ?? inventory(), null, 2)}\n`;
  const run = (command, args) => {
    if (command === 'tar') return JSON.stringify(index);
    if (command === 'git') return `${gitHead}\n`;
    if (command === 'docker' && args[0] === 'image') return JSON.stringify([inspect]);
    if (command === 'docker' && args[0] === 'run') {
      assert.deepEqual(args.slice(-5), [
        '/platos/node_modules/.pnpm', '--importer-node-modules',
        '/platos/apps/webapp/node_modules', '--root', '/platos',
      ]);
      return generated;
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  const config = {
    root,
    expectedInventoryPath,
    scannerPath,
    image: 'candidate:local',
    stage: 'final',
    evidencePath: path.join(root, 'evidence.json'),
    candidateArchive: archive,
    candidateManifestDigest: manifestDigest,
    candidateArchiveSha256: sha256(fs.readFileSync(archive)),
    sourceRunId: '123',
    sourceRunAttempt: '2',
  };
  return { root, config, run };
}

function rejects(overrides, mutate, pattern) {
  const files = fixture(overrides);
  try {
    mutate?.(files.config);
    assert.throws(() => verifyWebappImageInventory(files.config, { run: files.run }), pattern);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
}

test('writes evidence for a valid exact inventory', () => {
  const files = fixture();
  try {
    const result = verifyWebappImageInventory(files.config, { run: files.run });
    assert.equal(result.evidence.inventoryByteMatch, true);
    assert.equal(result.evidence.generatedInventorySha256, result.evidence.committedInventorySha256);
    assert.equal(JSON.parse(fs.readFileSync(files.config.evidencePath, 'utf8')).sourceRunId, '123');
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});

test('rejects missing source-run identity fields', () => {
  rejects({}, (config) => { delete config.sourceRunId; }, /GITHUB_RUN_ID is required/);
  rejects({}, (config) => { delete config.sourceRunAttempt; }, /GITHUB_RUN_ATTEMPT is required/);
});

test('rejects a wrong archive checksum', () => {
  rejects({}, (config) => { config.candidateArchiveSha256 = '0'.repeat(64); }, /candidate archive sha256 is/);
});

test('rejects multiple OCI manifests', () => {
  rejects({ manifests: [{}, {}] }, null, /exactly one manifest/);
});

test('rejects a wrong candidate manifest digest and platform', () => {
  rejects({ archiveManifestDigest: `sha256:${'c'.repeat(64)}` }, null, /candidate OCI archive manifest is/);
  rejects({ archivePlatform: { os: 'linux', architecture: 'arm64' } }, null, /archive platform is linux\/arm64/);
});

test('rejects a wrong Docker image platform', () => {
  rejects({ imageArchitecture: 'arm64' }, null, /image platform is linux\/arm64/);
});

test('rejects missing or mismatched revision labels', () => {
  rejects({ removeRevisionLabel: true }, null, /image revision label is missing/);
  rejects({ labels: { 'org.opencontainers.image.revision': 'c'.repeat(40) } }, null, /image revision label is/);
});

test('rejects missing or mismatched build-input labels', () => {
  rejects({ removeInputLabel: true }, null, /inventory-input label is missing/);
  rejects({ labels: { 'dev.winsen.platos.webapp-inventory-inputs-sha256': '0'.repeat(64) } }, null, /inventory-input label is/);
});

test('rejects generated inventory platform drift', () => {
  const changed = inventory();
  changed.targetPlatform = 'linux/arm64';
  rejects({ generatedInventory: changed }, null, /target platform is linux\/arm64/);
});

test('rejects inventory byte and hash mismatch while retaining mismatch evidence', () => {
  const changed = inventory({ name: 'beta', version: '1.0.0' });
  const files = fixture({ generatedInventory: changed });
  try {
    assert.throws(
      () => verifyWebappImageInventory(files.config, { run: files.run }),
      /image inventory differs/,
    );
    const evidence = JSON.parse(fs.readFileSync(files.config.evidencePath, 'utf8'));
    assert.equal(evidence.inventoryByteMatch, false);
    assert.notEqual(evidence.generatedInventorySha256, evidence.committedInventorySha256);
  } finally {
    fs.rmSync(files.root, { recursive: true, force: true });
  }
});

test('requires production and final stage evidence to identify distinct images', () => {
  assert.throws(
    () => assertDistinctStageImageIds({ imageId: 'same' }, { imageId: 'same' }),
    /distinct images/,
  );
  assert.doesNotThrow(
    () => assertDistinctStageImageIds({ imageId: 'production' }, { imageId: 'final' }),
  );
});
