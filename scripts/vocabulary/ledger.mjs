/**
 * V1 repository ledger consumer.
 *
 * This reads the artifact emitted by `node scripts/v1-ledger.mjs --out <file>`
 * (the canonical generator, WIN-246) and cross-checks each row's declared
 * disposition against the boundary evidence this tool already computes: the
 * corroborated file moves, the classified manifest exceptions, and the set of
 * paths currently tracked in the tree. It is proven against the REAL generator
 * output (see scripts/vocabulary/ledger.test.mjs), not a hand-written schema.
 *
 * Artifact shape (see scripts/v1-ledger.mjs runCli --out):
 *
 *   {
 *     "version": 1,
 *     "complete": true,
 *     "summary": { "totalFiles": ..., "classificationSha256": ... },
 *     "unmatched": [{ "path": ..., "area": ... }],
 *     "unassigned": [ ...paths ],
 *     "deleteReferences": [{ "path": ..., "referencedBy": [ ... ] }],
 *     "rows": [
 *       { "path", "area", "rule_id", "rule_order", "kind", "owner_capability",
 *         "disposition", "protected", "lines", "bytes", "binary",
 *         "reached_via": [ ... ], "evidence": "..." }
 *     ]
 *   }
 *
 * The row carries NO destination for a move: the ledger declares the INTENT to
 * relocate a file, never where it lands. A relocation is therefore only ever
 * reported as corroborated when this tool independently finds a matching file
 * move; a declared relocation with no corroborating move is FLAGGED, never
 * silently passed. Fail-closed on an unavailable move target is the reason this
 * integration exists.
 */

import { readFileSync } from "node:fs";

import { normalizeRepositoryPath } from "./identity.mjs";

// The real disposition vocabulary emitted by scripts/v1-ledger.mjs. There is no
// invented "keep" here: the generator's word for "stays put" is "retain".
export const LEDGER_DISPOSITIONS = Object.freeze([
  "retain",
  "move-refactor",
  "regenerate",
  "archive",
  "delete",
  "unresolved",
]);

// Dispositions that assert the file STAYS at its path; corroborated by presence.
const PRESENCE_DISPOSITIONS = new Set(["retain", "regenerate"]);
// Dispositions that assert the file LEAVES its path via a relocation; only a
// corroborated file move can turn them from a claim into evidence.
const RELOCATION_DISPOSITIONS = new Set(["move-refactor", "archive"]);

export function parseLedger(text) {
  const ledger = JSON.parse(text);
  const errors = [];
  if (!Array.isArray(ledger?.rows)) {
    errors.push("ledger.rows must be an array");
    return { ledger: { rows: [], complete: false }, errors };
  }
  // A run the generator marked incomplete (an unmatched or unassigned file) is
  // refused wholesale: its rows are not a trustworthy census of the tree.
  if (ledger.complete === false) {
    errors.push(
      "ledger reports complete=false (an unmatched or unassigned file); refusing to verify an incomplete run"
    );
  }
  for (const [index, row] of ledger.rows.entries()) {
    if (typeof row?.path !== "string" || row.path.trim() === "") {
      errors.push(`rows[${index}].path must be a non-empty string`);
    }
    if (!LEDGER_DISPOSITIONS.includes(row?.disposition)) {
      errors.push(`rows[${index}].disposition must be one of ${LEDGER_DISPOSITIONS.join(", ")}`);
    }
    if (!Array.isArray(row?.reached_via)) {
      errors.push(`rows[${index}].reached_via must be an array`);
    }
  }
  return { ledger, errors };
}

export function readLedger(path) {
  return parseLedger(readFileSync(path, "utf8"));
}

/**
 * Decide, for every ledger row, whether the boundary evidence corroborates its
 * declared disposition.
 *
 * @param ledger        parsed real ledger (`parseLedger().ledger`)
 * @param entries       classifier output (`regenerate().entries`)
 * @param moves         corroborated file moves (`regenerate().moves`)
 * @param trackedPaths  set of paths currently tracked in the tree
 * @param deleteReferences the ledger's own reachability scan (defaults to the
 *                         value carried on the artifact)
 */
export function verifyLedger({
  ledger,
  entries = [],
  moves = [],
  trackedPaths = new Set(),
  deleteReferences = ledger?.deleteReferences ?? [],
}) {
  // Index boundary exceptions by the path they touch.
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
  for (const move of moves) movesByFrom.set(normalizeRepositoryPath(move.from), move);
  const referencedDeletes = new Set(
    (deleteReferences ?? []).map((reference) => normalizeRepositoryPath(reference.path))
  );

  const verified = [];
  const flagged = [];
  for (const row of ledger?.rows ?? []) {
    const path = normalizeRepositoryPath(row.path);
    const related = byPath.get(path) ?? [];
    const base = { path, disposition: row.disposition };
    const move = movesByFrom.get(path);

    // A disposition the ledger itself could not settle is never verifiable.
    if (row.disposition === "unresolved") {
      flagged.push({
        ...base,
        reason: "ledger marks this path unresolved; there is no settled disposition to verify",
      });
      continue;
    }

    // move-refactor / archive: the file is claimed to leave its path. FAIL
    // CLOSED -- without a corroborated move the target is unavailable, so the
    // claim cannot be turned into evidence and is flagged rather than passed.
    if (RELOCATION_DISPOSITIONS.has(row.disposition)) {
      if (!move) {
        flagged.push({
          ...base,
          reason: `declared ${row.disposition} but no corroborated file move was found; the move target is unavailable, so the relocation cannot be verified`,
        });
        continue;
      }
      const unsurvived = related.filter(
        (entry) => !["moved", "path-rebound"].includes(entry.disposition)
      );
      if (unsurvived.length) {
        flagged.push({
          ...base,
          target: move.to,
          reason: `${unsurvived.length} boundary exception(s) did not survive the move as ${unsurvived
            .map((entry) => entry.disposition)
            .join(", ")}`,
        });
        continue;
      }
      verified.push({
        ...base,
        target: move.to,
        evidence: `${move.source}${move.identical ? " (pure move)" : " (content changed)"}`,
        exceptions: related.length,
      });
      continue;
    }

    if (row.disposition === "delete") {
      // A "delete" the boundary evidence shows is actually a move is not a
      // deletion; refuse to pass it. This is the case the integration exists
      // for: the boundary can now tell a move from a removal.
      if (move) {
        flagged.push({
          ...base,
          target: move.to,
          reason: `declared delete but a corroborated move to ${move.to} exists; this is a relocation, not a deletion`,
        });
        continue;
      }
      // A delete the generator's own reachability scan found referenced was
      // never an orphan.
      if (referencedDeletes.has(path)) {
        flagged.push({
          ...base,
          reason: "declared delete but the ledger's reachability scan found live references to this path",
        });
        continue;
      }
      const reached = Array.isArray(row.reached_via) ? row.reached_via : [];
      if (reached.length !== 1 || reached[0] !== "NONE") {
        flagged.push({
          ...base,
          reason: `declared delete while recording reachability [${reached.join(", ")}]; a removal must be unreachable`,
        });
        continue;
      }
      verified.push({
        ...base,
        evidence: "unreachable (reached_via NONE); no corroborating move and no live reference",
        exceptions: related.length,
      });
      continue;
    }

    // retain / regenerate: the file is claimed to stay. Corroborated by
    // presence in the tracked tree -- and contradicted by a move away from it.
    if (PRESENCE_DISPOSITIONS.has(row.disposition)) {
      if (!trackedPaths.has(path)) {
        flagged.push({
          ...base,
          reason: `declared ${row.disposition} but the path is absent from the tracked tree`,
        });
        continue;
      }
      if (move) {
        flagged.push({
          ...base,
          target: move.to,
          reason: `declared ${row.disposition} but a corroborated move to ${move.to} exists`,
        });
        continue;
      }
      verified.push({
        ...base,
        evidence:
          row.disposition === "regenerate"
            ? "present in the tracked tree; regenerated in place"
            : "present in the tracked tree",
        exceptions: related.length,
      });
      continue;
    }

    // parseLedger rejects an unknown disposition, so this is only reachable if a
    // caller skipped it. Fail closed rather than pass an unhandled row.
    flagged.push({ ...base, reason: `unhandled disposition ${row.disposition}` });
  }
  return { verified, flagged };
}

export function formatLedgerReport({ verified, flagged }) {
  // The schema is agreed now -- this reads the real generator output -- so the
  // old "PROVISIONAL, schema not yet agreed" caveat is gone. The status line is
  // still honest: a flagged relocation is never reported as corroborated.
  const lines = [
    `ledger: ${verified.length} disposition(s) corroborated by boundary evidence, ${flagged.length} flagged`,
  ];
  for (const record of verified) {
    lines.push(
      `  evidence-ok  ${record.disposition} ${record.path}${
        record.target ? ` -> ${record.target}` : ""
      } (${record.evidence})`
    );
  }
  for (const record of flagged) {
    lines.push(
      `  FLAGGED   ${record.disposition} ${record.path}${
        record.target ? ` -> ${record.target}` : ""
      }: ${record.reason}`
    );
  }
  return lines.join("\n");
}
