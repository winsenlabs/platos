import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EndUserId, MemoryId, ProfileKey } from "../domain/index.js";
import { archive, forget, forgetMany, restore } from "./forget.js";
import { describeMemory, exportMemories, listMemories, pageMemories, resolveArchiveState } from "./read-memories.js";
import { revise, resolveVisibility } from "./revise.js";
import {
  AGENT,
  bindingFixture,
  harness,
  memoryFixture,
  OUTSIDE_AGENT,
  runtimeGrant,
  SUBJECT_ID,
  subjectFixture,
  type MemoryHarness,
} from "./testing/fixtures.js";
import { deterministicEmbedding } from "./testing/in-memory-embedding-model.js";

/**
 * A FIXED instant, because a fixture that says `new Date()` is a fixture whose
 * value depends on when the suite runs. `scripts/arch/ambient-time.mjs` rule T2
 * refuses the ambient form here as it does in the code under test: the whole
 * reason `Clock` is a port is that an instant is an input.
 */
const MARKED_AT = new Date("2026-01-01T00:00:00.000Z");


function seed(
  context: MemoryHarness,
  id: string,
  overrides: Parameters<typeof memoryFixture>[0] = {},
): void {
  const memory = memoryFixture({ memoryId: asIdentifier<MemoryId>(id), ...overrides });
  context.repository.seed(memory, memory.kind === "profile" ? null : deterministicEmbedding(memory.content));
}

const READ = {
  authorization: runtimeGrant(),
  endUserId: null,
  actingAgentId: null,
  requestedAgentIds: [],
  kind: null,
  source: null,
  visibilityIn: undefined,
  archiveState: null,
  includeArchived: null,
  limit: null,
  offset: null,
};

describe("reads", () => {
  it("describes one memory inside the caller's agent scope", async () => {
    const context = harness();
    seed(context, "mem-1");
    const described = await describeMemory(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId: asIdentifier<MemoryId>("mem-1"),
    });
    expect(described.ok).toBe(true);
  });

  it("reports a memory in ANOTHER agent's scope as NOT FOUND, not forbidden", async () => {
    const context = harness({
      bindings: [bindingFixture({ agentId: AGENT }), bindingFixture({ agentId: OUTSIDE_AGENT })],
    });
    seed(context, "mem-theirs", { ownership: { agentId: OUTSIDE_AGENT, clusterId: null } });
    const described = await describeMemory(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId: asIdentifier<MemoryId>("mem-theirs"),
    });
    expect(described.ok).toBe(false);
    if (described.ok) throw new Error("unreachable");
    expect(described.error.code).toBe("MEMORY_NOT_FOUND");
    expect(described.error.category).toBe("not_found");
  });

  it("reports a memory belonging to another SUBJECT as not found", async () => {
    const context = harness();
    seed(context, "mem-theirs", {
      subject: subjectFixture({ endUserId: asIdentifier<EndUserId>("user-2") }),
    });
    const described = await describeMemory(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryId: asIdentifier<MemoryId>("mem-theirs"),
    });
    expect(described.ok).toBe(false);
  });

  it("an operator listing INCLUDES quarantined and retrieval-augmented rows", async () => {
    const context = harness();
    seed(context, "mem-live");
    seed(context, "mem-quarantined", {
      lifecycle: { ...memoryFixture().lifecycle, quarantinedAt: MARKED_AT },
    });
    seed(context, "mem-rag", { source: "rag" });
    const listed = await listMemories(context.dependencies, READ);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(3);
  });

  it("EXCLUDES archived rows by default", async () => {
    const context = harness();
    seed(context, "mem-live");
    seed(context, "mem-archived", { lifecycle: { ...memoryFixture().lifecycle, archivedAt: MARKED_AT } });
    const listed = await listMemories(context.dependencies, READ);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.map((memory) => memory.memoryId)).toEqual(["mem-live"]);
  });

  it("reads the archive state with `archiveState` winning over the legacy boolean", () => {
    expect(resolveArchiveState(null, null)).toBe("active");
    expect(resolveArchiveState(null, true)).toBe("all");
    expect(resolveArchiveState(null, false)).toBe("active");
    expect(resolveArchiveState("archived", true)).toBe("archived");
  });

  it("pages with a total, and clamps a page a caller asked for", async () => {
    const context = harness();
    for (let index = 0; index < 5; index += 1) seed(context, `mem-${index}`);
    const paged = await pageMemories(context.dependencies, { ...READ, limit: 2, offset: 1 });
    expect(paged.ok).toBe(true);
    if (!paged.ok) throw new Error("unreachable");
    expect(paged.value.items).toHaveLength(2);
    expect(paged.value.total).toBe(5);
  });

  it("REFUSES an empty visibility list rather than widening the read", async () => {
    const context = harness();
    const listed = await listMemories(context.dependencies, { ...READ, visibilityIn: [] });
    expect(listed.ok).toBe(false);
    if (listed.ok) throw new Error("unreachable");
    expect(listed.error.code).toBe("MEMORY_INVALID_VISIBILITY");
  });

  it("exports by KEYSET, resuming exactly where it stopped", async () => {
    const context = harness();
    for (const id of ["mem-1", "mem-2", "mem-3"]) seed(context, id);
    const first = await exportMemories(context.dependencies, { ...READ, afterId: null, limit: 2 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.value.items.map((memory) => memory.memoryId)).toEqual(["mem-1", "mem-2"]);

    const next = await exportMemories(context.dependencies, {
      ...READ,
      afterId: first.value.nextCursor,
      limit: 2,
    });
    if (!next.ok) throw new Error("unreachable");
    expect(next.value.items.map((memory) => memory.memoryId)).toEqual(["mem-3"]);
  });
});

describe("archive and restore", () => {
  const command = {
    authorization: runtimeGrant(),
    endUserId: null,
    actingAgentId: null,
    memoryId: asIdentifier<MemoryId>("mem-1"),
  };

  it("archives, and reports that it changed something", async () => {
    const context = harness();
    seed(context, "mem-1");
    const archived = await archive(context.dependencies, command);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("unreachable");
    expect(archived.value.changed).toBe(true);
    expect(archived.value.memory.lifecycle.archivedAt).not.toBeNull();
  });

  it("archiving twice is IDEMPOTENT and reports no change the second time", async () => {
    const context = harness();
    seed(context, "mem-1");
    await archive(context.dependencies, command);
    const again = await archive(context.dependencies, command);
    if (!again.ok) throw new Error("unreachable");
    expect(again.value.changed).toBe(false);
  });

  it("restores, and reports the change", async () => {
    const context = harness();
    seed(context, "mem-1", { lifecycle: { ...memoryFixture().lifecycle, archivedAt: MARKED_AT } });
    const restored = await restore(context.dependencies, command);
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.value.changed).toBe(true);
    expect(restored.value.memory.lifecycle.archivedAt).toBeNull();
  });

  it("does NOT re-embed while archiving", async () => {
    const context = harness();
    seed(context, "mem-1");
    await archive(context.dependencies, command);
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("refuses a memory outside the caller's scope as not found", async () => {
    const context = harness();
    const archived = await archive(context.dependencies, command);
    expect(archived.ok).toBe(false);
    if (archived.ok) throw new Error("unreachable");
    expect(archived.error.code).toBe("MEMORY_NOT_FOUND");
  });
});

describe("forget", () => {
  const command = {
    authorization: runtimeGrant(),
    endUserId: null,
    actingAgentId: null,
    memoryId: asIdentifier<MemoryId>("mem-1"),
  };

  it("destroys the row and reports it", async () => {
    const context = harness();
    seed(context, "mem-1");
    const forgotten = await forget(context.dependencies, command);
    expect(forgotten.ok).toBe(true);
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(true);
    expect(context.repository.all()).toHaveLength(0);
  });

  it("reports false rather than failing when there was nothing to destroy", async () => {
    const context = harness();
    const forgotten = await forget(context.dependencies, command);
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(false);
  });

  it("cannot destroy a memory outside the caller's agent scope", async () => {
    const context = harness({
      bindings: [bindingFixture({ agentId: AGENT }), bindingFixture({ agentId: OUTSIDE_AGENT })],
    });
    seed(context, "mem-1", { ownership: { agentId: OUTSIDE_AGENT, clusterId: null } });
    const forgotten = await forget(context.dependencies, command);
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(false);
    expect(context.repository.all()).toHaveLength(1);
  });

  it("bulk forgets several ids and reports the count", async () => {
    const context = harness();
    for (const id of ["mem-1", "mem-2", "mem-3"]) seed(context, id);
    const forgotten = await forgetMany(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryIds: [asIdentifier<MemoryId>("mem-1"), asIdentifier<MemoryId>("mem-2")],
    });
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(2);
    expect(context.repository.all()).toHaveLength(1);
  });

  it("REFUSES a bulk request over the cap rather than truncating it", async () => {
    const context = harness();
    const ids = Array.from({ length: 101 }, (_unused, index) =>
      asIdentifier<MemoryId>(`mem-${index}`),
    );
    const forgotten = await forgetMany(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryIds: ids,
    });
    expect(forgotten.ok).toBe(false);
    if (forgotten.ok) throw new Error("unreachable");
    expect(forgotten.error.code).toBe("MEMORY_BULK_LIMIT_EXCEEDED");
  });

  it("de-duplicates before applying the cap", async () => {
    const context = harness();
    const repeated = Array.from({ length: 200 }, () => asIdentifier<MemoryId>("mem-1"));
    const forgotten = await forgetMany(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryIds: repeated,
    });
    expect(forgotten.ok).toBe(true);
  });

  it("an empty bulk request is zero, not an error", async () => {
    const context = harness();
    const forgotten = await forgetMany(context.dependencies, {
      authorization: runtimeGrant(),
      endUserId: null,
      actingAgentId: null,
      memoryIds: [],
    });
    if (!forgotten.ok) throw new Error("unreachable");
    expect(forgotten.value).toBe(0);
  });
});

describe("a `metadata` grant reads but does not destroy", () => {
  const metadataRead = (context: MemoryHarness) => ({
    ...READ,
    authorization: context.tenancy.grant("metadata"),
    endUserId: SUBJECT_ID,
    actingAgentId: AGENT,
  });

  it("lists under `metadata`", async () => {
    const context = harness();
    seed(context, "mem-1");
    const listed = await listMemories(context.dependencies, metadataRead(context));
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toHaveLength(1);
  });

  it("REFUSES to archive, restore, revise, forget or bulk-forget under `metadata`", async () => {
    const context = harness();
    seed(context, "mem-1");
    const command = {
      authorization: context.tenancy.grant("metadata"),
      endUserId: SUBJECT_ID,
      actingAgentId: AGENT,
      memoryId: asIdentifier<MemoryId>("mem-1"),
    };
    for (const outcome of [
      await archive(context.dependencies, command),
      await restore(context.dependencies, command),
      await revise(context.dependencies, { ...command, content: "rewritten" }),
      await forget(context.dependencies, command),
      await forgetMany(context.dependencies, { ...command, memoryIds: [command.memoryId] }),
    ]) {
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.error.code).toBe("MEMORY_SCOPE_MISMATCH");
    }
    expect(context.repository.all()).toHaveLength(1);
    expect(context.repository.all()[0]?.content).toBe(memoryFixture().content);
  });
});

describe("revise", () => {
  const command = {
    authorization: runtimeGrant(),
    endUserId: null,
    actingAgentId: null,
    memoryId: asIdentifier<MemoryId>("mem-1"),
  };

  it("patches the content and RE-EMBEDS", async () => {
    const context = harness();
    seed(context, "mem-1");
    const revised = await revise(context.dependencies, { ...command, content: "prefers coffee" });
    expect(revised.ok).toBe(true);
    if (!revised.ok) throw new Error("unreachable");
    expect(revised.value.content).toBe("prefers coffee");
    expect(context.embeddings.requests).toEqual(["prefers coffee"]);
  });

  it("does NOT re-embed when the content did not move", async () => {
    const context = harness();
    seed(context, "mem-1");
    await revise(context.dependencies, { ...command, visibility: "hidden" });
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("does not recompute the hash when the content did not move", async () => {
    const context = harness();
    seed(context, "mem-1");
    await revise(context.dependencies, { ...command, visibility: "hidden" });
    expect(context.repository.all()[0]?.contentHash).toBeNull();
  });

  it("CLEARS the vector when a row becomes a profile", async () => {
    const context = harness();
    seed(context, "mem-1");
    const revised = await revise(context.dependencies, {
      ...command,
      kind: "profile",
      metadata: { profileKey: "role" },
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) throw new Error("unreachable");
    expect(context.repository.embeddingOf(revised.value.memoryId)).toBeNull();
    expect(context.embeddings.requests).toHaveLength(0);
  });

  it("SETS a vector when a profile becomes a fact, even with unchanged content", async () => {
    const context = harness();
    seed(context, "mem-1", {
      kind: "profile",
      profileKey: asIdentifier<ProfileKey>("role"),
      content: "leads platform",
    });
    const revised = await revise(context.dependencies, { ...command, kind: "fact" });
    expect(revised.ok).toBe(true);
    if (!revised.ok) throw new Error("unreachable");
    expect(context.repository.embeddingOf(revised.value.memoryId)).not.toBeNull();
  });

  it("leaves an ABSENT field alone", async () => {
    const context = harness();
    seed(context, "mem-1", { visibility: "private" });
    const revised = await revise(context.dependencies, { ...command, content: "prefers coffee" });
    if (!revised.ok) throw new Error("unreachable");
    expect(revised.value.visibility).toBe("private");
  });

  it("does not let a patch rewrite provenance or ownership", async () => {
    const context = harness();
    seed(context, "mem-1", { source: "extracted" });
    const revised = await revise(context.dependencies, { ...command, content: "prefers coffee" });
    if (!revised.ok) throw new Error("unreachable");
    expect(revised.value.source).toBe("extracted");
    expect(revised.value.ownership.agentId).toBe(AGENT);
  });

  it("refuses a patch that would make the content invalid", async () => {
    const context = harness();
    seed(context, "mem-1");
    const revised = await revise(context.dependencies, { ...command, content: "   " });
    expect(revised.ok).toBe(false);
  });

  it("resolves visibility with the explicit field winning, then the boolean", () => {
    expect(resolveVisibility({ visibility: "private", agentVisible: true }, "hidden")).toEqual({
      ok: true,
      value: "private",
    });
    expect(resolveVisibility({ agentVisible: false }, "agent_visible")).toEqual({
      ok: true,
      value: "hidden",
    });
    expect(resolveVisibility({}, "private")).toEqual({ ok: true, value: "private" });
    expect(SUBJECT_ID).toBe("user-1");
  });
});
