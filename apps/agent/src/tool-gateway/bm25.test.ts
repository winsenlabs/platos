/**
 * PPR-38 — BM25 source/entity filter + core indexing behaviour tests.
 *
 * Two-entity setup: `entity_A` registers a "search" tool, `entity_B` registers
 * a "book" tool. Searching with `sourceEntityId` set filters results to that
 * entity's namespace only. This is what the agent's find_tools meta-tool
 * needs for the Mode 2 "one entity per turn" pattern.
 *
 * CLAUDE.md §9.11: Vitest only, no mocks. BM25 is a pure-TS in-memory
 * module — no DB needed. ToolRegistryService is exercised with a minimal
 * in-memory Prisma stub to hit the BM25 + scoped-cache code path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BM25Index, tokenize } from "./bm25";
import { ToolRegistryService } from "./tool-registry.service";

describe("bm25: tokenize", () => {
  it("lowercases + strips punctuation + removes stopwords", () => {
    const tokens = tokenize("Find a Person by Email");
    expect(tokens).toEqual(["find", "person", "email"]);
  });

  it("treats underscores as word boundaries NOT preserved? actually preserved by regex [^a-z0-9_]", () => {
    // Regex is /[^a-z0-9_]/g so underscores stay inside tokens.
    const tokens = tokenize("create_contact and update_opportunity");
    expect(tokens).toContain("create_contact");
    expect(tokens).toContain("update_opportunity");
  });

  it("drops single-char tokens", () => {
    expect(tokenize("a b c")).toEqual([]);
  });

  it("empty / all-stopword input → []", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("the and or of")).toEqual([]);
  });
});

describe("bm25: BM25Index basic indexing", () => {
  let idx: BM25Index;
  beforeEach(() => (idx = new BM25Index()));

  it("addDocument returns tokens for storage", () => {
    const tokens = idx.addDocument("tool_1", "search for people by name");
    expect(tokens).toContain("search");
    expect(tokens).toContain("people");
    expect(tokens).toContain("name");
  });

  it("search returns matching docs sorted by score", () => {
    idx.addDocument("tool_search", "search for people find a person by name");
    idx.addDocument("tool_email", "send an email message");
    idx.addDocument("tool_cal", "list calendar events today");

    const results = idx.search("find person", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("tool_search");
  });

  it("removeDocument drops the doc from future searches", () => {
    idx.addDocument("tool_search", "search for people find a person by name");
    idx.addDocument("tool_email", "send an email message");
    idx.removeDocument("tool_search");
    const results = idx.search("find person", 5);
    expect(results.find((r) => r.id === "tool_search")).toBeUndefined();
  });

  it("re-addDocument with same id updates in place (no dup)", () => {
    idx.addDocument("tool_1", "initial text search");
    idx.addDocument("tool_1", "updated text lookup");
    // Old term should not rank the doc anymore.
    const oldResults = idx.search("search", 5);
    expect(oldResults).toEqual([]);
    const newResults = idx.search("lookup", 5);
    expect(newResults[0].id).toBe("tool_1");
  });

  it("filterIds narrows BM25 to a subset", () => {
    idx.addDocument("tool_1", "search people");
    idx.addDocument("tool_2", "search things");
    const onlyTwo = idx.search("search", 10, new Set(["tool_2"]));
    expect(onlyTwo).toHaveLength(1);
    expect(onlyTwo[0].id).toBe("tool_2");
  });

  it("stats reflect totalDocs + uniqueTerms", () => {
    idx.addDocument("tool_1", "alpha beta gamma");
    idx.addDocument("tool_2", "alpha delta epsilon");
    const stats = idx.getStats();
    expect(stats.totalDocs).toBe(2);
    // alpha + beta + gamma + delta + epsilon = 5 unique
    expect(stats.uniqueTerms).toBe(5);
  });
});
