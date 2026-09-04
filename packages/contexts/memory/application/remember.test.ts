import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { SYNTHESIZED_PROFILE_KEY, type TurnId } from "../domain/index.js";
import { remember, type RememberCommand } from "./remember.js";
import {
  AGENT,
  bindingFixture,
  CLUSTER,
  harness,
  PEER_AGENT,
  runtimeGrant,
  SUBJECT_ID,
  THREAD,
  type MemoryHarness,
} from "./testing/fixtures.js";

function command(overrides: Partial<RememberCommand> = {}): RememberCommand {
  return {
    authorization: runtimeGrant(),
    endUserId: null,
    actingAgentId: null,
    requestedAgentId: null,
    kind: "fact",
    content: "prefers tea",
    metadata: null,
    visibility: null,
    agentVisible: null,
    source: null,
    sourceThreadId: null,
    sourceTurnIds: [],
    extractorVersion: null,
    confidence: null,
    ...overrides,
  };
}

function fromThread(context: MemoryHarness): void {
  context.repository.seedThread(THREAD, { agentId: AGENT, clusterId: null }, SUBJECT_ID);
  context.repository.seedTurns(THREAD, [asIdentifier<TurnId>("turn-1"), asIdentifier<TurnId>("turn-2")]);
}

describe("remember — the single write path", () => {
  it("writes a fact and attributes it to the acting agent", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command());
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.content).toBe("prefers tea");
    expect(written.value.ownership.agentId).toBe(AGENT);
    expect(written.value.subject.endUserId).toBe(SUBJECT_ID);
    expect(written.value.visibility).toBe("agent_visible");
    expect(context.repository.all()).toHaveLength(1);
  });

  it("goes through a transaction — every write is enlisted", async () => {
    const context = harness();
    await remember(context.dependencies, command());
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.writes).toEqual(context.unitOfWork.transactions);
  });

  it("stores the vector, so the row is recallable", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command());
    if (!written.ok) throw new Error("unreachable");
    expect(context.repository.embeddingOf(written.value.memoryId)).not.toBeNull();
  });

  it("refuses an unauthorized caller BEFORE it embeds anything", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ authorization: {} }));
    expect(written.ok).toBe(false);
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("validates the CONTENT before it embeds anything", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ content: "   " }));
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_INVALID_CONTENT");
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("refuses an unknown kind", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ kind: "opinion" }));
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_INVALID_KIND");
  });

  it("refuses a confidence outside [0, 1]", async () => {
    const context = harness();
    for (const confidence of [-0.1, 1.5, Number.NaN]) {
      const written = await remember(context.dependencies, command({ confidence }));
      expect(written.ok).toBe(false);
      if (written.ok) throw new Error("unreachable");
      expect(written.error.code).toBe("MEMORY_INVALID_CONFIDENCE");
    }
    expect((await remember(context.dependencies, command({ confidence: 1 }))).ok).toBe(true);
  });

  it("refuses an embedding the column cannot hold", async () => {
    const context = harness();
    context.embeddings.returnWidth(8);
    const written = await remember(context.dependencies, command());
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_EMBEDDING_UNAVAILABLE");
    expect(context.repository.all()).toHaveLength(0);
  });
});

describe("the trusted-source gate", () => {
  it("lets an untrusted caller claim `manual`", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ source: "manual" }));
    expect(written.ok).toBe(true);
  });

  it("REFUSES a caller claiming `extracted` without the option", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ source: "extracted" }));
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_UNTRUSTED_SOURCE");
    expect(written.error.category).toBe("forbidden");
  });

  it("refuses `rag` and `imported` on the same rule", async () => {
    const context = harness();
    for (const source of ["rag", "imported"] as const) {
      expect((await remember(context.dependencies, command({ source }))).ok).toBe(false);
    }
  });

  it("REFUSES when the option names a DIFFERENT provenance than the command", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ source: "rag" }), {
      trustedSource: "extracted",
    });
    expect(written.ok).toBe(false);
  });

  it("admits the claim when the option matches", async () => {
    const context = harness();
    fromThread(context);
    const written = await remember(
      context.dependencies,
      command({ source: "extracted", sourceThreadId: THREAD }),
      { trustedSource: "extracted" },
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.source).toBe("extracted");
  });
});

describe("provenance", () => {
  it("REFUSES turn ids that arrived without a thread", async () => {
    const context = harness();
    const written = await remember(
      context.dependencies,
      command({ sourceTurnIds: [asIdentifier<TurnId>("turn-1")] }),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_PROVENANCE_INCOMPLETE");
  });

  it("REFUSES turn ids that are not that thread's", async () => {
    const context = harness();
    fromThread(context);
    const written = await remember(
      context.dependencies,
      command({ sourceThreadId: THREAD, sourceTurnIds: [asIdentifier<TurnId>("turn-9")] }),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_PROVENANCE_INCOMPLETE");
    expect(written.error.details["found"]).toBe("0");
  });

  it("accepts turn ids that belong to the thread", async () => {
    const context = harness();
    fromThread(context);
    const written = await remember(
      context.dependencies,
      command({ sourceThreadId: THREAD, sourceTurnIds: [asIdentifier<TurnId>("turn-1")] }),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.provenance.sourceTurnIds).toEqual(["turn-1"]);
  });

  it("computes a content hash ONLY for a memory that came from a thread", async () => {
    const context = harness();
    fromThread(context);
    const hand = await remember(context.dependencies, command());
    if (!hand.ok) throw new Error("unreachable");
    expect(hand.value.contentHash).toBeNull();

    const swept = await remember(context.dependencies, command({ sourceThreadId: THREAD }));
    if (!swept.ok) throw new Error("unreachable");
    expect(swept.value.contentHash).not.toBeNull();
  });
});

describe("dedupe on repeated extraction", () => {
  it("MERGES a second write of the same sentence from the same thread", async () => {
    const context = harness();
    fromThread(context);
    const first = await remember(
      context.dependencies,
      command({
        sourceThreadId: THREAD,
        sourceTurnIds: [asIdentifier<TurnId>("turn-1")],
        confidence: 0.7,
      }),
    );
    const second = await remember(
      context.dependencies,
      command({
        sourceThreadId: THREAD,
        sourceTurnIds: [asIdentifier<TurnId>("turn-2")],
        confidence: 0.4,
      }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(context.repository.all()).toHaveLength(1);
    expect(second.value.memoryId).toBe(first.value.memoryId);
    expect([...second.value.provenance.sourceTurnIds].sort()).toEqual(["turn-1", "turn-2"]);
    expect(second.value.confidence.confidence).toBe(0.7);
  });

  it("APPENDS two different sentences from one thread", async () => {
    const context = harness();
    fromThread(context);
    await remember(context.dependencies, command({ sourceThreadId: THREAD }));
    await remember(context.dependencies, command({ sourceThreadId: THREAD, content: "prefers coffee" }));
    expect(context.repository.all()).toHaveLength(2);
  });

  it("APPENDS the same sentence written twice BY HAND — two operators, two facts", async () => {
    const context = harness();
    await remember(context.dependencies, command());
    await remember(context.dependencies, command());
    expect(context.repository.all()).toHaveLength(2);
  });

  it("does NOT re-embed on a merge", async () => {
    const context = harness();
    fromThread(context);
    await remember(context.dependencies, command({ sourceThreadId: THREAD }));
    const afterFirst = context.embeddings.requests.length;
    await remember(context.dependencies, command({ sourceThreadId: THREAD }));
    // One more embed for the incoming draft, and none for the stored row.
    expect(context.embeddings.requests.length).toBe(afterFirst + 1);
  });
});

describe("profile rows", () => {
  const profile = (content: string, key = "role") =>
    command({ kind: "profile", content, metadata: { profileKey: key } });

  it("stores a profile WITHOUT an embedding", async () => {
    const context = harness();
    const written = await remember(context.dependencies, profile("leads platform"));
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(context.repository.embeddingOf(written.value.memoryId)).toBeNull();
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("UPSERTS on the profile key rather than appending", async () => {
    const context = harness();
    const first = await remember(context.dependencies, profile("leads platform"));
    const second = await remember(context.dependencies, profile("leads infrastructure"));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(context.repository.all()).toHaveLength(1);
    expect(second.value.memoryId).toBe(first.value.memoryId);
    expect(second.value.content).toBe("leads infrastructure");
  });

  it("keeps two different profile keys apart", async () => {
    const context = harness();
    await remember(context.dependencies, profile("leads platform", "role"));
    await remember(context.dependencies, profile("Sam", "name"));
    expect(context.repository.all()).toHaveLength(2);
  });

  it("NORMALISES the key, so `Role` and `role` are one row", async () => {
    const context = harness();
    await remember(context.dependencies, profile("leads platform", "Role"));
    await remember(context.dependencies, profile("leads infrastructure", "  role "));
    expect(context.repository.all()).toHaveLength(1);
  });

  it("refuses a profile with no key", async () => {
    const context = harness();
    const written = await remember(
      context.dependencies,
      command({ kind: "profile", content: "Sam", metadata: null }),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_INVALID_METADATA");
  });

  it("shares one profile row across a CLUSTER", async () => {
    const context = harness({
      bindings: [
        bindingFixture({ agentId: AGENT, clusterId: CLUSTER }),
        bindingFixture({ agentId: PEER_AGENT, clusterId: CLUSTER }),
      ],
    });
    await remember(context.dependencies, {
      ...profile("leads platform"),
      authorization: runtimeGrant({ actingAgentId: AGENT }),
    });
    await remember(context.dependencies, {
      ...profile("leads infrastructure"),
      authorization: runtimeGrant({ actingAgentId: PEER_AGENT }),
    });
    expect(context.repository.all()).toHaveLength(1);
    expect(context.repository.all()[0]?.content).toBe("leads infrastructure");
  });

  it("reserves the synthesized key for the maintained narrative", async () => {
    const context = harness();
    const written = await remember(
      context.dependencies,
      profile("You lead platform.", SYNTHESIZED_PROFILE_KEY),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.profileKey).toBe(SYNTHESIZED_PROFILE_KEY);
  });
});

describe("visibility", () => {
  it("honours an explicit visibility over the legacy boolean", async () => {
    const context = harness();
    const written = await remember(
      context.dependencies,
      command({ visibility: "private", agentVisible: true }),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.visibility).toBe("private");
  });

  it("reads `agentVisible: false` as hidden", async () => {
    const context = harness();
    const written = await remember(context.dependencies, command({ agentVisible: false }));
    if (!written.ok) throw new Error("unreachable");
    expect(written.value.visibility).toBe("hidden");
  });

  it("refuses a visibility outside the vocabulary", async () => {
    const context = harness();
    const written = await remember(
      context.dependencies,
      command({ visibility: "public" as never }),
    );
    expect(written.ok).toBe(false);
    if (written.ok) throw new Error("unreachable");
    expect(written.error.code).toBe("MEMORY_INVALID_VISIBILITY");
  });
});
