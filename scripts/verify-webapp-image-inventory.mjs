#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WEBAPP_INVENTORY_EVIDENCE_SCHEMA,
  WEBAPP_TARGET_PLATFORM,
  buildInputReceipts,
  buildInputsSha256,
  sha256,
  validateInventoryDocument,
} from './lib/webapp-inventory-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_INVENTORY = path.join(ROOT, 'docs/audits/sbom/platos-webapp.image-inventory.json');
const SCANNER = path.join(ROOT, 'scripts/image-package-inventory.mjs');

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result.stdout;
}

function parseJson(bytes, description) {
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${description} is malformed JSON: ${error.message}`);
  }
}

export function currentBuildInputEvidence(root = ROOT, readFile = fs.readFileSync) {
  const receipts = buildInputReceipts(root, readFile);
  return { receipts, sha256: buildInputsSha256(receipts) };
}

export function verifyWebappImageInventory(config, dependencies = {}) {
  const root = path.resolve(config.root ?? ROOT);
  const readFile = dependencies.readFile ?? fs.readFileSync;
  const writeFile = dependencies.writeFile ?? fs.writeFileSync;
  const mkdir = dependencies.mkdir ?? fs.mkdirSync;
  const run = dependencies.run ?? defaultRun;
  const expectedInventoryPath = path.resolve(
    config.expectedInventoryPath ?? path.join(root, 'docs/audits/sbom/platos-webapp.image-inventory.json'),
  );
  const scannerPath = path.resolve(config.scannerPath ?? path.join(root, 'scripts/image-package-inventory.mjs'));

  if (!config.image || !['production-deps', 'final'].includes(config.stage) || !config.evidencePath ||
      !config.candidateArchive || !config.candidateManifestDigest || !config.candidateArchiveSha256) {
    throw new Error('image, valid stage, evidence path, candidate archive, manifest digest, and archive sha256 are required');
  }
  if (!/^[1-9][0-9]*$/u.test(config.sourceRunId ?? '')) {
    throw new Error('GITHUB_RUN_ID is required to bind inventory evidence to its source run');
  }
  if (!/^[1-9][0-9]*$/u.test(config.sourceRunAttempt ?? '')) {
    throw new Error('GITHUB_RUN_ATTEMPT is required to bind inventory evidence to its source run');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(config.candidateManifestDigest)) {
    throw new Error(`candidate manifest digest is invalid: ${config.candidateManifestDigest}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(config.candidateArchiveSha256)) {
    throw new Error(`candidate archive sha256 is invalid: ${config.candidateArchiveSha256}`);
  }

  const candidateArchive = path.resolve(config.candidateArchive);
  const archiveBytes = readFile(candidateArchive);
  const actualArchiveSha256 = sha256(archiveBytes);
  if (actualArchiveSha256 !== config.candidateArchiveSha256) {
    throw new Error(`candidate archive sha256 is ${actualArchiveSha256}; expected ${config.candidateArchiveSha256}`);
  }
  const candidateIndex = parseJson(
    run('tar', ['-xOf', candidateArchive, 'index.json'], { cwd: root }),
    'candidate OCI archive index',
  );
  if (!Array.isArray(candidateIndex.manifests) || candidateIndex.manifests.length !== 1) {
    throw new Error('candidate OCI archive must contain exactly one manifest');
  }
  const candidateDescriptor = candidateIndex.manifests[0];
  if (candidateDescriptor.digest !== config.candidateManifestDigest) {
    throw new Error(
      `candidate OCI archive manifest is ${candidateDescriptor.digest}; expected ${config.candidateManifestDigest}`,
    );
  }
  const candidatePlatform = `${candidateDescriptor.platform?.os ?? 'missing'}/${candidateDescriptor.platform?.architecture ?? 'missing'}`;
  if (candidatePlatform !== WEBAPP_TARGET_PLATFORM) {
    throw new Error(`candidate OCI archive platform is ${candidatePlatform}; expected ${WEBAPP_TARGET_PLATFORM}`);
  }

  const inspected = parseJson(
    run('docker', ['image', 'inspect', config.image], { cwd: root }),
    'docker image inspection',
  );
  if (!Array.isArray(inspected) || inspected.length !== 1) {
    throw new Error('docker image inspect must return exactly one image');
  }
  const inspect = inspected[0];
  const platform = `${inspect.Os}/${inspect.Architecture}`;
  if (platform !== WEBAPP_TARGET_PLATFORM) {
    throw new Error(`image platform is ${platform}; expected ${WEBAPP_TARGET_PLATFORM}`);
  }
  const gitHead = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim();
  const labels = inspect.Config?.Labels ?? {};
  if (labels['org.opencontainers.image.revision'] !== gitHead) {
    throw new Error(
      `image revision label is ${labels['org.opencontainers.image.revision'] ?? 'missing'}; expected ${gitHead}`,
    );
  }
  const inputEvidence = currentBuildInputEvidence(root, readFile);
  if (labels['dev.winsen.platos.webapp-inventory-inputs-sha256'] !== inputEvidence.sha256) {
    throw new Error(
      `image inventory-input label is ${labels['dev.winsen.platos.webapp-inventory-inputs-sha256'] ?? 'missing'}; expected ${inputEvidence.sha256}`,
    );
  }

  const scanner = readFile(scannerPath, 'utf8');
  const generated = run(
    'docker',
    [
      'run', '--rm', '-i', '--entrypoint', 'node', config.image, '-',
      '/platos/node_modules/.pnpm',
      '--importer-node-modules', '/platos/apps/webapp/node_modules',
      '--root', '/platos',
    ],
    { cwd: root, input: scanner },
  );
  const committed = readFile(expectedInventoryPath, 'utf8');
  const generatedInventory = parseJson(generated, 'generated image inventory');
  const committedInventory = parseJson(committed, 'committed image inventory');
  validateInventoryDocument(generatedInventory);
  validateInventoryDocument(committedInventory);
  const generatedInventorySha256 = sha256(generated);
  const committedInventorySha256 = sha256(committed);
  const inventoryByteMatch = generated === committed;

  const evidence = {
    $schema: WEBAPP_INVENTORY_EVIDENCE_SCHEMA,
    generatedBy: 'scripts/verify-webapp-image-inventory.mjs',
    sourceRunId: config.sourceRunId,
    sourceRunAttempt: config.sourceRunAttempt,
    gitHead,
    stage: config.stage,
    candidateManifestDigest: config.candidateManifestDigest,
    candidateArchive: path.basename(candidateArchive),
    candidateArchiveSha256: actualArchiveSha256,
    imageRef: config.image,
    imageId: inspect.Id,
    repoDigests: [...(inspect.RepoDigests ?? [])].sort(),
    rootfsDiffIds: [...(inspect.RootFS?.Layers ?? [])],
    platform,
    imageRevisionLabel: labels['org.opencontainers.image.revision'],
    imageBuildInputsLabel: labels['dev.winsen.platos.webapp-inventory-inputs-sha256'],
    inventoryByteMatch,
    generatedInventorySha256,
    committedInventorySha256,
    buildInputsSha256: inputEvidence.sha256,
    buildInputs: inputEvidence.receipts,
  };
  const evidencePath = path.resolve(config.evidencePath);
  mkdir(path.dirname(evidencePath), { recursive: true });
  writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  if (!inventoryByteMatch || generatedInventorySha256 !== committedInventorySha256) {
    throw new Error(
      `image inventory differs from ${path.relative(root, expectedInventoryPath)} ` +
      `(image=${generatedInventorySha256}, committed=${committedInventorySha256})`,
    );
  }
  return { evidence, inventory: generatedInventory };
}

export function runCli(argv = process.argv.slice(2), environment = process.env) {
  const inputEvidence = currentBuildInputEvidence();
  if (argv.includes('--print-build-inputs-sha256')) {
    console.log(inputEvidence.sha256);
    return;
  }
  const config = {
    image: flag(argv, '--image'),
    stage: flag(argv, '--stage'),
    evidencePath: flag(argv, '--evidence'),
    candidateArchive: flag(argv, '--candidate-archive'),
    candidateManifestDigest: flag(argv, '--candidate-manifest-digest'),
    candidateArchiveSha256: flag(argv, '--candidate-archive-sha256'),
    sourceRunId: environment.GITHUB_RUN_ID,
    sourceRunAttempt: environment.GITHUB_RUN_ATTEMPT,
  };
  const { evidence, inventory } = verifyWebappImageInventory(config);
  console.log(
    `verified ${config.stage} image inventory: ${inventory.componentCount} package pairs, ` +
      `${inventory.distinctNames} names, platform=${evidence.platform}, image=${evidence.imageId}`,
  );
  console.log(`evidence: ${path.resolve(config.evidencePath)}`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

export { ROOT, EXPECTED_INVENTORY, SCANNER };
