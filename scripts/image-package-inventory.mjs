#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INVENTORY_SCHEMA = 'platos.audit.image-package-inventory/v2';

function architecturePlatform() {
  const architecture = { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch;
  return `${process.platform}/${architecture}`;
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function realpathWithin(root, candidate, description) {
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch (error) {
    throw new Error(`${description} is missing or unreadable: ${candidate}: ${error.message}`);
  }
  if (!isWithin(root, resolved)) {
    throw new Error(`${description} resolves outside inventory root: ${candidate} -> ${resolved}`);
  }
  return resolved;
}

function readManifest(root, packagePath, description) {
  const resolvedPackage = realpathWithin(root, packagePath, description);
  const manifestPath = path.join(resolvedPackage, 'package.json');
  let bytes;
  try {
    bytes = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`${description} package manifest is missing: ${manifestPath}: ${error.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${description} package manifest is malformed: ${manifestPath}: ${error.message}`);
  }
  if (
    !manifest ||
    typeof manifest.name !== 'string' ||
    manifest.name.length === 0 ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0
  ) {
    throw new Error(`${description} package manifest lacks name/version: ${manifestPath}`);
  }
  return {
    component: { name: manifest.name, version: manifest.version },
    manifest,
    manifestPath,
    packagePath: resolvedPackage,
  };
}

function packageEntries(root, nodeModulesPath, description) {
  const resolvedNodeModules = realpathWithin(root, nodeModulesPath, description);
  const packages = [];
  const entries = fs.readdirSync(resolvedNodeModules, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(resolvedNodeModules, entry.name);
    if (entry.name.startsWith('@')) {
      const scopePath = realpathWithin(root, entryPath, `${description} scope ${entry.name}`);
      const scoped = fs.readdirSync(scopePath, { withFileTypes: true })
        .filter((child) => child.isDirectory() || child.isSymbolicLink())
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      for (const child of scoped) {
        packages.push({
          expectedName: `${entry.name}/${child.name}`,
          packagePath: path.join(scopePath, child.name),
        });
      }
    } else {
      packages.push({ expectedName: entry.name, packagePath: entryPath });
    }
  }
  return packages;
}

function addComponent(components, component) {
  components.set(`${component.name}\0${component.version}`, component);
}

function compareComponents(left, right) {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.version !== right.version) return left.version < right.version ? -1 : 1;
  return 0;
}

export function scanImagePackages({
  storePath,
  importerNodeModulesPath,
  repositoryRoot,
  targetPlatform = architecturePlatform(),
}) {
  if (!storePath) throw new Error('virtual store path is required');
  const resolvedStoreArgument = path.resolve(storePath);
  const rootArgument = path.resolve(
    repositoryRoot ?? path.join(resolvedStoreArgument, '..', '..'),
  );
  const root = fs.realpathSync(rootArgument);
  const store = realpathWithin(root, resolvedStoreArgument, 'pnpm virtual store');
  const importerNodeModules = path.resolve(
    importerNodeModulesPath ?? path.join(root, 'apps/webapp/node_modules'),
  );
  const components = new Map();

  const virtualEntries = fs.readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const virtualEntry of virtualEntries) {
    const nodeModulesPath = path.join(store, virtualEntry.name, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) continue;
    for (const entry of packageEntries(root, nodeModulesPath, `virtual store entry ${virtualEntry.name}`)) {
      const { component } = readManifest(
        root,
        entry.packagePath,
        `virtual store package ${entry.expectedName}`,
      );
      addComponent(components, component);
    }
  }

  const linkedWorkspaces = new Map();
  const visitedWorkspacePaths = new Set();
  const nodeModulesQueue = [importerNodeModules];
  const visitedNodeModules = new Set();
  while (nodeModulesQueue.length > 0) {
    const nodeModulesPath = nodeModulesQueue.shift();
    const resolvedNodeModules = realpathWithin(root, nodeModulesPath, 'production importer node_modules');
    if (visitedNodeModules.has(resolvedNodeModules)) continue;
    visitedNodeModules.add(resolvedNodeModules);
    for (const entry of packageEntries(root, resolvedNodeModules, 'production importer node_modules')) {
      const resolvedPackage = realpathWithin(root, entry.packagePath, `linked package ${entry.expectedName}`);
      if (isWithin(store, resolvedPackage)) continue;
      const record = readManifest(root, resolvedPackage, `linked workspace ${entry.expectedName}`);
      if (record.component.name !== entry.expectedName) {
        throw new Error(
          `linked workspace name mismatch: ${entry.expectedName} -> ${record.component.name} (${record.manifestPath})`,
        );
      }
      addComponent(components, record.component);
      linkedWorkspaces.set(`${record.component.name}\0${record.component.version}`, record.component);
      if (!visitedWorkspacePaths.has(record.packagePath)) {
        visitedWorkspacePaths.add(record.packagePath);
        const nestedNodeModules = path.join(record.packagePath, 'node_modules');
        if (fs.existsSync(nestedNodeModules)) nodeModulesQueue.push(nestedNodeModules);
      }
    }
  }

  const sorted = [...components.values()].sort(compareComponents);
  const sortedLinked = [...linkedWorkspaces.values()].sort(compareComponents);
  return {
    $schema: INVENTORY_SCHEMA,
    generatedBy: 'scripts/image-package-inventory.mjs',
    targetPlatform,
    source: {
      dockerfile: 'apps/webapp/Dockerfile.platos',
      stage: 'production-deps',
      virtualStore: resolvedStoreArgument,
      importerNodeModules,
      linkedWorkspaceCount: sortedLinked.length,
      linkedWorkspaces: sortedLinked,
    },
    componentCount: sorted.length,
    distinctNames: new Set(sorted.map((component) => component.name)).size,
    components: sorted,
  };
}

export function inventoryBytes(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

function parseCli(argv) {
  const args = [...argv];
  const storePath = args.shift();
  let outputPath = null;
  let importerNodeModulesPath = null;
  let repositoryRoot = null;
  while (args.length > 0) {
    const value = args.shift();
    if (value === '--importer-node-modules') importerNodeModulesPath = args.shift();
    else if (value === '--root') repositoryRoot = args.shift();
    else if (!outputPath) outputPath = value;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!storePath) {
    throw new Error(
      'usage: node scripts/image-package-inventory.mjs <node_modules/.pnpm> [output.json] ' +
        '[--importer-node-modules <path>] [--root <path>]',
    );
  }
  return { storePath, outputPath, importerNodeModulesPath, repositoryRoot };
}

export function runCli(argv = process.argv.slice(2)) {
  const { outputPath, ...options } = parseCli(argv);
  const bytes = inventoryBytes(scanImagePackages(options));
  if (outputPath) fs.writeFileSync(outputPath, bytes);
  else process.stdout.write(bytes);
}

const isDirect = process.argv[1] === '-' ||
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isDirect) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
