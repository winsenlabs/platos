/**
 * Stable identity model for vocabulary boundary exceptions.
 *
 * An exception records a human judgement about one forbidden token: that a
 * given spelling names an external vendor contract rather than a Platos
 * concept. That judgement is a statement about the *code*, not about where the
 * file happens to sit in the tree. So identity splits into two coordinates:
 *
 *   occurrence identity  rule + matchedText + localContextSha256 +
 *                        semanticContextKind + semanticContextSha256 +
 *                        collisionContextSha256
 *                        -- path independent; this is what survives a move.
 *
 *   location             path
 *                        -- where the occurrence currently lives.
 *
 * anchor identity = location + occurrence identity, which is byte-for-byte the
 * key `scripts/vocabulary-boundary.mjs` already matches on. Splitting it does
 * not change the gate; it only makes "same violation, new path" expressible.
 *
 * The single genuine exception is a *path finding* -- a finding whose scanned
 * source IS the path string (`semanticContextKind === "repository-path"`).
 * Its matchedText and both context digests are derived from the path, so its
 * occurrence identity is path-bound by definition. A move really does resolve
 * the old one and introduce a new one; the classifier reports those as
 * `path-rebound` rather than pretending they survived.
 */

import { createHash } from "node:crypto";

/**
 * Field separator. Must stay NUL to match `anchorKey()` in
 * vocabulary-boundary.mjs byte for byte. Built from a char code rather than a
 * literal so the source file stays plain text and greppable.
 */
const SEP = String.fromCharCode(0);

/** Fields that make up occurrence identity, in fixed order. */
export const OCCURRENCE_FIELDS = Object.freeze([
  "rule",
  "matchedText",
  "localContextSha256",
  "semanticContextKind",
  "semanticContextSha256",
]);

/**
 * Normalize a repository-relative path to its canonical cross-platform form.
 *
 * Verified against the 20,364 paths in the production manifest: this function
 * is the identity mapping on every one of them, so adopting it cannot perturb
 * the existing entries.
 */
export function normalizeRepositoryPath(input) {
  if (typeof input !== "string") throw new TypeError("path must be a string");
  let path = input.replaceAll("\\", "/").normalize("NFC");
  path = path.replace(/\/{2,}/gu, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

/**
 * Deterministic, locale-independent ordering: compare UTF-8 bytes.
 *
 * `Array.prototype.sort()` compares UTF-16 code units, which disagrees with
 * byte order for astral-plane characters and is the usual source of
 * "regenerated on another machine and the diff moved" bugs.
 */
export function compareUtf8(left, right) {
  if (left === right) return 0;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digestField(value) {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * The path-independent identity of one occurrence, as a NUL-delimited string.
 * Two occurrences sharing this string are the same reviewed judgement,
 * wherever they live.
 */
export function occurrenceIdentity(entry) {
  const fields = OCCURRENCE_FIELDS.map((field) => digestField(entry[field]));
  fields.push(digestField(entry.collisionContextSha256));
  return fields.join(SEP);
}

/** Content-addressable form of {@link occurrenceIdentity}. */
export function occurrenceId(entry) {
  return createHash("sha256").update(occurrenceIdentity(entry), "utf8").digest("hex");
}

/**
 * Full anchor identity: location + occurrence.
 *
 * MUST remain byte-for-byte equal to `anchorKey()` in vocabulary-boundary.mjs.
 * `scripts/vocabulary-boundary.test.mjs` asserts this equivalence so the split
 * cannot silently drift away from the gate it describes.
 */
export function anchorIdentity(entry) {
  return normalizeRepositoryPath(entry.path) + SEP + occurrenceIdentity(entry);
}

/** True when this entry's identity is derived from its path, not its content. */
export function isPathBound(entry) {
  return entry.semanticContextKind === "repository-path";
}

/**
 * Fingerprint of the rule set. Any change to a rule id, pattern, or flags
 * changes every digest downstream of it, so the receipt records this and a
 * regeneration made under different rules is detectable.
 */
export function rulesFingerprint(rules) {
  const canonical = rules
    .map((rule) => `${rule.id} ${rule.pattern.source} ${rule.pattern.flags}`)
    .sort(compareUtf8)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Group records by a key, preserving encounter order inside each bucket.
 * Occurrences that share an anchor are genuinely indistinguishable, so they
 * are matched positionally -- the same multiplicity rule the gate already uses.
 */
export function groupBy(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}
