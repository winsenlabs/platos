// SPDX-License-Identifier: Apache-2.0
//
// audit-sbom.mjs — deterministic SBOM generation + drift/licence gate for the
// two Platos shipping images. WIN-250 / M0.5 deliverables #1 and #6.
//
//   node scripts/audit-sbom.mjs generate   # (re)write CycloneDX SBOMs + receipts
//   node scripts/audit-sbom.mjs check       # fail on SBOM drift or a policy breach
//   node scripts/audit-sbom.mjs check --lockfile <path>   # gate a scratch/other tree
//
// DETERMINISM CONTRACT
//   The component set, versions, purls and integrity hashes are a pure function
//   of pnpm-lock.yaml. Licences come from the COMMITTED frozen snapshot
//   docs/audits/sbom/license-index.json (+ a small curated overlay for the
//   handful of registry-ambiguous packages). No network, no clock in `generate`
//   except a fixed epoch timestamp so bytes are reproducible. `check`
//   regenerates in memory and byte-compares component data against the committed
//   SBOMs, then runs the licence policy. Same inputs -> same bytes -> green.
//
// NON-VACUITY
//   `check` fails (exit 1) if any package in a shipping RUNTIME closure carries a
//   copyleft or commercial licence that is not in the dispositioned baseline
//   (docs/audits/sbom/license-policy.json). Proven by injecting an
//   un-dispositioned GPL package into a scratch lockfile — see
//   docs/audits/sbom/NON-VACUITY-PROOF.md.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadLockfile, computeClosure, componentsFromSnapshots, IMAGES,
} from './lib/pnpm-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SBOM_DIR = path.join(ROOT, 'docs/audits/sbom');
const LICENSE_INDEX = path.join(SBOM_DIR, 'license-index.json');
const LICENSE_OVERLAY = path.join(SBOM_DIR, 'license-overlay.json');
const LICENSE_POLICY = path.join(SBOM_DIR, 'license-policy.json');
const RECEIPTS = path.join(SBOM_DIR, 'closure-receipts.json');

const SBOM_FILE = { agent: 'platos-agent.cdx.json', webapp: 'platos-webapp.cdx.json' };

// Fixed timestamp keeps `generate` byte-reproducible. Bump only intentionally.
const FIXED_EPOCH = '2026-08-28T00:00:00.000Z';
const TOOL_VERSION = '1.0.0';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function purl(name, version) {
  // pkg:npm/@scope%2Fname@version — the single scope slash is percent-encoded
  // per the purl spec; npm names have no other reserved characters.
  const encoded = name.includes('/') ? name.replace('/', '%2F') : name;
  return `pkg:npm/${encoded}@${version}`;
}

function loadLicenseResolver(paths = {}) {
  const indexPath = paths.index || LICENSE_INDEX;
  const overlayPath = paths.overlay || LICENSE_OVERLAY;
  const index = fs.existsSync(indexPath) ? readJson(indexPath).index : {};
  const overlay = fs.existsSync(overlayPath) ? readJson(overlayPath).licenses : {};
  return (name, version) => {
    const id = `${name}@${version}`;
    if (overlay[id]) return { license: overlay[id].spdx ?? overlay[id].license, source: 'overlay', note: overlay[id].note };
    const idx = index[id];
    if (idx && idx.license) return { license: idx.license, source: `registry:${idx.resolvedFrom}` };
    if (idx) return { license: null, source: `registry:${idx.resolvedFrom}` };
    return { license: null, source: 'unresolved' };
  };
}

function integrityOf(parsed, name, version) {
  const pkg = parsed.packages[`${name}@${version}`];
  return pkg?.integrity || null;
}

function buildComponent(parsed, resolveLicense, name, version, images) {
  const integrity = integrityOf(parsed, name, version);
  const { license, source, note } = resolveLicense(name, version);
  const comp = {
    type: 'library',
    'bom-ref': purl(name, version),
    name,
    version,
    purl: purl(name, version),
    properties: [
      { name: 'platos:image', value: images.join(',') },
      { name: 'platos:licenseSource', value: source },
    ],
  };
  if (integrity) {
    // pnpm integrity is `sha512-<base64>`; express as a CycloneDX hash.
    const m = integrity.match(/^sha(\d+)-(.+)$/);
    if (m) {
      const alg = { '512': 'SHA-512', '256': 'SHA-256', '1': 'SHA-1' }[m[1]];
      if (alg) comp.hashes = [{ alg, content: Buffer.from(m[2], 'base64').toString('hex') }];
    }
  }
  if (license) {
    comp.licenses = spdxToCycloneDx(license);
  } else {
    comp.licenses = [{ license: { name: 'NOASSERTION' } }];
  }
  if (note) comp.properties.push({ name: 'platos:licenseNote', value: note });
  return comp;
}

function spdxToCycloneDx(expr) {
  // Simple SPDX id -> {license:{id}}; compound/non-SPDX -> {license:{name}} or
  // {expression}. Keep it lossless for the SBOM consumer.
  const KNOWN = new Set([
    'MIT', 'Apache-2.0', 'ISC', 'BSD-3-Clause', 'BSD-2-Clause', 'BlueOak-1.0.0',
    'Unlicense', 'CC0-1.0', '0BSD', 'MIT-0', 'GPL-2.0', 'GPL-2.0-only', 'GPL-3.0',
    'MPL-2.0', 'CC-BY-4.0', 'CC-BY-3.0', 'Python-2.0', 'CC-BY-SA-4.0', 'LGPL-3.0',
    'AGPL-3.0', 'WTFPL',
  ]);
  if (KNOWN.has(expr)) return [{ license: { id: expr } }];
  if (/\b(OR|AND|WITH)\b/.test(expr)) return [{ expression: expr }];
  return [{ license: { name: expr } }];
}

function generateSbomForImage(parsed, resolveLicense, image, imageMembership) {
  const snaps = computeClosure(IMAGES[image].roots, parsed);
  const components = componentsFromSnapshots(snaps).map((c) =>
    buildComponent(parsed, resolveLicense, c.name, c.version, imageMembership(c.name, c.version)));
  const serialNumber = 'urn:uuid:' + deterministicUuid(`platos:${image}`);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber,
    version: 1,
    metadata: {
      timestamp: FIXED_EPOCH,
      tools: [{ vendor: 'Winsen Labs', name: 'platos-audit-sbom', version: TOOL_VERSION }],
      component: {
        type: 'application',
        'bom-ref': `platos:${IMAGES[image].displayName}`,
        name: IMAGES[image].displayName,
        description: `Platos ${image} shipping image — production dependency closure resolved from pnpm-lock.yaml`,
      },
      properties: [
        { name: 'platos:image', value: image },
        { name: 'platos:closureRoots', value: IMAGES[image].roots.join(',') },
        { name: 'platos:componentCount', value: String(components.length) },
        { name: 'platos:derivation', value: 'pnpm-lock.yaml production closure (dependencies+optionalDependencies, devDependencies excluded)' },
      ],
    },
    components,
  };
}

function deterministicUuid(seed) {
  const h = sha256(seed);
  // shape into a v4-looking uuid deterministically (not RFC-random, but stable)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function imageMembershipFactory(parsed) {
  const sets = {};
  for (const image of Object.keys(IMAGES)) {
    const snaps = computeClosure(IMAGES[image].roots, parsed);
    sets[image] = new Set(componentsFromSnapshots(snaps).map((c) => `${c.name}@${c.version}`));
  }
  return (name, version) => Object.keys(IMAGES).filter((img) => sets[img].has(`${name}@${version}`));
}

// ---- licence policy ----

function classifyLicense(expr, policy) {
  if (!expr) return { class: 'unknown', reason: 'no licence field' };
  const s = String(expr);
  for (const rule of policy.forbiddenPatterns) {
    if (new RegExp(rule.pattern, 'i').test(s)) return { class: rule.class, reason: rule.reason, matched: rule.pattern };
  }
  return { class: 'permissive-or-allowed' };
}

function runLicensePolicy(parsed, resolveLicense, policyPath = LICENSE_POLICY) {
  const policy = readJson(policyPath);
  const baseline = new Set(policy.dispositionedBaseline.map((b) => `${b.package}@${b.version}`));
  const violations = [];
  const dispositioned = [];

  for (const image of Object.keys(IMAGES)) {
    const snaps = computeClosure(IMAGES[image].roots, parsed);
    for (const c of componentsFromSnapshots(snaps)) {
      const { license } = resolveLicense(c.name, c.version);
      const verdict = classifyLicense(license, policy);
      if (verdict.class === 'copyleft' || verdict.class === 'commercial') {
        const id = `${c.name}@${c.version}`;
        const rec = { image, package: c.name, version: c.version, license, class: verdict.class, reason: verdict.reason };
        if (baseline.has(id)) dispositioned.push(rec);
        else violations.push(rec);
      }
    }
  }
  return { violations, dispositioned, policy };
}

// ---- commands ----

function cmdGenerate() {
  const { parsed } = loadLockfile(path.join(ROOT, 'pnpm-lock.yaml'));
  const resolveLicense = loadLicenseResolver();
  const membership = imageMembershipFactory(parsed);
  fs.mkdirSync(SBOM_DIR, { recursive: true });

  const receiptImages = {};
  for (const image of Object.keys(IMAGES)) {
    const sbom = generateSbomForImage(parsed, resolveLicense, image, membership);
    const bytes = stableStringify(sbom);
    fs.writeFileSync(path.join(SBOM_DIR, SBOM_FILE[image]), bytes);
    receiptImages[image] = {
      file: `docs/audits/sbom/${SBOM_FILE[image]}`,
      sha256: sha256(bytes),
      componentCount: sbom.components.length,
      distinctNames: new Set(sbom.components.map((c) => c.name)).size,
      roots: IMAGES[image].roots,
    };
  }

  const lockText = fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const receipt = {
    $schema: 'platos.audit.closure-receipts/v1',
    generatedBy: 'scripts/audit-sbom.mjs generate',
    toolVersion: TOOL_VERSION,
    fixedTimestamp: FIXED_EPOCH,
    lockfileSha256: sha256(lockText),
    licenseIndexSha256: fs.existsSync(LICENSE_INDEX) ? sha256(fs.readFileSync(LICENSE_INDEX)) : null,
    licenseOverlaySha256: fs.existsSync(LICENSE_OVERLAY) ? sha256(fs.readFileSync(LICENSE_OVERLAY)) : null,
    licensePolicySha256: fs.existsSync(LICENSE_POLICY) ? sha256(fs.readFileSync(LICENSE_POLICY)) : null,
    images: receiptImages,
  };
  fs.writeFileSync(RECEIPTS, stableStringify(receipt));

  console.log('Generated SBOMs:');
  for (const [img, r] of Object.entries(receiptImages)) {
    console.log(`  ${img}: ${r.componentCount} components / ${r.distinctNames} names  sha256=${r.sha256.slice(0, 16)}…  -> ${r.file}`);
  }
  console.log(`Receipts: docs/audits/sbom/closure-receipts.json  lockfileSha256=${receipt.lockfileSha256.slice(0, 16)}…`);
}

function flag(argv, name) { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : null; }

function cmdCheck(argv) {
  const lockArg = flag(argv, '--lockfile');
  const indexArg = flag(argv, '--index');
  const overlayArg = flag(argv, '--overlay');
  const policyArg = flag(argv, '--policy');
  const lockPath = lockArg ? path.resolve(lockArg) : path.join(ROOT, 'pnpm-lock.yaml');
  const { parsed } = loadLockfile(lockPath);
  const resolveLicense = loadLicenseResolver({
    index: indexArg ? path.resolve(indexArg) : null,
    overlay: overlayArg ? path.resolve(overlayArg) : null,
  });
  const policyPath = policyArg ? path.resolve(policyArg) : LICENSE_POLICY;
  const membership = imageMembershipFactory(parsed);
  let failed = false;

  // 1) SBOM drift (skip when checking an external lockfile — the committed SBOMs
  //    describe the repo's own lockfile only).
  if (!lockArg) {
    for (const image of Object.keys(IMAGES)) {
      const regen = stableStringify(generateSbomForImage(parsed, resolveLicense, image, membership));
      const committedPath = path.join(SBOM_DIR, SBOM_FILE[image]);
      if (!fs.existsSync(committedPath)) {
        console.error(`DRIFT: committed SBOM missing: ${SBOM_FILE[image]} — run \`generate\`.`);
        failed = true; continue;
      }
      const committed = fs.readFileSync(committedPath, 'utf8');
      if (regen !== committed) {
        console.error(`DRIFT: ${SBOM_FILE[image]} does not match the current lockfile closure — run \`generate\` and review the diff.`);
        failed = true;
      } else {
        console.log(`OK: ${SBOM_FILE[image]} matches the lockfile closure (${countComponents(regen)} components).`);
      }
    }
    // receipts hash cross-check
    if (fs.existsSync(RECEIPTS)) {
      const receipt = readJson(RECEIPTS);
      for (const image of Object.keys(IMAGES)) {
        const bytes = fs.readFileSync(path.join(SBOM_DIR, SBOM_FILE[image]));
        const got = sha256(bytes);
        const want = receipt.images?.[image]?.sha256;
        if (want && got !== want) {
          console.error(`DRIFT: receipt sha256 mismatch for ${image} (receipt=${want.slice(0, 12)}…, file=${got.slice(0, 12)}…).`);
          failed = true;
        }
      }
    }
  }

  // 2) Licence policy — non-vacuous gate.
  const { violations, dispositioned, policy } = runLicensePolicy(parsed, resolveLicense, policyPath);
  for (const d of dispositioned) {
    console.log(`DISPOSITIONED: ${d.package}@${d.version} (${d.license}, ${d.class}) in ${d.image} — baseline-waived.`);
  }
  if (violations.length) {
    failed = true;
    console.error(`\nLICENCE POLICY FAILURE — ${violations.length} un-dispositioned ${'copyleft/commercial'} package(s) in a shipping runtime closure:`);
    for (const v of violations) {
      console.error(`  [${v.class}] ${v.package}@${v.version}  (${v.license})  image=${v.image}  — ${v.reason}`);
    }
    console.error('\nResolve by removing the dependency, overriding to a permissive version, or — if genuinely accepted —');
    console.error('adding an explicit, reasoned entry to docs/audits/sbom/license-policy.json dispositionedBaseline.');
  } else {
    console.log(`\nLicence policy: no un-dispositioned copyleft/commercial packages in any shipping closure.`);
  }

  if (failed) { console.error('\naudit:sbom check FAILED'); process.exit(1); }
  console.log('\naudit:sbom check PASSED');
}

function countComponents(sbomText) {
  try { return JSON.parse(sbomText).components.length; } catch { return '?'; }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'generate') cmdGenerate();
else if (cmd === 'check') cmdCheck(rest);
else {
  console.log('usage: node scripts/audit-sbom.mjs <generate|check> [--lockfile <path>]');
  process.exit(cmd ? 1 : 0);
}
