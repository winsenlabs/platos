import { describe, expect, it } from "vitest";

import { parseSkillSource, serializeSkill, validateManifest } from "./manifest-parse.js";
import { DEFAULT_SKILL_VERSION } from "./manifest.js";
import { parseYamlSubset } from "./manifest-yaml.js";

const MINIMAL = ["---", "id: platos.web_search", "description: Search the web.", "---", "", "Body."].join("\n");

function parsed(source: string) {
  const result = parseSkillSource(source);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("parseSkillSource", () => {
  it("splits frontmatter from the prompt block and trims the body", () => {
    const skill = parsed(MINIMAL);
    expect(skill.manifest.id).toBe("platos.web_search");
    expect(skill.promptBlock).toBe("Body.");
    expect(skill.source).toBe(MINIMAL);
  });

  it("REFUSES a source with no frontmatter fence", () => {
    const result = parseSkillSource("Just a markdown file.");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_FRONTMATTER_MISSING");
  });

  it("REFUSES an id that is not namespaced", () => {
    const result = parseSkillSource(
      ["---", "id: web_search", "description: d", "---", "", "b"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_ID_INVALID");
  });

  it("REFUSES a manifest with no description", () => {
    const result = parseSkillSource(["---", "id: a.b", "---", "", "b"].join("\n"));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_FIELD_MISSING");
    expect(result.error.fields[0]?.field).toBe("description");
  });

  it("falls back to the id for a missing name and to a fixed version", () => {
    const skill = parsed(MINIMAL);
    expect(skill.manifest.name).toBe("platos.web_search");
    expect(skill.manifest.version).toBe(DEFAULT_SKILL_VERSION);
  });

  it("carries importedFrom from the option rather than from the document", () => {
    const result = parseSkillSource(MINIMAL, { importedFrom: "https://example.test/s.md" });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.manifest.importedFrom).toBe("https://example.test/s.md");
  });

  it("REFUSES a declared origin it does not recognise, rather than storing it", () => {
    const skill = parsed(
      ["---", "id: a.b", "description: d", "origin: sideloaded", "---", "", "b"].join("\n"),
    );
    expect(skill.manifest.origin).toBeNull();
  });

  it("keeps a recognised declared origin", () => {
    const skill = parsed(
      ["---", "id: a.b", "description: d", "origin: community", "---", "", "b"].join("\n"),
    );
    expect(skill.manifest.origin).toBe("community");
  });

  it("REFUSES a scalar where a list belongs, rather than coercing it", () => {
    const result = parseSkillSource(
      ["---", "id: a.b", "description: d", "tags: search", "---", "", "b"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_FIELD_INVALID");
  });

  it("REFUSES a list holding a non-string", () => {
    const result = parseSkillSource(
      ["---", "id: a.b", "description: d", "tags:", "  - 42", "---", "", "b"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.fields[0]?.field).toBe("tags[0]");
  });

  it("reads a list of maps into provided tools, with schemas kept verbatim", () => {
    const skill = parsed(
      [
        "---",
        "id: a.b",
        "description: d",
        "provides_tools:",
        "  - name: search",
        "    description: Find things.",
        '    inputSchema: {"type":"object","properties":{"q":{"type":"string"}}}',
        "    handler: skill:a.b:search",
        "---",
        "",
        "b",
      ].join("\n"),
    );
    expect(skill.manifest.provides_tools).toHaveLength(1);
    const tool = skill.manifest.provides_tools[0];
    expect(tool?.name).toBe("search");
    expect(tool?.handler).toBe("skill:a.b:search");
    expect(tool?.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
  });

  it("admits a tool that declares only a name, giving it an empty description", () => {
    const skill = parsed(
      ["---", "id: a.b", "description: d", "provides_tools:", "  - name: only", "---", "", "b"].join("\n"),
    );
    expect(skill.manifest.provides_tools[0]).toMatchObject({ name: "only", description: "", handler: null });
  });

  it("REFUSES a tool with no name", () => {
    const result = parseSkillSource(
      ["---", "id: a.b", "description: d", "provides_tools:", "  - description: x", "---", "", "b"].join("\n"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("SKILLS_MANIFEST_FIELD_MISSING");
  });

  it("does not lowercase a mixed-case id — the slug is stored as written", () => {
    const skill = parsed(["---", "id: Acme.Web_Search", "description: d", "---", "", "b"].join("\n"));
    expect(skill.manifest.id).toBe("Acme.Web_Search");
  });

  it("treats a quoted value carrying a hash as text, not as a comment", () => {
    const skill = parsed(['---', 'id: a.b', 'description: "issue #12 handling"', "---", "", "b"].join("\n"));
    expect(skill.manifest.description).toBe("issue #12 handling");
  });
});

describe("validateManifest", () => {
  it("defaults every list to empty when the document omits them", () => {
    const raw = parseYamlSubset("id: a.b\ndescription: d");
    if (!raw.ok) throw new Error(raw.error.code);
    const manifest = validateManifest(raw.value);
    if (!manifest.ok) throw new Error(manifest.error.code);
    expect(manifest.value.required_env).toEqual([]);
    expect(manifest.value.optional_env).toEqual([]);
    expect(manifest.value.tags).toEqual([]);
    expect(manifest.value.provides_tools).toEqual([]);
  });
});

describe("serializeSkill", () => {
  it("round-trips a rich manifest back to an equal manifest", () => {
    const original = parsed(
      [
        "---",
        "id: acme.csv-ops",
        "name: CSV Operations",
        "description: Work with CSV files.",
        "version: 2.1.0",
        "author: Acme",
        "category: data",
        "required_env:",
        "  - ACME_TOKEN",
        "optional_env:",
        "  - ACME_REGION",
        "tags:",
        "  - data",
        "  - csv",
        "provides_tools:",
        "  - name: read",
        "    description: Read a file.",
        '    inputSchema: {"type":"object"}',
        "    handler: skill:acme.csv-ops:read",
        "---",
        "",
        "Use for CSV work.",
      ].join("\n"),
    );
    const round = parsed(serializeSkill(original));
    expect(round.manifest).toEqual(original.manifest);
    expect(round.promptBlock).toBe(original.promptBlock);
  });

  it("does NOT emit importedFrom — provenance is not part of the document", () => {
    const result = parseSkillSource(MINIMAL, { importedFrom: "https://example.test/s.md" });
    if (!result.ok) throw new Error(result.error.code);
    const text = serializeSkill(result.value);
    expect(text).not.toContain("importedFrom");
    expect(parsed(text).manifest.importedFrom).toBeNull();
  });

  it("quotes a value that would otherwise stop being a string", () => {
    const skill = parsed(['---', 'id: a.b', 'description: "true"', "---", "", "b"].join("\n"));
    expect(skill.manifest.description).toBe("true");
    expect(parsed(serializeSkill(skill)).manifest.description).toBe("true");
  });
});
