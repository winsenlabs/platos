import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  extractionWatermarkKey,
  workingMemoryKey,
  type ThreadId,
  type TurnId,
} from "../domain/index.js";
import {
  cacheToolResult,
  clearWorkingMemory,
  forgetWorkingField,
  holdPendingAction,
  noteWorkingEntity,
  readCachedToolResult,
  readPendingAction,
  readWatermark,
  readWorkingEntities,
  readWorkingField,
  renderWorkingMemory,
  sweepIsRedundant,
  writeWatermark,
  writeWorkingField,
} from "./working-memory.js";
import { harness, HOUR, THREAD } from "./testing/fixtures.js";

const OTHER_THREAD = asIdentifier<ThreadId>("thread-2");
const HEAD = asIdentifier<TurnId>("turn-9");

describe("working fields", () => {
  it("round-trips a value", async () => {
    const context = harness();
    expect(await writeWorkingField(context.dependencies, THREAD, "note", { a: 1 })).toBe(true);
    expect(await readWorkingField(context.dependencies, THREAD, "note")).toEqual({ a: 1 });
  });

  it("writes with the policy's TTL rather than a server-side default", async () => {
    const context = harness();
    await writeWorkingField(context.dependencies, THREAD, "note", 1);
    expect(context.cache.writes[0]?.ttlSeconds).toBe(
      context.dependencies.policy.cache.workingMemoryTtlSeconds,
    );
  });

  it("EXPIRES against the injected clock", async () => {
    const context = harness();
    await writeWorkingField(context.dependencies, THREAD, "note", 1);
    context.clock.advance(HOUR + 1000);
    expect(await readWorkingField(context.dependencies, THREAD, "note")).toBeNull();
  });

  it("treats a cache FAILURE as a miss rather than failing a turn", async () => {
    const context = harness();
    await writeWorkingField(context.dependencies, THREAD, "note", 1);
    context.cache.failWith("cache down");
    expect(await readWorkingField(context.dependencies, THREAD, "note")).toBeNull();
  });

  it("treats MALFORMED JSON as a miss", async () => {
    const context = harness();
    context.cache.seed(workingMemoryKey(THREAD, "note"), "{not json");
    expect(await readWorkingField(context.dependencies, THREAD, "note")).toBeNull();
  });

  it("removes one field", async () => {
    const context = harness();
    await writeWorkingField(context.dependencies, THREAD, "note", 1);
    expect(await forgetWorkingField(context.dependencies, THREAD, "note")).toBe(true);
    expect(await readWorkingField(context.dependencies, THREAD, "note")).toBeNull();
  });
});

describe("clearing a conversation", () => {
  it("removes every key under THAT thread and no other", async () => {
    const context = harness();
    await writeWorkingField(context.dependencies, THREAD, "a", 1);
    await writeWorkingField(context.dependencies, THREAD, "b", 2);
    await writeWorkingField(context.dependencies, OTHER_THREAD, "a", 3);

    const cleared = await clearWorkingMemory(context.dependencies, THREAD);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error("unreachable");
    expect(cleared.value).toBe(2);
    expect(await readWorkingField(context.dependencies, OTHER_THREAD, "a")).toBe(3);
  });

  it("does NOT touch the extraction watermark, which is a different keyspace", async () => {
    const context = harness();
    await writeWatermark(context.dependencies, THREAD, HEAD);
    await clearWorkingMemory(context.dependencies, THREAD);
    expect(await readWatermark(context.dependencies, THREAD)).toBe(HEAD);
  });

  it("reports zero rather than failing when the cache is down", async () => {
    const context = harness();
    context.cache.failWith("cache down");
    const cleared = await clearWorkingMemory(context.dependencies, THREAD);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) throw new Error("unreachable");
    expect(cleared.value).toBe(0);
  });
});

describe("detected entities", () => {
  it("records a mention and renders it into the context block", async () => {
    const context = harness();
    await noteWorkingEntity(context.dependencies, THREAD, { type: "person", name: "Sam", id: null });
    expect(await readWorkingEntities(context.dependencies, THREAD)).toHaveLength(1);
    expect(await renderWorkingMemory(context.dependencies, THREAD)).toContain("person: Sam");
  });

  it("de-duplicates a repeated mention", async () => {
    const context = harness();
    const sam = { type: "person", name: "Sam", id: null };
    await noteWorkingEntity(context.dependencies, THREAD, sam);
    await noteWorkingEntity(context.dependencies, THREAD, sam);
    expect(await readWorkingEntities(context.dependencies, THREAD)).toHaveLength(1);
  });

  it("does not write again when nothing changed", async () => {
    const context = harness();
    const sam = { type: "person", name: "Sam", id: null };
    await noteWorkingEntity(context.dependencies, THREAD, sam);
    const writes = context.cache.writes.length;
    await noteWorkingEntity(context.dependencies, THREAD, sam);
    expect(context.cache.writes).toHaveLength(writes);
  });

  it("renders the EMPTY string when nothing is known", async () => {
    const context = harness();
    expect(await renderWorkingMemory(context.dependencies, THREAD)).toBe("");
  });

  it("survives a stored value that is not a list", async () => {
    const context = harness();
    context.cache.seed(workingMemoryKey(THREAD, "entities"), '"nonsense"');
    expect(await readWorkingEntities(context.dependencies, THREAD)).toEqual([]);
  });
});

describe("tool results and pending actions", () => {
  it("round-trips a cached tool result", async () => {
    const context = harness();
    await cacheToolResult(context.dependencies, THREAD, "search", { q: "tea" }, { hits: 3 });
    expect(await readCachedToolResult(context.dependencies, THREAD, "search", { q: "tea" })).toEqual({
      hits: 3,
    });
  });

  it("HITS the same entry for arguments given in a different order", async () => {
    const context = harness();
    await cacheToolResult(context.dependencies, THREAD, "search", { a: 1, b: 2 }, "answer");
    expect(await readCachedToolResult(context.dependencies, THREAD, "search", { b: 2, a: 1 })).toBe(
      "answer",
    );
  });

  it("MISSES for different arguments", async () => {
    const context = harness();
    await cacheToolResult(context.dependencies, THREAD, "search", { q: "tea" }, "answer");
    expect(await readCachedToolResult(context.dependencies, THREAD, "search", { q: "coffee" })).toBeNull();
  });

  it("round-trips a pending action", async () => {
    const context = harness();
    await holdPendingAction(context.dependencies, THREAD, "act-1", { kind: "approve" });
    expect(await readPendingAction(context.dependencies, THREAD, "act-1")).toEqual({ kind: "approve" });
  });
});

describe("the extraction watermark", () => {
  it("round-trips the head turn under its own namespace", async () => {
    const context = harness();
    await writeWatermark(context.dependencies, THREAD, HEAD);
    expect(context.cache.keys()).toContain(extractionWatermarkKey(THREAD));
    expect(await readWatermark(context.dependencies, THREAD)).toBe(HEAD);
  });

  it("writes with the fourteen-day lifetime the policy states", async () => {
    const context = harness();
    await writeWatermark(context.dependencies, THREAD, HEAD);
    expect(context.cache.writes[0]?.ttlSeconds).toBe(
      context.dependencies.policy.cache.extractionWatermarkTtlSeconds,
    );
  });

  it("is redundant only at the same head", async () => {
    const context = harness();
    await writeWatermark(context.dependencies, THREAD, HEAD);
    expect(await sweepIsRedundant(context.dependencies, THREAD, HEAD)).toBe(true);
    expect(await sweepIsRedundant(context.dependencies, THREAD, asIdentifier<TurnId>("turn-10"))).toBe(
      false,
    );
  });

  it("a cache failure makes a sweep NOT redundant, which is the safe direction", async () => {
    const context = harness();
    await writeWatermark(context.dependencies, THREAD, HEAD);
    context.cache.failWith("cache down");
    expect(await sweepIsRedundant(context.dependencies, THREAD, HEAD)).toBe(false);
  });

  it("reports a failed write rather than pretending it landed", async () => {
    const context = harness();
    context.cache.failWith("cache down");
    expect(await writeWatermark(context.dependencies, THREAD, HEAD)).toBe(false);
  });
});
