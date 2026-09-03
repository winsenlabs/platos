// SPDX-License-Identifier: Apache-2.0
//
// Unit coverage for the WIN-299 advisory disposition gate. The end-to-end proof
// that the gate fails through the real CLI lives in
// scripts/verify-advisory-nonvacuity.mjs; these tests pin the individual rules
// and the boundary conditions that the eight-case proof does not enumerate.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADVISORY_POLICY_SCHEMA,
  GATED_SEVERITIES,
  assertDispositions,
  evaluateDispositions,
} from './lib/advisory-dispositions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-09-02T00:00:00Z');

function finding(overrides = {}) {
  return {
    package: 'demo',
    version: '1.0.0',
    id: 'GHSA-demo-0000-0000',
    aliases: [],
    cves: [],
    severity: 'HIGH',
    cvss: null,
    summary: 'demo advisory',
    fixedIn: '1.0.1',
    images: ['agent'],
    withdrawn: null,
    ...overrides,
  };
}

function disposition(overrides = {}) {
  return {
    advisory: 'GHSA-demo-0000-0000',
    package: 'demo',
    version: '1.0.0',
    severity: 'HIGH',
    images: ['agent'],
    state: 'waived',
    reachability: 'inert',
    argument: 'x'.repeat(120),
    owner: 'Owner Name',
    issue: 'WIN-299',
    acceptedOn: '2026-09-01',
    reviewBy: '2026-12-01',
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    $schema: ADVISORY_POLICY_SCHEMA,
    gatedSeverities: [...GATED_SEVERITIES],
    resolved: [],
    dispositions: [disposition()],
    ...overrides,
  };
}

function evaluate(receiptFindings, policyDoc) {
  return evaluateDispositions({ findings: receiptFindings }, policyDoc, { now: NOW });
}

test('a complete, in-date disposition satisfies the gate', () => {
  const { errors, summary } = evaluate([finding()], policy());
  assert.deepEqual(errors, []);
  assert.equal(summary.gated, 1);
  assert.equal(summary.waived, 1);
  assert.equal(summary.carried, 0);
});

test('MODERATE and LOW findings are not gated and need no disposition', () => {
  for (const severity of ['MODERATE', 'LOW', 'UNKNOWN', 'NONE']) {
    const { errors, summary } = evaluate([finding({ severity })], policy({ dispositions: [] }));
    assert.deepEqual(errors, [], `${severity} must not be gated`);
    assert.equal(summary.gated, 0);
  }
});

test('CRITICAL is gated as well as HIGH', () => {
  const { errors } = evaluate([finding({ severity: 'CRITICAL' })], policy({ dispositions: [] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unowned CRITICAL advisory/u);
});

test('an unowned gated finding fails and names the advisory and images', () => {
  const { errors } = evaluate([finding()], policy({ dispositions: [] }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /unowned HIGH advisory: demo@1\.0\.0\/GHSA-demo-0000-0000/u);
  assert.match(errors[0], /\["agent"\]/u);
});

test('a disposition matching no live finding is rejected as stale', () => {
  const { errors } = evaluate([], policy());
  assert.equal(errors.length, 1);
  assert.match(errors[0], /stale disposition/u);
});

test('reviewBy in the past fails even though every other field is complete', () => {
  const { errors } = evaluate([finding()], policy({
    dispositions: [disposition({ acceptedOn: '2026-06-01', reviewBy: '2026-09-01' })],
  }));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /expired disposition/u);
});

test('reviewBy exactly today is still in date', () => {
  const { errors } = evaluate([finding()], policy({
    dispositions: [disposition({ reviewBy: '2026-09-02' })],
  }));
  assert.deepEqual(errors, []);
});

test('reviewBy must be strictly after acceptedOn', () => {
  const { errors } = evaluate([finding()], policy({
    dispositions: [disposition({ acceptedOn: '2026-09-02', reviewBy: '2026-09-02' })],
  }));
  assert.ok(errors.some((e) => /reviewBy .* must be after acceptedOn/u.test(e)));
});

test('a token argument is refused; only a substantive one passes', () => {
  for (const argument of ['', '   ', 'n/a', 'TODO', 'see ticket']) {
    const { errors } = evaluate([finding()], policy({ dispositions: [disposition({ argument })] }));
    assert.ok(errors.some((e) => /written reachability argument/u.test(e)), `"${argument}" must fail`);
  }
});

test('owner and a WIN-nnn issue are both mandatory', () => {
  const missingOwner = evaluate([finding()], policy({ dispositions: [disposition({ owner: '  ' })] }));
  assert.ok(missingOwner.errors.some((e) => /owner is required/u.test(e)));

  for (const issue of ['', 'nope', 'JIRA-12', 'WIN-']) {
    const { errors } = evaluate([finding()], policy({ dispositions: [disposition({ issue })] }));
    assert.ok(errors.some((e) => /issue must be a WIN-nnn identifier/u.test(e)), `"${issue}" must fail`);
  }
});

test('image and severity drift against the receipt are both caught', () => {
  const images = evaluate([finding()], policy({
    dispositions: [disposition({ images: ['agent', 'webapp'] })],
  }));
  assert.ok(images.errors.some((e) => /images .* disagree with the receipt/u.test(e)));

  const severity = evaluate([finding({ severity: 'CRITICAL' })], policy({
    dispositions: [disposition({ severity: 'HIGH' })],
  }));
  assert.ok(severity.errors.some((e) => /severity .* disagrees with the receipt/u.test(e)));
});

test('carried and waived may not borrow each other\'s reachability verdict', () => {
  const carriedClaimingInert = evaluate([finding()], policy({
    dispositions: [disposition({ state: 'carried', reachability: 'inert' })],
  }));
  assert.ok(carriedClaimingInert.errors.some((e) => /carried disposition must declare reachability "unassessed"/u.test(e)));

  const waivedClaimingUnassessed = evaluate([finding()], policy({
    dispositions: [disposition({ state: 'waived', reachability: 'unassessed' })],
  }));
  assert.ok(waivedClaimingUnassessed.errors.some((e) => /waived disposition cannot declare reachability "unassessed"/u.test(e)));
});

test('waiving a REACHABLE finding demands a named compensating control', () => {
  const bare = evaluate([finding()], policy({
    dispositions: [disposition({ reachability: 'reachable' })],
  }));
  assert.ok(bare.errors.some((e) => /requires a named compensatingControl/u.test(e)));

  const controlled = evaluate([finding()], policy({
    dispositions: [disposition({ reachability: 'reachable', compensatingControl: 'WAF rule 42 blocks the vector' })],
  }));
  assert.deepEqual(controlled.errors, []);
});

test('duplicate dispositions for the same finding are rejected', () => {
  const { errors } = evaluate([finding()], policy({ dispositions: [disposition(), disposition()] }));
  assert.ok(errors.some((e) => /duplicate disposition/u.test(e)));
});

test('a resolved entry whose advisory is still present is a false fix claim', () => {
  const resolvedEntry = {
    advisory: 'GHSA-demo-0000-0000',
    package: 'demo',
    fromVersion: '1.0.0',
    toVersion: '1.0.1',
    severity: 'HIGH',
    mechanism: 'pnpm override',
    issue: 'WIN-299',
    resolvedOn: '2026-09-02',
  };
  const { errors } = evaluate([finding()], policy({ resolved: [resolvedEntry] }));
  assert.ok(errors.some((e) => /false resolution claim/u.test(e)));

  // The same claim is accepted once the finding genuinely leaves the receipt,
  // and the stale disposition is removed alongside it.
  const gone = evaluate([], policy({ resolved: [resolvedEntry], dispositions: [] }));
  assert.deepEqual(gone.errors, []);
});

test('resolved entries still require a mechanism, issue and date', () => {
  const { errors } = evaluate([], policy({
    dispositions: [],
    resolved: [{ advisory: 'GHSA-x', package: 'demo', fromVersion: '0.0.1', toVersion: '', mechanism: '', issue: 'x', resolvedOn: 'nope' }],
  }));
  assert.ok(errors.some((e) => /mechanism is required/u.test(e)));
  assert.ok(errors.some((e) => /toVersion is required/u.test(e)));
  assert.ok(errors.some((e) => /issue must be a WIN-nnn identifier/u.test(e)));
  assert.ok(errors.some((e) => /resolvedOn must be a YYYY-MM-DD date/u.test(e)));
});

test('the severity floor cannot be narrowed from inside the policy file', () => {
  for (const gatedSeverities of [['CRITICAL'], [], ['HIGH', 'CRITICAL'], undefined]) {
    const { errors } = evaluate([finding()], policy({ gatedSeverities }));
    assert.ok(errors.some((e) => /gatedSeverities must be exactly/u.test(e)),
      `${JSON.stringify(gatedSeverities)} must be refused`);
  }
});

test('a wrong schema is refused', () => {
  const { errors } = evaluate([finding()], policy({ $schema: 'something-else/v1' }));
  assert.ok(errors.some((e) => /advisory policy schema must be/u.test(e)));
});

test('assertDispositions throws with every outstanding item, not just the first', () => {
  assert.throws(
    () => assertDispositions(
      { findings: [finding(), finding({ package: 'other', id: 'GHSA-other-0000-0000' })] },
      policy({ dispositions: [] }),
      { now: NOW },
    ),
    (error) => {
      assert.match(error.message, /advisory disposition drift/u);
      assert.match(error.message, /demo@1\.0\.0/u);
      assert.match(error.message, /other@1\.0\.0/u);
      return true;
    },
  );
});

test('the committed policy disposes every gated finding in the committed receipt', () => {
  const receipt = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/audits/sbom/advisory/osv-report.json'), 'utf8'));
  const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/audits/sbom/advisory/advisory-policy.json'), 'utf8'));
  const summary = assertDispositions(receipt, committed);
  assert.equal(summary.gated, summary.waived + summary.carried);
  assert.ok(summary.gated > 0, 'the proof is vacuous if nothing is gated');
});
