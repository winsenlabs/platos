import { describe, expect, it } from "vitest";
import { parseDoc, parseYamlBlock, splitFrontmatter } from "./frontmatter.js";

const SAMPLE = `---
slug: agents
title: Agents
description: Durable, versioned agents.
category: platform
order: 10
trigger_dev_primitive: false
trigger_dev_link: ""
questions:
  - "How do I create an agent?"
  - "What is versioning?"
related:
  - skills
  - tools
source_files_referenced:
  - apps/agent/src/agent-runtime/agent.controller.ts
---

# Agents

Body content here.`;

describe("splitFrontmatter", () => {
  it("splits yaml + body cleanly", () => {
    const { yaml, body } = splitFrontmatter(SAMPLE);
    expect(yaml).toContain("slug: agents");
    expect(body.trim().startsWith("# Agents")).toBe(true);
  });

  it("returns empty yaml when no frontmatter", () => {
    const out = splitFrontmatter("# No frontmatter\nhi");
    expect(out.yaml).toBe("");
    expect(out.body).toContain("# No frontmatter");
  });
});

describe("parseYamlBlock", () => {
  it("parses scalar + array entries", () => {
    const yaml = `slug: agents
order: 10
trigger_dev_primitive: false
questions:
  - "Q1"
  - "Q2"`;
    const out = parseYamlBlock(yaml);
    expect(out.slug).toBe("agents");
    expect(out.order).toBe(10);
    expect(out.trigger_dev_primitive).toBe(false);
    expect(out.questions).toEqual(["Q1", "Q2"]);
  });

  it("ignores comments + blank lines", () => {
    const yaml = `# header comment
slug: x

# another
order: 5`;
    const out = parseYamlBlock(yaml);
    expect(out.slug).toBe("x");
    expect(out.order).toBe(5);
  });
});

describe("parseDoc", () => {
  it("normalizes types", () => {
    const { frontmatter, body } = parseDoc(SAMPLE, "fallback-slug");
    expect(frontmatter.slug).toBe("agents");
    expect(frontmatter.title).toBe("Agents");
    expect(frontmatter.order).toBe(10);
    expect(frontmatter.trigger_dev_primitive).toBe(false);
    expect(frontmatter.questions).toHaveLength(2);
    expect(frontmatter.related).toEqual(["skills", "tools"]);
    expect(frontmatter.source_files_referenced).toHaveLength(1);
    expect(body.trim().startsWith("# Agents")).toBe(true);
  });

  it("falls back to default slug when missing", () => {
    const { frontmatter } = parseDoc("# Nothing", "my-fallback");
    expect(frontmatter.slug).toBe("my-fallback");
    expect(frontmatter.category).toBe("uncategorized");
    expect(frontmatter.order).toBe(999);
  });
});
