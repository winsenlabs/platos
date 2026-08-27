/**
 * V1 repository ledger integration.
 *
 * IMPORTANT, READ BEFORE RELYING ON THIS: no V1 repository ledger file exists
 * anywhere in this repository, its git history, any branch, or any sibling
 * checkout at the SHA this was written against. The `move-refactor` /
 * `archive` disposition vocabulary appears nowhere in the tree. This module is
 * therefore written against the *documented contract* below and is proven only
 * against fixtures -- it has never been run against real ledger data.
 *
 * Ledger shape this reads:
 *
 *   {
 *     "version": 1,
 *     "entries": [
 *       { "path": "apps/old/thing.ts", "disposition": "move-refactor",
 *         "target": "apps/new/thing.ts" },
 *       { "path": "apps/dead/thing.ts", "disposition": "archive" },
 *       { "path": "apps/keep/thing.ts", "disposition": "keep" }
 *     ]
 *   }
 *
 * The point of the integration: a `move-refactor` or `archive` disposition used
 * to be blocked because the boundary gate could not tell a move from a
 * deletion. Now the classifier can, so each disposition can be *verified*
 * against evidence instead of blocked -- or reported as still-blocked with the
 * specific reason.
 */

import { readFileSync } from "node:fs";

import { normalizeRepositoryPath } from "./identity.mjs";

export const LEDGER_DISPOSITIONS = Object.freeze(["move-refactor", "archive", "delete", "keep"]);

export function parseLedger(text) {
  const ledger = JSON.parse(text);
  const errors = [];
  if (!Array.isArray(ledger?.entries)) {
    errors.push("ledger.entries must be an array");
    return { ledger: { entries: [] }, errors };
  }
  for (const [index, entry] of ledger.entries.entries()) {
    if (typeof entry?.path !== "string" || entry.path.trim() === "") {
      errors.push(`entries[${index}].path must be a non-empty string`);
    }
    if (!LEDGER_DISPOSITIONS.includes(entry?.disposition)) {
      errors.push(`entries[${index}].disposition must be one of ${LEDGER_DISPOSITIONS.join(", ")}`);
    }
    if (entry?.disposition === "move-refactor" && entry.target !== undefined) {
      if (typeof entry.target !== "string" || entry.target.trim() === "") {
        errors.push(`entries[${index}].target must be a non-empty string when present`);
      }
    }
  }
  return { ledger, errors };
}

export function readLedger(path) {
  return parseLedger(readFileSync(path, "utf8"));
}

/**
 * Decide, for every ledger entry, whether the boundary evidence supports it.
 *
 * @param entries    classifier output (`classifyRegeneration().entries`)
 * @param moves      corroborated file moves
 * @param trackedPaths set of paths currently tracked in the tree
 */
export function verifyLedger({ ledger, entries, moves = [], trackedPaths = new Set() }) {
  const byPath = new Map();
  for (const entry of entries) {
    const source = entry.exception ?? entry.finding;
    if (!source) continue;
    const path = normalizeRepositoryPath(entry.exception ? entry.exception.path : source.path);
    const bucket = byPath.get(path) ?? [];
    bucket.push(entry);
    byPath.set(path, bucket);
  }
  const movesByFrom = new Map();
  for (const move of moves) movesByFrom.set(move.from, move);

  const verified = [];
  const blocked = [];
  for (const record of ledger.entries) {
    const path = normalizeRepositoryPath(record.path);
    const related = byPath.get(path) ?? [];
    const result = { path, disposition: record.disposition, target: record.target };

    if (record.disposition === "move-refactor") {
      const move = movesByFrom.get(path);
      if (!move) {
        blocked.push({ ...result, reason: "no corroborated file move found for this path" });
        continue;
      }
      if (record.target && normalizeRepositoryPath(record.target) !== move.to) {
        blocked.push({ ...result, reason: `move goes to ${move.to}, ledger declares ${record.target}` });
        continue;
      }
      const unresolved = related.filter(
        (entry) => !["moved", "path-rebound"].includes(entry.disposition)
      );
      if (unresolved.length) {
        blocked.push({
          ...result,
          reason: `${unresolved.length} exception(s) did not survive the move as ${unresolved
            .map((entry) => entry.disposition)
            .join(", ")}`,
        });
        continue;
      }
      verified.push({ ...result, target: move.to, evidence: `${move.source}${move.identical ? " (pure)" : " (content changed)"}`, exceptions: related.length });
      continue;
    }

    if (record.disposition === "archive" || record.disposition === "delete") {
      if (trackedPaths.has(path)) {
        blocked.push({ ...result, reason: "path is still tracked in the tree" });
        continue;
      }
      const unresolved = related.filter((entry) => entry.disposition !== "removed");
      if (unresolved.length) {
        blocked.push({
          ...result,
          reason: `${unresolved.length} exception(s) classified as ${unresolved
            .map((entry) => entry.disposition)
            .join(", ")} rather than removed`,
        });
        continue;
      }
      verified.push({ ...result, evidence: "path absent and every exception resolved", exceptions: related.length });
      continue;
    }

    if (!trackedPaths.has(path)) {
      blocked.push({ ...result, reason: "path is declared kept but is absent from the tree" });
      continue;
    }
    verified.push({ ...result, evidence: "path present", exceptions: related.length });
  }
  return { verified, blocked };
}

export function formatLedgerReport({ verified, blocked }) {
  const lines = [`ledger: ${verified.length} verified, ${blocked.length} blocked`];
  for (const record of verified) {
    lines.push(`  VERIFIED  ${record.disposition} ${record.path}${record.target ? ` -> ${record.target}` : ""} (${record.evidence}, ${record.exceptions} exception(s))`);
  }
  for (const record of blocked) {
    lines.push(`  BLOCKED   ${record.disposition} ${record.path}: ${record.reason}`);
  }
  return lines.join("\n");
}
