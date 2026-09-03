import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type {
  ClusterId,
  ContentHash,
  EndUserId,
  MemoryId,
  ThreadId,
  TurnId,
} from "./identifiers.js";
import {
  admitProvenance,
  archive,
  collidesOnContent,
  collidesOnProfileKey,
  isAgentVisible,
  isArchived,
  isQuarantined,
  isRecallable,
  matchesArchiveState,
  mergeRepeatedExtraction,
  NO_CONFIDENCE,
  NO_PROVENANCE,
  replaceProfileRevision,
  restore,
  touchAccess,
  type Memory,
} from "./memory.js";
import { memorySubject } from "./scope.js";
import type { ProfileKey } from "./identifiers.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const SUBJECT = memorySubject(ENVIRONMENT, asIdentifier<EndUserId>("user-1"));
const NOW = new Date("2026-09-03T12:00:00.000Z");
const LATER = new Date("2026-09-03T13:00:00.000Z");
const THREAD = asIdentifier<ThreadId>("thread-1");

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    memoryId: asIdentifier<MemoryId>("mem-1"),
    subject: SUBJECT,
    ownership: { agentId: asIdentifier("agent-1"), clusterId: null },
    kind: "fact",
    profileKey: null,
    content: "prefers tea",
    metadata: null,
    visibility: "agent_visible",
    source: "manual",
    contentHash: null,
    provenance: NO_PROVENANCE,
    confidence: NO_CONFIDENCE,
    lifecycle: {
      lastAccessedAt: null,
      quarantinedAt: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  };
}

describe("the three lifecycle instants are independent", () => {
  it("archived and quarantined are separately observable on one row", () => {
    const both = memory({
      lifecycle: { ...memory().lifecycle, archivedAt: NOW, quarantinedAt: NOW },
    });
    expect(isArchived(both)).toBe(true);
    expect(isQuarantined(both)).toBe(true);
  });

  it("un-archiving does NOT restore something feedback withdrew", () => {
    const both = memory({
      lifecycle: { ...memory().lifecycle, archivedAt: NOW, quarantinedAt: NOW },
    });
    const restored = restore(both, LATER);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("unreachable");
    expect(isArchived(restored.value)).toBe(false);
    expect(isQuarantined(restored.value)).toBe(true);
    expect(isRecallable(restored.value)).toBe(false);
  });

  it("a recallable memory is live, unwithdrawn AND agent-visible", () => {
    expect(isRecallable(memory())).toBe(true);
    expect(isRecallable(memory({ visibility: "hidden" }))).toBe(false);
    expect(isRecallable(memory({ lifecycle: { ...memory().lifecycle, archivedAt: NOW } }))).toBe(false);
    expect(isRecallable(memory({ lifecycle: { ...memory().lifecycle, quarantinedAt: NOW } }))).toBe(
      false,
    );
  });

  it("derives `agentVisible` from `visibility` rather than storing it twice", () => {
    expect(isAgentVisible(memory())).toBe(true);
    expect(isAgentVisible(memory({ visibility: "private" }))).toBe(false);
  });
});

describe("archive and restore", () => {
  it("archiving stamps the instant and advances `updatedAt`", () => {
    const archived = archive(memory(), LATER);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.value.lifecycle.archivedAt).toBe(LATER);
    expect(archived.value.lifecycle.updatedAt).toBe(LATER);
  });

  it("archiving an already-archived row is IDEMPOTENT and returns it unchanged", () => {
    const already = memory({ lifecycle: { ...memory().lifecycle, archivedAt: NOW } });
    const archived = archive(already, LATER);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.value).toBe(already);
  });

  it("restoring a live row is likewise a no-op", () => {
    const live = memory();
    const restored = restore(live, LATER);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value).toBe(live);
  });

  it("matchesArchiveState reads the three states the way a query means them", () => {
    const live = memory();
    const put = memory({ lifecycle: { ...memory().lifecycle, archivedAt: NOW } });
    expect(matchesArchiveState(live, "active")).toBe(true);
    expect(matchesArchiveState(live, "archived")).toBe(false);
    expect(matchesArchiveState(put, "archived")).toBe(true);
    expect(matchesArchiveState(put, "active")).toBe(false);
    expect(matchesArchiveState(live, "all")).toBe(true);
    expect(matchesArchiveState(put, "all")).toBe(true);
  });
});

describe("touchAccess", () => {
  it("stamps the access instant and does NOT advance `updatedAt`", () => {
    const touched = touchAccess(memory(), LATER);
    expect(touched.lifecycle.lastAccessedAt).toBe(LATER);
    expect(touched.lifecycle.updatedAt).toBe(NOW);
  });
});

describe("admitProvenance", () => {
  it("de-duplicates turn ids so feedback cannot double-count one", () => {
    const admitted = admitProvenance({
      sourceThreadId: THREAD,
      sourceTurnIds: [asIdentifier<TurnId>("turn-1"), asIdentifier<TurnId>("turn-1")],
      extractorVersion: "v1",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.sourceTurnIds).toEqual(["turn-1"]);
  });

  it("REFUSES turn ids that arrived without the thread that holds them", () => {
    const admitted = admitProvenance({
      sourceThreadId: null,
      sourceTurnIds: [asIdentifier<TurnId>("turn-1")],
      extractorVersion: null,
    });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("MEMORY_PROVENANCE_INCOMPLETE");
  });

  it("accepts a thread with no turns", () => {
    expect(
      admitProvenance({ sourceThreadId: THREAD, sourceTurnIds: [], extractorVersion: null }).ok,
    ).toBe(true);
  });
});

describe("mergeRepeatedExtraction — the ON CONFLICT clause", () => {
  const existing = memory({
    content: "prefers tea",
    visibility: "hidden",
    provenance: { ...NO_PROVENANCE, sourceThreadId: THREAD, sourceTurnIds: [asIdentifier<TurnId>("turn-1")], extractorVersion: "v1" },
    confidence: { confidence: 0.7, feedbackBaselineConfidence: 0.6 },
  });
  const incoming = memory({
    memoryId: asIdentifier<MemoryId>("mem-2"),
    content: "prefers tea",
    visibility: "agent_visible",
    provenance: { ...NO_PROVENANCE, sourceThreadId: THREAD, sourceTurnIds: [asIdentifier<TurnId>("turn-2")], extractorVersion: "v2" },
    confidence: { confidence: 0.4, feedbackBaselineConfidence: null },
  });

  it("UNIONS the source turns rather than replacing them", () => {
    const merged = mergeRepeatedExtraction(existing, incoming, LATER);
    expect([...merged.provenance.sourceTurnIds].sort()).toEqual(["turn-1", "turn-2"]);
  });

  it("takes the GREATER confidence — a second sighting cannot lower it", () => {
    expect(mergeRepeatedExtraction(existing, incoming, LATER).confidence.confidence).toBe(0.7);
  });

  it("takes the greater confidence when the INCOMING one is higher", () => {
    const better = memory({ confidence: { confidence: 0.9, feedbackBaselineConfidence: null } });
    expect(mergeRepeatedExtraction(existing, better, LATER).confidence.confidence).toBe(0.9);
  });

  it("treats a missing confidence as zero on either side", () => {
    const unscored = memory({ confidence: NO_CONFIDENCE });
    expect(mergeRepeatedExtraction(unscored, unscored, LATER).confidence.confidence).toBe(0);
  });

  it("records the NEWER extractor version", () => {
    expect(mergeRepeatedExtraction(existing, incoming, LATER).provenance.extractorVersion).toBe("v2");
  });

  it("keeps the stored version when the incoming row states none", () => {
    const anonymous = memory({ provenance: { ...NO_PROVENANCE, extractorVersion: null } });
    expect(mergeRepeatedExtraction(existing, anonymous, LATER).provenance.extractorVersion).toBe("v1");
  });

  it("LEAVES the operator's visibility, ownership and id alone", () => {
    const merged = mergeRepeatedExtraction(existing, incoming, LATER);
    expect(merged.visibility).toBe("hidden");
    expect(merged.memoryId).toBe(existing.memoryId);
    expect(merged.content).toBe(existing.content);
    expect(merged.lifecycle.createdAt).toBe(existing.lifecycle.createdAt);
  });

  it("advances both the access and update instants — the fact was re-observed", () => {
    const merged = mergeRepeatedExtraction(existing, incoming, LATER);
    expect(merged.lifecycle.lastAccessedAt).toBe(LATER);
    expect(merged.lifecycle.updatedAt).toBe(LATER);
  });

  it("never mutates either input", () => {
    mergeRepeatedExtraction(existing, incoming, LATER);
    expect(existing.provenance.sourceTurnIds).toEqual(["turn-1"]);
    expect(incoming.provenance.sourceTurnIds).toEqual(["turn-2"]);
  });
});

describe("replaceProfileRevision", () => {
  const stored = memory({
    kind: "profile",
    profileKey: asIdentifier<ProfileKey>("role"),
    content: "leads platform",
    lifecycle: { ...memory().lifecycle, archivedAt: NOW },
  });
  const written = memory({
    memoryId: asIdentifier<MemoryId>("mem-2"),
    kind: "profile",
    profileKey: asIdentifier<ProfileKey>("role"),
    content: "leads infrastructure",
  });

  it("REPLACES the content, unlike the extraction merge", () => {
    expect(replaceProfileRevision(stored, written, LATER).content).toBe("leads infrastructure");
  });

  it("keeps the stored row's id, so the upsert is an update", () => {
    expect(replaceProfileRevision(stored, written, LATER).memoryId).toBe(stored.memoryId);
  });

  it("CLEARS `archivedAt`, so writing a key an operator archived brings it back", () => {
    expect(replaceProfileRevision(stored, written, LATER).lifecycle.archivedAt).toBeNull();
  });

  it("keeps the original creation instant", () => {
    expect(replaceProfileRevision(stored, written, LATER).lifecycle.createdAt).toBe(NOW);
  });
});

describe("collision predicates", () => {
  const hash = asIdentifier<ContentHash>("hash-1");

  it("content collides on (environment, subject, thread, hash) and nothing else", () => {
    const left = memory({ contentHash: hash, provenance: { ...NO_PROVENANCE, sourceThreadId: THREAD } });
    const right = memory({
      memoryId: asIdentifier<MemoryId>("mem-2"),
      contentHash: hash,
      provenance: { ...NO_PROVENANCE, sourceThreadId: THREAD },
    });
    expect(collidesOnContent(left, right)).toBe(true);
  });

  it("does not collide across threads", () => {
    const left = memory({ contentHash: hash, provenance: { ...NO_PROVENANCE, sourceThreadId: THREAD } });
    const right = memory({
      contentHash: hash,
      provenance: { ...NO_PROVENANCE, sourceThreadId: asIdentifier<ThreadId>("thread-2") },
    });
    expect(collidesOnContent(left, right)).toBe(false);
  });

  it("does not collide when either row has no hash", () => {
    expect(collidesOnContent(memory(), memory())).toBe(false);
  });

  it("profile keys collide within one AGENT when neither is clustered", () => {
    const key = asIdentifier<ProfileKey>("role");
    const left = memory({ profileKey: key });
    const right = memory({ memoryId: asIdentifier<MemoryId>("mem-2"), profileKey: key });
    expect(collidesOnProfileKey(left, right)).toBe(true);
  });

  it("profile keys do NOT collide across two unclustered agents", () => {
    const key = asIdentifier<ProfileKey>("role");
    const left = memory({ profileKey: key });
    const right = memory({
      profileKey: key,
      ownership: { agentId: asIdentifier("agent-2"), clusterId: null },
    });
    expect(collidesOnProfileKey(left, right)).toBe(false);
  });

  it("profile keys collide across a CLUSTER regardless of which agent wrote", () => {
    const key = asIdentifier<ProfileKey>("role");
    const cluster = asIdentifier<ClusterId>("cluster-1");
    const left = memory({ profileKey: key, ownership: { agentId: asIdentifier("agent-1"), clusterId: cluster } });
    const right = memory({ profileKey: key, ownership: { agentId: asIdentifier("agent-2"), clusterId: cluster } });
    expect(collidesOnProfileKey(left, right)).toBe(true);
  });
});
