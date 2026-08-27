/**
 * Regeneration diff classifier.
 *
 * Given the manifest's reviewed exceptions and the tree's current findings,
 * decide what happened to each one. Every entry lands in exactly one bucket:
 *
 *   unchanged        same anchor, same path. Nothing to do.
 *   moved            same occurrence identity, new path, corroborated by a
 *                    file move. The reviewed judgement is intact; only the
 *                    location changed.
 *   path-rebound     a path-derived exception carried along by a pure file
 *                    move. Its digests are recomputed from the new path
 *                    because they are definitionally path-bound.
 *   removed          the occurrence is gone and nothing explains it as a move.
 *                    The violation was resolved, or the file was deleted.
 *   context-changed  same path, same rule and spelling, but the reviewed
 *                    surroundings changed. The old review no longer covers it.
 *   added            a finding with no reviewed exception behind it.
 *
 * The safety argument for `--write` rests on one asymmetry: *removing* or
 * *relocating* an exception can only ever make the gate stricter or keep it
 * equally strict, while *creating* one weakens it. So the writer may apply
 * `unchanged`, `moved`, `path-rebound` and `removed` on its own, and must
 * refuse `added` and `context-changed`. Those two are exactly the cases where
 * a human has not yet judged the code in front of them.
 */

import {
  anchorIdentity,
  groupBy,
  isPathBound,
  normalizeRepositoryPath,
  occurrenceIdentity,
} from "./identity.mjs";

const NUL = String.fromCharCode(0);

export const AUTO_APPLIED = Object.freeze(["unchanged", "moved", "path-rebound", "removed"]);
export const REVIEW_REQUIRED = Object.freeze(["added", "context-changed"]);

/** Fields the scanner derives; lifecycle metadata is never taken from a finding. */
const ANCHOR_FIELDS = Object.freeze([
  "path",
  "rule",
  "matchedText",
  "line",
  "column",
  "localContextSha256",
  "semanticContextKind",
  "semanticContextSha256",
  "collisionContextSha256",
]);

function anchorPatchFrom(finding) {
  const patch = {};
  for (const field of ANCHOR_FIELDS) {
    if (field === "collisionContextSha256" && !finding.collisionContextSha256) continue;
    patch[field] = field === "path" ? normalizeRepositoryPath(finding.path) : finding[field];
  }
  return patch;
}

function takeFrom(buckets, key) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.length === 0) return null;
  return bucket.shift();
}

/**
 * @param exceptions reviewed manifest entries, in manifest order
 * @param findings   current scan findings, with collision anchors applied
 * @param moves      corroborated file moves from ./moves.mjs
 */
export function classifyRegeneration({ exceptions, findings, moves = [] }) {
  const remainingFindings = groupBy(findings, anchorIdentity);
  const results = [];

  // Pass 1: exact anchor matches, positionally, preserving multiplicity.
  const unmatched = [];
  for (const [index, exception] of exceptions.entries()) {
    const finding = takeFrom(remainingFindings, anchorIdentity(exception));
    if (finding) results.push({ index, disposition: "unchanged", exception, finding });
    else unmatched.push({ index, exception });
  }

  const leftoverFindings = [...remainingFindings.values()].flat();
  const byOccurrenceAtPath = groupBy(
    leftoverFindings,
    (finding) => normalizeRepositoryPath(finding.path) + NUL + occurrenceIdentity(finding)
  );
  const pathBoundAt = groupBy(
    leftoverFindings.filter((finding) => isPathBound(finding)),
    (finding) => normalizeRepositoryPath(finding.path)
  );

  const movesByFrom = new Map();
  for (const move of moves) {
    const bucket = movesByFrom.get(move.from) ?? [];
    bucket.push(move);
    movesByFrom.set(move.from, bucket);
  }

  // How many path-derived exceptions each moving file carried, per rule. A pure
  // move must reproduce that exact profile at the destination, otherwise the new
  // location has introduced or dropped path vocabulary and needs a human.
  const pathProfileFrom = new Map();
  for (const { exception } of unmatched) {
    if (!isPathBound(exception)) continue;
    const key = normalizeRepositoryPath(exception.path);
    const profile = pathProfileFrom.get(key) ?? new Map();
    profile.set(exception.rule, (profile.get(exception.rule) ?? 0) + 1);
    pathProfileFrom.set(key, profile);
  }

  function pathProfileMatches(fromPath, toPath) {
    const before = pathProfileFrom.get(fromPath) ?? new Map();
    const after = new Map();
    for (const finding of pathBoundAt.get(toPath) ?? []) {
      after.set(finding.rule, (after.get(finding.rule) ?? 0) + 1);
    }
    if (before.size !== after.size) return false;
    for (const [rule, count] of before) if (after.get(rule) !== count) return false;
    return true;
  }

  const stillUnmatched = [];
  for (const { index, exception } of unmatched) {
    const fromPath = normalizeRepositoryPath(exception.path);
    const candidates = movesByFrom.get(fromPath) ?? [];
    let settled = false;

    for (const move of candidates) {
      if (isPathBound(exception)) {
        // Path-derived identity cannot survive verbatim. Rebind it only when the
        // move is byte-pure and the destination carries the same rule profile.
        if (!move.identical || !pathProfileMatches(fromPath, move.to)) continue;
        const bucket = pathBoundAt.get(move.to) ?? [];
        const matchIndex = bucket.findIndex((candidate) => candidate.rule === exception.rule);
        if (matchIndex < 0) continue;
        const [rebound] = bucket.splice(matchIndex, 1);
        removeFromList(leftoverFindings, rebound);
        removeFromGroup(
          byOccurrenceAtPath,
          normalizeRepositoryPath(rebound.path) + NUL + occurrenceIdentity(rebound),
          rebound
        );
        results.push({
          index,
          disposition: "path-rebound",
          exception,
          finding: rebound,
          move,
          patch: anchorPatchFrom(rebound),
        });
        settled = true;
        break;
      }

      const key = move.to + NUL + occurrenceIdentity(exception);
      const finding = takeFrom(byOccurrenceAtPath, key);
      if (!finding) continue;
      removeFromList(leftoverFindings, finding);
      if (isPathBound(finding)) removeFromGroup(pathBoundAt, normalizeRepositoryPath(finding.path), finding);
      results.push({
        index,
        disposition: "moved",
        exception,
        finding,
        move,
        patch: anchorPatchFrom(finding),
      });
      settled = true;
      break;
    }
    if (!settled) stillUnmatched.push({ index, exception });
  }

  // Pass 3: same path, same rule and spelling, different reviewed context.
  const bySamePathRule = groupBy(
    leftoverFindings,
    (finding) => normalizeRepositoryPath(finding.path) + NUL + finding.rule + NUL + finding.matchedText
  );
  for (const { index, exception } of stillUnmatched) {
    const key =
      normalizeRepositoryPath(exception.path) + NUL + exception.rule + NUL + exception.matchedText;
    const finding = takeFrom(bySamePathRule, key);
    if (finding) {
      removeFromList(leftoverFindings, finding);
      results.push({
        index,
        disposition: "context-changed",
        exception,
        finding,
        patch: anchorPatchFrom(finding),
      });
    } else {
      results.push({ index, disposition: "removed", exception });
    }
  }

  // Anything still unclaimed is a violation nobody has reviewed.
  for (const finding of leftoverFindings) {
    results.push({ index: Number.MAX_SAFE_INTEGER, disposition: "added", finding });
  }

  results.sort((left, right) => left.index - right.index);
  return { entries: results, counts: countDispositions(results) };
}

function removeFromList(list, item) {
  const index = list.indexOf(item);
  if (index >= 0) list.splice(index, 1);
}

function removeFromGroup(groups, key, item) {
  const bucket = groups.get(key);
  if (!bucket) return;
  const index = bucket.indexOf(item);
  if (index >= 0) bucket.splice(index, 1);
}

export function countDispositions(entries) {
  const counts = Object.fromEntries([...AUTO_APPLIED, ...REVIEW_REQUIRED].map((name) => [name, 0]));
  for (const entry of entries) counts[entry.disposition] = (counts[entry.disposition] ?? 0) + 1;
  return counts;
}

/** Entries a human must look at before the manifest may be rewritten. */
export function reviewRequiredEntries(entries) {
  return entries.filter((entry) => REVIEW_REQUIRED.includes(entry.disposition));
}
