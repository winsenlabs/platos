import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  isSynthesizedProfile,
  profileCacheKey,
  SYNTHESIZED_PROFILE_KEY,
  type MemoryId,
  type MemoryKind,
} from "../domain/index.js";
import { synthesizeProfile } from "./synthesize-profile.js";
import {
  AGENT,
  bindingFixture,
  CLUSTER,
  ENVIRONMENT_SCOPE,
  FIXED_NOW,
  harness,
  HOUR,
  memoryFixture,
  PEER_AGENT,
  runtimeGrant,
  SUBJECT_ID,
  type MemoryHarness,
} from "./testing/fixtures.js";
import { deterministicEmbedding } from "./testing/in-memory-embedding-model.js";

const COMMAND = { authorization: runtimeGrant(), endUserId: null, actingAgentId: null };

function seedAtoms(context: MemoryHarness, count: number, kind: MemoryKind = "fact"): void {
  for (let index = 0; index < count; index += 1) {
    const memory = memoryFixture({
      memoryId: asIdentifier<MemoryId>(`atom-${index}`),
      kind,
      content: `fact ${index}`,
    });
    context.repository.seed(memory, deterministicEmbedding(memory.content));
  }
}

function seedPriorProfile(context: MemoryHarness, synthesizedAt: Date | null): void {
  context.repository.seed(
    memoryFixture({
      memoryId: asIdentifier<MemoryId>("profile-1"),
      kind: "profile",
      profileKey: SYNTHESIZED_PROFILE_KEY,
      content: "You lead platform.",
      metadata:
        synthesizedAt === null
          ? { profileKey: SYNTHESIZED_PROFILE_KEY }
          : { profileKey: SYNTHESIZED_PROFILE_KEY, synthesizedAt: synthesizedAt.toISOString() },
    }),
    null,
  );
}

describe("synthesizeProfile", () => {
  it("writes the narrative under the reserved key", async () => {
    const context = harness();
    seedAtoms(context, 5);
    context.judge.answerSynthesisWith({ text: "You lead platform and prefer tea." });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.written).toBe(true);
    expect(report.value.atomCount).toBe(5);
    expect(report.value.memory?.profileKey).toBe(SYNTHESIZED_PROFILE_KEY);
    expect(context.repository.all().filter(isSynthesizedProfile)).toHaveLength(1);
  });

  it("stores the narrative WITHOUT an embedding", async () => {
    const context = harness();
    seedAtoms(context, 5);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok || report.value.memory === null) throw new Error("unreachable");
    expect(context.repository.embeddingOf(report.value.memory.memoryId)).toBeNull();
  });

  it("shows the model one atom per line, kind first", async () => {
    const context = harness();
    seedAtoms(context, 4);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    await synthesizeProfile(context.dependencies, COMMAND);
    expect(context.judge.syntheses[0]).toContain("(fact) fact 0");
  });

  it("REFUSES under the atom floor, as an outcome rather than an error", async () => {
    const context = harness();
    seedAtoms(context, 3);
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    expect(report.ok).toBe(true);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.written).toBe(false);
    expect(report.value.refusal).toBe("too-few-atoms");
    expect(context.judge.syntheses).toHaveLength(0);
  });

  it("does not count PROFILE rows toward the atom floor", async () => {
    const context = harness();
    seedAtoms(context, 3);
    seedPriorProfile(context, null);
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.refusal).toBe("too-few-atoms");
  });

  it("does not count RETRIEVAL-AUGMENTED rows toward the atom floor", async () => {
    const context = harness();
    seedAtoms(context, 3);
    context.repository.seed(
      memoryFixture({ memoryId: asIdentifier<MemoryId>("rag-1"), source: "rag" }),
      deterministicEmbedding("doc"),
    );
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.refusal).toBe("too-few-atoms");
  });

  it("REFUSES inside the throttle window", async () => {
    const context = harness();
    seedAtoms(context, 6);
    seedPriorProfile(context, FIXED_NOW);
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.refusal).toBe("throttled");
    expect(context.judge.syntheses).toHaveLength(0);
  });

  it("proceeds once the window has elapsed", async () => {
    const context = harness();
    seedAtoms(context, 6);
    seedPriorProfile(context, FIXED_NOW);
    context.clock.advance(HOUR + 1);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.written).toBe(true);
  });

  it("`force` bypasses the throttle", async () => {
    const context = harness();
    seedAtoms(context, 6);
    seedPriorProfile(context, FIXED_NOW);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const report = await synthesizeProfile(context.dependencies, { ...COMMAND, force: true });
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.written).toBe(true);
  });

  it("treats a prior with NO readable stamp as stale rather than freezing forever", async () => {
    const context = harness();
    seedAtoms(context, 6);
    seedPriorProfile(context, null);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.written).toBe(true);
  });

  it("REFUSES to store an empty narrative over a good one", async () => {
    const context = harness();
    seedAtoms(context, 6);
    context.judge.answerSynthesisWith({ text: "   " });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.written).toBe(false);
    expect(report.value.refusal).toBe("empty");
    expect(context.repository.all().filter(isSynthesizedProfile)).toHaveLength(0);
  });

  it("UPSERTS the narrative rather than appending a second one", async () => {
    const context = harness();
    seedAtoms(context, 6);
    context.judge.answerSynthesisWith({ text: "first" }, { text: "second" });
    await synthesizeProfile(context.dependencies, { ...COMMAND, force: true });
    await synthesizeProfile(context.dependencies, { ...COMMAND, force: true });
    const profiles = context.repository.all().filter(isSynthesizedProfile);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.content).toBe("second");
  });

  it("stamps the instant and the atom count on the row", async () => {
    const context = harness();
    seedAtoms(context, 5);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok || report.value.memory === null) throw new Error("unreachable");
    expect(report.value.memory.metadata?.["synthesizedAt"]).toBe(FIXED_NOW.toISOString());
    expect(report.value.memory.metadata?.["atomCount"]).toBe(5);
  });

  it("INVALIDATES the cached projection after a write", async () => {
    const context = harness();
    seedAtoms(context, 5);
    const key = profileCacheKey(ENVIRONMENT_SCOPE, AGENT, SUBJECT_ID);
    context.cache.seed(key, "{}", 600);
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    await synthesizeProfile(context.dependencies, COMMAND);
    expect(context.cache.keys()).not.toContain(key);
  });

  it("reads the ATOMS across the acting agent's whole cluster", async () => {
    const context = harness({
      bindings: [
        bindingFixture({ agentId: AGENT, clusterId: CLUSTER }),
        bindingFixture({ agentId: PEER_AGENT, clusterId: CLUSTER }),
      ],
    });
    for (let index = 0; index < 3; index += 1) {
      context.repository.seed(
        memoryFixture({
          memoryId: asIdentifier<MemoryId>(`mine-${index}`),
          content: `mine ${index}`,
          ownership: { agentId: AGENT, clusterId: CLUSTER },
        }),
        deterministicEmbedding(`mine ${index}`),
      );
      context.repository.seed(
        memoryFixture({
          memoryId: asIdentifier<MemoryId>(`peer-${index}`),
          content: `peer ${index}`,
          ownership: { agentId: PEER_AGENT, clusterId: CLUSTER },
        }),
        deterministicEmbedding(`peer ${index}`),
      );
    }
    context.judge.answerSynthesisWith({ text: "You lead platform." });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.atomCount).toBe(6);
  });

  it("prices the synthesis call through providers", async () => {
    const context = harness();
    seedAtoms(context, 5);
    context.judge.answerSynthesisWith({
      text: "You lead platform.",
      model: "test:sonnet",
      usage: { inputTokens: 2000, outputTokens: 200 },
    });
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    if (!report.ok) throw new Error("unreachable");
    expect(report.value.costCents).toBe("90.000000");
    expect(context.providers.priced[0]?.model).toBe("test:sonnet");
  });

  it("a MODEL failure IS an error — nothing was written and nothing is known", async () => {
    const context = harness();
    seedAtoms(context, 5);
    context.judge.failSynthesis("no key");
    const report = await synthesizeProfile(context.dependencies, COMMAND);
    expect(report.ok).toBe(false);
    if (report.ok) throw new Error("unreachable");
    expect(report.error.code).toBe("MEMORY_EXTRACTION_JUDGE_UNAVAILABLE");
  });

  it("refuses an unauthorized caller", async () => {
    const context = harness();
    expect((await synthesizeProfile(context.dependencies, { ...COMMAND, authorization: {} })).ok).toBe(
      false,
    );
  });
});
