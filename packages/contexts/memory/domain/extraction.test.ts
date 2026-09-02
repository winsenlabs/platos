import { describe, expect, it } from "vitest";

import {
  byConfidenceDescending,
  countMessages,
  DEFAULT_EXTRACTION_POLICY,
  EMPTY_ENVELOPE,
  EXTRACTOR_VERSION,
  overrideExtractionPolicy,
  parseJudgeEnvelope,
  renderTranscript,
  resolveExtractionPolicy,
  selectCandidates,
  transcriptWindow,
  type CandidateMemory,
  type TranscriptTurn,
} from "./extraction.js";

function turn(sequence: number, overrides: Partial<TranscriptTurn> = {}): TranscriptTurn {
  return {
    turnId: `turn-${sequence}`,
    sequence,
    inputText: `in ${sequence}`,
    outputText: `out ${sequence}`,
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    kind: "fact",
    content: "prefers tea",
    metadata: undefined,
    confidence: 0.9,
    entityKeys: [],
    ...overrides,
  };
}

describe("the default policy", () => {
  it("is the transcribed one, and never permits the judge to write a profile", () => {
    expect(DEFAULT_EXTRACTION_POLICY.enabled).toBe(true);
    expect(DEFAULT_EXTRACTION_POLICY.confidenceThreshold).toBe(0.6);
    expect(DEFAULT_EXTRACTION_POLICY.maxPerSession).toBe(10);
    expect(DEFAULT_EXTRACTION_POLICY.minMessagesBeforeRun).toBe(6);
    expect(DEFAULT_EXTRACTION_POLICY.kinds).not.toContain("profile");
  });

  it("stamps a stable extractor version on every row it writes", () => {
    expect(EXTRACTOR_VERSION).toBe("v1");
  });
});

describe("resolveExtractionPolicy", () => {
  it("falls back wholesale for a value that is not an object", () => {
    for (const raw of [null, undefined, 7, "policy", []]) {
      expect(resolveExtractionPolicy(raw)).toEqual(DEFAULT_EXTRACTION_POLICY);
    }
  });

  it("falls back FIELD BY FIELD, so one bad number keeps four good ones", () => {
    const policy = resolveExtractionPolicy({
      enabled: false,
      confidenceThreshold: "high",
      maxPerSession: 3,
    });
    expect(policy.enabled).toBe(false);
    expect(policy.confidenceThreshold).toBe(DEFAULT_EXTRACTION_POLICY.confidenceThreshold);
    expect(policy.maxPerSession).toBe(3);
  });

  it("clamps every bound rather than refusing", () => {
    const policy = resolveExtractionPolicy({
      confidenceThreshold: 9,
      maxPerSession: 5000,
      minMessagesBeforeRun: 0,
    });
    expect(policy.confidenceThreshold).toBe(1);
    expect(policy.maxPerSession).toBe(100);
    expect(policy.minMessagesBeforeRun).toBe(1);
  });

  it("floors a fractional session cap", () => {
    expect(resolveExtractionPolicy({ maxPerSession: 3.9 }).maxPerSession).toBe(3);
  });

  it("SILENTLY DROPS `profile` from a stated kind list", () => {
    const policy = resolveExtractionPolicy({ kinds: ["fact", "profile"] });
    expect(policy.kinds).toEqual(["fact"]);
  });

  it("falls back to the default kinds when the list empties out", () => {
    expect(resolveExtractionPolicy({ kinds: ["profile", "nonsense"] }).kinds).toEqual(
      DEFAULT_EXTRACTION_POLICY.kinds,
    );
  });

  it("ignores a non-boolean `enabled`", () => {
    expect(resolveExtractionPolicy({ enabled: "yes" }).enabled).toBe(true);
  });
});

describe("overrideExtractionPolicy", () => {
  it("returns the base untouched when there is no override", () => {
    const base = resolveExtractionPolicy({ maxPerSession: 3 });
    expect(overrideExtractionPolicy(base, undefined)).toBe(base);
  });

  it("layers and RE-CLAMPS, so an override cannot escape a bound", () => {
    const base = resolveExtractionPolicy({});
    expect(overrideExtractionPolicy(base, { maxPerSession: 9999 }).maxPerSession).toBe(100);
  });
});

describe("the transcript window", () => {
  it("is twice the message floor, bounded at twenty and eighty messages", () => {
    expect(transcriptWindow({ ...DEFAULT_EXTRACTION_POLICY, minMessagesBeforeRun: 6 }).messages).toBe(20);
    expect(transcriptWindow({ ...DEFAULT_EXTRACTION_POLICY, minMessagesBeforeRun: 30 }).messages).toBe(60);
    expect(transcriptWindow({ ...DEFAULT_EXTRACTION_POLICY, minMessagesBeforeRun: 200 }).messages).toBe(80);
  });

  it("halves the message window into turns, rounding up", () => {
    expect(transcriptWindow({ ...DEFAULT_EXTRACTION_POLICY, minMessagesBeforeRun: 6 }).turns).toBe(10);
  });
});

describe("countMessages", () => {
  it("counts a present side of a turn as one message", () => {
    expect(countMessages([turn(1), turn(2)])).toBe(4);
  });

  it("does NOT count an absent side", () => {
    expect(countMessages([turn(1, { outputText: null })])).toBe(1);
    expect(countMessages([turn(1, { inputText: null, outputText: null })])).toBe(0);
  });
});

describe("renderTranscript", () => {
  it("renders oldest first, whatever order the store handed back", () => {
    const rendered = renderTranscript([turn(2), turn(1)]);
    expect(rendered.indexOf("in 1")).toBeLessThan(rendered.indexOf("in 2"));
  });

  it("labels each side and skips an absent one", () => {
    expect(renderTranscript([turn(1, { outputText: null })])).toBe("USER: in 1");
  });

  it("does not mutate its input", () => {
    const turns = [turn(2), turn(1)];
    renderTranscript(turns);
    expect(turns.map((entry) => entry.sequence)).toEqual([2, 1]);
  });
});

describe("parseJudgeEnvelope", () => {
  it("reads a bare JSON object", () => {
    const parsed = parseJudgeEnvelope('{"memories":[{"content":"a","confidence":0.9}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.memories).toHaveLength(1);
    expect(parsed.value.memories[0]?.kind).toBe("fact");
  });

  it("reads a FENCED block, and prefers it over the surrounding prose", () => {
    const parsed = parseJudgeEnvelope(
      'Here you go:\n```json\n{"memories":[{"content":"a"}]}\n```\nhope that helps',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.memories).toHaveLength(1);
  });

  it("reads a brace span embedded in prose", () => {
    const parsed = parseJudgeEnvelope('Sure. {"entities":[{"name":"Acme"}]} Done.');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.entities[0]?.entityKey).toBe("Acme");
  });

  it("REFUSES an answer with no readable object rather than reporting zero memories", () => {
    const parsed = parseJudgeEnvelope("I could not do that.");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.error.code).toBe("MEMORY_EXTRACTION_ENVELOPE_INVALID");
  });

  it("refuses an answer that parses to a scalar or an array", () => {
    expect(parseJudgeEnvelope('"unavailable"').ok).toBe(false);
    expect(parseJudgeEnvelope("[]").ok).toBe(false);
  });

  it("accepts an object with no sections and reports empty lists", () => {
    const parsed = parseJudgeEnvelope("{}");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value).toEqual(EMPTY_ENVELOPE);
  });

  it("drops a memory with no content rather than storing an empty one", () => {
    const parsed = parseJudgeEnvelope('{"memories":[{"kind":"fact"},{"content":"a"}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.memories).toHaveLength(1);
  });

  it("reads a MISSING confidence as ZERO, which cannot clear a threshold", () => {
    const parsed = parseJudgeEnvelope('{"memories":[{"content":"a"}]}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.memories[0]?.confidence).toBe(0);
  });

  it("names an entity from EITHER its key or its display name", () => {
    const parsed = parseJudgeEnvelope(
      '{"entities":[{"entityKey":"acme"},{"name":"Sam"},{"type":"person"}]}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.entities.map((entity) => entity.entityKey)).toEqual(["acme", "Sam"]);
    expect(parsed.value.entities[0]?.label).toBe("acme");
  });

  it("drops a relationship missing any of its three required fields", () => {
    const parsed = parseJudgeEnvelope(
      '{"relationships":[{"from":"a","to":"b"},{"from":"a","to":"b","type":"knows"}]}',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.relationships).toHaveLength(1);
    expect(parsed.value.relationships[0]?.weight).toBeNull();
  });

  it("ignores a section that is not a list", () => {
    const parsed = parseJudgeEnvelope('{"memories":"none","entities":{}}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value.memories).toEqual([]);
  });
});

describe("selectCandidates", () => {
  const policy = { ...DEFAULT_EXTRACTION_POLICY, confidenceThreshold: 0.6, maxPerSession: 2 };

  it("orders by confidence DESCENDING before the cap applies", () => {
    const selection = selectCandidates(
      [candidate({ content: "low", confidence: 0.7 }), candidate({ content: "high", confidence: 0.95 })],
      policy,
    );
    expect(selection.admitted.map((entry) => entry.candidate.content)).toEqual(["high", "low"]);
  });

  it("keeps the judge's order within a confidence tie", () => {
    const ordered = byConfidenceDescending([
      candidate({ content: "first", confidence: 0.8 }),
      candidate({ content: "second", confidence: 0.8 }),
    ]);
    expect(ordered.map((entry) => entry.content)).toEqual(["first", "second"]);
  });

  it("refuses a candidate under the threshold and SAYS SO", () => {
    const selection = selectCandidates([candidate({ confidence: 0.5 })], policy);
    expect(selection.admitted).toHaveLength(0);
    expect(selection.refused.map((entry) => entry.reason)).toEqual(["below-threshold"]);
  });

  it("refuses a kind the policy does not permit", () => {
    const selection = selectCandidates([candidate({ kind: "profile" })], policy);
    expect(selection.refused.map((entry) => entry.reason)).toEqual(["kind-not-permitted"]);
  });

  it("refuses an unknown kind", () => {
    const selection = selectCandidates([candidate({ kind: "opinion" })], policy);
    expect(selection.refused.map((entry) => entry.reason)).toEqual(["kind-not-permitted"]);
  });

  it("lower-cases a kind before matching, and stores the canonical spelling", () => {
    const selection = selectCandidates([candidate({ kind: "FACT" })], policy);
    expect(selection.admitted[0]?.kind).toBe("fact");
  });

  it("applies the cap AFTER the threshold, so a rejected candidate takes no slot", () => {
    const selection = selectCandidates(
      [
        candidate({ content: "a", confidence: 0.99 }),
        candidate({ content: "weak", confidence: 0.1 }),
        candidate({ content: "b", confidence: 0.98 }),
        candidate({ content: "c", confidence: 0.97 }),
      ],
      policy,
    );
    expect(selection.admitted.map((entry) => entry.candidate.content)).toEqual(["a", "b"]);
    expect(selection.refused.map((entry) => entry.reason).sort()).toEqual([
      "below-threshold",
      "over-session-cap",
    ]);
  });

  it("admits nothing from an empty envelope", () => {
    const selection = selectCandidates([], policy);
    expect(selection.admitted).toEqual([]);
    expect(selection.refused).toEqual([]);
  });
});
