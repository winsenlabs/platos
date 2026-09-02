import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { NamespacedToolName, SkillSlug, ToolName } from "./identifiers.js";
import {
  isToolOfSkill,
  namespaceTool,
  TOOL_NAMESPACE_SEPARATOR,
  toolNamespacePrefix,
} from "./tool-namespace.js";

const slug = (value: string): SkillSlug => asIdentifier<SkillSlug>(value);
const tool = (value: string): ToolName => asIdentifier<ToolName>(value);

describe("toolNamespacePrefix", () => {
  it("replaces dots with underscores", () => {
    expect(toolNamespacePrefix(slug("platos.web_search"))).toBe("platos_web_search");
  });

  it("replaces hyphens with underscores too", () => {
    expect(toolNamespacePrefix(slug("acme.csv-ops"))).toBe("acme_csv_ops");
  });

  it("leaves an already-plain slug alone", () => {
    expect(toolNamespacePrefix(slug("acme.rag"))).toBe("acme_rag");
  });
});

describe("namespaceTool", () => {
  it("joins the prefix and the tool name with a double underscore", () => {
    expect(namespaceTool(slug("platos.web_search"), tool("search"))).toBe("platos_web_search__search");
  });

  it("uses a DOUBLE separator, so a folded dot cannot collide with a real one", () => {
    // Both slugs fold to something containing `a_b`; a single separator would
    // make these two different tools produce the identical name.
    const first = namespaceTool(slug("a.b"), tool("c"));
    const second = namespaceTool(slug("a"), tool("b_c"));
    expect(first).toBe(`a_b${TOOL_NAMESPACE_SEPARATOR}c`);
    expect(second).toBe(`a${TOOL_NAMESPACE_SEPARATOR}b_c`);
    expect(first).not.toBe(second);
  });

  it("is stable — the same inputs always give the same name", () => {
    expect(namespaceTool(slug("a.b"), tool("x"))).toBe(namespaceTool(slug("a.b"), tool("x")));
  });
});

describe("isToolOfSkill", () => {
  it("claims a tool its own skill produced", () => {
    expect(isToolOfSkill(namespaceTool(slug("a.b"), tool("x")), slug("a.b"))).toBe(true);
  });

  it("REFUSES a tool from a different skill", () => {
    expect(isToolOfSkill(namespaceTool(slug("a.b"), tool("x")), slug("c.d"))).toBe(false);
  });

  it("is not fooled by a slug that merely BEGINS the same", () => {
    // Without the separator in the comparison, `platos.web` would claim a tool
    // belonging to `platos.web_search`, and a per-skill check would apply one
    // skill's rules to another's tool.
    const name = namespaceTool(slug("platos.web_search"), tool("go"));
    expect(isToolOfSkill(name, slug("platos.web"))).toBe(false);
    expect(isToolOfSkill(name, slug("platos.web_search"))).toBe(true);
  });

  it("REFUSES a bare tool name that was never namespaced", () => {
    expect(isToolOfSkill(asIdentifier<NamespacedToolName>("search"), slug("a.b"))).toBe(false);
  });
});
