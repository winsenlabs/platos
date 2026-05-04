/**
 * Theme S — Skill manifest parser tests.
 *
 * Covers:
 *   - Valid frontmatter + prompt block round-trip
 *   - Missing frontmatter throws with a helpful message
 *   - Required fields (id, description) enforced
 *   - Namespace enforcement on id
 *   - Lists + nested maps parsed correctly
 *   - JSON-literal fallback for complex inputSchema
 *
 * CLAUDE.md §9.11: Vitest only. Parser is pure — no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { parseSkill, parseYamlSubset, serializeSkill } from "./skill-manifest.parser";
import { SkillParseError } from "./skill-manifest.types";

const VALID_SKILL = `---
id: platos.web_search
name: Web Search
description: Search the public web with Tavily.
version: 0.1.0
author: Platos
required_env:
  - TAVILY_API_KEY
optional_env:
  - EXA_API_KEY
tags:
  - search
  - research
provides_tools:
  - name: web_search
    description: Search the web.
    inputSchema: {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
  - name: fetch_url
    description: Fetch a single URL.
---
You can search the web and fetch URLs when the user asks about recent events.`;

describe("parseSkill", () => {
  it("parses a valid Claude-skills-format file", () => {
    const parsed = parseSkill(VALID_SKILL);
    expect(parsed.manifest.id).toBe("platos.web_search");
    expect(parsed.manifest.name).toBe("Web Search");
    expect(parsed.manifest.version).toBe("0.1.0");
    expect(parsed.manifest.required_env).toEqual(["TAVILY_API_KEY"]);
    expect(parsed.manifest.optional_env).toEqual(["EXA_API_KEY"]);
    expect(parsed.manifest.tags).toEqual(["search", "research"]);
    expect(parsed.manifest.provides_tools).toHaveLength(2);
    expect(parsed.manifest.provides_tools[0]!.name).toBe("web_search");
    expect(parsed.manifest.provides_tools[0]!.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
    });
    expect(parsed.promptBlock).toContain("You can search the web");
  });

  it("throws SkillParseError when frontmatter is missing", () => {
    expect(() => parseSkill("# just markdown")).toThrow(SkillParseError);
  });

  it("throws when id is missing", () => {
    const src = `---\ndescription: Foo\n---\nbody`;
    expect(() => parseSkill(src)).toThrow(/id/);
  });

  it("enforces namespaced id format", () => {
    const src = `---\nid: foo\ndescription: Bar\n---\nbody`;
    expect(() => parseSkill(src)).toThrow(/namespaced/);
  });

  it("defaults missing optional fields", () => {
    const src = `---\nid: acme.foo\ndescription: A skill.\n---\nHello.`;
    const p = parseSkill(src);
    expect(p.manifest.name).toBe("acme.foo");
    expect(p.manifest.version).toBe("0.0.1");
    expect(p.manifest.required_env).toEqual([]);
    expect(p.manifest.provides_tools).toEqual([]);
  });

  it("captures importedFrom when provided", () => {
    const p = parseSkill(VALID_SKILL, { importedFrom: "https://claude.ai/skills/web-search" });
    expect(p.manifest.importedFrom).toBe("https://claude.ai/skills/web-search");
  });

  it("round-trips through serializeSkill", () => {
    const parsed = parseSkill(VALID_SKILL);
    const serialized = serializeSkill(parsed);
    const reparsed = parseSkill(serialized);
    expect(reparsed.manifest.id).toBe(parsed.manifest.id);
    expect(reparsed.manifest.required_env).toEqual(parsed.manifest.required_env);
    expect(reparsed.manifest.provides_tools[0]!.inputSchema).toEqual(
      parsed.manifest.provides_tools[0]!.inputSchema,
    );
    expect(reparsed.promptBlock).toBe(parsed.promptBlock);
  });
});

describe("parseYamlSubset", () => {
  it("parses key/value pairs", () => {
    expect(parseYamlSubset("a: 1\nb: hello")).toEqual({ a: 1, b: "hello" });
  });

  it("parses lists of scalars", () => {
    expect(parseYamlSubset("items:\n  - a\n  - b\n  - c")).toEqual({ items: ["a", "b", "c"] });
  });

  it("parses lists of maps", () => {
    const doc = "tools:\n  - name: a\n    description: A\n  - name: b\n    description: B";
    expect(parseYamlSubset(doc)).toEqual({
      tools: [
        { name: "a", description: "A" },
        { name: "b", description: "B" },
      ],
    });
  });

  it("parses JSON-literal values", () => {
    const doc = 'schema: {"type":"object"}';
    expect(parseYamlSubset(doc)).toEqual({ schema: { type: "object" } });
  });

  it("strips # comments", () => {
    expect(parseYamlSubset("a: 1  # note")).toEqual({ a: 1 });
  });

  it("handles quoted strings with spaces/colons", () => {
    expect(parseYamlSubset('a: "hello: world"')).toEqual({ a: "hello: world" });
  });
});
