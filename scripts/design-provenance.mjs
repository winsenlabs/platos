// SPDX-License-Identifier: Apache-2.0
//
// Deterministic provenance receipt for the Platos UI design reference.
// This records repository evidence only. It deliberately makes no claim about
// external ownership where the repository history does not establish one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN_ROOT = 'design/platos-ui-refactor';
const MANIFEST = 'design/platos-ui-refactor.provenance.json';
const IMPORT_COMMIT = '866c9a8980378a476cfa89f5b0863036fce126bd';
const INITIAL_COMMIT = 'f5be33998fa7039884ffb7bd32274f0cb6bed6d9';
const BRIEF = `${DESIGN_ROOT}/uploads/platos-design-prompt.md`;
const REGULAR_GIT_MODES = new Set(['100644', '100755']);
const TOP_LEVEL_FIELDS = [
  '$schema', 'generatedBy', 'root', 'repositoryLicense', 'ownershipBoundary',
  'fileCount', 'files', 'duplicateSets',
];
const FILE_FIELDS = ['path', 'sha256', 'source', 'license'];
const SOURCE_FIELDS = [
  'status', 'kind', 'sourcePath', 'sourceCommit', 'importPath', 'importCommit', 'evidence',
];
const LICENSE_FIELDS = ['spdx', 'basis', 'sourcePath', 'externalOwnership'];
const DUPLICATE_FIELDS = ['sha256', 'classification', 'paths'];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function trackedEntries(root) {
  return git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map((record) => {
    const match = record.match(/^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/);
    if (!match) throw new Error(`Unable to parse Git index entry: ${record}`);
    return { mode: match[1], object: match[2], stage: Number(match[3]), path: match[4] };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function trackedFiles(root) {
  return trackedEntries(root).map((entry) => entry.path);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function containedPath(root, relative, boundary) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return null;
  const repository = fs.realpathSync(root);
  const boundaryPath = fs.realpathSync(path.join(repository, boundary));
  const absolute = path.resolve(repository, relative);
  if (!isWithin(repository, absolute) || !isWithin(boundaryPath, absolute)) return null;
  return { absolute, boundaryPath };
}

function resolvedContainedPath(root, relative, boundary) {
  const contained = containedPath(root, relative, boundary);
  if (!contained || !fs.existsSync(contained.absolute)) return null;
  const resolved = fs.realpathSync(contained.absolute);
  return isWithin(contained.boundaryPath, resolved) ? { ...contained, resolved } : null;
}

function inspectDesignTree(root) {
  const entries = trackedEntries(root).filter((entry) => entry.path.startsWith(`${DESIGN_ROOT}/`));
  const errors = [];
  for (const entry of entries) {
    const contained = containedPath(root, entry.path, DESIGN_ROOT);
    if (!contained) {
      errors.push(`PATH ESCAPE: tracked design path ${entry.path} is outside ${DESIGN_ROOT}.`);
      continue;
    }
    if (entry.stage !== 0) errors.push(`UNSAFE ASSET: ${entry.path} has unresolved Git index stage ${entry.stage}.`);
    if (!REGULAR_GIT_MODES.has(entry.mode)) errors.push(`UNSAFE ASSET: ${entry.path} has non-regular Git mode ${entry.mode}.`);
    let stat;
    try { stat = fs.lstatSync(contained.absolute); } catch {
      errors.push(`MISSING ASSET: ${entry.path}.`);
      continue;
    }
    if (stat.isSymbolicLink()) errors.push(`UNSAFE ASSET: ${entry.path} is a symbolic link in the worktree.`);
    else if (!stat.isFile()) errors.push(`UNSAFE ASSET: ${entry.path} is not a regular file in the worktree.`);
    let resolved;
    try { resolved = fs.realpathSync(contained.absolute); } catch { continue; }
    if (!isWithin(contained.boundaryPath, resolved)) {
      errors.push(`PATH ESCAPE: ${entry.path} resolves outside ${DESIGN_ROOT}.`);
    }
  }
  return { entries, errors };
}

function repositoryLicense() {
  return {
    spdx: 'Apache-2.0',
    basis: 'repository-license',
    sourcePath: 'LICENSE',
    externalOwnership: 'not-asserted',
  };
}

function sourceFor(file) {
  const common = { importPath: file, importCommit: IMPORT_COMMIT };
  if (file === `${DESIGN_ROOT}/assets/logo.png`) {
    return {
      status: 'unknown',
      kind: 'unknown-origin-brand-asset',
      sourcePath: null,
      sourceCommit: null,
      ...common,
      evidence: 'Git records the import, but no earlier repository path or external source is derivable for these bytes.',
    };
  }
  if (file === `${DESIGN_ROOT}/assets/platos-icon.svg`) {
    return {
      status: 'derived',
      kind: 'serialized-repository-copy',
      sourcePath: 'apps/webapp/public/images/platos-icon.svg',
      sourceCommit: INITIAL_COMMIT,
      ...common,
      evidence: 'github.md records a copy from webapp/public; XML formatting changed, so byte identity is not claimed.',
    };
  }
  if (file === `${DESIGN_ROOT}/assets/platos-logo.png`) {
    return {
      status: 'derived',
      kind: 'byte-identical-repository-copy',
      sourcePath: 'apps/webapp/public/emails/platos-logo.png',
      sourceCommit: INITIAL_COMMIT,
      ...common,
      evidence: 'The source path predates the design import and has byte-identical content.',
    };
  }
  if (file === `${DESIGN_ROOT}/assets/platos-logotype.png`) {
    return {
      status: 'derived',
      kind: 'byte-identical-repository-copy',
      sourcePath: 'apps/webapp/public/images/platos-logotype.png',
      sourceCommit: INITIAL_COMMIT,
      ...common,
      evidence: 'The source path predates the design import and has byte-identical content.',
    };
  }
  if (file === BRIEF) {
    return {
      status: 'repository-history',
      kind: 'repository-source-document',
      sourcePath: file,
      sourceCommit: IMPORT_COMMIT,
      ...common,
      evidence: 'The design brief is committed alongside the generated reference in the import commit.',
    };
  }
  if (file === `${DESIGN_ROOT}/github.md`) {
    return {
      status: 'repository-history',
      kind: 'repository-sync-record',
      sourcePath: file,
      sourceCommit: IMPORT_COMMIT,
      ...common,
      evidence: 'The repository synchronization record is committed in the design import.',
    };
  }
  return {
    status: 'repository-history',
    kind: 'generated-from-repository-brief',
    sourcePath: BRIEF,
    sourceCommit: IMPORT_COMMIT,
    ...common,
    evidence: 'The import commit and design/README.md identify the committed brief as the source for the generated reference.',
  };
}

function matchingTrackedFiles(root, digest, size, files = trackedFiles(root)) {
  const matches = [];
  for (const file of files) {
    const contained = resolvedContainedPath(root, file, '.');
    if (!contained) continue;
    let stat;
    try { stat = fs.lstatSync(contained.absolute); } catch { continue; }
    if (!stat.isFile() || stat.size !== size) continue;
    if (sha256(fs.readFileSync(contained.absolute)) === digest) matches.push(file);
  }
  return matches.sort();
}

export function buildManifest(root = ROOT) {
  const inspection = inspectDesignTree(root);
  if (inspection.errors.length) throw new Error(inspection.errors.join('\n'));
  const files = inspection.entries.map((entry) => entry.path);
  const entries = files.map((file) => ({
    path: file,
    sha256: sha256(fs.readFileSync(path.join(root, file))),
    source: sourceFor(file),
    license: repositoryLicense(),
  }));

  const duplicateSets = [];
  const byHash = new Map();
  for (const entry of entries) {
    const group = byHash.get(entry.sha256) || [];
    group.push(entry.path);
    byHash.set(entry.sha256, group);
  }
  const allTracked = trackedFiles(root);
  for (const [digest, paths] of [...byHash.entries()].sort()) {
    if (paths.length < 2) continue;
    const size = fs.statSync(path.join(root, paths[0])).size;
    duplicateSets.push({
      sha256: digest,
      classification: 'known-byte-identical-brand-assets',
      paths: matchingTrackedFiles(root, digest, size, allTracked),
    });
  }

  return {
    $schema: 'platos.design-provenance/v1',
    generatedBy: 'node scripts/design-provenance.mjs write',
    root: DESIGN_ROOT,
    repositoryLicense: 'Apache-2.0',
    ownershipBoundary: 'Repository history and licensing are recorded; external ownership is not asserted.',
    fileCount: entries.length,
    files: entries,
    duplicateSets,
  };
}

function walkFiles(root, relative) {
  const result = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const item = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) visit(item);
      else result.push(item);
    }
  };
  visit(relative);
  return result.sort();
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && sameJson(Object.keys(value), allowed);
}

function validateManifestShape(manifest) {
  const errors = [];
  if (!exactKeys(manifest, TOP_LEVEL_FIELDS)) {
    errors.push(`MANIFEST SHAPE DRIFT: top-level fields must be exactly ${TOP_LEVEL_FIELDS.join(', ')}.`);
  }
  if (!Array.isArray(manifest?.files)) {
    errors.push('MANIFEST SHAPE DRIFT: files must be an array.');
  } else {
    for (const [index, entry] of manifest.files.entries()) {
      if (!exactKeys(entry, FILE_FIELDS)) errors.push(`MANIFEST SHAPE DRIFT: files[${index}] has unexpected or missing fields.`);
      if (!exactKeys(entry?.source, SOURCE_FIELDS)) errors.push(`MANIFEST SHAPE DRIFT: files[${index}].source has unexpected or missing fields.`);
      if (!exactKeys(entry?.license, LICENSE_FIELDS)) errors.push(`MANIFEST SHAPE DRIFT: files[${index}].license has unexpected or missing fields.`);
    }
  }
  if (!Array.isArray(manifest?.duplicateSets)) {
    errors.push('MANIFEST SHAPE DRIFT: duplicateSets must be an array.');
  } else {
    for (const [index, group] of manifest.duplicateSets.entries()) {
      if (!exactKeys(group, DUPLICATE_FIELDS)) errors.push(`MANIFEST SHAPE DRIFT: duplicateSets[${index}] has unexpected or missing fields.`);
      if (!Array.isArray(group?.paths)) errors.push(`MANIFEST SHAPE DRIFT: duplicateSets[${index}].paths must be an array.`);
    }
  }
  return errors;
}

function pathAtCommitExists(root, commit, file) {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}:${file}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function checkManifest(manifest, root = ROOT) {
  const errors = validateManifestShape(manifest);
  const inspection = inspectDesignTree(root);
  errors.push(...inspection.errors);
  if (inspection.errors.length) return errors;
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files) ||
      !manifest.files.every((entry) => entry && typeof entry === 'object') ||
      !Array.isArray(manifest.duplicateSets) ||
      !manifest.duplicateSets.every((group) => group && typeof group === 'object' && Array.isArray(group.paths))) {
    return errors;
  }
  const expected = buildManifest(root);
  if (manifest.$schema !== expected.$schema) errors.push(`SCHEMA DRIFT: expected ${expected.$schema}.`);
  if (manifest.root !== DESIGN_ROOT) errors.push(`ROOT DRIFT: expected ${DESIGN_ROOT}.`);
  if (manifest.fileCount !== manifest.files?.length) errors.push('COUNT DRIFT: fileCount does not match files length.');
  if (!sameJson(manifest, expected)) errors.push('MANIFEST DRIFT: manifest must exactly match deterministic generator output.');

  const actualFiles = walkFiles(root, DESIGN_ROOT);
  const entries = Array.isArray(manifest.files) ? manifest.files : [];
  const listedFiles = entries.map((entry) => entry.path).filter((file) => typeof file === 'string').sort();
  const actualSet = new Set(actualFiles);
  const listedSet = new Set(listedFiles);
  const trackedSet = new Set(trackedFiles(root));
  for (const file of listedFiles) if (!actualSet.has(file)) errors.push(`MISSING ASSET: ${file}.`);
  for (const file of actualFiles) if (!listedSet.has(file)) errors.push(`EXTRA ASSET: ${file}.`);
  for (const file of actualFiles) if (!trackedSet.has(file)) errors.push(`UNTRACKED ASSET: ${file}.`);
  if (listedSet.size !== listedFiles.length) errors.push('PATH DRIFT: duplicate manifest paths are not allowed.');

  const expectedByPath = new Map(expected.files.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const wanted = expectedByPath.get(entry.path);
    if (!wanted) continue;
    const contained = resolvedContainedPath(root, entry.path, DESIGN_ROOT);
    if (!contained) {
      errors.push(`PATH ESCAPE: manifest asset ${entry.path} does not resolve inside ${DESIGN_ROOT}.`);
      continue;
    }
    if (fs.existsSync(contained.absolute)) {
      const got = sha256(fs.readFileSync(contained.absolute));
      if (entry.sha256 !== got) errors.push(`HASH DRIFT: ${entry.path} expected ${entry.sha256}, got ${got}.`);
    }
    if (!sameJson(entry.source, wanted.source)) errors.push(`SOURCE DRIFT: ${entry.path} provenance differs from repository evidence.`);
    if (!sameJson(entry.license, wanted.license)) errors.push(`LICENSE DRIFT: ${entry.path} must use the repository Apache-2.0 declaration.`);

    const source = entry.source || {};
    if (source.status === 'unknown') {
      if (source.sourcePath !== null || source.sourceCommit !== null || !source.evidence) {
        errors.push(`SOURCE DRIFT: ${entry.path} unknown provenance must remain explicit and must not invent a source.`);
      }
    } else if (!containedPath(root, source.sourcePath, '.') || !source.sourceCommit || !pathAtCommitExists(root, source.sourceCommit, source.sourcePath)) {
      errors.push(`SOURCE DRIFT: ${entry.path} source path/commit is not present in Git history.`);
    }
    if (!containedPath(root, source.importPath, DESIGN_ROOT) || !source.importCommit || !pathAtCommitExists(root, source.importCommit, source.importPath)) {
      errors.push(`SOURCE DRIFT: ${entry.path} import path/commit is not present in Git history.`);
    }
    if (entry.license?.spdx !== 'Apache-2.0' || entry.license?.basis !== 'repository-license' || entry.license?.sourcePath !== 'LICENSE') {
      errors.push(`LICENSE DRIFT: ${entry.path} lacks the repository Apache-2.0 basis.`);
    }
  }

  if (!sameJson(manifest.duplicateSets, expected.duplicateSets)) {
    errors.push('DUPLICATE DRIFT: known byte-identical brand asset declarations differ from current tracked files.');
  }
  for (const group of manifest.duplicateSets) {
    for (const file of group.paths) {
      const contained = resolvedContainedPath(root, file, '.');
      if (!contained || sha256(fs.readFileSync(contained.absolute)) !== group.sha256) {
        errors.push(`DUPLICATE DRIFT: ${file} does not match declared hash ${group.sha256}.`);
      }
    }
  }

  if (manifest.repositoryLicense !== 'Apache-2.0' || !fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Apache License')) {
    errors.push('LICENSE DRIFT: repository Apache-2.0 evidence is missing.');
  }
  if (manifest.ownershipBoundary !== expected.ownershipBoundary) {
    errors.push('OWNERSHIP DRIFT: the external ownership non-assertion changed.');
  }
  return errors;
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

function main(argv) {
  const [command] = argv;
  const manifestPath = path.resolve(flag(argv, '--manifest') || path.join(ROOT, MANIFEST));
  if (command === 'write') {
    fs.writeFileSync(manifestPath, stableStringify(buildManifest(ROOT)));
    console.log(`WROTE: ${path.relative(ROOT, manifestPath)}`);
    return;
  }
  if (command === 'check') {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const errors = checkManifest(manifest, ROOT);
    if (errors.length) {
      for (const error of errors) console.error(error);
      console.error(`design provenance check FAILED (${errors.length} error(s))`);
      process.exitCode = 1;
      return;
    }
    console.log(`design provenance check PASSED (${manifest.fileCount} files, ${manifest.duplicateSets.length} duplicate set).`);
    return;
  }
  console.log('usage: node scripts/design-provenance.mjs <write|check> [--manifest <path>]');
  process.exitCode = command ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
