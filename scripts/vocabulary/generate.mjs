/**
 * Deterministic manifest regeneration.
 *
 * `--check` is read-only and is what CI runs: it classifies the regeneration
 * diff and fails if the manifest is out of date or if anything needs a human.
 * `--write` applies only the dispositions that cannot weaken the gate.
 *
 * Determinism comes from three places: the scan order is fixed by
 * `git ls-files` sorted; the writer preserves the position, key order and
 * bytes of every entry it does not deliberately change; and every derived
 * ordering compares UTF-8 bytes rather than UTF-16 code units.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { collectFindings, listRepositoryFiles, RULES } from "../vocabulary-boundary.mjs";
import { classifyRegeneration, reviewRequiredEntries } from "./classify.mjs";
import { compareUtf8, normalizeRepositoryPath } from "./identity.mjs";
import { patchEntry, readManifest, serializeManifest } from "./manifest-io.mjs";
import { detectFileMoves } from "./moves.mjs";
import { buildReceipt } from "./receipt.mjs";

/**
 * Run a full regeneration pass without writing anything.
 * @returns everything a caller needs to report, verify, or persist.
 */
export function regenerate(root, { manifestPath, manifestLabel, revision = "HEAD" } = {}) {
  const manifest = readManifest(manifestPath);
  const exceptions = manifest.exceptions ?? [];
  const exclusions = manifest.exclusions ?? [];

  const trackedFiles = listTracked(root);
  const trackedSet = new Set(trackedFiles);

  const declaredPaths = new Set([
    ...exceptions.map((entry) => normalizeRepositoryPath(entry.path)),
    ...exclusions.map((entry) => normalizeRepositoryPath(entry.path)),
  ]);
  const disappeared = [...declaredPaths].filter((path) => !trackedSet.has(path)).sort(compareUtf8);
  const appeared = trackedFiles.filter((path) => !declaredPaths.has(path));

  const moveResult = detectFileMoves(root, { revision, disappeared, appeared });
  const moves = moveResult.moves;
  const moveTo = new Map(moves.map((move) => [move.from, move]));

  // An excluded file that moved keeps its exclusion, otherwise the scan would
  // suddenly read a generated artifact it was never meant to read.
  const effectiveExclusions = new Set();
  for (const exclusion of exclusions) {
    const path = normalizeRepositoryPath(exclusion.path);
    const move = trackedSet.has(path) ? null : moveTo.get(path);
    effectiveExclusions.add(move ? move.to : path);
  }

  const scan = collectFindings(root, effectiveExclusions, trackedFiles);
  const classification = classifyRegeneration({ exceptions, findings: scan.findings, moves });
  const reviewRequired = reviewRequiredEntries(classification.entries);

  const nextManifest = applyClassification({ manifest, classification, moves, trackedSet });
  const manifestText = serializeManifest(nextManifest);
  const receipt = buildReceipt({
    rules: RULES,
    scan,
    manifestText,
    counts: {
      exceptionsBefore: exceptions.length,
      exceptionsAfter: nextManifest.exceptions.length,
      ...classification.counts,
    },
    moves,
    mode: "regenerate",
    // Repository-relative on purpose: an absolute path would make the receipt
    // machine-specific and therefore not reproducible by a reviewer.
    manifestPath: manifestLabel ?? manifestPath,
  });

  return {
    manifest,
    nextManifest,
    manifestText,
    scan,
    classification,
    reviewRequired,
    moves,
    moveDetectionAvailable: moveResult.available,
    receipt,
    trackedSet,
  };
}

/** Reuse the gate's own discovery so the two can never disagree about scope. */
function listTracked(root) {
  return listRepositoryFiles(root).filter((path) => existsSync(join(root, path)));
}

/**
 * Build the next manifest, preserving untouched entries byte for byte.
 * Only dispositions that cannot weaken the gate are applied here; a caller in
 * write mode must independently refuse when `reviewRequired` is non-empty.
 */
export function applyClassification({ manifest, classification, moves, trackedSet }) {
  const patchByIndex = new Map();
  const dropped = new Set();
  for (const entry of classification.entries) {
    if (entry.disposition === "moved" || entry.disposition === "path-rebound") {
      patchByIndex.set(entry.index, entry.patch);
    } else if (entry.disposition === "removed") {
      dropped.add(entry.index);
    }
  }

  const exceptions = [];
  for (const [index, exception] of (manifest.exceptions ?? []).entries()) {
    if (dropped.has(index)) continue;
    const patch = patchByIndex.get(index);
    exceptions.push(patch ? patchEntry(exception, patch) : exception);
  }

  const moveTo = new Map(moves.map((move) => [move.from, move]));
  const exclusions = [];
  for (const exclusion of manifest.exclusions ?? []) {
    const path = normalizeRepositoryPath(exclusion.path);
    if (trackedSet.has(path)) {
      exclusions.push(exclusion);
      continue;
    }
    const move = moveTo.get(path);
    if (move) exclusions.push(patchEntry(exclusion, { path: move.to }));
    // An excluded path that vanished with no corroborating move is stale and
    // is dropped; dropping an exclusion only ever widens what gets scanned.
  }

  return { ...manifest, exclusions, exceptions };
}

/** Human-readable classification report. */
export function formatClassification(result, manifestPath) {
  const { classification, moves, moveDetectionAvailable } = result;
  const lines = [];
  const counts = classification.counts;
  lines.push(
    `regeneration: ${counts.unchanged} unchanged, ${counts.moved} moved, ${counts["path-rebound"]} path-rebound, ` +
      `${counts.removed} removed, ${counts["context-changed"]} changed-context, ${counts.added} added`
  );
  if (!moveDetectionAvailable) {
    lines.push("  note: no usable git revision for move detection; moves cannot be corroborated");
  }
  for (const move of moves) {
    lines.push(`  move ${move.identical ? "(pure)   " : "(changed)"} ${move.from} -> ${move.to} [${move.source}]`);
  }
  for (const entry of classification.entries) {
    if (entry.disposition === "added") {
      const finding = entry.finding;
      lines.push(
        `  ADDED ${finding.path}:${finding.line}:${finding.column} [${finding.rule}] "${finding.matchedText}"`,
        "    This occurrence has no reviewed exception. Review it and add one by hand; --write will not create it."
      );
    } else if (entry.disposition === "context-changed") {
      const exception = entry.exception;
      lines.push(
        `  CHANGED-CONTEXT ${exception.path} [${exception.rule}] "${exception.matchedText}"`,
        "    The reviewed surroundings changed, so the existing review no longer covers it. Re-review by hand."
      );
    }
  }
  if (counts.moved || counts["path-rebound"] || counts.removed) {
    lines.push(`  run \`node scripts/vocabulary-boundary.mjs --write\` to apply these to ${manifestPath}`);
  }
  return lines.join("\n");
}
