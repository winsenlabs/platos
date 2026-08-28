// SPDX-License-Identifier: Apache-2.0
//
// verify-sbom-nonvacuity.mjs — proves the M0.5 licence gate is NON-VACUOUS:
// it actually fails when a GPL/commercial dependency enters a shipping runtime
// closure, and it is not merely passing because nothing can ever trip it.
// WIN-250 / M0.5 deliverable #6 (non-vacuity requirement).
//
// It never mutates the committed tree. It writes scratch copies under a temp
// dir, injects a GPL canary into the AGENT production closure, and runs the real
// `scripts/audit-sbom.mjs check` against the scratch inputs. It asserts:
//
//   A. control            — real lockfile + real policy  -> PASS (exit 0)
//   B. inject un-waived   — GPL canary in agent, empty-baseline policy -> FAIL (exit 1)
//   C. inject + dispose   — same canary, canary added to baseline -> PASS (exit 0)
//   D. remove a real waiver — real breakword GPL, baseline minus breakword -> FAIL
//
// A + B together prove the gate discriminates (it is not stuck-green). C proves
// the disposition path is the release valve. D proves the gate fires on the
// REAL GPL package already in the tree, not just on a synthetic one.
//
// Usage: node scripts/verify-sbom-nonvacuity.mjs   (exit 0 iff all assertions hold)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SBOM = path.join(ROOT, 'scripts/audit-sbom.mjs');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const INDEX = path.join(ROOT, 'docs/audits/sbom/license-index.json');
const POLICY = path.join(ROOT, 'docs/audits/sbom/license-policy.json');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platos-nonvacuity-'));
const transcript = [];
function log(s) { transcript.push(s); console.log(s); }

function runCheck(args) {
  const res = spawnSync('node', [SBOM, 'check', ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

const CANARY = 'evil-gpl-canary';
const CANARY_VER = '9.9.9';

// --- build scratch inputs ---
const lockText = fs.readFileSync(LOCK, 'utf8');

// Inject the canary as a production dependency of apps/agent, and give it a
// snapshot node, so the closure walker pulls it into the agent image.
const injectedLock = lockText
  .replace(
    /^(  apps\/agent:\n    dependencies:\n)/m,
    `$1      ${CANARY}:\n        specifier: ^${CANARY_VER}\n        version: ${CANARY_VER}\n`,
  )
  .replace(
    /^(snapshots:\n)/m,
    `$1\n  ${CANARY}@${CANARY_VER}: {}\n`,
  );
const injectedLockPath = path.join(tmp, 'pnpm-lock.injected.yaml');
fs.writeFileSync(injectedLockPath, injectedLock);

// Scratch licence index = committed index + the canary declared GPL-3.0-only.
const indexDoc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
indexDoc.index[`${CANARY}@${CANARY_VER}`] = { license: 'GPL-3.0-only', resolvedFrom: 'version', status: 200 };
const injectedIndexPath = path.join(tmp, 'license-index.injected.json');
fs.writeFileSync(injectedIndexPath, JSON.stringify(indexDoc, null, 2));

// Scratch policy with an EMPTY baseline (nothing waived).
const policyDoc = JSON.parse(fs.readFileSync(POLICY, 'utf8'));
const emptyBaseline = JSON.parse(JSON.stringify(policyDoc));
emptyBaseline.dispositionedBaseline = [];
const emptyBaselinePath = path.join(tmp, 'policy.empty-baseline.json');
fs.writeFileSync(emptyBaselinePath, JSON.stringify(emptyBaseline, null, 2));

// Scratch policy = the REAL baseline PLUS the canary (so the other three real
// dispositions still apply and only the canary is newly waived).
const canaryWaived = JSON.parse(JSON.stringify(policyDoc));
canaryWaived.dispositionedBaseline = [...policyDoc.dispositionedBaseline, {
  package: CANARY, version: CANARY_VER, class: 'copyleft', license: 'GPL-3.0-only',
  image: 'agent', disposition: 'ACCEPTED-FOR-TEST', owner: 'test', reason: 'non-vacuity proof canary',
}];
const canaryWaivedPath = path.join(tmp, 'policy.canary-waived.json');
fs.writeFileSync(canaryWaivedPath, JSON.stringify(canaryWaived, null, 2));

// Scratch policy = real baseline MINUS breakword (to prove the real GPL fires).
const minusBreakword = JSON.parse(JSON.stringify(policyDoc));
minusBreakword.dispositionedBaseline = minusBreakword.dispositionedBaseline.filter((b) => b.package !== 'breakword');
const minusBreakwordPath = path.join(tmp, 'policy.minus-breakword.json');
fs.writeFileSync(minusBreakwordPath, JSON.stringify(minusBreakword, null, 2));

// --- assertions ---
const results = [];
function assert(label, got, wantCode) {
  const ok = got.code === wantCode;
  results.push(ok);
  log(`\n### ${label}`);
  log(`expected exit ${wantCode}, got exit ${got.code} — ${ok ? 'PASS' : 'FAIL'}`);
  log('---- check output ----');
  log(got.out.trim());
}

log(`# Non-vacuity proof transcript`);
log(`scratch dir: ${tmp}`);

assert(
  'A. CONTROL — real lockfile + real committed policy (should PASS)',
  runCheck([]),
  0,
);
assert(
  `B. INJECT — ${CANARY}@${CANARY_VER} (GPL-3.0-only) added to the agent closure, empty baseline (should FAIL)`,
  runCheck(['--lockfile', injectedLockPath, '--index', injectedIndexPath, '--policy', emptyBaselinePath]),
  1,
);
assert(
  'C. DISPOSITION — same injected GPL canary, but waived in baseline (should PASS)',
  runCheck(['--lockfile', injectedLockPath, '--index', injectedIndexPath, '--policy', canaryWaivedPath]),
  0,
);
assert(
  'D. REAL GPL — unmodified lockfile, but breakword removed from baseline (should FAIL on the real GPL-2.0 breakword@1.0.5 in webapp)',
  runCheck(['--policy', minusBreakwordPath]),
  1,
);

const allOk = results.every(Boolean);
log(`\n# RESULT: ${allOk ? 'NON-VACUITY PROVEN — all 4 assertions held.' : 'PROOF FAILED — see above.'}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
