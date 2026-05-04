/**
 * Phase 3 — minimal frontmatter parser tailored to the docs/ + guides/
 * frontmatter shape.
 *
 * Supported keys (all optional, all parsed type-correctly):
 *
 *     slug: string
 *     title: string
 *     description: string
 *     category: string
 *     order: number                 (parsed as integer)
 *     trigger_dev_primitive: bool
 *     trigger_dev_link: string
 *     questions:                    (array of strings)
 *       - "..."
 *       - "..."
 *     related:                      (array of strings)
 *       - slug-1
 *       - slug-2
 *     source_files_referenced:      (array of strings)
 *       - path/to/file.ts
 *
 * Plus a permissive `extra: Record<string, unknown>` for anything we
 * didn't whitelist — preserved opaquely so future content can ride along
 * without parser changes.
 */

export interface DocFrontmatter {
  slug: string;
  title: string;
  description: string;
  category: string;
  order: number;
  trigger_dev_primitive: boolean;
  trigger_dev_link: string;
  questions: string[];
  related: string[];
  source_files_referenced: string[];
  extra: Record<string, unknown>;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

interface SplitResult {
  yaml: string;
  body: string;
}

/** Split a markdown source into `yaml` (frontmatter text) + `body`. */
export function splitFrontmatter(source: string): SplitResult {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    return { yaml: "", body: source };
  }
  const [, yaml, body] = match as [string, string, string];
  return { yaml, body };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(raw: string): string | number | boolean {
  const v = unquote(raw);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "" || v === "null" || v === "~") return "";
  // Only treat as number if it round-trips cleanly (avoids slug-like
  // strings that start with digits).
  if (/^-?\d+$/.test(v)) {
    const n = parseInt(v, 10);
    if (String(n) === v) return n;
  }
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

/**
 * Parse a YAML subset matching what we ship in content/. Returns a flat
 * `Record<string, unknown>` — caller normalizes to `DocFrontmatter`.
 *
 * Subset rules:
 *   - Top-level lines `key: value` → scalar entry.
 *   - Top-level line `key:` followed by `- item` lines (indented 2 spaces)
 *     → array-of-strings entry.
 *   - Comments (`#`) and blank lines ignored.
 *   - Anything else (nested objects, anchors, multi-doc) is silently
 *     ignored — keeps the parser tiny + free of surprises.
 */
export function parseYamlBlock(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: Record<string, unknown> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }
    // Top-level only: lines that don't start with whitespace.
    if (line.startsWith(" ") || line.startsWith("\t")) {
      i += 1;
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue !== "") {
      // Inline scalar.
      out[key] = parseScalar(rawValue);
      i += 1;
      continue;
    }

    // Block — collect indented `- item` entries until we hit a non-indented line.
    const items: unknown[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      const nextTrim = next.trim();
      if (!nextTrim) {
        j += 1;
        continue;
      }
      if (!next.startsWith(" ") && !next.startsWith("\t")) {
        break;
      }
      // Look for `- value` (with optional surrounding spaces).
      const dashIdx = next.indexOf("- ");
      if (dashIdx >= 0) {
        const itemRaw = next.slice(dashIdx + 2).trim();
        items.push(parseScalar(itemRaw));
      }
      j += 1;
    }
    out[key] = items;
    i = j;
  }
  return out;
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.toLowerCase().trim();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string" ? item : typeof item === "number" || typeof item === "boolean" ? String(item) : null,
    )
    .filter((s): s is string => s !== null);
}

/** Normalize a raw frontmatter object into the typed DocFrontmatter shape. */
export function normalizeFrontmatter(
  raw: Record<string, unknown>,
  fallbackSlug: string,
): DocFrontmatter {
  const known = new Set([
    "slug",
    "title",
    "description",
    "category",
    "order",
    "trigger_dev_primitive",
    "trigger_dev_link",
    "questions",
    "related",
    "source_files_referenced",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) extra[k] = v;
  }
  return {
    slug: asString(raw.slug, fallbackSlug),
    title: asString(raw.title, fallbackSlug),
    description: asString(raw.description),
    category: asString(raw.category, "uncategorized"),
    order: asNumber(raw.order, 999),
    trigger_dev_primitive: asBoolean(raw.trigger_dev_primitive, false),
    trigger_dev_link: asString(raw.trigger_dev_link),
    questions: asStringArray(raw.questions),
    related: asStringArray(raw.related),
    source_files_referenced: asStringArray(raw.source_files_referenced),
    extra,
  };
}

/** Convenience: split + parse + normalize in one step. */
export function parseDoc(source: string, fallbackSlug: string): {
  frontmatter: DocFrontmatter;
  body: string;
} {
  const { yaml, body } = splitFrontmatter(source);
  const raw = parseYamlBlock(yaml);
  return { frontmatter: normalizeFrontmatter(raw, fallbackSlug), body };
}
