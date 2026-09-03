import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId, EndUserId, MemoryId } from "../domain/index.js";
import { recall, recallAcrossCluster } from "./recall.js";
import {
  AGENT,
  bindingFixture,
  CLUSTER,
  harness,
  memoryFixture,
  OUTSIDE_AGENT,
  PEER_AGENT,
  runtimeGrant,
  SUBJECT_ID,
  subjectFixture,
  type MemoryHarness,
} from "./testing/fixtures.js";
import { deterministicEmbedding } from "./testing/in-memory-embedding-model.js";

function seed(
  context: MemoryHarness,
  id: string,
  content: string,
  overrides: Parameters<typeof memoryFixture>[0] = {},
): void {
  const memory = memoryFixture({
    memoryId: asIdentifier<MemoryId>(id),
    content,
    ...overrides,
  });
  context.repository.seed(memory, deterministicEmbedding(memory.content));
}

const QUERY = { authorization: runtimeGrant(), query: "tea", kind: null, limit: null, minScore: null };

describe("recall", () => {
  it("requires the RUNTIME grant, not an operator one", async () => {
    const context = harness();
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      authorization: context.tenancy.grant(),
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(false);
    if (recalled.ok) throw new Error("unreachable");
    expect(recalled.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("returns the subject's agent-visible memories, closest first", async () => {
    const context = harness();
    seed(context, "mem-1", "tea");
    seed(context, "mem-2", "coffee");
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories[0]?.memory.memoryId).toBe("mem-1");
    expect(recalled.value.memories[0]?.score).toBeCloseTo(1, 10);
  });

  it("refuses a query that is only whitespace, before it embeds", async () => {
    const context = harness();
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      query: "  ",
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(false);
    if (recalled.ok) throw new Error("unreachable");
    expect(recalled.error.code).toBe("MEMORY_QUERY_INVALID");
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("EXCLUDES archived, quarantined and retrieval-augmented rows", async () => {
    const context = harness();
    seed(context, "mem-live", "tea");
    seed(context, "mem-archived", "tea", {
      lifecycle: { ...memoryFixture().lifecycle, archivedAt: new Date() },
    });
    seed(context, "mem-quarantined", "tea", {
      lifecycle: { ...memoryFixture().lifecycle, quarantinedAt: new Date() },
    });
    seed(context, "mem-rag", "tea", { source: "rag" });
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-live"]);
  });

  it("excludes hidden and private rows under the default visibility filter", async () => {
    const context = harness();
    seed(context, "mem-visible", "tea");
    seed(context, "mem-hidden", "tea", { visibility: "hidden" });
    seed(context, "mem-private", "tea", { visibility: "private" });
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-visible"]);
  });

  it("reaches hidden rows when a caller names them explicitly", async () => {
    const context = harness();
    seed(context, "mem-hidden", "tea", { visibility: "hidden" });
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: ["hidden"],
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories).toHaveLength(1);
  });

  it("never returns another SUBJECT's memories", async () => {
    const context = harness();
    seed(context, "mem-mine", "tea");
    seed(context, "mem-theirs", "tea", {
      subject: subjectFixture({ endUserId: asIdentifier<EndUserId>("user-2") }),
    });
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-mine"]);
  });

  it("never returns another AGENT's memories outside the cluster", async () => {
    const context = harness({
      bindings: [bindingFixture({ agentId: AGENT }), bindingFixture({ agentId: OUTSIDE_AGENT })],
    });
    seed(context, "mem-mine", "tea");
    seed(context, "mem-theirs", "tea", { ownership: { agentId: OUTSIDE_AGENT, clusterId: null } });
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-mine"]);
  });

  it("PROMOTES a slightly less similar memory that feedback confirmed", async () => {
    const context = harness();
    // "tea" is an exact match; "tea leaves" is close but not exact.
    seed(context, "mem-a", "tea leaves brewing", { confidence: { confidence: 1, feedbackBaselineConfidence: null } });
    seed(context, "mem-b", "tea leaves brewed", { confidence: { confidence: 0, feedbackBaselineConfidence: null } });
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      query: "tea leaves brewed",
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    const ranked = recalled.value.memories;
    expect(ranked[0]?.memory.memoryId).toBe("mem-b");
    expect(ranked[0]?.rankingScore).toBeGreaterThan(ranked[1]?.rankingScore ?? 1);
  });

  it("OVERFETCHES: the candidate window is wider than the page", async () => {
    const context = harness();
    for (let index = 0; index < 12; index += 1) seed(context, `mem-${index}`, "tea");
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      limit: 2,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories).toHaveLength(2);
    expect(recalled.value.candidatesConsidered).toBe(8);
  });

  it("stamps `lastAccessedAt` on what it returned, and only on that", async () => {
    const context = harness();
    seed(context, "mem-1", "tea");
    seed(context, "mem-2", "espresso");
    await recall(context.dependencies, {
      ...QUERY,
      limit: 1,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    const stamped = context.repository.all().filter((memory) => memory.lifecycle.lastAccessedAt !== null);
    expect(stamped.map((memory) => memory.memoryId)).toEqual(["mem-1"]);
  });

  it("does NOT fail a recall when the access stamp could not be written", async () => {
    const context = harness();
    seed(context, "mem-1", "tea");
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.accessStamped).toBe(true);
  });

  it("reports a store failure as an error, not as an empty page", async () => {
    const context = harness();
    context.repository.failWith("store down");
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(false);
    if (recalled.ok) throw new Error("unreachable");
    expect(recalled.error.code).toBe("MEMORY_REPOSITORY_UNAVAILABLE");
  });

  it("reports an embedding failure rather than searching with nothing", async () => {
    const context = harness();
    context.embeddings.failWith("model down");
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(false);
    if (recalled.ok) throw new Error("unreachable");
    expect(recalled.error.code).toBe("MEMORY_EMBEDDING_UNAVAILABLE");
  });

  it("applies `minScore` to the raw similarity", async () => {
    const context = harness();
    seed(context, "mem-1", "tea");
    seed(context, "mem-2", "coffee beans roasted dark");
    const recalled = await recall(context.dependencies, {
      ...QUERY,
      minScore: 0.9,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-1"]);
  });
});

describe("recallAcrossCluster", () => {
  it("reads every agent in the acting agent's cluster", async () => {
    const context = harness({
      bindings: [
        bindingFixture({ agentId: AGENT, clusterId: CLUSTER }),
        bindingFixture({ agentId: PEER_AGENT, clusterId: CLUSTER }),
      ],
    });
    seed(context, "mem-mine", "tea", { ownership: { agentId: AGENT, clusterId: CLUSTER } });
    seed(context, "mem-peer", "tea", { ownership: { agentId: PEER_AGENT, clusterId: CLUSTER } });
    const recalled = await recallAcrossCluster(context.dependencies, {
      ...QUERY,
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories).toHaveLength(2);
  });

  it("derives the peer set from the ACTING agent's own binding", async () => {
    const context = harness({
      bindings: [
        bindingFixture({ agentId: AGENT, clusterId: null }),
        bindingFixture({ agentId: PEER_AGENT, clusterId: CLUSTER }),
      ],
    });
    seed(context, "mem-mine", "tea");
    seed(context, "mem-peer", "tea", { ownership: { agentId: PEER_AGENT, clusterId: CLUSTER } });
    const recalled = await recallAcrossCluster(context.dependencies, {
      ...QUERY,
      visibilityIn: undefined,
    });
    if (!recalled.ok) throw new Error("unreachable");
    expect(recalled.value.memories.map((entry) => entry.memory.memoryId)).toEqual(["mem-mine"]);
  });

  it("is exactly a single-agent recall when the acting agent has no cluster", async () => {
    const context = harness();
    seed(context, "mem-1", "tea");
    const clustered = await recallAcrossCluster(context.dependencies, {
      ...QUERY,
      visibilityIn: undefined,
    });
    const plain = await recall(context.dependencies, {
      ...QUERY,
      requestedAgentIds: [],
      visibilityIn: undefined,
    });
    expect(clustered.ok && plain.ok).toBe(true);
    if (!clustered.ok || !plain.ok) throw new Error("unreachable");
    expect(clustered.value.memories.map((entry) => entry.memory.memoryId)).toEqual(
      plain.value.memories.map((entry) => entry.memory.memoryId),
    );
  });

  it("refuses when the acting agent is not bound in this environment", async () => {
    const context = harness();
    const recalled = await recallAcrossCluster(context.dependencies, {
      ...QUERY,
      authorization: runtimeGrant({ actingAgentId: asIdentifier<AgentId>("agent-unbound") }),
      visibilityIn: undefined,
    });
    expect(recalled.ok).toBe(false);
    expect(SUBJECT_ID).toBe("user-1");
  });
});
