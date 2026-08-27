/**
 * File-move evidence.
 *
 * A move is only ever accepted when it is corroborated by evidence *outside*
 * the exception being moved. Occurrence identity alone is not enough: a common
 * boilerplate line carries the same occurrence identity in dozens of files, so
 * "an identical fingerprint appeared somewhere else" would happily pair an
 * unrelated deletion with an unrelated addition and launder a new exception
 * into the manifest as a move.
 *
 * Two independent sources are used, strongest first:
 *
 *   1. git rename detection (`git diff --find-renames`), which knows about
 *      staged and unstaged `git mv` as well as committed history.
 *   2. exact whole-file content digest: a path that disappeared and a path
 *      that appeared whose bytes are identical, paired only when that pairing
 *      is unambiguous (exactly one candidate on each side).
 *
 * Both record whether the content is byte-identical. A move whose content also
 * changed is still a move, but it is not a *pure* move, and the classifier
 * refuses to auto-apply anything that depends on purity.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeRepositoryPath } from "./identity.mjs";

const NUL = String.fromCharCode(0);

function git(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding, maxBuffer: 1024 * 1024 * 256 });
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

/** sha256 of a file's raw bytes; works for binary as well as text. */
export function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function digestFile(root, path) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return null;
  return digestBytes(readFileSync(absolute));
}

/** sha256 of a path's content at a git revision, or null if absent there. */
export function digestBlobAt(root, revision, path) {
  const bytes = git(root, ["cat-file", "blob", `${revision}:${path}`], {
    allowFailure: true,
    encoding: "buffer",
  });
  return bytes === null ? null : digestBytes(bytes);
}

export function revisionExists(root, revision) {
  return git(root, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { allowFailure: true }) !== null;
}

/**
 * Renames git itself reports between `revision` and the working tree.
 * Returns [{ from, to, similarity, source: "git-rename" }].
 */
export function gitRenames(root, revision) {
  const raw = git(root, ["diff", "--find-renames", "--name-status", "-z", revision], { allowFailure: true });
  if (raw === null) return [];
  const fields = raw.split(NUL);
  const renames = [];
  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index];
    if (!status) continue;
    if (/^[RC]\d*$/u.test(status)) {
      const from = fields[index + 1];
      const to = fields[index + 2];
      index += 2;
      if (!from || !to) continue;
      renames.push({
        from: normalizeRepositoryPath(from),
        to: normalizeRepositoryPath(to),
        similarity: Number(status.slice(1)) || 100,
        source: "git-rename",
      });
    } else {
      index += 1;
    }
  }
  return renames;
}

/**
 * Pair disappeared paths with appeared paths by exact content digest.
 *
 * Only unambiguous 1:1 pairings are returned. If two files vanished and two
 * appeared all sharing one digest, there is no evidence saying which became
 * which, so none of them is reported as a move.
 */
export function digestPairings(root, revision, disappeared, appeared) {
  const before = new Map();
  for (const path of disappeared) {
    const digest = digestBlobAt(root, revision, path);
    if (!digest) continue;
    const bucket = before.get(digest) ?? [];
    bucket.push(path);
    before.set(digest, bucket);
  }
  const after = new Map();
  for (const path of appeared) {
    const digest = digestFile(root, path);
    if (!digest) continue;
    const bucket = after.get(digest) ?? [];
    bucket.push(path);
    after.set(digest, bucket);
  }
  const pairings = [];
  for (const [digest, fromPaths] of before) {
    const toPaths = after.get(digest);
    if (!toPaths) continue;
    if (fromPaths.length !== 1 || toPaths.length !== 1) continue;
    pairings.push({
      from: fromPaths[0],
      to: toPaths[0],
      similarity: 100,
      source: "content-digest",
      contentDigest: digest,
    });
  }
  return pairings;
}

/**
 * Resolve the full set of corroborated moves, each annotated with whether the
 * content is byte-identical (`identical: true` => pure move).
 *
 * `disappeared` / `appeared` narrow the digest search to paths the classifier
 * actually cares about; git rename detection is unconditional.
 */
export function detectFileMoves(root, { revision = "HEAD", disappeared = [], appeared = [] } = {}) {
  if (!revisionExists(root, revision)) return { revision, moves: [], available: false };

  const moves = new Map();
  for (const rename of gitRenames(root, revision)) {
    moves.set(`${rename.from}${NUL}${rename.to}`, rename);
  }
  const known = new Set([...moves.values()].map((move) => move.from));
  const stillMissing = disappeared.filter((path) => !known.has(path));
  const knownTargets = new Set([...moves.values()].map((move) => move.to));
  const stillNew = appeared.filter((path) => !knownTargets.has(path));
  for (const pairing of digestPairings(root, revision, stillMissing, stillNew)) {
    moves.set(`${pairing.from}${NUL}${pairing.to}`, pairing);
  }

  const resolved = [];
  for (const move of moves.values()) {
    const beforeDigest = digestBlobAt(root, revision, move.from);
    const afterDigest = digestFile(root, move.to);
    resolved.push({
      ...move,
      identical: Boolean(beforeDigest && afterDigest && beforeDigest === afterDigest),
    });
  }
  resolved.sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0));
  return { revision, moves: resolved, available: true };
}

/** Index moves by their source path for O(1) lookup during classification. */
export function indexMovesByFrom(moves) {
  const index = new Map();
  for (const move of moves) {
    const bucket = index.get(move.from) ?? [];
    bucket.push(move);
    index.set(move.from, bucket);
  }
  return index;
}
