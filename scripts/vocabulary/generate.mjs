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

import { collectFindings, listRepositoryFiles, RULES, scanRepository } from "../vocabulary-boundary.mjs";
import { classifyExclusions, classifyRegeneration, isReviewRequired } from "./classify.mjs";
import { compareUtf8, normalizeRepositoryPath } from "./identity.mjs";
import { patchEntry, readManifest, serializeManifest } from "./manifest-io.mjs";
import { detectFileMoves } from "./moves.mjs";
import { buildReceipt } from "./receipt.mjs";

/** Reuse the gate's own discovery so the two can never disagree about scope. */
function listTracked(root) {
  return listRepositoryFiles(root).filter((path) => existsSync(join(root, path)));
}

/**
 * Run a full regeneration pass without writing anything.
 *
 * @param scan optional precomputed `collectFindings` result. The CLI passes the
 *   scan the gate already performed so a check costs one tree walk, not two.
 * @returns everything a caller needs to report, verify, or persist.
 */
export function regenerate(root, { manifestPath, manifestLabel, revision = "HEAD", scan: providedScan } = {}) {
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

  // Scan with the exclusions exactly as the manifest declares them. Following a
  // rename here would be the whole vulnerability: an excluded path that moved
  // would silently suppress its destination, and an arbitrary source file could
  // be renamed into permanent invisibility. If an exclusion no longer resolves,
  // its file gets scanned like any other and its contents are reported.
  const exclusionPaths = new Set(exclusions.map((entry) => normalizeRepositoryPath(entry.path)));
  const scan = providedScan ?? collectFindings(root, exclusionPaths, trackedFiles);

  const classification = classifyRegeneration({ exceptions, findings: scan.findings, moves });
  const exclusionEntries = classifyExclusions({ exclusions, trackedSet, moves });
  const entries = [...classification.entries, ...exclusionEntries];
  const reviewRequired = entries.filter((entry) => isReviewRequired(entry.disposition));

  const nextManifest = applyClassification({ manifest, classification, exclusionEntries });
  const manifestText = serializeManifest(nextManifest);
  const receipt = buildReceipt({
    rules: RULES,
    scan,
    manifestText,
    counts: {
      exceptionsBefore: exceptions.length,
      exceptionsAfter: nextManifest.exceptions.length,
      exclusionsBefore: exclusions.length,
      exclusionsAfter: nextManifest.exclusions.length,
      ...classification.counts,
      "exclusion-relocated": exclusionEntries.filter((e) => e.disposition === "exclusion-relocated").length,
      "exclusion-stale": exclusionEntries.filter((e) => e.disposition === "exclusion-stale").length,
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
    exclusionEntries,
    entries,
    reviewRequired,
    moves,
    moveDetectionAvailable: moveResult.available,
    unexplainedDisappearances: moveResult.unexplained ?? [],
    moveRevisions: moveResult.revisions ?? [],
    receipt,
    trackedSet,
  };
}

/**
 * Build the next manifest, preserving untouched entries byte for byte.
 *
 * Only dispositions that cannot weaken the gate are applied. An exclusion is
 * never relocated here under any circumstances -- that is review-only, and the
 * caller refuses the whole write when one is pending.
 */
export function applyClassification({ manifest, classification, exclusionEntries = [] }) {
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

  // Dropping a stale exclusion widens what gets scanned, so it can only make
  // the gate stricter and is safe to apply. Relocation is left untouched.
  const staleExclusions = new Set(
    exclusionEntries.filter((entry) => entry.disposition === "exclusion-stale").map((entry) => entry.index)
  );
  const exclusions = (manifest.exclusions ?? []).filter((_, index) => !staleExclusions.has(index));

  return { ...manifest, exclusions, exceptions };
}

/**
 * Confirm the regenerated manifest actually passes the gate.
 *
 * Relocating an exception rewrites its `path`, and several lifecycle rules are
 * path-dependent -- `migration-archaeology` is only legal on an immutable
 * Prisma `migration.sql`, and 2,172 production entries carry it. Without this
 * check the tool can hand back a manifest, tell the author to commit it, and
 * have CI fail on a rule they never touched.
 *
 * @returns `{ ok, errors }` where errors are gate-level, not classifier-level.
 */
export function validateRegeneratedManifest(root, nextManifest, options = {}) {
  const verdict = scanRepository(root, nextManifest, options);
  const errors = [
    ...verdict.manifestErrors,
    ...verdict.violations.map(
      (finding) => `unreviewed ${finding.path}:${finding.line}:${finding.column} [${finding.rule}]`
    ),
    ...verdict.exceptionDrift.map((entry) => `drifted exception for ${entry.path} [${entry.rule}]`),
  ];
  return { ok: errors.length === 0, errors, verdict };
}

/** Human-readable classification report. */
export function formatClassification(result, manifestPath) {
  const { classification, moves, moveDetectionAvailable, exclusionEntries } = result;
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

  for (const entry of exclusionEntries ?? []) {
    if (entry.disposition === "exclusion-relocated") {
      lines.push(
        `  EXCLUSION-RELOCATED ${entry.exclusion.path} -> ${entry.move.to}`,
        "    An exclusion suppresses an ENTIRE file, so following a rename here could put an",
        "    arbitrary source file permanently out of scope. Rename detection tolerates large",
        "    content changes, so the rename alone is not evidence the destination deserves it.",
        `    Review the destination and edit ${manifestPath} by hand; --write will not do it.`
      );
    } else if (entry.disposition === "exclusion-stale") {
      lines.push(`  exclusion-stale ${entry.exclusion.path} (path is gone; the exclusion will be dropped)`);
    }
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

  // A move that is already committed does not show up against HEAD. Say so
  // rather than reporting it as an unexplained deletion plus an addition.
  if (result.unexplainedDisappearances?.length && counts.removed + counts.added > 0) {
    const sample = result.unexplainedDisappearances.slice(0, 3).join(", ");
    lines.push(
      `  ${result.unexplainedDisappearances.length} declared path(s) no longer exist and no move explains them (e.g. ${sample}).`,
      "    If the move is already committed, re-run with --since=<revision before the move>,",
      `    for example: node scripts/vocabulary-boundary.mjs --check --since=$(git merge-base HEAD origin/v1)`
    );
  }

  const applicable =
    counts.moved ||
    counts["path-rebound"] ||
    counts.removed ||
    (exclusionEntries ?? []).some((entry) => entry.disposition === "exclusion-stale");
  if (applicable) {
    lines.push(`  run \`node scripts/vocabulary-boundary.mjs --write\` to apply these to ${manifestPath}`);
  }
  return lines.join("\n");
}
