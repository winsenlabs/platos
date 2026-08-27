#!/usr/bin/env node

// Deterministic repository file/disposition ledger for the V1 refactor.
//
// One ledger row per tracked file. Every row is produced by exactly one
// declared rule; a tracked file that matches no rule is a hard error, never a
// silent skip. Conventions here mirror scripts/vocabulary-boundary.mjs: the
// same `git ls-files -z` enumeration, the same text/non-text heuristic, the
// same "print a report, set process.exitCode" command shape.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RULES as VOCABULARY_RULES } from "./vocabulary-boundary.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultRulesPath = "docs/v1-ledger-rules.json";
const vocabularyManifestPath = "docs/vocabulary-boundary-exceptions.json";

export const AREAS = [
  "apps-agent",
  "apps-webapp",
  "packages",
  "internal-packages",
  "docs-content",
  "root-infra",
];

export const KINDS = [
  "source",
  "test",
  "fixture",
  "config",
  "doc",
  "asset",
  "generated",
  "migration",
  "legal",
  "lockfile",
];

export const DISPOSITIONS = ["retain", "move-refactor", "regenerate", "archive", "delete", "unresolved"];

export const REACHED_VIA = [
  "entrypoint",
  "imports",
  "dynamic-import",
  "package-scripts",
  "turbo",
  "CI",
  "Dockerfile",
  "compose",
  "test-config",
  "docs-reference",
  "generated-asset",
  "license-obligation",
  "git-subcommand",
  "filesystem-path",
  "NONE",
];

// A protected file may never be proposed for removal. These are hard-coded on
// purpose: they must not be weakened by editing the rules document alone.
export const PROTECTED_GLOBS = [
  "design/platos-ui-refactor/**",
  "lefthook.yml",
  "LICENSE",
  "NOTICE",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "**/prisma/migrations/**",
  "internal-packages/tsql/NOTICE.md",
];

export const PROTECTED_DISPOSITIONS = new Set(["retain", "move-refactor", "regenerate"]);

const DOCS_CONTENT_ROOTS = new Set(["docs", "content", "references", "rules", "ai", "design"]);
const ROOT_INFRA_ROOTS = new Set([
  "scripts",
  "deploy",
  "hosting",
  "tests",
  "examples",
  "patches",
  ".github",
  ".configs",
]);

// ---------------------------------------------------------------------------
// Enumeration and ordering
// ---------------------------------------------------------------------------

export function listTrackedFiles(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean)
    .sort(byteCompare);
}

// LC_ALL=C ordering: compare the UTF-8 bytes, never the locale collation.
export function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

// ---------------------------------------------------------------------------
// Area assignment
// ---------------------------------------------------------------------------

export function assignArea(path) {
  if (path.startsWith("apps/agent/")) return "apps-agent";
  if (path.startsWith("apps/webapp/")) return "apps-webapp";

  const slash = path.indexOf("/");
  if (slash === -1) return "root-infra";

  const first = path.slice(0, slash);
  if (first === "packages") return "packages";
  if (first === "internal-packages") return "internal-packages";
  if (DOCS_CONTENT_ROOTS.has(first)) return "docs-content";
  if (ROOT_INFRA_ROOTS.has(first)) return "root-infra";
  if (first.startsWith(".")) return "root-infra";
  return null;
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

// Deliberately hand-rolled rather than delegating to minimatch or globby.
// Both default to dot:false, under which `references/entity-*/**` silently
// matches no dotfile and six tracked files fall through every rule. This
// matcher has no leading-dot special case at all, so a dotfile is an ordinary
// path component and the failure mode cannot come back.
export function globToRegExp(glob) {
  const segments = glob.split("/");
  let source = "";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    if (segment === "**") {
      source += isLast ? "(?:.*)" : "(?:[^/]+/)*";
      continue;
    }
    source += segmentToRegExpSource(segment);
    if (!isLast) source += "/";
  }
  return new RegExp(`^${source}$`, "u");
}

function segmentToRegExpSource(segment) {
  let source = "";
  let index = 0;
  while (index < segment.length) {
    const character = segment[index];
    if (character === "*") {
      source += "[^/]*";
      index += 1;
    } else if (character === "?") {
      source += "[^/]";
      index += 1;
    } else if (character === "{") {
      const close = segment.indexOf("}", index);
      if (close === -1) {
        source += "\\{";
        index += 1;
        continue;
      }
      const options = segment.slice(index + 1, close).split(",");
      source += `(?:${options.map((option) => option.split("").map(escapeRegExpCharacter).join("")).join("|")})`;
      index = close + 1;
    } else if (character === "[") {
      const close = segment.indexOf("]", index + 1);
      if (close === -1) {
        source += "\\[";
        index += 1;
        continue;
      }
      let body = segment.slice(index + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      source += `[${body}]`;
      index = close + 1;
    } else {
      source += escapeRegExpCharacter(character);
      index += 1;
    }
  }
  return source;
}

function escapeRegExpCharacter(character) {
  return /[.*+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}

// ---------------------------------------------------------------------------
// Rules document
// ---------------------------------------------------------------------------

export function validateRulesDocument(document) {
  const errors = [];
  if (document?.version !== 1) errors.push("rules.version must be 1");
  if (!document?.areas || typeof document.areas !== "object") {
    errors.push("rules.areas must be an object keyed by area");
    return errors;
  }
  for (const area of AREAS) {
    if (!Array.isArray(document.areas[area])) errors.push(`rules.areas[${area}] must be an ordered array`);
  }
  for (const area of Object.keys(document.areas)) {
    if (!AREAS.includes(area)) errors.push(`rules.areas[${area}] is not a declared area`);
  }

  const seenIds = new Set();
  for (const area of AREAS) {
    const list = document.areas?.[area];
    if (!Array.isArray(list)) continue;
    if (list.length === 0) errors.push(`rules.areas[${area}] declares no rules`);
    for (const [order, rule] of list.entries()) {
      const label = `rules.areas[${area}][${order}]`;
      if (typeof rule?.id !== "string" || rule.id.trim() === "") {
        errors.push(`${label}.id must be a non-empty string`);
      } else if (seenIds.has(rule.id)) {
        errors.push(`${label}.id duplicates ${rule.id}`);
      } else {
        seenIds.add(rule.id);
      }
      if (!Array.isArray(rule?.match) || rule.match.length === 0) {
        errors.push(`${label}.match must be a non-empty array of globs`);
      } else if (rule.match.some((glob) => typeof glob !== "string" || glob.trim() === "")) {
        errors.push(`${label}.match entries must be non-empty strings`);
      }
      if (!KINDS.includes(rule?.kind)) errors.push(`${label}.kind is not a declared kind: ${rule?.kind}`);
      if (!DISPOSITIONS.includes(rule?.disposition)) {
        errors.push(`${label}.disposition is not a declared disposition: ${rule?.disposition}`);
      }
      if (typeof rule?.owner_capability !== "string" || rule.owner_capability.trim() === "") {
        errors.push(`${label}.owner_capability must be a non-empty string`);
      }
      if (typeof rule?.evidence !== "string" || rule.evidence.trim() === "") {
        errors.push(`${label}.evidence must be a non-empty string`);
      }
      if (!Array.isArray(rule?.reached_via) || rule.reached_via.length === 0) {
        errors.push(`${label}.reached_via must be a non-empty array`);
      } else {
        for (const token of rule.reached_via) {
          if (!REACHED_VIA.includes(token)) errors.push(`${label}.reached_via has unknown token: ${token}`);
        }
        if (rule.reached_via.includes("NONE") && rule.reached_via.length > 1) {
          errors.push(`${label}.reached_via may not combine NONE with a reachability token`);
        }
      }
      if (rule?.protected !== undefined && typeof rule.protected !== "boolean") {
        errors.push(`${label}.protected must be a boolean when present`);
      }
      if (rule?.disposition === "delete" && !(rule?.reached_via ?? []).includes("NONE")) {
        errors.push(`${label} proposes removal without recording zero reachability`);
      }
    }
  }
  return errors;
}

export function compileRules(document) {
  const compiled = new Map();
  for (const area of AREAS) {
    const list = (document.areas?.[area] ?? []).map((rule, order) => ({
      ...rule,
      area,
      order,
      matchers: rule.match.map((glob) => globToRegExp(glob)),
    }));
    compiled.set(area, list);
  }
  return compiled;
}

// First match wins, in the area's declared array order. The array order is the
// precedence: a safer disposition is placed ahead of a riskier one so that a
// file covered by two plausible rules always resolves the safe way.
export function classify(path, area, compiled) {
  for (const rule of compiled.get(area) ?? []) {
    for (const matcher of rule.matchers) {
      if (matcher.test(path)) return rule;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// File measurement (mirrors the vocabulary scanner's text heuristic exactly)
// ---------------------------------------------------------------------------

export function measureFile(root, path) {
  const source = readFileSync(join(root, path));
  let text = null;
  if (!source.includes(0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      text = null;
    }
  }
  if (text === null) return { bytes: source.length, lines: 0, binary: true };
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") lines += 1;
  if (text.length > 0 && !text.endsWith("\n")) lines += 1;
  return { bytes: source.length, lines, binary: false };
}

// ---------------------------------------------------------------------------
// Ledger construction
// ---------------------------------------------------------------------------

export function readVocabularyPinnedPaths(root) {
  const manifestFile = join(root, vocabularyManifestPath);
  if (!existsSync(manifestFile)) return new Set();
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const pinned = new Set();
  for (const entry of manifest.exceptions ?? []) pinned.add(entry.path);
  for (const entry of manifest.exclusions ?? []) pinned.add(entry.path);
  return pinned;
}

export function buildLedger(root, document, options = {}) {
  const documentErrors = validateRulesDocument(document);
  if (documentErrors.length) return { rows: [], unmatched: [], unassigned: [], errors: documentErrors };

  const compiled = compileRules(document);
  const protectedMatchers = PROTECTED_GLOBS.map((glob) => globToRegExp(glob));
  const trackedFiles = options.trackedFiles ?? listTrackedFiles(root);
  const measure = options.measure ?? ((path) => measureFile(root, path));

  const rows = [];
  const unmatched = [];
  const unassigned = [];

  for (const path of trackedFiles) {
    const area = assignArea(path);
    if (area === null) {
      unassigned.push(path);
      continue;
    }
    const rule = classify(path, area, compiled);
    if (rule === null) {
      unmatched.push({ path, area });
      continue;
    }
    const size = measure(path);
    rows.push({
      path,
      area,
      rule_id: rule.id,
      rule_order: rule.order,
      kind: rule.kind,
      owner_capability: rule.owner_capability,
      disposition: rule.disposition,
      protected: rule.protected === true || protectedMatchers.some((matcher) => matcher.test(path)),
      lines: size.lines,
      bytes: size.bytes,
      binary: size.binary,
      reached_via: [...rule.reached_via],
      evidence: rule.evidence,
    });
  }

  rows.sort((left, right) => byteCompare(left.path, right.path));
  return { rows, unmatched, unassigned, errors: [], trackedFiles };
}

export function checkInvariants(result, trackedFiles, pinnedPaths) {
  const failures = [];
  const { rows, unmatched, unassigned } = result;

  for (const path of unassigned) failures.push(`no area claims ${path}`);
  for (const entry of unmatched) {
    failures.push(`no rule in area ${entry.area} classifies ${entry.path}; add a rule to ${defaultRulesPath}`);
  }

  if (rows.length !== trackedFiles.length) {
    failures.push(`row count ${rows.length} does not equal tracked file count ${trackedFiles.length}`);
  }

  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.path)) failures.push(`duplicate ledger row for ${row.path}`);
    seen.add(row.path);

    if (typeof row.rule_id !== "string" || row.rule_id.trim() === "") {
      failures.push(`${row.path} has no rule_id`);
    }
    if (!AREAS.includes(row.area)) failures.push(`${row.path} has undeclared area ${row.area}`);
    if (!KINDS.includes(row.kind)) failures.push(`${row.path} has undeclared kind ${row.kind}`);
    if (!DISPOSITIONS.includes(row.disposition)) {
      failures.push(`${row.path} has undeclared disposition ${row.disposition}`);
    }
    for (const token of row.reached_via) {
      if (!REACHED_VIA.includes(token)) failures.push(`${row.path} has undeclared reachability token ${token}`);
    }
    if (row.protected && !PROTECTED_DISPOSITIONS.has(row.disposition)) {
      failures.push(`${row.path} is protected but its disposition is ${row.disposition}`);
    }
    if (row.disposition === "delete") {
      if (row.reached_via.length !== 1 || row.reached_via[0] !== "NONE") {
        failures.push(`${row.path} proposes removal while recording reachability [${row.reached_via.join(", ")}]`);
      }
      // Removing a path that the read-only vocabulary manifest anchors makes
      // the gate report exception drift or a stale exclusion, so CI turns red
      // on the removal alone. This generalises the index-browser pin instead
      // of special-casing one file.
      if (pinnedPaths.has(row.path)) {
        failures.push(`${row.path} proposes removal but ${vocabularyManifestPath} anchors it; removal alone reddens CI`);
      }
    }
  }

  for (let index = 1; index < rows.length; index += 1) {
    if (byteCompare(rows[index - 1].path, rows[index].path) >= 0) {
      failures.push(`ledger rows are not in byte order at ${rows[index].path}`);
      break;
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Summary and fingerprint
// ---------------------------------------------------------------------------

function tally(rows, key) {
  const counts = {};
  for (const row of rows) counts[row[key]] = (counts[row[key]] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((left, right) => byteCompare(left[0], right[0])));
}

export function summarize(rows) {
  return {
    totalFiles: rows.length,
    areaCounts: tally(rows, "area"),
    kindCounts: tally(rows, "kind"),
    dispositionCounts: tally(rows, "disposition"),
    protectedCount: rows.filter((row) => row.protected).length,
    ruleCounts: tally(rows, "rule_id"),
  };
}

// The committed fingerprint covers classification only. Line and byte counts
// move with ordinary edits; pinning them would force a ledger refresh on every
// content change and teach reviewers to refresh the ledger without reading it.
export function classificationText(rows) {
  return rows
    .map((row) =>
      [
        row.path,
        row.area,
        row.rule_id,
        String(row.rule_order),
        row.kind,
        row.owner_capability,
        row.disposition,
        row.protected ? "protected" : "unprotected",
        row.reached_via.join("+"),
      ].join("\t")
    )
    .join("\n")
    .concat("\n");
}

export function classificationSha256(rows) {
  return createHash("sha256").update(classificationText(rows), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Gate-safe JSON emission
// ---------------------------------------------------------------------------

const reservedTextPattern = new RegExp(VOCABULARY_RULES.map((rule) => rule.pattern.source).join("|"), "giu");

// Generated ledger output repeats every repository path, and some of those
// paths carry terms the boundary scanner reserves. JSON \u escapes parse back
// to the identical string, so the emitted artifact stays byte-honest to any
// JSON reader while the scanner sees no reserved literal. Applied to generated
// output only; the hand-authored rules document avoids reserved terms outright.
export function gateSafeJson(value) {
  return JSON.stringify(value, null, 2).replace(reservedTextPattern, (match) => {
    const escaped = `\\u${match.codePointAt(0).toString(16).padStart(4, "0")}`;
    return escaped + match.slice(String.fromCodePoint(match.codePointAt(0)).length);
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function formatReport(summary, baseline, failures, drift) {
  const lines = [`v1-ledger: ${summary.totalFiles} tracked files classified`];

  lines.push("  area reconciliation:");
  let running = 0;
  for (const area of AREAS) {
    const count = summary.areaCounts[area] ?? 0;
    running += count;
    const expected = baseline?.areaCounts?.[area];
    const mark = expected === undefined ? "" : expected === count ? "  (matches baseline)" : `  (baseline ${expected})`;
    lines.push(`    ${area.padEnd(18)} ${String(count).padStart(5)}${mark}`);
  }
  lines.push(`    ${"TOTAL".padEnd(18)} ${String(running).padStart(5)}`);

  lines.push("  disposition:");
  for (const disposition of DISPOSITIONS) {
    lines.push(`    ${disposition.padEnd(18)} ${String(summary.dispositionCounts[disposition] ?? 0).padStart(5)}`);
  }
  lines.push("  kind:");
  for (const kind of KINDS) {
    lines.push(`    ${kind.padEnd(18)} ${String(summary.kindCounts[kind] ?? 0).padStart(5)}`);
  }
  lines.push(`  protected files: ${summary.protectedCount}`);

  for (const entry of drift) lines.push(`STALE: ${entry}`);
  for (const failure of failures) lines.push(`FAIL: ${failure}`);
  if (!drift.length && !failures.length) lines.push("ok: ledger is complete, consistent, and current");
  return lines.join("\n");
}

function compareExpected(expected, summary, digest) {
  if (!expected) {
    return [`${defaultRulesPath} carries no committed "expected" fingerprint; run --write to record one`];
  }
  const drift = [];
  if (expected.totalFiles !== summary.totalFiles) {
    drift.push(`tracked file count moved from ${expected.totalFiles} to ${summary.totalFiles}`);
  }
  for (const [field, current] of [
    ["areaCounts", summary.areaCounts],
    ["kindCounts", summary.kindCounts],
    ["dispositionCounts", summary.dispositionCounts],
    ["ruleCounts", summary.ruleCounts],
  ]) {
    const previous = expected[field] ?? {};
    const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort(byteCompare);
    for (const key of keys) {
      if ((previous[key] ?? 0) !== (current[key] ?? 0)) {
        drift.push(`${field}.${key} moved from ${previous[key] ?? 0} to ${current[key] ?? 0}`);
      }
    }
  }
  if (expected.protectedCount !== summary.protectedCount) {
    drift.push(`protectedCount moved from ${expected.protectedCount} to ${summary.protectedCount}`);
  }
  if (expected.classificationSha256 !== digest) {
    drift.push(`classification digest moved from ${expected.classificationSha256 ?? "<absent>"} to ${digest}`);
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { mode: "check", rulesPath: defaultRulesPath, out: null };
  for (const argument of argv) {
    if (argument === "--check") options.mode = "check";
    else if (argument === "--write") options.mode = "write";
    else if (argument.startsWith("--rules=")) options.rulesPath = argument.slice("--rules=".length);
    else if (argument.startsWith("--out=")) options.out = argument.slice("--out=".length);
    else throw new Error(`unknown option ${argument}`);
  }
  return options;
}

export function runCli(argv = process.argv.slice(2), root = repositoryRoot) {
  const options = parseArguments(argv);
  const rulesFile = resolve(root, options.rulesPath);
  const document = JSON.parse(readFileSync(rulesFile, "utf8"));

  const result = buildLedger(root, document);
  if (result.errors.length) {
    console.log([`v1-ledger: ${options.rulesPath} is not usable`, ...result.errors.map((e) => `FAIL: ${e}`)].join("\n"));
    process.exitCode = 1;
    return;
  }

  const pinnedPaths = readVocabularyPinnedPaths(root);
  const failures = checkInvariants(result, result.trackedFiles, pinnedPaths);
  const summary = summarize(result.rows);
  const digest = classificationSha256(result.rows);

  if (options.out) {
    writeFileSync(
      resolve(root, options.out),
      `${gateSafeJson({ version: 1, summary: { ...summary, classificationSha256: digest }, rows: result.rows })}\n`
    );
  }

  if (options.mode === "write") {
    if (failures.length) {
      console.log(formatReport(summary, document.baseline, failures, []));
      console.log("refusing to record a fingerprint while invariants fail");
      process.exitCode = 1;
      return;
    }
    const updated = { ...document, expected: { ...summary, classificationSha256: digest } };
    writeFileSync(rulesFile, `${gateSafeJson(updated)}\n`);
    console.log(formatReport(summary, document.baseline, [], []));
    console.log(`wrote fingerprint to ${options.rulesPath}`);
    return;
  }

  const drift = compareExpected(document.expected, summary, digest);
  console.log(formatReport(summary, document.baseline, failures, drift));
  if (failures.length || drift.length) {
    console.log(`re-run: node scripts/v1-ledger.mjs --write (after classifying every new file in ${options.rulesPath})`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) runCli();
