/**
 * Order-preserving manifest reader/writer.
 *
 * The production manifest was assembled by hand over time, not emitted by one
 * serializer: its 20,349 entries carry four different key orders and an entry
 * order that is not the scan order. A generator that "canonicalized" it would
 * rewrite all 20,349 lines and produce an unreviewable diff, and 1,460 of the
 * stored line/column diagnostics are already stale, so refreshing those
 * unconditionally would rewrite them too.
 *
 * This writer therefore preserves, for every entry it does not deliberately
 * change: its position in the array, its key order, and its exact field values
 * -- stale diagnostics included. The consequence is the property CI depends on:
 * a `--write` over an unchanged tree reproduces the file byte for byte.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { compareUtf8 } from "./identity.mjs";

/** Parse manifest text, keeping per-entry key order as authored. */
export function parseManifest(text) {
  const manifest = JSON.parse(text);
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("manifest must be a JSON object");
  }
  return manifest;
}

export function readManifest(path) {
  return parseManifest(readFileSync(path, "utf8"));
}

/**
 * Serialize in the repository's established layout: two-space outer indent,
 * one compact entry per line at four spaces, trailing newline.
 *
 * Key order comes from each object's own insertion order, so an untouched
 * entry re-serializes to the identical bytes it was parsed from.
 */
export function serializeManifest(manifest) {
  const lines = ["{", `  "version": ${JSON.stringify(manifest.version)},`];
  lines.push(...serializeSection("exclusions", manifest.exclusions ?? []));
  lines.push(...serializeSection("exceptions", manifest.exceptions ?? [], true));
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function serializeSection(name, entries, last = false) {
  if (entries.length === 0) return [`  "${name}": []${last ? "" : ","}`];
  const lines = [`  "${name}": [`];
  for (const [index, entry] of entries.entries()) {
    const suffix = index === entries.length - 1 ? "" : ",";
    lines.push(`    ${JSON.stringify(entry)}${suffix}`);
  }
  lines.push(`  ]${last ? "" : ","}`);
  return lines;
}

/**
 * Rebuild one entry with a patch applied while keeping the original key order
 * for keys that already existed. Genuinely new keys are appended in a stable
 * order so two machines emit identical bytes.
 */
export function patchEntry(entry, patch) {
  const result = {};
  for (const key of Object.keys(entry)) {
    result[key] = Object.hasOwn(patch, key) ? patch[key] : entry[key];
  }
  const added = Object.keys(patch)
    .filter((key) => !Object.hasOwn(entry, key))
    .sort(compareUtf8);
  for (const key of added) result[key] = patch[key];
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}
