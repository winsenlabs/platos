#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const MANIFEST_PATH = "docs/audits/win-254-protected-paths.json";
export const LIFECYCLE_PATH = "docs/audits/win-254-evidence-lifecycle.json";
export const CONTROL_PATHS = Object.freeze([MANIFEST_PATH, LIFECYCLE_PATH]);
// M2 INTEGRATION DELTA — the anchor moves from
// fc19e189460ef7f14ef1670bf4628383ecdd7e9ead09f2093c32f3e98e336bf4 (788 paths,
// v1 @ 2abd19b4, the M2 base this landing was cut from) to the value below
// (792 paths). FOUR branches add protected paths on independent axes and NONE
// removes any, so the integrated set is the UNION of all four contributions —
// 788 + 1 + 0 + 2 + 1 = 792 — not any one branch's set. Each branch pinned its
// own anchor against 788 and every one of those pins is WRONG merged:
//   tejas/safety/m2-finish-2 (secret-projection)  789  80bc12c1…
//   tejas/safety/m2-finish-1 (secret-lifecycle)   788  fc19e189…  (adds none)
//   tejas/safety/m2-finish-3 (errors-idempotency) 790  872dcdfd…
//   tejas/safety/m2-finish-4 (outbox-lifecycle)   789  1945eba0…
// Taking any one of them would silently DROP the other three's protected paths.
//
// The 781 -> 788 step below is the previous integration (WIN-299 + WIN-284)
// that produced the 788-path base; it is kept because the additions it names
// are still in the set.
//
// WIN-299 (M2.6) adds five, no removals and no content substitutions:
//   docs/audits/sbom/advisory/README.md              (disposition contract)
//   docs/audits/sbom/advisory/advisory-policy.json   (the disposition register)
//   scripts/advisory-dispositions.test.mjs           (newly protected by prefix)
//   scripts/lib/advisory-dispositions.mjs            (newly protected by prefix)
//   scripts/verify-advisory-nonvacuity.mjs           (newly protected by prefix)
//
// WIN-284 adds two, no removals:
//   docs/audits/win-284-differential-coverage.json
//   docs/audits/win-284-differential-coverage.md
// Both fall inside the existing `docs/**` selection rather than widening it.
//
// WIN-259 (M2.4) adds ONE, no removals and no content substitutions, taking the
// set from 788 to 789:
//   docs/audits/win-259-secret-response-census.json  (the raw-secret RESPONSE
//                                                     count and its dispositions)
// It falls inside the existing `docs/**` selection rather than widening it. The
// scanner that produces it, scripts/arch/secret-response-census.mjs, is NOT
// added to SCRIPT_PREFIXES: the advisory and licence gates are protected because
// they are security CONTROLS that fail a release, and this one is a census that
// fails a review. Protecting it would say something about it that is not true.
// WIN-260 (M2.5) adds TWO, no removals and no content substitutions:
//   docs/error-taxonomy.json                         (the code->status contract)
//   docs/win-260-mutation-ledger.json                (the mutation sweep)
// Both fall inside the existing `docs/**` selection rather than widening it, so
// 788 + 2 = 790. `scripts/error-taxonomy.mjs` and its suite are deliberately NOT
// added: the selection protects the evidence a gate reads, not the gate, and the
// exact-path list is where a governance script earns protection one decision at
// a time.
// WIN-260 (M2.5) adds one, no removals and no content substitutions:
//   docs/audits/M2.5-transaction-outbox-clock-retry.md   (milestone note)
// It falls inside the existing `docs/**` selection rather than widening it. The
// dimension's other new files are not protected paths: two live under
// packages/, one under apps/core-api, and scripts/arch/ambient-time*.mjs and
// scripts/arch/transaction-outcome*.mjs are already covered by the scripts/
// prefix — 788 -> 789 is the one addition the selection actually gains, and it
// stays 789 across this dimension's SECOND gate for exactly that reason.
// M2 INTEGRATION: 788 + 1 + 0 + 2 + 1 = 792, verified SET-WISE and not only by
// count — the 792 paths at this head are exactly the union of the 788-path base
// with the four additions named above, with nothing in the head that is not in
// the union and nothing in the union that is not in the head. All four fall
// inside the existing `docs/**` selection rather than widening it, and none of
// the scanners beside them is added to SCRIPT_PREFIXES.
//
// WIN-267 W2 adds TWO, no removals and no content substitutions, taking the set
// from 792 to 794:
//   docs/openapi-3.1-meta-schema.json  (the OpenAPI Initiative's published 3.1
//                                       meta-schema, vendored byte-for-byte and
//                                       pinned by digest in
//                                       apps/agent/scripts/openapi-meta-schema.mjs)
//   docs/openapi-v1-baseline.json      (the frozen V1 REST wire contract the
//                                       breaking-change ratchet compares against)
// Both fall inside the existing `docs/**` selection rather than widening it, and
// the difference was verified SET-WISE against the base at 63388a9f: the 794
// paths at this head are exactly the 792-path base plus those two, with nothing
// removed. Neither `scripts/openapi-compat.mjs` nor its two suites is added to
// SCRIPT_PREFIXES: the selection protects the EVIDENCE a gate reads, not the
// gate, and the ratchet's evidence is the baseline above.
//
// WIN-268 (M4.2) adds TWO, no removals and no content substitutions, taking the
// set from 794 to 796:
//   docs/audits/win-268-mcp-store-ownership.json  (the MCP surface's ORM
//                                                  register — every store call
//                                                  site, its owning context, and
//                                                  the per-file disposition
//                                                  naming what it is waiting on)
//   docs/audits/win-268-mcp-store-ownership.md    (the same, rendered)
// Both fall inside the existing `docs/**` selection rather than widening it, and
// the difference was verified SET-WISE against the base at 7e1243fc: the 796
// paths at this head are exactly the 794-path base plus those two, with nothing
// removed and nothing substituted. `scripts/arch/mcp-store-ownership.mjs` is NOT
// added to SCRIPT_PREFIXES, for the reason the openapi ratchet was not: the
// selection protects the EVIDENCE a gate reads, not the gate.
//
// The anchor is re-pinned by hand rather than derived so that a protected path
// LEAVING the set stays a hard failure — a silently shrinking protected set is
// the failure this anchor exists to catch.
export const EXPECTED_PATH_SET_SHA256 = "54454b79d8af5b6a7a66df06b78d9eadb5b191cfb8a35f7d9362e5448f6794db";
const REGULAR_MODES = new Set(["100644", "100755"]);
const EXACT_PATHS = new Set([
  ".github/workflows/ci.yml",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "apps/webapp/public/emails/platos-logo.png",
  "apps/webapp/public/images/platos-icon.svg",
  "apps/webapp/public/images/platos-logotype.png",
]);
const SCRIPT_PREFIXES = [
  // WIN-299 (M2.6). The advisory disposition gate is a security control, so its
  // implementation, its unit tests and its non-vacuity proof are tamper-evident
  // on exactly the same terms as the licence gate's verify-sbom-nonvacuity and
  // the lib/ closure contracts already listed below.
  "scripts/advisory-dispositions",
  "scripts/audit-advisory",
  "scripts/audit-licenses",
  "scripts/audit-sbom",
  "scripts/design-provenance",
  "scripts/docs-link-integrity",
  "scripts/evidence-lifecycle",
  "scripts/protected-paths",
  "scripts/root-entry-manifest",
  "scripts/v1-ledger",
  "scripts/verify-advisory-nonvacuity",
  "scripts/verify-sbom-nonvacuity",
  "scripts/verify-win254",
  "scripts/vocabulary-boundary",
  "scripts/workspace-reachability",
  "scripts/lib/advisory-dispositions",
  "scripts/lib/pnpm-closure",
  "scripts/lib/webapp-inventory-contract",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} contains invalid UTF-8 bytes`);
  }
}

function parseNulRecords(output, label) {
  if (output.length > 0 && output[output.length - 1] !== 0) throw new Error(`${label} is not NUL-terminated`);
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    records.push(output.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function safePath(path) {
  return typeof path === "string" && path.length > 0 && !path.includes("\0") && !path.includes("\n") &&
    !path.includes("\r") && !isAbsolute(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function worktreeMode(stat) {
  if (!stat.isFile()) return stat.isSymbolicLink() ? "120000" : "non-regular";
  return (stat.mode & 0o111) === 0 ? "100644" : "100755";
}

export function listProspectiveEntries(root = repositoryRoot) {
  const pathOutput = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stagedOutput = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stagedModes = new Map();
  for (const record of parseNulRecords(stagedOutput, "Git stage inventory")) {
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error("Git stage inventory record has no pathname separator");
    const metadata = record.subarray(0, tab).toString("ascii").match(/^(\d{6}) [0-9a-f]+ (\d)$/u);
    if (!metadata) throw new Error("Git stage inventory record has malformed metadata");
    const path = decodeUtf8(record.subarray(tab + 1), "Git pathname");
    if (Number(metadata[2]) !== 0) throw new Error(`${JSON.stringify(path)} has an unresolved Git index stage`);
    if (stagedModes.has(path)) throw new Error(`${JSON.stringify(path)} appears more than once in the Git index`);
    stagedModes.set(path, metadata[1]);
  }

  const repositoryReal = realpathSync(root);
  const entries = [];
  const seen = new Set();
  for (const record of parseNulRecords(pathOutput, "Git pathname inventory")) {
    const path = decodeUtf8(record, "Git pathname");
    if (!safePath(path)) throw new Error(`${JSON.stringify(path)} is not a canonical newline-free repository path`);
    if (seen.has(path)) continue;
    seen.add(path);
    const absolute = resolve(root, path);
    const rel = relative(repositoryReal, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} escapes the repository root`);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    const mode = stagedModes.get(path) ?? worktreeMode(stat);
    entries.push({ path, mode, absolute, stat });
  }
  return entries.sort((left, right) => byteCompare(left.path, right.path));
}

export function isProtectedPath(path) {
  return ["ai/", "content/", "design/", "docs/", "examples/", "references/", "rules/"].some((root) => path.startsWith(root)) ||
    EXACT_PATHS.has(path) || SCRIPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}/`));
}

export function protectedEntries(root = repositoryRoot) {
  const errors = [];
  const entries = [];
  for (const item of listProspectiveEntries(root)) {
    if (!isProtectedPath(item.path) || CONTROL_PATHS.includes(item.path)) continue;
    if (!REGULAR_MODES.has(item.mode)) errors.push(`${item.path}: protected Git mode ${item.mode} is not regular`);
    if (item.stat.isSymbolicLink()) errors.push(`${item.path}: protected path is a symbolic link`);
    else if (!item.stat.isFile()) errors.push(`${item.path}: protected path is not a regular file`);
    let resolved;
    try {
      resolved = realpathSync(item.absolute);
    } catch {
      errors.push(`${item.path}: protected path cannot be resolved`);
      continue;
    }
    const rel = relative(realpathSync(root), resolved);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) errors.push(`${item.path}: protected path resolves outside the repository root`);
    if (REGULAR_MODES.has(item.mode) && item.stat.isFile() && !item.stat.isSymbolicLink()) {
      entries.push({ path: item.path, mode: item.mode, sha256: sha256(readFileSync(item.absolute)) });
    }
  }
  return { entries, errors };
}

export function pathSetSha256(entries) {
  return sha256(Buffer.from(entries.map((entry) => entry.path).join("\0") + "\0", "utf8"));
}

export function buildManifest(root = repositoryRoot) {
  const { entries, errors } = protectedEntries(root);
  if (errors.length) throw new Error(errors.join("\n"));
  return {
    $schema: "platos.protected-paths/v1",
    generatedBy: "node scripts/protected-paths.mjs write",
    enumeration: "git ls-files -z --cached --others --exclude-standard plus git ls-files --stage -z; fatal UTF-8 decode; newline-free canonical paths; UTF-8 byte sort",
    selection: "all ai/**, content/**, design/**, docs/**, examples/**, references/**, and rules/** plus exact WIN-254/governance/provenance source inputs; generated WIN-254 control manifests are self-excluded and independently required",
    controlPaths: CONTROL_PATHS,
    pathCount: entries.length,
    pathSetSha256: pathSetSha256(entries),
    entries,
  };
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(expected);
}

export function checkManifest(manifest, root = repositoryRoot, options = {}) {
  const errors = [];
  const topFields = ["$schema", "generatedBy", "enumeration", "selection", "controlPaths", "pathCount", "pathSetSha256", "entries"];
  if (!exactKeys(manifest, topFields)) errors.push(`manifest fields must be exactly ${topFields.join(", ")}`);
  if (!Array.isArray(manifest?.entries)) return [...errors, "entries must be an array"];
  const paths = [];
  for (const [index, entry] of manifest.entries.entries()) {
    if (!exactKeys(entry, ["path", "mode", "sha256"])) errors.push(`entries[${index}] fields must be exactly path, mode, sha256`);
    if (!safePath(entry?.path)) errors.push(`entries[${index}].path is invalid`);
    if (!REGULAR_MODES.has(entry?.mode)) errors.push(`entries[${index}].mode is not a regular Git mode`);
    if (!/^[0-9a-f]{64}$/u.test(entry?.sha256 ?? "")) errors.push(`entries[${index}].sha256 is invalid`);
    paths.push(entry?.path);
  }
  if (new Set(paths).size !== paths.length) errors.push("manifest has duplicate paths");
  if (JSON.stringify(paths) !== JSON.stringify([...paths].sort(byteCompare))) errors.push("manifest paths are not UTF-8 byte sorted");
  if (manifest.pathCount !== manifest.entries.length) errors.push("pathCount does not match entries length");
  if (manifest.pathSetSha256 !== pathSetSha256(manifest.entries)) errors.push("pathSetSha256 does not match manifest paths");
  const expectedDigest = options.expectedPathSetSha256 ?? EXPECTED_PATH_SET_SHA256;
  if (expectedDigest !== "PENDING" && manifest.pathSetSha256 !== expectedDigest) errors.push(`protected path set differs from the committed anchor ${expectedDigest}`);
  let expected;
  try {
    expected = buildManifest(root);
  } catch (error) {
    errors.push(...String(error.message).split("\n"));
    return errors;
  }
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) errors.push("manifest must exactly equal deterministic current-tree output");
  const prospective = new Map(listProspectiveEntries(root).map((entry) => [entry.path, entry]));
  for (const path of CONTROL_PATHS) {
    const entry = prospective.get(path);
    if (!entry) errors.push(`${path}: required control artifact is missing from the prospective Git inventory`);
    else if (!REGULAR_MODES.has(entry.mode) || !entry.stat.isFile() || entry.stat.isSymbolicLink()) errors.push(`${path}: required control artifact is not a regular file`);
  }
  return errors;
}

function main(argv) {
  const [command = "check"] = argv;
  if (command === "write") {
    const manifest = buildManifest(repositoryRoot);
    writeFileSync(join(repositoryRoot, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`protected-paths: wrote ${manifest.pathCount} paths; path-set sha256=${manifest.pathSetSha256}`);
    return;
  }
  if (command !== "check") {
    console.error("usage: node scripts/protected-paths.mjs <write|check>");
    process.exitCode = 1;
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repositoryRoot, MANIFEST_PATH), "utf8"));
  } catch (error) {
    console.error(`protected-paths: cannot read manifest (${error.message})`);
    process.exitCode = 1;
    return;
  }
  const errors = checkManifest(manifest, repositoryRoot);
  if (errors.length) {
    console.error(`protected-paths: ${errors.length} error(s)`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`protected-paths: validated ${manifest.pathCount} paths; path-set sha256=${manifest.pathSetSha256}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
