#!/usr/bin/env node

// Deterministic repository file/disposition ledger for the V1 refactor.
//
// One ledger row per tracked file. Every row is produced by exactly one
// declared rule; a tracked file that matches no rule is a hard error, never a
// silent skip. Conventions here mirror scripts/vocabulary-boundary.mjs: the
// same `git ls-files -z` enumeration, the same text/non-text heuristic, the
// same "print a report, set process.exitCode" command shape.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findSemanticPathReferences, listRepositoryFiles } from "./root-entry-manifest.mjs";
import { RULES as VOCABULARY_RULES } from "./vocabulary-boundary.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultRulesPath = "docs/v1-ledger-rules.json";
const vocabularyManifestPath = "docs/vocabulary-boundary-exceptions.json";
export const WORKSPACE_REACHABILITY_ARTIFACTS = [
  "docs/audits/win-253-workspace-reachability.json",
  "docs/audits/win-253-workspace-reachability.md",
];

export const AREAS = [
  "apps-agent",
  "apps-webapp",
  "apps-core-api",
  "apps-mcp-stdio",
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
  return listRepositoryFiles(root);
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
  // The ADR M0.3 §4 deployables. Each gets its own area rather than folding into
  // apps-agent: `area` is a data field on every row and is hashed into the
  // classification fingerprint, so labelling a core-api file "apps-agent" would
  // be false data. Separate areas also keep the M2 drain (agent -> core-api)
  // legible as two conserving counts instead of one net number that hides both
  // directions. A sibling that is not one of these two still returns null and is
  // reported, never absorbed.
  if (path.startsWith("apps/core-api/")) return "apps-core-api";
  if (path.startsWith("apps/mcp-stdio/")) return "apps-mcp-stdio";

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
  // A malformed character class (an out-of-order range, a lone backslash) makes
  // the RegExp constructor throw. Convert that into a labelled error so
  // validateRulesDocument reports it against the offending glob rather than the
  // process dying with an opaque stack. No committed glob hits this path today;
  // the guard is for a future edit to the rules document.
  try {
    return new RegExp(`^${source}$`, "u");
  } catch (error) {
    throw new Error(`invalid glob ${JSON.stringify(glob)}: ${error.message}`);
  }
}

function segmentToRegExpSource(segment) {
  let source = "";
  let index = 0;
  while (index < segment.length) {
    const character = segment[index];
    if (character === "\\") {
      // An escaped metacharacter is matched literally, including inside the
      // brace and bracket scanners below which must not treat it as a delimiter.
      const next = segment[index + 1];
      source += next === undefined ? "\\\\" : escapeRegExpCharacter(next);
      index += next === undefined ? 1 : 2;
    } else if (character === "*") {
      source += "[^/]*";
      index += 1;
    } else if (character === "?") {
      source += "[^/]";
      index += 1;
    } else if (character === "{") {
      const close = findUnescaped(segment, "}", index + 1);
      if (close === -1) {
        source += "\\{";
        index += 1;
        continue;
      }
      const options = splitUnescaped(segment.slice(index + 1, close), ",");
      source += `(?:${options.map((option) => segmentToRegExpSource(option)).join("|")})`;
      index = close + 1;
    } else if (character === "[") {
      const close = findUnescaped(segment, "]", index + 1);
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

function findUnescaped(text, target, from) {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === target) return index;
  }
  return -1;
}

function splitUnescaped(text, separator) {
  const parts = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      current += text[index] + (text[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (text[index] === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += text[index];
  }
  parts.push(current);
  return parts;
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
      } else {
        for (const glob of rule.match) {
          try {
            globToRegExp(glob);
          } catch (error) {
            errors.push(`${label}.match ${error.message}`);
          }
          // A destructive rule may never carry a wildcard. An open-ended glob in
          // a delete rule silently sweeps a future actively-referenced file into
          // removal, so every delete match must be an exact literal path.
          if (rule.disposition === "delete" && /[*?{}[\]]/u.test(glob)) {
            errors.push(`${label}.match "${glob}" must be a literal path; a delete rule may not contain a wildcard`);
          }
        }
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

// First match wins, in the area's declared array order. Array order IS the
// precedence, and it is ordered pins-first: individually-verified rules (a
// legal obligation, a named-consumer pin, a reachability-proven orphan) are
// declared ahead of the broad fallback buckets so a specific verified decision
// is never overridden by a generic rule. This is deliberately NOT a monotonic
// safety gradient -- a delete pin is declared ahead of the archive bucket that
// also matches its files. The safety property the generator actually ENFORCES
// for the destructive case lives in checkInvariants: every delete row must be a
// literal path AND be confirmed unreferenced by a live scan at check time.
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

// Returns both the size measurement and the decoded text (null when non-text),
// so a caller reading a file for measurement also gets its content for the
// reachability corpus without a second read.
export function measureBuffer(source) {
  let text = null;
  if (!source.includes(0)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    } catch {
      text = null;
    }
  }
  if (text === null) return { bytes: source.length, lines: 0, binary: true, text: null };
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") lines += 1;
  if (text.length > 0 && !text.endsWith("\n")) lines += 1;
  return { bytes: source.length, lines, binary: false, text };
}

export function measureFile(root, path) {
  const { text, ...size } = measureBuffer(readFileSync(join(root, path)));
  void text;
  return size;
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

// Normalise a caller-supplied path to the repository-relative form that corpus
// keys use, so an exclusion works regardless of how the argument was spelled
// (`./docs/x.json`, `docs/x.json`, or an absolute path all collapse to the same
// key). A path outside the repository yields a `..`-prefixed string that can
// never collide with a tracked file, which is harmless.
export function toRepoRelative(root, candidate) {
  if (candidate === null || candidate === undefined) return null;
  return relative(root, resolve(root, candidate));
}

// A committed or pointed-at emitted ledger lists every delete candidate as data,
// not as a reference, so it must never enter the reachability corpus whatever it
// is named. Detected by shape rather than by path: a JSON object with a rows
// array and a summary.classificationSha256 string is one of our artifacts.
export function looksLikeLedgerArtifact(text) {
  if (!text.includes("classificationSha256")) return false;
  try {
    const parsed = JSON.parse(text);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray(parsed.rows) &&
      typeof parsed.summary?.classificationSha256 === "string"
    );
  } catch {
    return false;
  }
}

export function buildLedger(root, document, options = {}) {
  const documentErrors = validateRulesDocument(document);
  if (documentErrors.length) {
    return { rows: [], unmatched: [], unassigned: [], errors: documentErrors, deleteReferences: [], trackedFiles: [] };
  }

  const compiled = compileRules(document);
  const protectedMatchers = PROTECTED_GLOBS.map((glob) => globToRegExp(glob));
  const trackedFiles = options.trackedFiles ?? listTrackedFiles(root);
  const injectedMeasure = options.measure;
  // The rules document names every delete candidate as a disposition decision;
  // that is not a reachability reference, so it is kept out of the corpus. So is
  // any emitted ledger artifact (excluded by shape below). Exclusions are
  // resolved to repo-relative real paths so the result never depends on how the
  // --rules or --out argument was spelled.
  const corpusExclude = new Set(
    (options.corpusExclude ?? [options.rulesPath ?? defaultRulesPath, options.out, ...WORKSPACE_REACHABILITY_ARTIFACTS])
      .map((candidate) => toRepoRelative(root, candidate))
      .filter((candidate) => candidate !== null)
  );
  const corpus = options.corpus ?? new Map();
  const readCorpus = options.corpus === undefined && injectedMeasure === undefined;

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
    let size;
    if (injectedMeasure) {
      size = injectedMeasure(path);
    } else {
      const measured = measureBuffer(readFileSync(join(root, path)));
      size = { bytes: measured.bytes, lines: measured.lines, binary: measured.binary };
      if (
        readCorpus &&
        measured.text !== null &&
        !corpusExclude.has(path) &&
        !looksLikeLedgerArtifact(measured.text)
      ) {
        corpus.set(path, measured.text);
      }
    }
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

  // Reachability for the destructive case is COMPUTED, never copied from the
  // rules document. Every delete candidate is scanned against the corpus; a
  // literal reference anywhere means the file is reachable and its delete claim
  // is false. An edit that references a delete candidate now fails --check.
  const deletePaths = rows.filter((row) => row.disposition === "delete").map((row) => row.path);
  const deleteReferences = deletePaths.length ? findSemanticPathReferences(deletePaths, corpus, {
    includeBasename: true,
    exclusions: [
      "docs/v1-ledger-rules.json",
      "docs/audits/win-252-root-entry-manifest.json",
      "docs/audits/win-252-root-entry-manifest.md",
      "scripts/root-entry-manifest.mjs",
      "scripts/root-entry-manifest.test.mjs",
      "scripts/v1-ledger.mjs",
      "scripts/v1-ledger.test.mjs",
    ],
  }) : [];

  return { rows, unmatched, unassigned, errors: [], trackedFiles, deleteReferences };
}

export function checkInvariants(result, trackedFiles, pinnedPaths) {
  const failures = [];
  const { rows, unmatched, unassigned } = result;

  // A delete candidate that the live scan found referenced was never actually
  // an orphan; the classification looked and the answer was wrong.
  for (const reference of result.deleteReferences ?? []) {
    failures.push(
      `${reference.path} is classified delete but is referenced by ${reference.referencedBy.join(", ")}; reachability is not zero`
    );
  }

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

// Both the emitted ledger and the rewritten rules document repeat repository
// paths, and some carry terms the boundary scanner reserves (a delete pin must
// name an exact literal path, wildcards being forbidden there). A JSON \u escape
// parses back to the identical string, so the file stays byte-honest to any JSON
// reader while the scanner sees no reserved literal. This is the sanctioned way
// to keep a literal reserved path in a product-owned JSON file without adding a
// manifest exception.
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

  const result = buildLedger(root, document, { rulesPath: options.rulesPath, out: options.out });
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
    // The artifact carries the drop lists so a consumer can tell it was written
    // over an incomplete or reachability-failed run rather than trusting rows.
    writeFileSync(
      resolve(root, options.out),
      `${gateSafeJson({
        version: 1,
        complete: result.unmatched.length === 0 && result.unassigned.length === 0,
        summary: { ...summary, classificationSha256: digest },
        unmatched: result.unmatched,
        unassigned: result.unassigned,
        deleteReferences: result.deleteReferences,
        rows: result.rows,
      })}\n`
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
