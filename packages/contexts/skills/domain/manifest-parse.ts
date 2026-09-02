// Turning a skill source file into a validated manifest, and back again.
//
// The format is a markdown file with a YAML frontmatter header:
//
//     ---
//     id: platos.web_search
//     ...
//     ---
//     <the prompt block>
//
// Everything below the closing fence is the prompt block, merged into the
// agent's system prompt when the skill is active. Everything above it is the
// manifest.
//
// VALIDATION IS TOTAL AND HAPPENS ONCE. `id` and `description` are required;
// `name` falls back to the id; `version` falls back to `DEFAULT_SKILL_VERSION`;
// every list defaults to empty. Downstream code receives a `SkillManifest` and
// never re-checks any of it. The one rule that rejects rather than defaults is
// the namespacing of `id`, because the slug is half of this context's
// uniqueness key and an un-namespaced id collides across authors.
//
// `required_env` IS A LIST OF NAMES. This layer validates the shape and nothing
// else: it never reads a value, never consults an environment, and never sees a
// secret. Readiness is a separate question asked at enable time against the
// `EnvironmentKeyDirectory` port (`domain/environment-readiness.ts`).

import { asIdentifier, err, ok, type JsonValue, type Result } from "@platos/kernel";

import {
  manifestFieldInvalid,
  manifestFieldMissing,
  manifestFrontmatterMissing,
  manifestIdInvalid,
} from "./errors.js";
import type { EnvironmentKey, SkillSlug, SkillVersion, ToolName } from "./identifiers.js";
import {
  DEFAULT_SKILL_VERSION,
  isNamespacedSkillId,
  isSkillOrigin,
  type ParsedSkill,
  type SkillManifest,
  type SkillProvidedTool,
} from "./manifest.js";
import { parseYamlSubset, type YamlValue } from "./manifest-yaml.js";

const FRONTMATTER = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/u;

function requiredString(value: YamlValue | undefined, field: string): Result<string> {
  if (typeof value !== "string" || value.trim() === "") return err(manifestFieldMissing(field));
  return ok(value.trim());
}

function optionalString(value: YamlValue | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A list of strings, or nothing.
 *
 * Absent and null both mean empty — an author who omits `tags` has no tags, and
 * that is not an error. A non-list, or a list holding a non-string, IS an error:
 * silently coercing `tags: search` into `["search"]` would let two manifests
 * that read differently store identically.
 */
function stringList(value: YamlValue | undefined, field: string): Result<readonly string[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) {
    return err(manifestFieldInvalid(field, `skill manifest field "${field}" must be a list of strings`));
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      return err(
        manifestFieldInvalid(
          `${field}[${index}]`,
          `skill manifest "${field}[${index}]" must be a string (received ${typeof item})`,
        ),
      );
    }
    out.push(item.trim());
  }
  return ok(out);
}

/** A schema is stored as supplied, so it is accepted only as a JSON object. */
function schemaOrNull(value: YamlValue | undefined): Readonly<Record<string, JsonValue>> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value as Readonly<Record<string, JsonValue>>;
}

function providedTool(entry: YamlValue, index: number): Result<SkillProvidedTool> {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return err(manifestFieldInvalid(`provides_tools[${index}]`, `provides_tools[${index}] must be an object`));
  }
  const record = entry as { [key: string]: YamlValue };
  const name = requiredString(record.name, `provides_tools[${index}].name`);
  if (!name.ok) return err(name.error);
  // A missing description is empty, not a failure: the live parser admits a
  // tool with a name alone, and rejecting one here would refuse manifests the
  // system already holds.
  const description = typeof record.description === "string" ? record.description : "";
  return ok({
    name: asIdentifier<ToolName>(name.value),
    description,
    inputSchema: schemaOrNull(record.inputSchema),
    outputSchema: schemaOrNull(record.outputSchema),
    handler: typeof record.handler === "string" ? record.handler : null,
  });
}

function providedTools(value: YamlValue | undefined): Result<readonly SkillProvidedTool[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) {
    return err(manifestFieldInvalid("provides_tools", `skill manifest "provides_tools" must be a list`));
  }
  const tools: SkillProvidedTool[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const tool = providedTool(value[index] as YamlValue, index);
    if (!tool.ok) return err(tool.error);
    tools.push(tool.value);
  }
  return ok(tools);
}

function keyList(value: YamlValue | undefined, field: string): Result<readonly EnvironmentKey[]> {
  const list = stringList(value, field);
  if (!list.ok) return err(list.error);
  return ok(list.value.map((key) => asIdentifier<EnvironmentKey>(key)));
}

export interface ManifestValidationOptions {
  /** The URL an import came from, recorded on the manifest it produced. */
  readonly importedFrom?: string | null;
}

export function validateManifest(
  raw: { readonly [key: string]: YamlValue },
  options: ManifestValidationOptions = {},
): Result<SkillManifest> {
  const id = requiredString(raw.id, "id");
  if (!id.ok) return err(id.error);
  if (!isNamespacedSkillId(id.value)) return err(manifestIdInvalid(id.value));

  const description = requiredString(raw.description, "description");
  if (!description.ok) return err(description.error);

  const requiredEnv = keyList(raw.required_env, "required_env");
  if (!requiredEnv.ok) return err(requiredEnv.error);
  const optionalEnv = keyList(raw.optional_env, "optional_env");
  if (!optionalEnv.ok) return err(optionalEnv.error);
  const tags = stringList(raw.tags, "tags");
  if (!tags.ok) return err(tags.error);
  const tools = providedTools(raw.provides_tools);
  if (!tools.ok) return err(tools.error);

  const declaredOrigin = optionalString(raw.origin);
  return ok({
    id: asIdentifier<SkillSlug>(id.value),
    // The id is the fallback name, so a manifest is never nameless.
    name: optionalString(raw.name) ?? id.value,
    description: description.value,
    version: asIdentifier<SkillVersion>(
      typeof raw.version === "string" ? raw.version : DEFAULT_SKILL_VERSION,
    ),
    author: optionalString(raw.author),
    // An origin the closed set does not contain is dropped rather than stored.
    // The registry decides origin anyway; a manifest only ever suggests one.
    origin: declaredOrigin !== null && isSkillOrigin(declaredOrigin) ? declaredOrigin : null,
    spec_version: optionalString(raw.spec_version),
    required_env: requiredEnv.value,
    optional_env: optionalEnv.value,
    provides_tools: tools.value,
    tags: tags.value,
    importedFrom: options.importedFrom ?? null,
    category: optionalString(raw.category),
  });
}

/** Split a source file into its manifest and its prompt block. */
export function parseSkillSource(
  source: string,
  options: ManifestValidationOptions = {},
): Result<ParsedSkill> {
  const match = FRONTMATTER.exec(source);
  if (match === null) return err(manifestFrontmatterMissing());
  const [, frontmatter = "", body = ""] = match;
  const raw = parseYamlSubset(frontmatter);
  if (!raw.ok) return err(raw.error);
  const manifest = validateManifest(raw.value, options);
  if (!manifest.ok) return err(manifest.error);
  return ok({ manifest: manifest.value, promptBlock: body.trim(), source });
}

/**
 * Quote a scalar only when leaving it bare would change what it means.
 *
 * The list is the live serialiser's: anything carrying YAML punctuation or
 * whitespace, anything opening with `-` or `?`, and the three literals that
 * would otherwise stop being strings.
 */
function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (/[:#&*!|>'"%@`\s{}[\],]/u.test(value) || /^[-?]/u.test(value) || /^(true|false|null|~)$/iu.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function appendList(lines: string[], field: string, values: readonly string[]): void {
  if (values.length === 0) return;
  lines.push(`${field}:`);
  for (const value of values) lines.push(`  - ${yamlScalar(value)}`);
}

/**
 * Render a parsed skill back to the canonical source form.
 *
 * An import re-serialises so that what is stored is diffable and so a
 * round-trip is verifiable. `importedFrom` is deliberately NOT emitted: it
 * describes where this copy came from, not what the skill is, and writing it
 * into the source would make a re-import of the re-serialised file claim the
 * wrong provenance.
 */
export function serializeSkill(parsed: ParsedSkill): string {
  const manifest = parsed.manifest;
  const lines: string[] = ["---"];
  lines.push(`id: ${yamlScalar(manifest.id)}`);
  lines.push(`name: ${yamlScalar(manifest.name)}`);
  lines.push(`description: ${yamlScalar(manifest.description)}`);
  lines.push(`version: ${yamlScalar(manifest.version)}`);
  if (manifest.author !== null) lines.push(`author: ${yamlScalar(manifest.author)}`);
  if (manifest.origin !== null) lines.push(`origin: ${yamlScalar(manifest.origin)}`);
  if (manifest.spec_version !== null) lines.push(`spec_version: ${yamlScalar(manifest.spec_version)}`);
  if (manifest.category !== null) lines.push(`category: ${yamlScalar(manifest.category)}`);
  appendList(lines, "required_env", manifest.required_env);
  appendList(lines, "optional_env", manifest.optional_env);
  appendList(lines, "tags", manifest.tags);
  if (manifest.provides_tools.length > 0) {
    lines.push("provides_tools:");
    for (const tool of manifest.provides_tools) {
      lines.push(`  - name: ${yamlScalar(tool.name)}`);
      lines.push(`    description: ${yamlScalar(tool.description)}`);
      if (tool.inputSchema !== null) lines.push(`    inputSchema: ${JSON.stringify(tool.inputSchema)}`);
      if (tool.outputSchema !== null) lines.push(`    outputSchema: ${JSON.stringify(tool.outputSchema)}`);
      if (tool.handler !== null) lines.push(`    handler: ${yamlScalar(tool.handler)}`);
    }
  }
  lines.push("---");
  lines.push("");
  lines.push(parsed.promptBlock);
  return lines.join("\n");
}
