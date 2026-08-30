// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WEBAPP_TARGET_PLATFORM = 'linux/amd64';
export const WEBAPP_INVENTORY_SCHEMA = 'platos.audit.image-package-inventory/v2';
export const WEBAPP_INVENTORY_EVIDENCE_SCHEMA = 'platos.audit.webapp-image-inventory-evidence/v3';
export const WEBAPP_BUILD_INPUTS = Object.freeze([
  'apps/webapp/Dockerfile.platos',
  'apps/webapp/package.json',
  'apps/webapp/scripts/restore-patches.cjs',
  'internal-packages/tenancy-database/package.json',
  'internal-packages/workload-identity/package.json',
  'package.json',
  'pnpm-lock.yaml',
  'scripts/image-package-inventory.mjs',
  'scripts/lib/webapp-inventory-contract.mjs',
]);

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function componentId({ name, version }) {
  return `${name}@${version}`;
}

export function compareComponents(left, right) {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.version !== right.version) return left.version < right.version ? -1 : 1;
  return 0;
}

export function sortAndDedupeComponents(components) {
  const byId = new Map();
  for (const component of components) {
    if (
      !component ||
      typeof component.name !== 'string' ||
      component.name.length === 0 ||
      typeof component.version !== 'string' ||
      component.version.length === 0
    ) {
      throw new Error('inventory component lacks a non-empty name/version');
    }
    byId.set(componentId(component), { name: component.name, version: component.version });
  }
  return [...byId.values()].sort(compareComponents);
}

export function validateInventoryDocument(
  inventory,
  { expectedPlatform = WEBAPP_TARGET_PLATFORM, expectedSchema = WEBAPP_INVENTORY_SCHEMA } = {},
) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw new Error('webapp image inventory is not an object');
  }
  if (inventory.$schema !== expectedSchema) {
    throw new Error(
      `webapp image inventory schema is ${inventory.$schema ?? 'missing'}; expected ${expectedSchema}`,
    );
  }
  if (inventory.targetPlatform !== expectedPlatform) {
    throw new Error(
      `webapp image inventory target platform is ${inventory.targetPlatform ?? 'missing'}; expected ${expectedPlatform}`,
    );
  }
  if (!Array.isArray(inventory.components)) {
    throw new Error('webapp image inventory has no components array');
  }
  const components = sortAndDedupeComponents(inventory.components);
  if (components.length !== inventory.components.length) {
    throw new Error('webapp image inventory contains duplicate package pairs');
  }
  if (JSON.stringify(components) !== JSON.stringify(inventory.components)) {
    throw new Error('webapp image inventory components are not deterministically sorted');
  }
  const distinctNames = new Set(components.map(({ name }) => name)).size;
  if (inventory.componentCount !== components.length || inventory.distinctNames !== distinctNames) {
    throw new Error('webapp image inventory summary counts do not match its components');
  }
  const linkedWorkspaces = inventory.source?.linkedWorkspaces;
  if (!Array.isArray(linkedWorkspaces)) {
    throw new Error('webapp image inventory has no linked workspace component list');
  }
  const sortedLinked = sortAndDedupeComponents(linkedWorkspaces);
  if (
    sortedLinked.length !== linkedWorkspaces.length ||
    JSON.stringify(sortedLinked) !== JSON.stringify(linkedWorkspaces)
  ) {
    throw new Error('webapp linked workspace components are duplicated or unsorted');
  }
  if (inventory.source.linkedWorkspaceCount !== linkedWorkspaces.length) {
    throw new Error('webapp linked workspace count does not match its component list');
  }
  const componentIds = new Set(components.map(componentId));
  for (const workspace of linkedWorkspaces) {
    if (!componentIds.has(componentId(workspace))) {
      throw new Error(`linked workspace is absent from image components: ${componentId(workspace)}`);
    }
  }
  return { inventory, components, linkedWorkspaces };
}

export function buildInputReceipts(root, readFile = fs.readFileSync) {
  return WEBAPP_BUILD_INPUTS.map((file) => ({
    file,
    sha256: sha256(readFile(path.join(root, file))),
  }));
}

export function buildInputsSha256(receipts) {
  return sha256(JSON.stringify(receipts));
}

export function componentSetsSha256(componentSets) {
  const normalized = Object.fromEntries(
    Object.entries(componentSets)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, components]) => [name, sortAndDedupeComponents(components)]),
  );
  return sha256(JSON.stringify(normalized));
}

export function assertDistinctStageImageIds(productionEvidence, finalEvidence) {
  if (!productionEvidence?.imageId || !finalEvidence?.imageId) {
    throw new Error('production-deps and final evidence must both identify an image');
  }
  if (productionEvidence.imageId === finalEvidence.imageId) {
    throw new Error('production-deps and final evidence must identify distinct images');
  }
}

export function linkedWorkspaceComponents(
  root,
  parsed,
  importerRoots = ['apps/webapp'],
  readFile = fs.readFileSync,
) {
  const visited = new Set();
  const components = [];
  const visit = (importer) => {
    if (visited.has(importer)) return;
    visited.add(importer);
    const record = parsed.importers?.[importer];
    if (!record) throw new Error(`lockfile has no linked importer: ${importer}`);
    for (const group of ['prod', 'opt']) {
      for (const [expectedName, value] of Object.entries(record[group] ?? {})) {
        if (!value.startsWith('link:')) continue;
        const target = path.posix.normalize(path.posix.join(importer, value.slice('link:'.length)));
        if (!parsed.importers[target]) continue;
        const manifestPath = path.join(root, target, 'package.json');
        let manifest;
        try {
          manifest = JSON.parse(readFile(manifestPath, 'utf8'));
        } catch (error) {
          throw new Error(`linked workspace manifest is unreadable: ${manifestPath}: ${error.message}`);
        }
        if (manifest.name !== expectedName) {
          throw new Error(
            `linked workspace name mismatch: ${expectedName} -> ${manifest.name ?? 'missing'} (${manifestPath})`,
          );
        }
        if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
          throw new Error(`linked workspace manifest lacks a version: ${manifestPath}`);
        }
        components.push({ name: manifest.name, version: manifest.version });
        visit(target);
      }
    }
  };
  for (const importer of importerRoots) visit(importer);
  return sortAndDedupeComponents(components);
}
