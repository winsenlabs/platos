// SPDX-License-Identifier: Apache-2.0
//
// Point-in-time OSV scan for the exact shipping package sets. The agent set is
// derived from the canonical production lock closure. The webapp set is the
// validated, committed linux/amd64 image inventory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLockfile, computeClosure, componentsFromSnapshots, IMAGES } from './lib/pnpm-closure.mjs';
import {
  WEBAPP_INVENTORY_SCHEMA,
  WEBAPP_TARGET_PLATFORM,
  componentId,
  componentSetsSha256,
  sha256,
  sortAndDedupeComponents,
  validateInventoryDocument,
} from './lib/webapp-inventory-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'pnpm-lock.yaml');
const INVENTORY = path.join(ROOT, 'docs/audits/sbom/platos-webapp.image-inventory.json');
const OUT = path.join(ROOT, 'docs/audits/sbom/advisory/osv-report.json');
const OSV_API = 'https://api.osv.dev';
const RECEIPT_SCHEMA = 'platos.audit.osv-receipt/v2';
const DEFAULT_CACHE_DIR = '/var/tmp/platos-osv-cache';
const DEFAULT_TIMEOUT_MS = 20_000;
const QUERY_BATCH_SIZE = 1000;
const DETAIL_CONCURRENCY = 8;

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

function flag(argv, name, fallback = null) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function buildCurrentInputs({ lockPath = LOCK, inventoryPath = INVENTORY } = {}) {
  const { text, parsed } = loadLockfile(lockPath);
  const inventoryBytes = fs.readFileSync(inventoryPath);
  const inventory = JSON.parse(inventoryBytes);
  const validated = validateInventoryDocument(inventory);
  const componentSets = {
    agent: componentsFromSnapshots(computeClosure(IMAGES.agent.roots, parsed)),
    webapp: validated.components,
  };
  const union = sortAndDedupeComponents([...componentSets.agent, ...componentSets.webapp]);
  return {
    lockfileSha256: sha256(text),
    inventoryBytes,
    inventory,
    componentSets,
    union,
    scanSetSha256: componentSetsSha256(componentSets),
    imageScanSetSha256: Object.fromEntries(
      Object.entries(componentSets).map(([image, components]) => [
        image,
        sha256(JSON.stringify(sortAndDedupeComponents(components))),
      ]),
    ),
  };
}

function imagesFor(component, componentSets) {
  const id = componentId(component);
  return ['agent', 'webapp'].filter((image) => componentSets[image].some((entry) => componentId(entry) === id));
}

function severityOf(vulnerability) {
  const qualitative = vulnerability.database_specific?.severity;
  if (qualitative) return { label: String(qualitative).toUpperCase(), vector: null };
  const severity = vulnerability.severity?.find((entry) => entry.type?.startsWith('CVSS'));
  if (severity?.score && !/\/AV:/u.test(severity.score)) {
    const score = Number.parseFloat(severity.score);
    if (Number.isFinite(score)) {
      if (score >= 9) return { label: 'CRITICAL', vector: severity.score };
      if (score >= 7) return { label: 'HIGH', vector: severity.score };
      if (score >= 4) return { label: 'MODERATE', vector: severity.score };
      if (score > 0) return { label: 'LOW', vector: severity.score };
      return { label: 'NONE', vector: severity.score };
    }
  }
  return { label: 'UNKNOWN', vector: severity?.score ?? null };
}

function semverCmp(left, right) {
  const a = String(left).split('.').map((value) => Number.parseInt(value, 10) || 0);
  const b = String(right).split('.').map((value) => Number.parseInt(value, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) < (b[index] ?? 0)) return -1;
    if ((a[index] ?? 0) > (b[index] ?? 0)) return 1;
  }
  return 0;
}

function inRange(version, events) {
  let affected = false;
  for (const event of events ?? []) {
    if (event.introduced !== undefined) {
      affected = event.introduced === '0' || semverCmp(version, event.introduced) >= 0;
    }
    if (event.fixed !== undefined && semverCmp(version, event.fixed) >= 0) affected = false;
    if (event.last_affected !== undefined && semverCmp(version, event.last_affected) > 0) affected = false;
  }
  return affected;
}

function ecosystemAffects(vulnerability, name, version) {
  return (vulnerability.affected ?? []).some((affected) => {
    if (affected.package?.ecosystem !== 'npm' || affected.package?.name !== name) return false;
    if (affected.versions?.includes(version)) return true;
    return (affected.ranges ?? []).some(
      (range) => ['SEMVER', 'ECOSYSTEM'].includes(range.type) && inRange(version, range.events),
    );
  });
}

async function boundedFetch(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cacheFile(cacheDir, kind, key) {
  return path.join(cacheDir, kind, `${sha256(key)}.json`);
}

function readCache(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCache(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function fetchJsonWithCache({ fetchImpl, url, options, timeoutMs, cachePath, telemetry }) {
  telemetry.publicRequestsAttempted += 1;
  try {
    const response = await boundedFetch(fetchImpl, url, options, timeoutMs);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    telemetry.publicRequestsSucceeded += 1;
    writeCache(cachePath, value);
    return value;
  } catch (error) {
    const cached = readCache(cachePath);
    if (!cached) throw new Error(`${url} failed and no cache entry is available: ${error.message}`);
    telemetry.cacheFallbacks += 1;
    telemetry.limitations.push(`${url}: live request failed (${error.message}); used validated JSON cache`);
    return cached;
  }
}

async function onlineResults(components, options) {
  const queries = components.map(({ name, version }) => ({ package: { name, ecosystem: 'npm' }, version }));
  const results = [];
  for (let index = 0; index < queries.length; index += QUERY_BATCH_SIZE) {
    const chunk = queries.slice(index, index + QUERY_BATCH_SIZE);
    const body = JSON.stringify({ queries: chunk });
    const value = await fetchJsonWithCache({
      ...options,
      url: `${OSV_API}/v1/querybatch`,
      options: { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      cachePath: cacheFile(options.cacheDir, 'querybatch', body),
    });
    if (!Array.isArray(value.results) || value.results.length !== chunk.length) {
      throw new Error(`OSV querybatch returned ${value.results?.length ?? 'invalid'} results for ${chunk.length} queries`);
    }
    results.push(...value.results);
  }
  return results;
}

async function offlineResults(components, osvDir, detailCache) {
  if (!osvDir) throw new Error('--offline requires --osv-dir <path>');
  const vulnerabilities = fs.readdirSync(osvDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => readJson(path.join(osvDir, file)));
  for (const vulnerability of vulnerabilities) detailCache.set(vulnerability.id, vulnerability);
  return components.map((component) => ({
    vulns: vulnerabilities
      .filter((vulnerability) => ecosystemAffects(vulnerability, component.name, component.version))
      .map(({ id }) => ({ id })),
  }));
}

function fixedVersion(vulnerability, packageName) {
  for (const affected of vulnerability.affected ?? []) {
    if (affected.package?.ecosystem !== 'npm' || affected.package?.name !== packageName) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) if (event.fixed) return event.fixed;
    }
  }
  return null;
}

function buildFindings(components, batchResults, details, componentSets) {
  const findings = [];
  batchResults.forEach((result, index) => {
    const component = components[index];
    for (const match of result.vulns ?? []) {
      const detail = details.get(match.id) ?? { id: match.id };
      const severity = severityOf(detail);
      const aliases = detail.aliases ?? [];
      findings.push({
        package: component.name,
        version: component.version,
        id: match.id,
        aliases,
        cves: aliases.filter((alias) => alias.startsWith('CVE-')),
        severity: severity.label,
        cvss: severity.vector,
        summary: detail.summary ?? null,
        fixedIn: fixedVersion(detail, component.name),
        images: imagesFor(component, componentSets),
        withdrawn: detail.withdrawn ?? null,
      });
    }
  });
  const rank = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MODERATE_LOW: 3, LOW: 4, NONE: 5, UNKNOWN: 6 };
  findings.sort((left, right) =>
    (rank[left.severity] ?? 9) - (rank[right.severity] ?? 9) ||
    left.package.localeCompare(right.package) || left.version.localeCompare(right.version) || left.id.localeCompare(right.id));
  return findings;
}

function buildAdjudication(union, findings, componentSets) {
  const active = findings.filter((finding) => !finding.withdrawn);
  return M05_FLAGGED.map((flagged) => {
    const components = union.filter(({ name }) => name === flagged.name);
    const versions = [...new Set(components.map(({ version }) => version))].sort();
    const hits = active.filter((finding) => finding.package === flagged.name);
    return {
      package: flagged.name,
      m05Note: flagged.note,
      versionsInClosure: versions,
      shipsIn: [...new Set(components.flatMap((component) => imagesFor(component, componentSets)))],
      advisories: hits.map((hit) => ({
        id: hit.id,
        cves: hit.cves,
        version: hit.version,
        severity: hit.severity,
        fixedIn: hit.fixedIn,
        images: hit.images,
      })),
      verdict: hits.length ? 'VULNERABLE_VERSION_PRESENT' : (versions.length ? 'PRESENT_NO_ADVISORY' : 'NOT_IN_CLOSURE'),
    };
  });
}

function severityCounts(findings) {
  const counts = {};
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  return counts;
}

export function validateReceipt(receipt, current) {
  const errors = [];
  const equal = (actual, expected, description) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(description);
  };
  equal(receipt.$schema, RECEIPT_SCHEMA, 'receipt schema');
  equal(receipt.lockfileSha256, current.lockfileSha256, 'lockfile SHA-256');
  equal(receipt.webappInventory?.file, 'docs/audits/sbom/platos-webapp.image-inventory.json', 'inventory file');
  equal(receipt.webappInventory?.schema, WEBAPP_INVENTORY_SCHEMA, 'inventory schema');
  equal(receipt.webappInventory?.sha256, sha256(current.inventoryBytes), 'inventory SHA-256');
  equal(receipt.webappInventory?.targetPlatform, WEBAPP_TARGET_PLATFORM, 'inventory target platform');
  equal(receipt.webappInventory?.componentCount, current.componentSets.webapp.length, 'webapp component count');
  equal(receipt.agentComponents, current.componentSets.agent.length, 'agent component count');
  equal(receipt.webappComponents, current.componentSets.webapp.length, 'webapp component count summary');
  equal(receipt.componentsScanned, current.union.length, 'union component count');
  equal(receipt.scanSetSha256, current.scanSetSha256, 'per-image scan-set SHA-256');
  equal(receipt.imageScanSetSha256, current.imageScanSetSha256, 'per-image component SHA-256 values');

  const unionIds = new Set(current.union.map(componentId));
  const findingKeys = new Set();
  for (const finding of [...(receipt.findings ?? []), ...(receipt.withdrawn ?? [])]) {
    const id = componentId({ name: finding.package, version: finding.version });
    if (!unionIds.has(id)) errors.push(`finding outside current scan set: ${id}/${finding.id}`);
    const expectedImages = imagesFor({ name: finding.package, version: finding.version }, current.componentSets);
    if (JSON.stringify(finding.images) !== JSON.stringify(expectedImages)) {
      errors.push(`finding image membership drift: ${id}/${finding.id}`);
    }
    const key = `${id}\0${finding.id}`;
    if (findingKeys.has(key)) errors.push(`duplicate finding: ${id}/${finding.id}`);
    findingKeys.add(key);
  }
  equal(receipt.findingsCount, receipt.findings?.length ?? 0, 'active finding count');
  equal(receipt.withdrawnCount, receipt.withdrawn?.length ?? 0, 'withdrawn finding count');
  equal(receipt.bySeverity, severityCounts(receipt.findings ?? []), 'severity totals');
  equal(receipt.m05Adjudication, buildAdjudication(current.union, [
    ...(receipt.findings ?? []),
    ...(receipt.withdrawn ?? []),
  ], current.componentSets), 'M0.5 adjudication');
  if (errors.length) throw new Error(`OSV receipt drift: ${errors.join('; ')}`);
  return true;
}

export async function refreshReceipt(options = {}) {
  const current = buildCurrentInputs(options);
  const offline = Boolean(options.offline);
  const cacheDir = path.resolve(options.cacheDir ?? DEFAULT_CACHE_DIR);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const telemetry = {
    requestedMode: offline ? 'offline-export' : 'public-osv-with-cache',
    effectiveMode: offline ? 'offline-export' : 'public-osv-live',
    timeoutMs,
    queryBatchSize: QUERY_BATCH_SIZE,
    detailConcurrency: DETAIL_CONCURRENCY,
    publicRequestsAttempted: 0,
    publicRequestsSucceeded: 0,
    cacheFallbacks: 0,
    limitations: [],
  };
  const details = new Map();
  const requestOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs,
    cacheDir,
    telemetry,
  };
  const batchResults = offline
    ? await offlineResults(current.union, options.osvDir, details)
    : await onlineResults(current.union, requestOptions);
  const ids = [...new Set(batchResults.flatMap((result) => (result.vulns ?? []).map(({ id }) => id)))].sort();
  if (!offline) {
    let cursor = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        const detail = await fetchJsonWithCache({
          ...requestOptions,
          url: `${OSV_API}/v1/vulns/${encodeURIComponent(id)}`,
          options: { method: 'GET' },
          cachePath: cacheFile(cacheDir, 'details', id),
        });
        if (detail.id !== id) throw new Error(`OSV detail cache/response ID is ${detail.id}; expected ${id}`);
        details.set(id, detail);
      }
    }
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, Math.max(ids.length, 1)) }, worker));
  }
  if (telemetry.cacheFallbacks > 0) telemetry.effectiveMode = 'public-osv-cache-fallback';

  const allFindings = buildFindings(current.union, batchResults, details, current.componentSets);
  const findings = allFindings.filter((finding) => !finding.withdrawn);
  const withdrawn = allFindings.filter((finding) => finding.withdrawn);
  const receipt = {
    $schema: RECEIPT_SCHEMA,
    tool: 'scripts/audit-advisory.mjs (OSV querybatch + vulnerability details)',
    scannedAt: new Date().toISOString(),
    network: telemetry,
    lockfileSha256: current.lockfileSha256,
    ecosystem: 'npm',
    scope: 'agent production lock closure plus exact verified linux/amd64 webapp image inventory',
    webappInventory: {
      file: 'docs/audits/sbom/platos-webapp.image-inventory.json',
      schema: current.inventory.$schema,
      sha256: sha256(current.inventoryBytes),
      targetPlatform: current.inventory.targetPlatform,
      componentCount: current.componentSets.webapp.length,
      distinctNames: current.inventory.distinctNames,
    },
    scanSetSha256: current.scanSetSha256,
    imageScanSetSha256: current.imageScanSetSha256,
    componentsScanned: current.union.length,
    agentComponents: current.componentSets.agent.length,
    webappComponents: current.componentSets.webapp.length,
    findingsCount: findings.length,
    withdrawnCount: withdrawn.length,
    bySeverity: severityCounts(findings),
    m05Adjudication: buildAdjudication(current.union, allFindings, current.componentSets),
    findings,
    withdrawn,
  };
  validateReceipt(receipt, current);
  return receipt;
}

export async function runCli(argv = process.argv.slice(2)) {
  const outputPath = path.resolve(flag(argv, '--output', OUT));
  const inputOptions = {
    lockPath: path.resolve(flag(argv, '--lockfile', LOCK)),
    inventoryPath: path.resolve(flag(argv, '--inventory', INVENTORY)),
  };
  if (argv.includes('--check')) {
    validateReceipt(readJson(outputPath), buildCurrentInputs(inputOptions));
    console.error(`OK: ${path.relative(ROOT, outputPath)} matches the current lock and exact webapp image inventory.`);
    return;
  }
  const receipt = await refreshReceipt({
    ...inputOptions,
    offline: argv.includes('--offline'),
    osvDir: flag(argv, '--osv-dir'),
    cacheDir: flag(argv, '--cache-dir', DEFAULT_CACHE_DIR),
    timeoutMs: Number.parseInt(flag(argv, '--timeout-ms', String(DEFAULT_TIMEOUT_MS)), 10),
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.error(`Wrote ${outputPath}`);
  console.error(
    `Scanned agent=${receipt.agentComponents}, webapp=${receipt.webappComponents}, union=${receipt.componentsScanned}; ` +
    `findings=${receipt.findingsCount}, network=${receipt.network.effectiveMode}.`,
  );
  for (const limitation of receipt.network.limitations) console.error(`LIMITATION: ${limitation}`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
