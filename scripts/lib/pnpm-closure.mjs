// SPDX-License-Identifier: Apache-2.0
//
// pnpm-closure.mjs — deterministic per-image production-closure walker for
// pnpm-lock.yaml (lockfileVersion 9). WIN-250 / M0.5.
//
// This module reads pnpm-lock.yaml WITHOUT installing anything. It parses the
// three sections it needs (`importers`, `packages`, `snapshots`) with a small
// indentation state machine — the file is machine-generated with rigid 2-space
// indentation, so a full YAML engine is unnecessary and would add an install
// dependency this audit is specifically trying to avoid.
//
// The per-image closures are defined to match how each image is actually built
// (see docs/audits/M0.5-dependency-sbom.md §1.1):
//
//   agent image  : `pnpm --filter platos-agent deploy --prod` — ONLY apps/agent's
//                  production dependencies plus the workspace packages it links
//                  to (and their production deps). Root dependencies do NOT reach
//                  the agent runtime image.
//
//   webapp image : the production-deps stage installs `--filter webapp...`, so
//                  only apps/webapp and its production workspace dependency
//                  graph ship. Root release/tooling dependencies do not.
//
// "Production" = `dependencies` + `optionalDependencies`, never `devDependencies`.
//
// Everything here is a pure function of the lockfile bytes: same input -> same
// output, no network, no clock, no filesystem beyond reading the lock. That is
// what makes the SBOM drift-check meaningful.

import fs from 'node:fs';
import path from 'node:path';

function unquote(s) {
  s = s.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function indentOf(line) {
  let n = 0;
  while (line[n] === ' ') n++;
  return n;
}

// Split a `key: value` YAML line (already stripped of indentation) into
// [key, value], honouring single-quoted keys (scoped npm names, versioned
// snapshot keys). npm names/versions never contain a literal single quote, so
// a plain paired-quote strip is exact here.
function splitKV(body) {
  body = body.replace(/\s+$/, '');
  let key, rest;
  if (body[0] === "'") {
    const end = body.indexOf("'", 1);
    key = body.slice(1, end);
    rest = body.slice(end + 1).replace(/^:\s?/, '');
  } else {
    const ci = body.indexOf(':');
    key = body.slice(0, ci);
    rest = body.slice(ci + 1).replace(/^\s?/, '');
  }
  return [key, rest];
}

function mappingEntryKey(body, kind, lineNumber) {
  let text = body.replace(/\s+$/, '');
  if (text.endsWith(': {}')) text = text.slice(0, -4);
  else if (text.endsWith(':')) text = text.slice(0, -1);
  else throw new Error(`Malformed ${kind} entry at line ${lineNumber}: ${body}`);
  const key = unquote(text);
  if (key === '') throw new Error(`Empty ${kind} entry at line ${lineNumber}`);
  return key;
}

export function parseLockfile(text) {
  const lines = text.split('\n');
  const importers = {};
  const snapshots = {};
  const packages = {};
  let section = null;

  let curImp = null, curImpGroup = null, curDep = null;
  let curSnap = null, curSnapGroup = null;
  let curPkg = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    if (rawLine === '') continue;
    const line = rawLine.replace(/\r$/, '');
    const ind = indentOf(line);
    const body = line.slice(ind);

    if (ind === 0) {
      const m = body.match(/^([A-Za-z][A-Za-z0-9_]*):\s*$/);
      section = m ? m[1] : null;
      curImp = curSnap = curPkg = null;
      continue;
    }

    if (section === 'importers') {
      if (ind === 2) {
        curImp = mappingEntryKey(body, 'importer', lineIndex + 1);
        if (Object.hasOwn(importers, curImp)) {
          throw new Error(`Duplicate importer entry at line ${lineIndex + 1}: ${curImp}`);
        }
        importers[curImp] = { prod: {}, dev: {}, opt: {} };
        curImpGroup = null; curDep = null;
      } else if (ind === 4) {
        if (body.startsWith('dependencies:')) curImpGroup = 'prod';
        else if (body.startsWith('optionalDependencies:')) curImpGroup = 'opt';
        else if (body.startsWith('devDependencies:')) curImpGroup = 'dev';
        else curImpGroup = 'other';
        curDep = null;
      } else if (ind === 6) {
        curDep = unquote(body.replace(/:\s*$/, ''));
      } else if (ind === 8 && body.startsWith('version:')) {
        const v = unquote(body.slice('version:'.length).trim());
        if (curImp && curImpGroup && curImpGroup !== 'other' && curDep) {
          importers[curImp][curImpGroup][curDep] = v;
        }
      }
    } else if (section === 'snapshots') {
      if (ind === 2) {
        let t = body;
        if (t.endsWith(': {}')) t = t.slice(0, -4);
        else if (t.endsWith(':')) t = t.slice(0, -1);
        curSnap = unquote(t);
        snapshots[curSnap] = { deps: {}, opt: {} };
        curSnapGroup = null;
      } else if (ind === 4) {
        if (body.startsWith('dependencies:')) curSnapGroup = 'deps';
        else if (body.startsWith('optionalDependencies:')) curSnapGroup = 'opt';
        else curSnapGroup = 'other';
      } else if (ind === 6 && (curSnapGroup === 'deps' || curSnapGroup === 'opt')) {
        const [k, v] = splitKV(body);
        if (v !== '') snapshots[curSnap][curSnapGroup][unquote(k)] = unquote(v);
      }
    } else if (section === 'packages') {
      if (ind === 2) {
        curPkg = unquote(body.replace(/:\s*$/, ''));
        packages[curPkg] = {};
      } else if (ind === 4 && body.startsWith('resolution:')) {
        const m = body.match(/integrity:\s*([^\s},]+)/);
        if (m && curPkg) packages[curPkg].integrity = m[1];
      }
    }
  }
  return { importers, snapshots, packages };
}

// Resolve a (depName, lockValue) pair to the snapshot key it points at.
// pnpm records an npm alias as `depName: realName@version` — the value does not
// start with a digit — and the resolved node is the VALUE itself, not
// `depName@value`. A plain dependency value is a version (starts with a digit),
// so the key is `depName@version`.
export function toSnapKey(name, value) {
  return /^[0-9]/.test(value) ? `${name}@${value}` : value;
}

// Split a snapshot key ("name@version(peer@x)(patch_hash=y)") into its bare
// name + version, discarding the peer/patch suffix so it matches the key used
// in the `packages:` section and in a purl.
export function parseKey(key) {
  const paren = key.indexOf('(');
  const noPeer = paren === -1 ? key : key.slice(0, paren);
  const at = noPeer.lastIndexOf('@');
  return { name: noPeer.slice(0, at), version: noPeer.slice(at + 1) };
}

// Walk the external snapshot closure from a set of seed importer directories.
// Importer groups default to production; callers may include `dev` for an
// independently derived repository closure. Returns peer-qualified keys.
export function computeClosure(roots, parsed, importerGroups = ['prod', 'opt']) {
  const visitedImp = new Set();
  const snapVisited = new Set();
  const queue = [];

  const enqueue = (key) => {
    if (!snapVisited.has(key)) { snapVisited.add(key); queue.push(key); }
  };

  const addImporter = (dir) => {
    if (visitedImp.has(dir)) return;
    visitedImp.add(dir);
    const imp = parsed.importers[dir];
    if (!imp) return;
    for (const group of importerGroups) {
      for (const [name, version] of Object.entries(imp[group] || {})) {
        if (version.startsWith('link:')) {
          const rel = version.slice('link:'.length);
          const target = path.posix.normalize(path.posix.join(dir, rel));
          if (parsed.importers[target]) addImporter(target);
          // A link: to a non-importer path (e.g. a local @types shim) has no
          // production closure of its own — nothing to add.
        } else {
          enqueue(toSnapKey(name, version));
        }
      }
    }
  };

  for (const r of roots) addImporter(r);

  while (queue.length) {
    const key = queue.shift();
    const snap = parsed.snapshots[key];
    if (!snap) continue;
    for (const group of ['deps', 'opt']) {
      for (const [name, version] of Object.entries(snap[group] || {})) {
        enqueue(toSnapKey(name, version));
      }
    }
  }
  return snapVisited;
}

// The two shipping images, by seed importer set. Single source of truth so the
// SBOM, advisory scan and licence index all agree on what "ships".
export const IMAGES = {
  agent: { roots: ['apps/agent'], displayName: 'platos-agent' },
  webapp: { roots: ['apps/webapp'], displayName: 'webapp' },
};

// Reduce a set of snapshot keys to the sorted, de-duplicated list of
// { name, version } components (peer/patch suffix collapsed).
export function componentsFromSnapshots(snaps) {
  const byId = new Map();
  for (const k of snaps) {
    const { name, version } = parseKey(k);
    const id = `${name}@${version}`;
    if (!byId.has(id)) byId.set(id, { name, version });
  }
  return [...byId.values()].sort((a, b) =>
    a.name === b.name ? cmpVersion(a.version, b.version) : (a.name < b.name ? -1 : 1)
  );
}

function cmpVersion(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function loadLockfile(lockPath) {
  const text = fs.readFileSync(lockPath, 'utf8');
  return { text, parsed: parseLockfile(text) };
}

// Compute both image closures + the union in one pass. Returns component lists.
export function computeAllClosures(parsed) {
  const out = {};
  for (const [image, { roots }] of Object.entries(IMAGES)) {
    const snaps = computeClosure(roots, parsed);
    out[image] = {
      snapshotKeys: [...snaps].sort(),
      components: componentsFromSnapshots(snaps),
    };
  }
  const unionKeys = new Set([...out.agent.snapshotKeys, ...out.webapp.snapshotKeys]);
  out.union = {
    snapshotKeys: [...unionKeys].sort(),
    components: componentsFromSnapshots(unionKeys),
  };
  return out;
}
