import { describe, expect, it } from "vitest";

import { EXTRACTOR_VERSION } from "../domain/index.js";
import {
  extractFromConversation,
  stampEntities,
  type ExtractFromConversationCommand,
} from "./extract-from-conversation.js";
import {
  AGENT,
  harness,
  runtimeGrant,
  SUBJECT_ID,
  THREAD,
  turnFixture,
  turnsFixture,
  type MemoryHarness,
} from "./testing/fixtures.js";

function command(overrides: Partial<ExtractFromConversationCommand> = {}): ExtractFromConversationCommand {
  return {
    authorization: runtimeGrant(),
    threadId: THREAD,
    turns: turnsFixture(6),
    storedPolicy: null,
    ...overrides,
  };
}

const ENVELOPE = JSON.stringify({
  memories: [
    { kind: "fact", content: "prefers tea", confidence: 0.9, entities: ["Acme Corp"] },
    { kind: "preference", content: "tea over coffee", confidence: 0.8 },
  ],
  entities: [{ entityKey: "Acme Corp", name: "Acme Corp", type: "org", aliases: ["Acme"] }],
  relationships: [{ from: "Acme Corp", to: "Acme Corp", type: "self" }],
});

function prepare(context: MemoryHarness, text = ENVELOPE): void {
  context.repository.seedThread(THREAD, { agentId: AGENT, clusterId: null }, SUBJECT_ID);
  // Wider than any window a test asks for, so provenance always resolves.
  context.repository.seedTurns(
    THREAD,
    turnsFixture(20).map((turn) => turn.turnId as never),
  );
  context.judge.answerExtractionWith({ text });
}

describe("the policy gate", () => {
  it("does NOTHING when extraction is switched off, and says so", async () => {
    const context = harness();
    const report = await extractFromConversation(
      context.dependencies,
      command({ storedPolicy: { enabled: false } }),
    );
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toBe("extraction-disabled");
    expect(context.judge.extractions).toHaveLength(0);
  });

  it("does NOTHING under the message floor, and pays no judge", async () => {
    const context = harness();
    prepare(context);
    const report = await extractFromConversation(
      context.dependencies,
      command({ turns: turnsFixture(2) }),
    );
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toBe("insufficient-messages");
    expect(context.judge.extractions).toHaveLength(0);
  });

  it("counts a turn with only an input as ONE message", async () => {
    const context = harness();
    prepare(context);
    const halves = [turnFixture(1), turnFixture(2), turnFixture(3)].map((turn) => ({
      ...turn,
      outputText: null,
    }));
    const report = await extractFromConversation(context.dependencies, command({ turns: halves }));
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toBe("insufficient-messages");
  });

  it("requires the RUNTIME grant", async () => {
    const context = harness();
    const report = await extractFromConversation(
      context.dependencies,
      command({ authorization: context.tenancy.grant() }),
    );
    expect(report.ok).toBe(false);
  });
});

describe("the watermark", () => {
  it("SKIPS a thread already swept at its current head, without paying a judge", async () => {
    const context = harness();
    prepare(context);
    const first = await extractFromConversation(context.dependencies, command());
    expect(first.ok).toBe(true);

    context.judge.answerExtractionWith({ text: ENVELOPE });
    const second = await extractFromConversation(context.dependencies, command());
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.skipped).toBe("no-new-activity");
    expect(context.judge.extractions).toHaveLength(1);
  });

  it("`force` bypasses the watermark", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    context.judge.answerExtractionWith({ text: ENVELOPE });
    const forced = await extractFromConversation(context.dependencies, command({ force: true }));
    if (!forced.ok) throw new Error("unreachable");
    expect(forced.value.skipped).toBeNull();
    expect(context.judge.extractions).toHaveLength(2);
  });

  it("a cache that lost every key costs money and changes NO outcome", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    const writtenFirst = context.repository.all().length;

    context.cache.failWith("cache down");
    context.judge.answerExtractionWith({ text: ENVELOPE });
    const second = await extractFromConversation(context.dependencies, command());
    if (!second.ok) throw new Error("unreachable");
    expect(second.value.skipped).toBeNull();
    // The store's unique index absorbed the repeat: no new rows.
    expect(context.repository.all()).toHaveLength(writtenFirst);
  });

  it("sweeps again once the thread has a new head", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    context.judge.answerExtractionWith({ text: ENVELOPE });
    const grown = await extractFromConversation(
      context.dependencies,
      command({ turns: turnsFixture(7) }),
    );
    if (!grown.ok) throw new Error("unreachable");
    expect(grown.value.skipped).toBeNull();
  });
});

describe("the judge", () => {
  it("is shown the transcript OLDEST FIRST", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    const transcript = context.judge.extractions[0]?.transcript ?? "";
    expect(transcript.indexOf("what I said at 1")).toBeLessThan(transcript.indexOf("what I said at 2"));
  });

  it("is shown the policy it is working to", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(
      context.dependencies,
      command({ storedPolicy: { maxPerSession: 3 } }),
    );
    expect(context.judge.extractions[0]?.policy.maxPerSession).toBe(3);
  });

  it("an UNAVAILABLE judge is an outcome, not a failure", async () => {
    const context = harness();
    prepare(context);
    context.judge.failExtraction("no key");
    const report = await extractFromConversation(context.dependencies, command());
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.skipped).toBe("judge-unavailable");
  });

  it("an UNREADABLE answer IS a failure", async () => {
    const context = harness();
    prepare(context, "I could not do that.");
    const report = await extractFromConversation(context.dependencies, command());
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.error.code).toBe("MEMORY_EXTRACTION_ENVELOPE_INVALID");
  });
});

describe("pricing through providers", () => {
  it("prices the judge call and reports the cents", async () => {
    const context = harness();
    prepare(context);
    context.judge.answerExtractionWith({
      text: ENVELOPE,
      model: "test:haiku",
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    const report = await extractFromConversation(context.dependencies, command());
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.model).toBe("test:haiku");
    expect(report.value.costCents).toBe("45.000000");
    expect(context.providers.priced[0]?.model).toBe("test:haiku");
  });

  it("TRANSLATES `cacheCreationInputTokens` to the rate card's `cacheWrite`", async () => {
    const context = harness();
    prepare(context);
    context.judge.answerExtractionWith({
      text: ENVELOPE,
      usage: {
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 300,
      },
    });
    await extractFromConversation(context.dependencies, command());
    expect(context.providers.priced[0]?.usage).toEqual({
      input: 1000,
      output: 0,
      cacheRead: 200,
      cacheWrite: 300,
    });
  });

  it("does not price a call that reported no tokens", async () => {
    const context = harness();
    prepare(context);
    const report = await extractFromConversation(context.dependencies, command());
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.costCents).toBeNull();
    expect(context.providers.priced).toHaveLength(0);
  });

  it("a pricing FAILURE does not fail the sweep; the cost is null", async () => {
    const context = harness();
    prepare(context);
    context.providers.failWith("no rate card");
    context.judge.answerExtractionWith({
      text: ENVELOPE,
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    const report = await extractFromConversation(context.dependencies, command());
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.costCents).toBeNull();
    expect(report.value.memoriesWritten).toBe(2);
  });
});

describe("what a sweep writes", () => {
  it("writes memories, entities and relationships, and reports each count", async () => {
    const context = harness();
    prepare(context);
    const report = await extractFromConversation(context.dependencies, command());
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.memoriesWritten).toBe(2);
    expect(report.value.entitiesWritten).toBe(1);
    expect(report.value.relationshipsWritten).toBe(1);
  });

  it("stamps `extracted` provenance and the extractor version on every row", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    for (const memory of context.repository.all()) {
      expect(memory.source).toBe("extracted");
      expect(memory.provenance.extractorVersion).toBe(EXTRACTOR_VERSION);
      expect(memory.provenance.sourceThreadId).toBe(THREAD);
      expect(memory.provenance.sourceTurnIds.length).toBeGreaterThan(0);
    }
  });

  it("stamps the entity slugs on the memory that named them", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    const tagged = context.repository.all().find((memory) => memory.content === "prefers tea");
    expect(tagged?.metadata?.["entities"]).toEqual(["acme-corp"]);
  });

  it("adds NO `entities` key to a memory that named none", async () => {
    const context = harness();
    prepare(context);
    await extractFromConversation(context.dependencies, command());
    const untagged = context.repository.all().find((memory) => memory.content === "tea over coffee");
    expect(untagged?.metadata?.["entities"]).toBeUndefined();
  });

  it("REFUSES a candidate under the threshold and reports the reason", async () => {
    const context = harness();
    prepare(
      context,
      JSON.stringify({ memories: [{ kind: "fact", content: "maybe", confidence: 0.2 }] }),
    );
    const report = await extractFromConversation(context.dependencies, command());
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.memoriesWritten).toBe(0);
    expect(report.value.refused).toEqual(["below-threshold"]);
  });

  it("REFUSES a `profile` candidate — synthesis writes profiles, not the judge", async () => {
    const context = harness();
    prepare(
      context,
      JSON.stringify({
        memories: [{ kind: "profile", content: "Sam leads platform", confidence: 0.99 }],
      }),
    );
    const report = await extractFromConversation(context.dependencies, command());
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.refused).toEqual(["kind-not-permitted"]);
  });

  it("honours the session cap and reports what it dropped", async () => {
    const context = harness();
    prepare(
      context,
      JSON.stringify({
        memories: [
          { kind: "fact", content: "a", confidence: 0.99 },
          { kind: "fact", content: "b", confidence: 0.98 },
          { kind: "fact", content: "c", confidence: 0.97 },
        ],
      }),
    );
    const report = await extractFromConversation(
      context.dependencies,
      command({ storedPolicy: { maxPerSession: 2 } }),
    );
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.memoriesWritten).toBe(2);
    expect(report.value.refused).toEqual(["over-session-cap"]);
  });

  it("re-applies the CONTENT rules to a judge's candidate", async () => {
    const context = harness();
    prepare(
      context,
      JSON.stringify({
        memories: [{ kind: "relationship", content: "sam works at acme", confidence: 0.99 }],
      }),
    );
    const report = await extractFromConversation(context.dependencies, command());
    // A relationship memory MUST carry { from, to, type }; the judge omitted it.
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.error.code).toBe("MEMORY_INVALID_METADATA");
  });

  it("skips a relationship whose endpoints this run did not materialise", async () => {
    const context = harness();
    prepare(
      context,
      JSON.stringify({
        memories: [{ kind: "fact", content: "a", confidence: 0.9 }],
        entities: [{ entityKey: "acme", name: "Acme" }],
        relationships: [{ from: "acme", to: "ghost", type: "knows" }],
      }),
    );
    const report = await extractFromConversation(context.dependencies, command());
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.relationshipsWritten).toBe(0);
    expect(context.graph.allRelationships()).toHaveLength(0);
  });

  it("de-duplicates two candidate entities that slug to one key", async () => {
    const context = harness();
    prepare(
      context,
      JSON.stringify({
        memories: [{ kind: "fact", content: "a", confidence: 0.9 }],
        entities: [
          { entityKey: "Acme Corp", name: "Acme Corp" },
          { entityKey: "acme-corp", name: "ACME CORP" },
        ],
      }),
    );
    const report = await extractFromConversation(context.dependencies, command());
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.entitiesWritten).toBe(1);
    expect(context.graph.allEntities()).toHaveLength(1);
  });
});

describe("stampEntities", () => {
  it("adds no key when there are no slugs", () => {
    expect(stampEntities({ topic: "tea" }, [])).toEqual({ topic: "tea" });
  });

  it("de-duplicates the slugs it stamps", () => {
    expect(stampEntities(null, ["acme", "acme", "sam"])).toEqual({ entities: ["acme", "sam"] });
  });

  it("preserves the judge's own metadata alongside the stamp", () => {
    expect(stampEntities({ topic: "tea" }, ["acme"])).toEqual({ topic: "tea", entities: ["acme"] });
  });

  it("treats an array or a scalar as no metadata at all", () => {
    expect(stampEntities([1, 2], ["acme"])).toEqual({ entities: ["acme"] });
    expect(stampEntities("prose", ["acme"])).toEqual({ entities: ["acme"] });
  });
});
