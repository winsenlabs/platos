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
export const REGISTRY = 'https://registry.npmjs.org';
export const RESOLUTION_FAILURE_CATEGORIES = Object.freeze([
  'http-status',
  'invalid-json',
  'missing-metadata',
  'network',
  'timeout',
]);
const RESOLUTION_FAILURE_CATEGORY_SET = new Set(RESOLUTION_FAILURE_CATEGORIES);
const MISSING_METADATA_DETAILS = new Set([
  'source-timestamp-invalid',
  'source-timestamp-missing',
  'version-document-missing',
]);
const TIMEOUT_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

export function normalizeLicense(meta, version) {
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

function normalizedSourceTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) return null;
  return new Date(value).toISOString();
}

function registryVersionPublishedAt(meta, version) {
  const value = meta?.time?.[version];
  return normalizedSourceTimestamp(value);
}

function errorCodes(error) {
  return [error?.code, error?.cause?.code].filter((value) => typeof value === 'string');
}

export function classifyExternalResolutionError(error) {
  if (
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError' ||
    errorCodes(error).some((code) => TIMEOUT_ERROR_CODES.has(code))
  ) {
    return 'timeout';
  }
  return 'network';
}

function failedResolution(failureCategory, retryCount, options = {}) {
  if (!RESOLUTION_FAILURE_CATEGORY_SET.has(failureCategory)) {
    throw new Error(`unsupported resolution failure category: ${failureCategory}`);
  }
  return {
    license: null,
    resolvedFrom: 'error',
    resolutionStatus: 'failed',
    failureCategory,
    retryCount,
    ...(Number.isInteger(options.status) ? { status: options.status } : {}),
    ...(options.failureDetail ? { failureDetail: options.failureDetail } : {}),
    sourceTimestamp: null,
  };
}

export async function fetchLicense(name, version, options = {}) {
  const registry = options.registry ?? REGISTRY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const url = `${registry}/${name.replace('/', '%2f')}`;
  for (let tryIndex = 0; tryIndex < 3; tryIndex++) {
    const retryCount = tryIndex + 1;
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch (error) {
      if (tryIndex === 2) {
        return failedResolution(classifyExternalResolutionError(error), retryCount);
      }
      await sleep(400 * (tryIndex + 1));
      continue;
    }

    if (res.status === 404) {
      return {
        license: null,
        resolvedFrom: 'not-found',
        resolutionStatus: 'not-found',
        status: 404,
        sourceTimestamp: null,
      };
    }
    if (!res.ok) {
      if (tryIndex === 2) return failedResolution('http-status', retryCount, { status: res.status });
      await sleep(400 * (tryIndex + 1));
      continue;
    }

    let meta;
    try {
      meta = await res.json();
    } catch {
      if (tryIndex === 2) return failedResolution('invalid-json', retryCount, { status: res.status });
      await sleep(400 * (tryIndex + 1));
      continue;
    }

    if (!meta || typeof meta !== 'object' || !meta.versions?.[version]) {
      if (tryIndex === 2) {
        return failedResolution('missing-metadata', retryCount, {
          status: res.status,
          failureDetail: 'version-document-missing',
        });
      }
      await sleep(400 * (tryIndex + 1));
      continue;
    }
    const rawTimestamp = meta?.time?.[version];
    const sourceTimestamp = registryVersionPublishedAt(meta, version);
    if (!sourceTimestamp) {
      if (tryIndex === 2) {
        return failedResolution('missing-metadata', retryCount, {
          status: res.status,
          failureDetail: typeof rawTimestamp === 'string'
            ? 'source-timestamp-invalid'
            : 'source-timestamp-missing',
        });
      }
      await sleep(400 * (tryIndex + 1));
      continue;
    }

    const { license, resolvedFrom } = normalizeLicense(meta, version);
    return {
      license,
      resolvedFrom,
      resolutionStatus: 'resolved',
      status: 200,
      sourceTimestamp,
    };
  }
}

function sanitizedResolution(id, resolution) {
  if (!resolution || typeof resolution !== 'object') {
    throw new Error(`${id}: resolver returned no structured result`);
  }
  const {
    license,
    resolvedFrom,
    resolutionStatus,
    status,
    failureCategory,
    failureDetail,
    retryCount,
  } = resolution;
  if (typeof license !== 'string' && license !== null) {
    throw new Error(`${id}: resolver returned an invalid licence value`);
  }
  if (!['version', 'package', 'none', 'not-found', 'error'].includes(resolvedFrom)) {
    throw new Error(`${id}: resolver returned an invalid resolvedFrom value`);
  }
  if (!['resolved', 'not-found', 'failed'].includes(resolutionStatus)) {
    throw new Error(`${id}: resolver returned an invalid resolutionStatus value`);
  }

  if (resolutionStatus === 'resolved') {
    if (status !== 200) throw new Error(`${id}: successful resolution must have HTTP status 200`);
    if (resolution.sourceTimestamp === null || resolution.sourceTimestamp === undefined) {
      throw new Error(`${id}: successful resolution is missing its publication timestamp`);
    }
    const sourceTimestamp = normalizedSourceTimestamp(resolution.sourceTimestamp);
    if (!sourceTimestamp) {
      throw new Error(`${id}: successful resolution has an invalid publication timestamp`);
    }
    return {
      evidence: { license, resolvedFrom, resolutionStatus, status },
      sourceTimestamp,
    };
  }

  if (resolutionStatus === 'not-found') {
    if (status !== 404 || resolvedFrom !== 'not-found') {
      throw new Error(`${id}: not-found resolution must have HTTP status 404`);
    }
    return {
      evidence: { license: null, resolvedFrom, resolutionStatus, status },
      sourceTimestamp: null,
    };
  }

  if (!RESOLUTION_FAILURE_CATEGORY_SET.has(failureCategory)) {
    throw new Error(`${id}: failed resolution has an invalid failure category`);
  }
  if (!Number.isInteger(retryCount) || retryCount < 1 || retryCount > 3) {
    throw new Error(`${id}: failed resolution has an invalid retry count`);
  }
  if (failureCategory === 'missing-metadata') {
    if (!MISSING_METADATA_DETAILS.has(failureDetail)) {
      throw new Error(`${id}: missing-metadata failure has an invalid detail`);
    }
    throw new Error(`${id}: registry metadata lacks required version/publication metadata (${failureDetail})`);
  }
  return {
    evidence: {
      license: null,
      resolvedFrom: 'error',
      resolutionStatus,
      failureCategory,
      retryCount,
      ...(Number.isInteger(status) ? { status } : {}),
    },
    sourceTimestamp: null,
  };
}

export async function buildLicenseIndex({
  lockfileText,
  components,
  resolveLicense = fetchLicense,
  registry = REGISTRY,
  concurrency = 24,
  onProgress = () => {},
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const lockHash = crypto.createHash('sha256').update(lockfileText).digest('hex');
  const comps = sortAndDedupeComponents(components);
  const index = {};
  const sourceTimestamps = [];
  let done = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < comps.length) {
      const c = comps[cursor++];
      const id = `${c.name}@${c.version}`;
      const r = await resolveLicense(c.name, c.version);
      const sanitized = sanitizedResolution(id, r);
      index[id] = sanitized.evidence;
      if (sanitized.sourceTimestamp) sourceTimestamps.push(sanitized.sourceTimestamp);
      done++;
      onProgress(done, comps.length);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const sorted = {};
  for (const k of Object.keys(index).sort()) sorted[k] = index[k];

  const nulls = Object.entries(sorted).filter(([, v]) => !v.license);
  if (sourceTimestamps.length === 0) {
    throw new Error('registry responses did not provide a version publication timestamp');
  }
  const resolvedAt = sourceTimestamps.sort().at(-1);
  return {
    $schema: 'platos.audit.license-index/v1',
    note: 'Frozen registry.npmjs.org licence snapshot for the union production closure plus linked first-party workspace components. '
      + 'Provisioning output of scripts/audit-licenses.mjs; consumed read-only by scripts/audit-sbom.mjs. '
      + 'Regenerate only after a relock. resolvedAt is the latest immutable publication timestamp among successful external resolutions, not the generator wall clock. '
      + 'Every successful external resolution must provide a valid publication timestamp; non-success statuses are excluded.',
    resolvedAgainstLockfileSha256: lockHash,
    resolvedAt,
    resolvedAtPolicy: 'maximum registry version publication timestamp across successful external resolutions; every successful resolution is timestamped; non-success statuses are excluded',
    registry,
    componentCount: comps.length,
    successfulResolutionCount: sourceTimestamps.length,
    resolvedAtExcludedCount: comps.length - sourceTimestamps.length,
    unresolvedCount: nulls.length,
    index: sorted,
  };
}

export function licenseIndexText(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function parseConcurrency(argv) {
  const index = argv.indexOf('--concurrency');
  if (index === -1) return 24;
  const value = Number.parseInt(argv[index + 1], 10);
  if (!Number.isInteger(value) || value < 1) throw new Error('--concurrency requires a positive integer');
  return value;
}

async function main() {
  const concurrency = parseConcurrency(process.argv.slice(2));
  const { text, parsed } = loadLockfile(LOCK);
  const closures = computeAllClosures(parsed);
  const comps = sortAndDedupeComponents([
    ...closures.union.components,
    ...linkedWorkspaceComponents(ROOT, parsed),
  ]);
  console.error(`Resolving licences for ${comps.length} components (concurrency ${concurrency})…`);
  const doc = await buildLicenseIndex({
    lockfileText: text,
    components: comps,
    concurrency,
    resolveLicense: (name, version) => fetchLicense(name, version),
    onProgress: (done, total) => {
      if (done % 200 === 0) console.error(`  … ${done}/${total}`);
    },
  });
  const nulls = Object.entries(doc.index).filter(([, value]) => !value.license);
  fs.writeFileSync(OUT, licenseIndexText(doc));
  console.error(`Wrote ${OUT} (${comps.length} components, ${nulls.length} without a published licence field).`);
  if (nulls.length) {
    console.error('No-licence-field packages:');
    for (const [id, v] of nulls) console.error(`  ${id} (${v.resolvedFrom})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
