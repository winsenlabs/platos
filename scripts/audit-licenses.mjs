// SPDX-License-Identifier: Apache-2.0
//
// audit-licenses.mjs — one-time PROVISIONING step (network-bound, not part of
// the deterministic check). WIN-250 / M0.5.
//
// pnpm-lock.yaml (v9) does not record package licences. This script resolves a
// licence for every name@version in the union production closure by querying
// registry.npmjs.org, and freezes the result into a committed snapshot
// (docs/audits/sbom/license-index.json). The SBOM generator and the licence
// gate then read that COMMITTED snapshot — so regeneration stays deterministic
// while the SBOM still carries real licence data.
//
// Re-run this only to refresh the frozen index (e.g. after a relock). The
// output is content-addressed by the lockfile hash it was resolved against.
//
// Usage: node scripts/audit-licenses.mjs [--concurrency N]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadLockfile, computeAllClosures } from './lib/pnpm-closure.mjs';
import {
  linkedWorkspaceComponents,
  sortAndDedupeComponents,
} from './lib/webapp-inventory-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const OUT = path.join(ROOT, 'docs/audits/sbom/license-index.json');
const REGISTRY = 'https://registry.npmjs.org';

const concurrency = (() => {
  const i = process.argv.indexOf('--concurrency');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : 24;
})();

function normalizeLicense(meta, version) {
  // npm packages carry licence either as a top-level `license` (SPDX string or
  // {type}) or the deprecated `licenses` array, sometimes only on the version
  // document. Return an SPDX-ish string plus the raw evidence.
  const vdoc = meta?.versions?.[version] || {};
  const pick = (obj) => {
    if (!obj) return null;
    if (typeof obj.license === 'string') return obj.license;
    if (obj.license && typeof obj.license === 'object' && obj.license.type) return obj.license.type;
    if (Array.isArray(obj.licenses) && obj.licenses.length) {
      return obj.licenses.map((l) => (typeof l === 'string' ? l : l.type)).filter(Boolean).join(' OR ');
    }
    if (typeof obj.licenses === 'string') return obj.licenses;
    return null;
  };
  const fromVersion = pick(vdoc);
  const fromRoot = pick(meta);
  const value = fromVersion || fromRoot || null;
  return { license: value, resolvedFrom: fromVersion ? 'version' : (fromRoot ? 'package' : 'none') };
}

async function fetchLicense(name, version) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`;
  for (let tryIndex = 0; tryIndex < 3; tryIndex++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 404) return { license: null, resolvedFrom: 'not-found', status: 404 };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await res.json();
      const { license, resolvedFrom } = normalizeLicense(meta, version);
      return { license, resolvedFrom, status: 200 };
    } catch (err) {
      if (tryIndex === 2) return { license: null, resolvedFrom: 'error', error: String(err) };
      await new Promise((r) => setTimeout(r, 400 * (tryIndex + 1)));
    }
  }
}

async function main() {
  const { text, parsed } = loadLockfile(LOCK);
  const lockHash = crypto.createHash('sha256').update(text).digest('hex');
  const closures = computeAllClosures(parsed);
  const comps = sortAndDedupeComponents([
    ...closures.union.components,
    ...linkedWorkspaceComponents(ROOT, parsed),
  ]);
  console.error(`Resolving licences for ${comps.length} components (concurrency ${concurrency})…`);

  const index = {};
  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < comps.length) {
      const c = comps[cursor++];
      const id = `${c.name}@${c.version}`;
      const r = await fetchLicense(c.name, c.version);
      index[id] = { license: r.license, resolvedFrom: r.resolvedFrom, ...(r.status ? { status: r.status } : {}), ...(r.error ? { error: r.error } : {}) };
      done++;
      if (done % 200 === 0) console.error(`  … ${done}/${comps.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const sorted = {};
  for (const k of Object.keys(index).sort()) sorted[k] = index[k];

  const nulls = Object.entries(sorted).filter(([, v]) => !v.license);
  const doc = {
    $schema: 'platos.audit.license-index/v1',
    note: 'Frozen registry.npmjs.org licence snapshot for the union production closure plus linked first-party workspace components. '
      + 'Provisioning output of scripts/audit-licenses.mjs; consumed read-only by scripts/audit-sbom.mjs. '
      + 'Regenerate only after a relock.',
    resolvedAgainstLockfileSha256: lockHash,
    resolvedAt: new Date().toISOString(),
    registry: REGISTRY,
    componentCount: comps.length,
    unresolvedCount: nulls.length,
    index: sorted,
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  console.error(`Wrote ${OUT} (${comps.length} components, ${nulls.length} without a published licence field).`);
  if (nulls.length) {
    console.error('No-licence-field packages:');
    for (const [id, v] of nulls) console.error(`  ${id} (${v.resolvedFrom})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
