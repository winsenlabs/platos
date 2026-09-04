import { describe, expect, it } from "vitest";

import {
  buildIndex,
  EMPTY_DISCOVERY_INDEX,
  indexStats,
  searchIndex,
  tokenize,
  type DiscoveryDocument,
} from "./discovery.js";
import { DEFAULT_TOOLS_POLICY } from "./policy.js";

const POLICY = DEFAULT_TOOLS_POLICY.discovery;

const CORPUS: readonly DiscoveryDocument[] = [
  { id: "tool-upload", text: "files.upload upload a file to storage bucket path" },
  { id: "tool-download", text: "files.download download a file from storage bucket path" },
  { id: "tool-issue", text: "github.create_issue open an issue on a repository title body" },
  { id: "tool-list", text: "files.list list the files in a bucket prefix" },
];

describe("tokenizing", () => {
  it("keeps snake_case whole, so a tool name does not score as its parts", () => {
    expect(tokenize("create_issue")).toEqual(["create_issue"]);
  });

  it("splits a dotted name into namespace and leaf, so either finds it", () => {
    expect(tokenize("github.create_issue")).toEqual(["github", "create_issue"]);
  });

  it("drops single characters and English function words", () => {
    expect(tokenize("a file in the bucket")).toEqual(["file", "bucket"]);
  });

  it("does NOT drop the verbs a query is actually made of", () => {
    expect(tokenize("create delete search list upload")).toEqual([
      "create",
      "delete",
      "search",
      "list",
      "upload",
    ]);
  });
});

describe("ranking", () => {
  const index = buildIndex(CORPUS, POLICY);

  it("puts the tool a query names first", () => {
    expect(searchIndex(index, "upload a file", 3, undefined)[0]?.id).toBe("tool-upload");
    expect(searchIndex(index, "open an issue", 3, undefined)[0]?.id).toBe("tool-issue");
  });

  it("returns NOTHING rather than padding with tools that share no term", () => {
    expect(searchIndex(index, "quantum chromodynamics", 15)).toEqual([]);
  });

  it("answers an all-stopword query with nothing rather than everything", () => {
    expect(searchIndex(index, "the a of", 15)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(searchIndex(index, "file bucket storage", 2)).toHaveLength(2);
  });

  it("breaks ties on id, so an indistinguishable pair does not reorder between calls", () => {
    const twins = buildIndex(
      [
        { id: "beta", text: "identical text here" },
        { id: "alpha", text: "identical text here" },
      ],
      POLICY,
    );
    const first = searchIndex(twins, "identical text", 5);
    expect(first.map((hit) => hit.id)).toEqual(["alpha", "beta"]);
    expect(first[0]?.score).toBeCloseTo(first[1]?.score ?? -1, 12);
  });

  it("restricts to a candidate set when one is supplied", () => {
    const hits = searchIndex(index, "file bucket", 15, new Set(["tool-list"]));
    expect(hits.map((hit) => hit.id)).toEqual(["tool-list"]);
  });

  it("never scores a term below zero, however common it is", () => {
    // `file` is in three of four documents — the regime where an idf without
    // the +1 goes negative and pushes a matching tool below a non-matching one.
    for (const hit of searchIndex(index, "file", 15)) {
      expect(hit.score).toBeGreaterThan(0);
    }
  });
});

describe("building", () => {
  it("indexes a repeated id once, so a shared tool does not inflate its own frequency", () => {
    const doubled = buildIndex(
      [
        { id: "tool-upload", text: "files.upload upload a file" },
        { id: "tool-upload", text: "files.upload upload a file" },
        { id: "tool-issue", text: "github.create_issue open an issue" },
      ],
      POLICY,
    );
    expect(indexStats(doubled).documentCount).toBe(2);
  });

  it("takes the FIRST text for a repeated id and ignores the rest", () => {
    const doubled = buildIndex(
      [
        { id: "x", text: "alpha" },
        { id: "x", text: "omega" },
      ],
      POLICY,
    );
    expect(searchIndex(doubled, "alpha", 5).map((hit) => hit.id)).toEqual(["x"]);
    expect(searchIndex(doubled, "omega", 5)).toEqual([]);
  });

  it("is safe to search when empty", () => {
    expect(searchIndex(buildIndex([], POLICY), "anything", 5)).toEqual([]);
    expect(searchIndex(EMPTY_DISCOVERY_INDEX, "anything", 5)).toEqual([]);
  });

  it("reports stats an operator can read", () => {
    const stats = indexStats(buildIndex(CORPUS, POLICY));
    expect(stats.documentCount).toBe(4);
    expect(stats.uniqueTerms).toBeGreaterThan(0);
    expect(stats.averageLength).toBeGreaterThan(0);
  });
});

describe("the two BM25 parameters", () => {
  const long = "alpha " + "filler ".repeat(60);

  it("discounts a long document without disqualifying it", () => {
    const documents = [
      { id: "short", text: "alpha" },
      { id: "long", text: long },
    ];
    const normalised = searchIndex(buildIndex(documents, POLICY), "alpha", 5);
    expect(normalised.map((hit) => hit.id)).toEqual(["short", "long"]);
    expect(normalised).toHaveLength(2);
  });

  it("stops discounting length entirely at b = 0", () => {
    const documents = [
      { id: "short", text: "alpha" },
      { id: "long", text: long },
    ];
    const flat = searchIndex(
      buildIndex(documents, { ...POLICY, lengthNormalisation: 0 }),
      "alpha",
      5,
    );
    expect(flat[0]?.score).toBeCloseTo(flat[1]?.score ?? -1, 12);
  });
});
