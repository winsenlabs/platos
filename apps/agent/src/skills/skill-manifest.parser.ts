/**
 * Theme S — Skill manifest parser.
 *
 * Parses a Claude-skills-format markdown file:
 *
 *     ---
 *     <YAML frontmatter>
 *     ---
 *     <prompt block markdown body>
 *
 * Format invariant: `required_env` is enforced by the caller at enable-time
 * (see SkillRegistryService.enableForAgent) — we validate shape here but
 * don't touch `process.env`.
 *
 * YAML subset supported (deliberately minimal — no external dep, no eval):
 *   key: value
 *   key: "value with spaces"
 *   key:
 *     - item1
 *     - item2
 *   key:
 *     nested_key: nested_value
 *     nested_list:
 *       - a
 *       - b
 *   key:
 *     - name: a
 *       description: b
 *
 * Nested inputSchema objects are parsed by the same recursive routine. If
 * a skill author wants richer YAML (anchors, multi-doc, etc.) they can
 * inline a JSON object literal instead — any `{ ... }` or `[ ... ]` value is
 * parsed via JSON.parse as a fallback.
 */
import type { ParsedSkill, SkillManifest, SkillProvidedTool } from "./skill-manifest.types";
import { SkillParseError } from "./skill-manifest.types";

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;

/** Parse a skill source file into a manifest + prompt block. */
export function parseSkill(source: string, opts?: { importedFrom?: string }): ParsedSkill {
  const match = source.match(FRONTMATTER_RE);
  if (!match) {
    throw new SkillParseError(
      "Skill source is missing a YAML frontmatter header (expected `---\\n<yaml>\\n---`).",
      "missing_frontmatter",
    );
  }
  const [, yamlText, body] = match as [string, string, string];
  const raw = parseYamlSubset(yamlText);
  const manifest = validateManifest(raw, opts?.importedFrom);
  return {
    manifest,
    promptBlock: body.trim(),
    source,
  };
}

/**
 * Serialize a ParsedSkill back to the canonical markdown format. Used when
 * importing from Claude-skills URLs (we re-serialise so edits are diffable).
 */
export function serializeSkill(parsed: ParsedSkill): string {
  const m = parsed.manifest;
  const lines: string[] = ["---"];
  lines.push(`id: ${yamlScalar(m.id)}`);
  lines.push(`name: ${yamlScalar(m.name)}`);
  lines.push(`description: ${yamlScalar(m.description)}`);
  lines.push(`version: ${yamlScalar(m.version)}`);
  if (m.author) lines.push(`author: ${yamlScalar(m.author)}`);
  if (m.origin) lines.push(`origin: ${yamlScalar(m.origin)}`);
  if (m.spec_version) lines.push(`spec_version: ${yamlScalar(m.spec_version)}`);
  // TL.1 — preserve category round-trip so library imports don't lose the
  // frontmatter grouping hint.
  if (m.category) lines.push(`category: ${yamlScalar(m.category)}`);
  if (m.required_env.length > 0) {
    lines.push(`required_env:`);
    for (const e of m.required_env) lines.push(`  - ${yamlScalar(e)}`);
  }
  if (m.optional_env.length > 0) {
    lines.push(`optional_env:`);
    for (const e of m.optional_env) lines.push(`  - ${yamlScalar(e)}`);
  }
  if (m.tags.length > 0) {
    lines.push(`tags:`);
    for (const t of m.tags) lines.push(`  - ${yamlScalar(t)}`);
  }
  if (m.provides_tools.length > 0) {
    lines.push(`provides_tools:`);
    for (const t of m.provides_tools) {
      lines.push(`  - name: ${yamlScalar(t.name)}`);
      lines.push(`    description: ${yamlScalar(t.description)}`);
      if (t.inputSchema) lines.push(`    inputSchema: ${JSON.stringify(t.inputSchema)}`);
      if (t.outputSchema) lines.push(`    outputSchema: ${JSON.stringify(t.outputSchema)}`);
      if (t.handler) lines.push(`    handler: ${yamlScalar(t.handler)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(parsed.promptBlock);
  return lines.join("\n");
}

function yamlScalar(v: string): string {
  if (v === "") return '""';
  if (/[:#&*!|>'"%@`\s{}[\],]/.test(v) || /^[-?]/.test(v) || /^(true|false|null|~)$/i.test(v)) {
    return JSON.stringify(v);
  }
  return v;
}

function validateManifest(raw: Record<string, unknown>, importedFrom?: string): SkillManifest {
  const id = stringRequired(raw.id, "id");
  if (!/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/i.test(id)) {
    throw new SkillParseError(
      `Skill id "${id}" must be namespaced (e.g. "platos.web_search"). Format: lowercase + digits + dots.`,
      "invalid_id",
    );
  }
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const description = stringRequired(raw.description, "description");
  const version = typeof raw.version === "string" ? raw.version : "0.0.1";
  const author = typeof raw.author === "string" ? raw.author : undefined;
  const origin = typeof raw.origin === "string" ? raw.origin : undefined;
  const spec_version = typeof raw.spec_version === "string" ? raw.spec_version : undefined;
  const required_env = stringArray(raw.required_env, "required_env");
  const optional_env = stringArray(raw.optional_env, "optional_env");
  const tags = stringArray(raw.tags, "tags");
  const provides_tools = toolsArray(raw.provides_tools);
  // TL.1 — optional `category` frontmatter field. Downstream falls back
  // to a slug-derived default when absent.
  const category = typeof raw.category === "string" && raw.category.trim()
    ? raw.category.trim()
    : undefined;

  return {
    id,
    name,
    description,
    version,
    ...(author !== undefined ? { author } : {}),
    ...(origin !== undefined ? { origin } : {}),
    ...(spec_version !== undefined ? { spec_version } : {}),
    required_env,
    optional_env,
    provides_tools,
    tags,
    ...(importedFrom ? { importedFrom } : {}),
    ...(category !== undefined ? { category } : {}),
  };
}

function stringRequired(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new SkillParseError(`Skill manifest is missing required field "${field}".`, "missing_field");
  }
  return v.trim();
}

function stringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new SkillParseError(`Skill manifest field "${field}" must be a list of strings.`, "invalid_field");
  }
  return v.map((item, i) => {
    if (typeof item !== "string") {
      throw new SkillParseError(
        `Skill manifest "${field}[${i}]" must be a string (got ${typeof item}).`,
        "invalid_field",
      );
    }
    return item.trim();
  });
}

function toolsArray(v: unknown): SkillProvidedTool[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new SkillParseError(`Skill manifest "provides_tools" must be a list.`, "invalid_field");
  }
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new SkillParseError(`provides_tools[${i}] must be an object.`, "invalid_field");
    }
    const e = entry as Record<string, unknown>;
    const name = stringRequired(e.name, `provides_tools[${i}].name`);
    const description = typeof e.description === "string" ? e.description : "";
    const tool: SkillProvidedTool = { name, description };
    if (e.inputSchema && typeof e.inputSchema === "object") {
      tool.inputSchema = e.inputSchema as Record<string, unknown>;
    }
    if (e.outputSchema && typeof e.outputSchema === "object") {
      tool.outputSchema = e.outputSchema as Record<string, unknown>;
    }
    if (typeof e.handler === "string") tool.handler = e.handler;
    return tool;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal YAML-subset parser
// ─────────────────────────────────────────────────────────────────────────────

type Line = { indent: number; content: string; raw: string; lineNo: number };

function tokenize(text: string): Line[] {
  const lines = text.split(/\r?\n/);
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // strip trailing comment only if it's preceded by whitespace or at start
    let trimmed = raw;
    const hashIdx = findUnquotedHash(raw);
    if (hashIdx >= 0) trimmed = raw.slice(0, hashIdx);
    if (!trimmed.trim()) continue;
    const indent = trimmed.length - trimmed.trimStart().length;
    out.push({ indent, content: trimmed.trim(), raw: trimmed, lineNo: i + 1 });
  }
  return out;
}

function findUnquotedHash(s: string): number {
  let inQuote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#") return i;
  }
  return -1;
}

/** Parse our limited YAML dialect → plain JS object. */
export function parseYamlSubset(text: string): Record<string, unknown> {
  const lines = tokenize(text);
  const state = { idx: 0 };
  const result = parseMap(lines, state, 0);
  if (state.idx !== lines.length) {
    // trailing noise — tolerate but ignore
  }
  return result;
}

function parseMap(lines: Line[], state: { idx: number }, baseIndent: number): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  while (state.idx < lines.length) {
    const line = lines[state.idx]!;
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) {
      // shouldn't happen at map level; guard against malformed input
      throw new SkillParseError(`Unexpected indent at line ${line.lineNo}: "${line.raw}"`, "yaml_indent");
    }
    if (line.content.startsWith("- ")) break; // we are actually in a list
    const colonIdx = findUnquotedColon(line.content);
    if (colonIdx < 0) {
      throw new SkillParseError(`Expected "key: value" at line ${line.lineNo}: "${line.raw}"`, "yaml_missing_colon");
    }
    const key = line.content.slice(0, colonIdx).trim();
    const inlineVal = line.content.slice(colonIdx + 1).trim();
    state.idx++;
    if (inlineVal.length > 0) {
      obj[key] = parseScalar(inlineVal);
    } else {
      // nested value — look at the next non-empty line's indent
      const next = lines[state.idx];
      if (!next || next.indent <= baseIndent) {
        obj[key] = null;
      } else if (next.content.startsWith("- ")) {
        obj[key] = parseList(lines, state, next.indent);
      } else {
        obj[key] = parseMap(lines, state, next.indent);
      }
    }
  }
  return obj;
}

function parseList(lines: Line[], state: { idx: number }, baseIndent: number): unknown[] {
  const out: unknown[] = [];
  while (state.idx < lines.length) {
    const line = lines[state.idx]!;
    if (line.indent !== baseIndent || !line.content.startsWith("- ")) break;
    const rest = line.content.slice(2).trim();
    state.idx++;
    if (rest === "") {
      // Nested map follows with deeper indent
      const next = lines[state.idx];
      if (next && next.indent > baseIndent) {
        out.push(parseMap(lines, state, next.indent));
      } else {
        out.push(null);
      }
      continue;
    }
    // Could be "name: value" first field of a map-item or a scalar item.
    const colonIdx = findUnquotedColon(rest);
    if (colonIdx > 0) {
      // map-item — build a synthetic key/value then parse remaining deeper
      // lines as same-indent map fields
      const key = rest.slice(0, colonIdx).trim();
      const inlineVal = rest.slice(colonIdx + 1).trim();
      const mapItem: Record<string, unknown> = {};
      if (inlineVal.length > 0) {
        mapItem[key] = parseScalar(inlineVal);
      } else {
        const next = lines[state.idx];
        if (next && next.indent > baseIndent) {
          mapItem[key] = next.content.startsWith("- ")
            ? parseList(lines, state, next.indent)
            : parseMap(lines, state, next.indent);
        } else {
          mapItem[key] = null;
        }
      }
      // Pick up sibling fields at indent = baseIndent + 2 (one level beyond "-")
      const siblingIndent = baseIndent + 2;
      while (state.idx < lines.length) {
        const sib = lines[state.idx]!;
        if (sib.indent !== siblingIndent) break;
        if (sib.content.startsWith("- ")) break;
        const sibColon = findUnquotedColon(sib.content);
        if (sibColon < 0) break;
        const sk = sib.content.slice(0, sibColon).trim();
        const sv = sib.content.slice(sibColon + 1).trim();
        state.idx++;
        if (sv.length > 0) {
          mapItem[sk] = parseScalar(sv);
        } else {
          const next = lines[state.idx];
          if (next && next.indent > siblingIndent) {
            mapItem[sk] = next.content.startsWith("- ")
              ? parseList(lines, state, next.indent)
              : parseMap(lines, state, next.indent);
          } else {
            mapItem[sk] = null;
          }
        }
      }
      out.push(mapItem);
    } else {
      out.push(parseScalar(rest));
    }
  }
  return out;
}

function findUnquotedColon(s: string): number {
  let inQuote: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote && s[i - 1] !== "\\") inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === ":" && depth === 0) return i;
  }
  return -1;
}

function parseScalar(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed.length === 0) return "";
  // JSON inline
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to string
    }
  }
  // Quoted strings
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  // Booleans, null, numbers
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
