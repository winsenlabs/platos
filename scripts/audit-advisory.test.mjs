// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCurrentInputs,
  refreshReceipt,
  validateReceipt,
} from './audit-advisory.mjs';

function emptyOsvResponse(_url, options) {
  const queries = JSON.parse(options.body).queries;
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ results: queries.map(() => ({ vulns: [] })) }),
  });
}

async function receiptFixture() {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-cache-'));
  const receipt = await refreshReceipt({ cacheDir, fetchImpl: emptyOsvResponse, timeoutMs: 1000 });
  const current = buildCurrentInputs();
  return { cacheDir, receipt, current };
}

test('exact-image empty OSV fixture produces a self-validating receipt', async () => {
  const { cacheDir, receipt, current } = await receiptFixture();
  try {
    assert.equal(validateReceipt(receipt, current), true);
    assert.equal(receipt.webappComponents, current.inventory.componentCount);
    assert.equal(receipt.webappInventory.sha256.length, 64);
    assert.equal(receipt.webappInventory.targetPlatform, 'linux/amd64');
    assert.equal(receipt.network.publicRequestsAttempted, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('receipt validation rejects inventory bytes, schema, platform, counts, and scan-set drift', async () => {
  const { cacheDir, receipt, current } = await receiptFixture();
  try {
    const mutations = [
      (value) => { value.webappInventory.sha256 = '0'.repeat(64); },
      (value) => { value.webappInventory.schema = 'wrong'; },
      (value) => { value.webappInventory.targetPlatform = 'linux/arm64'; },
      (value) => { value.webappComponents += 1; },
      (value) => { value.scanSetSha256 = '0'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(receipt);
      mutate(changed);
      assert.throws(() => validateReceipt(changed, current), /OSV receipt drift/);
    }
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('receipt validation rejects finding membership and image-membership drift', async () => {
  const { cacheDir, receipt, current } = await receiptFixture();
  try {
    const outside = structuredClone(receipt);
    outside.findings = [{
      package: 'not-in-image', version: '1.0.0', id: 'OSV-TEST', aliases: [], cves: [],
      severity: 'LOW', cvss: null, summary: null, fixedIn: null, images: ['webapp'], withdrawn: null,
    }];
    outside.findingsCount = 1;
    outside.bySeverity = { LOW: 1 };
    assert.throws(() => validateReceipt(outside, current), /finding outside current scan set/);

    const component = current.componentSets.agent[0];
    const mismatch = structuredClone(receipt);
    mismatch.findings = [{
      package: component.name, version: component.version, id: 'OSV-TEST', aliases: [], cves: [],
      severity: 'LOW', cvss: null, summary: null, fixedIn: null, images: [], withdrawn: null,
    }];
    mismatch.findingsCount = 1;
    mismatch.bySeverity = { LOW: 1 };
    assert.throws(() => validateReceipt(mismatch, current), /finding image membership drift/);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('public OSV request failure falls back only to a matching JSON cache and records the limitation', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'advisory-cache-fallback-'));
  try {
    await refreshReceipt({ cacheDir, fetchImpl: emptyOsvResponse, timeoutMs: 1000 });
    const receipt = await refreshReceipt({
      cacheDir,
      timeoutMs: 1000,
      fetchImpl: async () => { throw new Error('fixture network unavailable'); },
    });
    assert.equal(receipt.network.effectiveMode, 'public-osv-cache-fallback');
    assert.equal(receipt.network.cacheFallbacks, 1);
    assert.match(receipt.network.limitations[0], /used validated JSON cache/);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
