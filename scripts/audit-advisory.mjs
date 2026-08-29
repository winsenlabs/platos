// SPDX-License-Identifier: Apache-2.0
//
// audit-advisory.mjs — real vulnerability scan of the two shipping production
// closures against the OSV database (osv.dev), with a retained JSON receipt.
// WIN-250 / M0.5 deliverable #2.
//
// Why not `pnpm audit`: pnpm audit reports on the whole workspace install
// (dev + prod, all importers), not on the per-image production closure that
// actually ships. This script scans EXACTLY the agent and webapp runtime
// closures computed from pnpm-lock.yaml, so a finding maps to a real image.
//
// A scan is point-in-time: OSV grows as advisories are published, so this is a
// RECEIPT (timestamped, lockfile-hash-stamped), not a deterministic artifact.
// The deterministic gate is scripts/audit-sbom.mjs. Re-running refreshes the
// receipt.
//
// Network path : POST https://api.osv.dev/v1/querybatch  (batched, <=1000/req)
//                then GET https://api.osv.dev/v1/vulns/{id} for details.
// Offline path : --offline reads a committed OSV export dir if provided via
//                --osv-dir <path> (one <id>.json per advisory, OSV schema) and
//                matches versions locally. Documented for air-gapped CI.
//
// Usage:
//   node scripts/audit-advisory.mjs                 # live scan -> receipt
//   node scripts/audit-advisory.mjs --offline --osv-dir ./osv-export

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadLockfile, computeAllClosures } from './lib/pnpm-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const OUTDIR = path.join(ROOT, 'docs/audits/sbom/advisory');
const OSV_API = 'https://api.osv.dev';

const offline = process.argv.includes('--offline');
const osvDirArg = (() => {
  const i = process.argv.indexOf('--osv-dir');
  return i !== -1 ? process.argv[i + 1] : null;
})();

// M0.5 §6.1 named these explicitly for adjudication. We assert each is
// addressed in the receipt whether OSV flags it or not.
const M05_FLAGGED = [
  { name: 'cookie', note: 'M0.5: 0.4.2 below 0.7.0 fix line for CVE-2024-47764' },
  { name: 'postcss', note: 'M0.5: 6.0.23 / 7.0.32 named for scan' },
  { name: 'tmp', note: 'M0.5: 0.0.33 named for scan' },
  { name: 'semver', note: 'M0.5: 5.7.1 named for scan' },
  { name: 'undici', note: 'M0.5: 5.29.0 named for scan' },
  { name: 'fast-xml-parser', note: 'M0.5: 4.2.5 named for scan' },
  { name: 'ws', note: 'M0.5: 8.11.0 named for scan' },
  { name: 'path-to-regexp', note: 'M0.5: 0.1.10 named for scan' },
];

async function osvBatch(queries) {
  const results = [];
  for (let i = 0; i < queries.length; i += 1000) {
    const chunk = queries.slice(i, i + 1000);
    const res = await fetch(`${OSV_API}/v1/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: chunk }),
    });
    if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
    const json = await res.json();
    results.push(...(json.results || []));
  }
  return results;
}

async function osvDetails(id) {
  const res = await fetch(`${OSV_API}/v1/vulns/${id}`);
  if (!res.ok) throw new Error(`OSV vulns/${id} HTTP ${res.status}`);
  return res.json();
}

function severityOf(vuln) {
  // OSV/GHSA npm advisories carry a qualitative label in database_specific.severity
  // (CRITICAL/HIGH/MODERATE/LOW); prefer it. If only a numeric CVSS score is
  // published, bucket it. A raw CVSS vector without a numeric score stays UNKNOWN
  // rather than being mis-scored.
  const ds = vuln.database_specific?.severity;
  if (ds) return { score: null, label: String(ds).toUpperCase(), vector: null };
  const sev = vuln.severity?.find((s) => s.type?.startsWith('CVSS'));
  if (sev?.score && !/\/AV:/.test(sev.score)) {
    const n = parseFloat(sev.score);
    if (!Number.isNaN(n)) return { score: n, label: bucket(n), vector: sev.score };
  }
  if (sev?.score) return { score: null, label: 'UNKNOWN', vector: sev.score };
  return { score: null, label: 'UNKNOWN', vector: null };
}

function bucket(score) {
  if (score >= 9) return 'CRITICAL';
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MODERATE';
  if (score > 0) return 'LOW';
  return 'NONE';
}

function ecosystemAffects(vuln, name, version) {
  // Strict local match used ONLY by the offline path: is this exact npm
  // name@version inside one of the advisory's `affected` versions/ranges?
  // (The online path never calls this — osv.dev already filters by version.)
  for (const aff of vuln.affected || []) {
    if (aff.package?.ecosystem !== 'npm') continue;
    if (aff.package?.name !== name) continue;
    if (Array.isArray(aff.versions) && aff.versions.includes(version)) return true;
    for (const range of aff.ranges || []) {
      if (range.type === 'SEMVER' || range.type === 'ECOSYSTEM') {
        if (inRange(version, range.events)) return true;
      }
    }
  }
  return false;
}

function inRange(version, events) {
  // events: [{introduced}, {fixed}|{last_affected}] possibly multiple.
  let affected = false;
  let introduced = null, fixed = null;
  const cmp = (a, b) => semverCmp(a, b);
  for (const e of events) {
    if (e.introduced !== undefined) introduced = e.introduced;
    if (e.fixed !== undefined) fixed = e.fixed;
    if (e.last_affected !== undefined) fixed = null;
  }
  if (introduced === '0' || introduced === null) affected = true;
  else if (cmp(version, introduced) >= 0) affected = true;
  if (affected && fixed && cmp(version, fixed) >= 0) affected = false;
  return affected;
}

function semverCmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

async function main() {
  const { text, parsed } = loadLockfile(LOCK);
  const lockHash = crypto.createHash('sha256').update(text).digest('hex');
  const closures = computeAllClosures(parsed);
  const union = closures.union.components;

  // which images does each component ship in
  const inImage = (image, name, version) =>
    closures[image].components.some((c) => c.name === name && c.version === version);

  console.error(`Scanning ${union.length} components against OSV${offline ? ' (offline)' : ''}…`);

  const queries = union.map((c) => ({ package: { name: c.name, ecosystem: 'npm' }, version: c.version }));
  let batchResults;
  const detailCache = new Map();

  if (offline) {
    if (!osvDirArg) throw new Error('--offline requires --osv-dir <path>');
    batchResults = union.map((c) => {
      const vulns = [];
      for (const file of fs.readdirSync(osvDirArg)) {
        if (!file.endsWith('.json')) continue;
        const v = JSON.parse(fs.readFileSync(path.join(osvDirArg, file), 'utf8'));
        if (ecosystemAffects(v, c.name, c.version)) { vulns.push({ id: v.id }); detailCache.set(v.id, v); }
      }
      return { vulns };
    });
  } else {
    batchResults = await osvBatch(queries);
  }

  const findings = [];
  const idsToFetch = new Set();
  batchResults.forEach((r, i) => {
    for (const v of r.vulns || []) idsToFetch.add(v.id);
  });
  if (!offline) {
    const ids = [...idsToFetch];
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try { detailCache.set(id, await osvDetails(id)); }
        catch (e) { detailCache.set(id, { id, _error: String(e) }); }
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker));
  }

  batchResults.forEach((r, i) => {
    const c = union[i];
    for (const v of r.vulns || []) {
      const detail = detailCache.get(v.id) || { id: v.id };
      const sev = severityOf(detail);
      const aliases = detail.aliases || [];
      const cves = aliases.filter((a) => a.startsWith('CVE-'));
      const fixed = (() => {
        for (const aff of detail.affected || []) {
          if (aff.package?.ecosystem !== 'npm' || aff.package?.name !== c.name) continue;
          for (const range of aff.ranges || []) {
            for (const e of range.events || []) if (e.fixed) return e.fixed;
          }
        }
        return null;
      })();
      findings.push({
        package: c.name,
        version: c.version,
        id: v.id,
        aliases,
        cves,
        severity: sev.label,
        cvss: sev.vector,
        summary: detail.summary || null,
        fixedIn: fixed,
        images: ['agent', 'webapp'].filter((img) => inImage(img, c.name, c.version)),
        withdrawn: detail.withdrawn || null,
      });
    }
  });

  // Rank: severity then package
  const sevRank = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MODERATE_LOW: 3, LOW: 4, NONE: 5, UNKNOWN: 6 };
  findings.sort((a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) || a.package.localeCompare(b.package));

  const activeFindings = findings.filter((f) => !f.withdrawn);

  // Adjudicate the M0.5-named items
  const adjudication = M05_FLAGGED.map((flag) => {
    const versions = [...new Set(union.filter((c) => c.name === flag.name).map((c) => c.version))].sort();
    const hits = activeFindings.filter((f) => f.package === flag.name);
    return {
      package: flag.name,
      m05Note: flag.note,
      versionsInClosure: versions,
      shipsIn: [...new Set(union.filter((c) => c.name === flag.name)
        .flatMap((c) => ['agent', 'webapp'].filter((img) => inImage(img, c.name, c.version))))],
      advisories: hits.map((h) => ({ id: h.id, cves: h.cves, version: h.version, severity: h.severity, fixedIn: h.fixedIn, images: h.images })),
      verdict: hits.length ? 'VULNERABLE_VERSION_PRESENT' : (versions.length ? 'PRESENT_NO_ADVISORY' : 'NOT_IN_CLOSURE'),
    };
  });

  const bySeverity = {};
  for (const f of activeFindings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const receipt = {
    $schema: 'platos.audit.osv-receipt/v1',
    tool: offline ? 'osv-offline-match (scripts/audit-advisory.mjs)' : 'osv.dev querybatch+vulns (scripts/audit-advisory.mjs)',
    scannedAt: new Date().toISOString(),
    lockfileSha256: lockHash,
    ecosystem: 'npm',
    scope: 'per-image production closures (agent, webapp) from pnpm-lock.yaml',
    componentsScanned: union.length,
    agentComponents: closures.agent.components.length,
    webappComponents: closures.webapp.components.length,
    findingsCount: activeFindings.length,
    withdrawnCount: findings.length - activeFindings.length,
    bySeverity,
    m05Adjudication: adjudication,
    findings: activeFindings,
    withdrawn: findings.filter((f) => f.withdrawn),
  };

  fs.mkdirSync(OUTDIR, { recursive: true });
  const outFile = path.join(OUTDIR, 'osv-report.json');
  fs.writeFileSync(outFile, JSON.stringify(receipt, null, 2) + '\n');
  console.error(`Wrote ${outFile}`);
  console.error(`Findings: ${activeFindings.length} active (${JSON.stringify(bySeverity)}), ${receipt.withdrawnCount} withdrawn.`);
  for (const a of adjudication) console.error(`  ${a.package}: ${a.verdict} versions=[${a.versionsInClosure.join(', ')}] ships=[${a.shipsIn.join(', ')}]`);
}

main().catch((e) => { console.error(e); process.exit(1); });
