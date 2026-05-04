import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocRepository } from "./repository.js";

let tmpRoot: string;

const DOC_AGENTS = `---
slug: agents
title: Agents
description: Durable agents.
category: platform
order: 10
trigger_dev_primitive: false
questions:
  - "How do I version + roll back an agent?"
  - "How do I create an agent?"
related:
  - skills
---
# Agents

Agents are durable, versioned configurations. Use the **Version** button to roll back.`;

const DOC_SKILLS = `---
slug: skills
title: Skills
description: Reusable agent behaviors.
category: platform
order: 20
trigger_dev_primitive: false
questions:
  - "What is a skill?"
  - "How do I install a skill?"
---
# Skills

A skill is a manifest plus a prompt block.`;

const GUIDE_CREATE = `---
slug: create-first-agent
title: Create your first agent
description: Walk through creating an agent in the dashboard.
category: getting-started
order: 1
questions:
  - "How do I create my first agent?"
---
# Create your first agent

Click the **New Agent** button.`;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "platos-docs-test-"));
  const docs = path.join(tmpRoot, "content", "docs");
  const guides = path.join(tmpRoot, "content", "guides");
  await mkdir(docs, { recursive: true });
  await mkdir(guides, { recursive: true });
  await writeFile(path.join(docs, "agents.md"), DOC_AGENTS, "utf8");
  await writeFile(path.join(docs, "skills.md"), DOC_SKILLS, "utf8");
  await writeFile(path.join(guides, "create-first-agent.md"), GUIDE_CREATE, "utf8");
  // Also write a leading-underscore inventory file that should be ignored.
  await writeFile(path.join(docs, "_INVENTORY.md"), "ignored", "utf8");
});

afterEach(async () => {
  // tmp dirs auto-clean on exit; no-op.
});

describe("DocRepository", () => {
  it("lists docs sorted by category + order", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const docs = await repo.listDocs();
    expect(docs).toHaveLength(2);
    expect(docs[0]?.slug).toBe("agents");
    expect(docs[1]?.slug).toBe("skills");
  });

  it("ignores _INVENTORY.md and other underscore-prefixed files", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const docs = await repo.listDocs();
    expect(docs.find((d) => d.slug === "_INVENTORY")).toBeUndefined();
  });

  it("lists guides", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const guides = await repo.listGuides();
    expect(guides).toHaveLength(1);
    expect(guides[0]?.slug).toBe("create-first-agent");
  });

  it("returns null on unknown slug", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const missing = await repo.getDoc("does-not-exist");
    expect(missing).toBeNull();
  });

  it("returns rendered HTML lazily on get", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const doc = await repo.getDoc("agents");
    expect(doc).not.toBeNull();
    expect(doc!.html).toContain("<h1");
    expect(doc!.html).toContain("Agents");
    expect(doc!.markdown.startsWith("# Agents")).toBe(true);
  });

  it("ranks question-phrase hit highest", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const results = await repo.search("how do I version + roll back an agent", "all", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe("agents");
    expect(results[0]?.score).toBe(1.0);
    expect(results[0]?.matchedQuestion).toContain("version");
  });

  it("falls back to body match when question doesn't include the phrase", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const results = await repo.search("manifest prompt block", "all", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.slug).toBe("skills");
    expect(results[0]?.snippet).toContain("manifest");
  });

  it("respects `kind` filter", async () => {
    const repo = new DocRepository({ contentRoot: tmpRoot, watchMtime: false });
    const docsOnly = await repo.search("agent", "docs", 5);
    expect(docsOnly.every((r) => r.kind === "docs")).toBe(true);
    const guidesOnly = await repo.search("first", "guides", 5);
    expect(guidesOnly.every((r) => r.kind === "guides")).toBe(true);
    expect(guidesOnly[0]?.slug).toBe("create-first-agent");
  });
});
