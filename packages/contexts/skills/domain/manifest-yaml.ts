// The YAML subset a skill frontmatter may use.
//
// DELIBERATELY MINIMAL, AND DELIBERATELY OURS. The live parser takes no YAML
// dependency and does no evaluation, and this transcription keeps both
// properties: a skill manifest is untrusted input that arrives over the network
// from a URL an operator pasted, and a full YAML engine is a large surface to
// point at that. The supported dialect is exactly what the format needs —
// scalars, nested maps, lists of scalars, and lists of maps — plus a JSON escape
// hatch, so an author who wants richer structure inlines `{ ... }` or `[ ... ]`
// and gets `JSON.parse` rather than a new grammar.
//
// ON THE INTERNAL THROW. The recursive descent below signals a malformed
// document by throwing a module-private `YamlFault`. It is caught in
// `parseYamlSubset`, the single exported entry point, and converted to a
// `DomainError` value. Nothing here escapes this file, so no caller can observe
// an exception and no port sees one; threading a `Result` through every arm of a
// mutually recursive descent would obscure the grammar without changing what a
// caller can hold.

import { err, ok, type DomainError, type Result } from "@platos/kernel";

import { manifestYamlIndent, manifestYamlMissingColon } from "./errors.js";

/** A structural value the dialect can produce. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly content: string;
  readonly raw: string;
  readonly lineNo: number;
}

interface Cursor {
  idx: number;
}

/** Module-private. See the header: it never leaves this file. */
class YamlFault extends Error {
  readonly domainError: DomainError;

  constructor(error: DomainError) {
    super(error.code);
    this.name = "YamlFault";
    this.domainError = error;
  }
}

/**
 * The index of the `#` that starts a comment, or -1.
 *
 * Quote-aware, so a `#` inside a description is text and not the start of a
 * comment. Without this, `description: "issue #12"` silently truncates.
 */
export function findUnquotedHash(text: string): number {
  let inQuote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuote !== null) {
      if (character === inQuote && text[index - 1] !== "\\") inQuote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      inQuote = character;
      continue;
    }
    if (character === "#") return index;
  }
  return -1;
}

/**
 * The index of the `:` that separates a key from its value, or -1.
 *
 * Quote- AND bracket-aware. The bracket depth is what lets an inline JSON value
 * carry colons of its own: `inputSchema: {"type": "object"}` splits at the FIRST
 * colon and not at the one inside the object.
 */
export function findUnquotedColon(text: string): number {
  let inQuote: string | null = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuote !== null) {
      if (character === inQuote && text[index - 1] !== "\\") inQuote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      inQuote = character;
      continue;
    }
    if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") depth -= 1;
    else if (character === ":" && depth === 0) return index;
  }
  return -1;
}

function tokenize(text: string): Line[] {
  const lines = text.split(/\r?\n/u);
  const out: Line[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const hashIndex = findUnquotedHash(raw);
    const stripped = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    if (stripped.trim() === "") continue;
    out.push({
      indent: stripped.length - stripped.trimStart().length,
      content: stripped.trim(),
      raw: stripped,
      lineNo: index + 1,
    });
  }
  return out;
}

/**
 * A leaf value.
 *
 * Order matters: inline JSON first (so `[a, b]` is a list and not the string
 * "[a, b]"), then quoted strings, then the three literals, then numbers, then a
 * bare string. A JSON body that will not parse falls through to string rather
 * than failing the document — a malformed inline schema is the author's to see
 * in the stored manifest, not a reason to reject an otherwise valid skill.
 */
export function parseScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed) as YamlValue;
    } catch {
      // fall through to the string forms
    }
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed.replace(/'/gu, '"')) as YamlValue;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/u.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/u.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** Read the value that follows a key with nothing after its colon. */
function parseNested(lines: Line[], cursor: Cursor, baseIndent: number): YamlValue {
  const next = lines[cursor.idx];
  if (next === undefined || next.indent <= baseIndent) return null;
  if (next.content.startsWith("- ")) return parseList(lines, cursor, next.indent);
  return parseMap(lines, cursor, next.indent);
}

function parseMap(lines: Line[], cursor: Cursor, baseIndent: number): { [key: string]: YamlValue } {
  const map: { [key: string]: YamlValue } = {};
  while (cursor.idx < lines.length) {
    const line = lines[cursor.idx];
    if (line === undefined || line.indent < baseIndent) break;
    if (line.indent > baseIndent) throw new YamlFault(manifestYamlIndent(line.lineNo, line.raw));
    // A list marker at map level means the caller misread the shape; stop and
    // let it decide, rather than consuming a line this map cannot represent.
    if (line.content.startsWith("- ")) break;
    const colon = findUnquotedColon(line.content);
    if (colon < 0) throw new YamlFault(manifestYamlMissingColon(line.lineNo, line.raw));
    const key = line.content.slice(0, colon).trim();
    const inline = line.content.slice(colon + 1).trim();
    cursor.idx += 1;
    map[key] = inline.length > 0 ? parseScalar(inline) : parseNested(lines, cursor, baseIndent);
  }
  return map;
}

/**
 * The fields of one `- ` item that continue on following lines.
 *
 * Siblings sit one level beyond the dash, which for the two-space dialect this
 * format uses is `baseIndent + 2`. Anything at another indent belongs to
 * somebody else and ends the item.
 */
function parseItemSiblings(
  lines: Line[],
  cursor: Cursor,
  baseIndent: number,
  item: { [key: string]: YamlValue },
): void {
  const siblingIndent = baseIndent + 2;
  while (cursor.idx < lines.length) {
    const sibling = lines[cursor.idx];
    if (sibling === undefined || sibling.indent !== siblingIndent) break;
    if (sibling.content.startsWith("- ")) break;
    const colon = findUnquotedColon(sibling.content);
    if (colon < 0) break;
    const key = sibling.content.slice(0, colon).trim();
    const inline = sibling.content.slice(colon + 1).trim();
    cursor.idx += 1;
    item[key] = inline.length > 0 ? parseScalar(inline) : parseNested(lines, cursor, siblingIndent);
  }
}

function parseList(lines: Line[], cursor: Cursor, baseIndent: number): YamlValue[] {
  const out: YamlValue[] = [];
  while (cursor.idx < lines.length) {
    const line = lines[cursor.idx];
    if (line === undefined || line.indent !== baseIndent || !line.content.startsWith("- ")) break;
    const rest = line.content.slice(2).trim();
    cursor.idx += 1;
    if (rest === "") {
      out.push(parseNested(lines, cursor, baseIndent));
      continue;
    }
    const colon = findUnquotedColon(rest);
    if (colon > 0) {
      const key = rest.slice(0, colon).trim();
      const inline = rest.slice(colon + 1).trim();
      const item: { [key: string]: YamlValue } = {};
      item[key] = inline.length > 0 ? parseScalar(inline) : parseNested(lines, cursor, baseIndent);
      parseItemSiblings(lines, cursor, baseIndent, item);
      out.push(item);
      continue;
    }
    out.push(parseScalar(rest));
  }
  return out;
}

/** Parse the dialect into a plain object. Trailing noise is tolerated. */
export function parseYamlSubset(text: string): Result<{ [key: string]: YamlValue }> {
  try {
    return ok(parseMap(tokenize(text), { idx: 0 }, 0));
  } catch (fault) {
    if (fault instanceof YamlFault) return err(fault.domainError);
    throw fault;
  }
}
