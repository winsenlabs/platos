/**
 * Auditable regeneration receipt.
 *
 * A receipt answers, months later and without re-running anything: which tree
 * was scanned, under which rule set, what came out, and how many entries
 * changed and in which direction. All three digests are reproducible from a
 * clean checkout, so a reviewer can recompute them and compare.
 */

import { createHash } from "node:crypto";

import { compareUtf8, rulesFingerprint } from "./identity.mjs";

export const RECEIPT_VERSION = 1;

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Fingerprint of the scanned input: every scanned path paired with the digest
 * of its scanned content, in UTF-8 byte order. Changing any scanned byte, or
 * adding/removing any scanned file, changes this value.
 */
export function inputFingerprint({ textByPath, binaryFiles = [], excludedFiles = [] }) {
  const lines = [];
  for (const [path, source] of textByPath) lines.push(`text ${path} ${sha256Hex(source)}`);
  for (const path of binaryFiles) lines.push(`binary ${path}`);
  for (const path of excludedFiles) lines.push(`excluded ${path}`);
  lines.sort(compareUtf8);
  return sha256Hex(lines.join("\n"));
}

/** Fingerprint of the emitted manifest text, exactly as written to disk. */
export function outputFingerprint(manifestText) {
  return sha256Hex(manifestText);
}

export function buildReceipt({
  rules,
  scan,
  manifestText,
  counts,
  moves = [],
  mode,
  manifestPath,
}) {
  return {
    receiptVersion: RECEIPT_VERSION,
    mode,
    manifestPath,
    inputSha256: inputFingerprint(scan),
    rulesSha256: rulesFingerprint(rules),
    outputSha256: outputFingerprint(manifestText),
    counts: {
      scannedTextualFiles: scan.files.length,
      binaryFiles: scan.binaryFiles.length,
      exactExclusions: scan.excludedFiles.length,
      trackedFiles: scan.trackedFiles.length,
      findings: scan.findings.length,
      ...counts,
    },
    moves: moves.map((move) => ({
      from: move.from,
      to: move.to,
      identical: move.identical,
      source: move.source,
    })),
  };
}

/** Stable, diff-friendly rendering. Key order is fixed by construction. */
export function formatReceipt(receipt) {
  const lines = [
    "vocabulary-boundary receipt",
    `  mode          ${receipt.mode}`,
    `  manifest      ${receipt.manifestPath}`,
    `  inputSha256   ${receipt.inputSha256}`,
    `  rulesSha256   ${receipt.rulesSha256}`,
    `  outputSha256  ${receipt.outputSha256}`,
    "  counts",
  ];
  for (const key of Object.keys(receipt.counts).sort(compareUtf8)) {
    lines.push(`    ${key.padEnd(22)} ${receipt.counts[key]}`);
  }
  if (receipt.moves.length) {
    lines.push(`  corroborated file moves (${receipt.moves.length})`);
    for (const move of receipt.moves) {
      lines.push(`    ${move.identical ? "pure   " : "changed"} ${move.from} -> ${move.to} [${move.source}]`);
    }
  }
  return lines.join("\n");
}
