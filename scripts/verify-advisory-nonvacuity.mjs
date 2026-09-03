// SPDX-License-Identifier: Apache-2.0
//
// verify-advisory-nonvacuity.mjs — proves the WIN-299 advisory disposition gate
// is NON-VACUOUS: it actually fails when a CRITICAL/HIGH advisory is unowned,
// stale, expired, unreasoned, drifted, falsely claimed fixed, or when the
// severity floor itself is quietly narrowed. It is not merely passing because
// nothing can ever trip it.
//
// METHOD — and why it is stronger than mutating the receipt.
//
// Every one of the seven failure modes is a property of the POLICY, not of the
// OSV receipt. So each case runs the REAL `scripts/audit-advisory.mjs --check`
// against the REAL committed receipt, the REAL lockfile and the REAL webapp
// image inventory, varying ONLY `--policy`. Nothing is forged: the receipt that
// must reconcile against the lock is the same one CI checks. That keeps the
// proof end-to-end — it exercises the actual CLI CI runs, not a re-implementation
// of its logic — while leaving no room to argue the inputs were rigged.
//
//   A. CONTROL       — real receipt + real policy                      -> PASS
//   B. UNOWNED       — a live HIGH's disposition deleted               -> FAIL
//   C. STALE         — disposition for an advisory that is not present -> FAIL
//   D. EXPIRED       — reviewBy moved into the past                    -> FAIL
//   E. UNREASONED    — argument blanked                                -> FAIL
//   F. DRIFT         — images disagree with the receipt                -> FAIL
//   G. FALSE-FIX     — resolved[] claims a still-present advisory      -> FAIL
//   H. NARROWED      — gatedSeverities cut down to CRITICAL only       -> FAIL
//
// A proves the gate is not stuck-red. B..H prove it is not stuck-green, one
// independent mechanism at a time. B is the specific regression that let
// GHSA-gr94-w7qr-f4j3 and GHSA-xwg4-73v4-xw9w sit on `v1` unowned.
//
// Usage: node scripts/verify-advisory-nonvacuity.mjs   (exit 0 iff all hold)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = path.join(ROOT, 'scripts/audit-advisory.mjs');
const POLICY = path.join(ROOT, 'docs/audits/sbom/advisory/advisory-policy.json');
const RECEIPT = path.join(ROOT, 'docs/audits/sbom/advisory/osv-report.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platos-advisory-nonvacuity-'));
const transcript = [];
function log(line) { transcript.push(line); console.log(line); }

function runCheck(policyPath) {
  const args = [AUDIT, '--check', ...(policyPath ? ['--policy', policyPath] : [])];
  const res = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

const basePolicy = JSON.parse(fs.readFileSync(POLICY, 'utf8'));
const receipt = JSON.parse(fs.readFileSync(RECEIPT, 'utf8'));

// Anchor the mutations on a real, live HIGH so the cases cannot be dismissed as
// operating on a finding that was never gated in the first place.
const victim = receipt.findings.find((f) => f.severity === 'HIGH');
if (!victim) throw new Error('no HIGH finding in the receipt to anchor the proof on');
const victimKey = `${victim.package}@${victim.version}/${victim.id}`;

function mutated(name, mutate) {
  const doc = structuredClone(basePolicy);
  mutate(doc);
  const file = path.join(tmp, `advisory-policy.${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return file;
}

function indexOfVictim(doc) {
  const i = doc.dispositions.findIndex(
    (d) => d.advisory === victim.id && d.package === victim.package && d.version === victim.version,
  );
  if (i === -1) throw new Error(`committed policy has no disposition for ${victimKey}`);
  return i;
}

const cases = [
  ['A. CONTROL — real committed receipt + real committed policy', null, 0],
  [
    `B. UNOWNED — disposition for the live HIGH ${victimKey} deleted`,
    mutated('unowned', (d) => { d.dispositions.splice(indexOfVictim(d), 1); }),
    1,
  ],
  [
    'C. STALE — disposition retained for an advisory absent from the receipt',
    mutated('stale', (d) => {
      d.dispositions.push({
        ...structuredClone(d.dispositions[indexOfVictim(d)]),
        advisory: 'GHSA-0000-nonexistent-0000',
      });
    }),
    1,
  ],
  [
    `D. EXPIRED — reviewBy on ${victimKey} moved into the past`,
    mutated('expired', (d) => { d.dispositions[indexOfVictim(d)].reviewBy = '2000-01-01'; }),
    1,
  ],
  [
    `E. UNREASONED — argument on ${victimKey} blanked`,
    mutated('unreasoned', (d) => { d.dispositions[indexOfVictim(d)].argument = 'n/a'; }),
    1,
  ],
  [
    `F. DRIFT — images on ${victimKey} disagree with the receipt`,
    mutated('drift', (d) => { d.dispositions[indexOfVictim(d)].images = ['nonexistent-image']; }),
    1,
  ],
  [
    `G. FALSE-FIX — resolved[] claims ${victimKey}, which is still present`,
    mutated('falsefix', (d) => {
      d.resolved.push({
        advisory: victim.id,
        package: victim.package,
        fromVersion: victim.version,
        toVersion: '999.0.0',
        severity: victim.severity,
        mechanism: 'fabricated upgrade claim used to prove the resolved[] check is enforced',
        issue: 'WIN-299',
        resolvedOn: '2026-09-02',
      });
    }),
    1,
  ],
  [
    'H. NARROWED — gatedSeverities cut down to CRITICAL, dropping HIGH from the gate',
    mutated('narrowed', (d) => { d.gatedSeverities = ['CRITICAL']; }),
    1,
  ],
];

log('# WIN-299 advisory disposition gate — non-vacuity proof transcript');
log(`scratch dir: ${tmp}`);
log(`anchor finding: ${victimKey} (${victim.severity})`);

const results = [];
for (const [label, policyPath, wantCode] of cases) {
  const got = runCheck(policyPath);
  const ok = got.code === wantCode;
  results.push(ok);
  log(`\n### ${label}`);
  log(`expected exit ${wantCode}, got exit ${got.code} — ${ok ? 'PASS' : 'FAIL'}`);
  log('---- check output ----');
  log(got.out.trim());
}

const allOk = results.every(Boolean);
log(`\n# RESULT: ${allOk ? 'NON-VACUITY PROVEN — all 8 assertions held.' : 'PROOF FAILED — see above.'}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
