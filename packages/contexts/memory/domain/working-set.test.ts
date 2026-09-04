import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AgentId, EndUserId, ThreadId, TurnId } from "./identifiers.js";
import { memorySubject } from "./scope.js";
import {
  addWorkingEntity,
  extractionWatermarkKey,
  EXTRACTION_WATERMARK_TTL_SECONDS,
  isSweepRedundant,
  pendingActionField,
  profileCacheKey,
  PROFILE_CACHE_TTL_SECONDS,
  renderWorkingContext,
  subjectCachePrefix,
  toolResultField,
  workingMemoryKey,
  workingMemoryPrefix,
  WORKING_ENTITIES_FIELD,
  WORKING_MEMORY_TTL_SECONDS,
  type WorkingEntity,
} from "./working-set.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const THREAD = asIdentifier<ThreadId>("thread-1");
const AGENT = asIdentifier<AgentId>("agent-1");
const SUBJECT_ID = asIdentifier<EndUserId>("user-1");

describe("the three keyspaces", () => {
  it("are namespaced apart, so one cannot collide with another", () => {
    expect(workingMemoryKey(THREAD, "entities")).toBe("wm:thread-1:entities");
    expect(extractionWatermarkKey(THREAD)).toBe("memx:thread-1");
    expect(profileCacheKey(ENVIRONMENT, AGENT, SUBJECT_ID)).toBe(
      "profile:org/org-1/proj/proj-1/env/env-1:agent-1:user-1",
    );
  });

  it("build the profile key on the kernel's resolvePath, not a private format", () => {
    expect(profileCacheKey(ENVIRONMENT, AGENT, SUBJECT_ID)).toContain("org/org-1/proj/proj-1/env/env-1");
  });

  it("give a thread's working memory a prefix its own keys sit under", () => {
    const prefix = workingMemoryPrefix(THREAD);
    expect(workingMemoryKey(THREAD, "entities").startsWith(prefix)).toBe(true);
    expect(workingMemoryKey(asIdentifier<ThreadId>("thread-2"), "entities").startsWith(prefix)).toBe(
      false,
    );
  });

  it("give a subject a cache prefix built from its own path", () => {
    expect(subjectCachePrefix(memorySubject(ENVIRONMENT, SUBJECT_ID))).toBe(
      "profile:org/org-1/proj/proj-1/env/env-1/user/user-1",
    );
  });

  it("carry the TTLs the source uses", () => {
    expect(WORKING_MEMORY_TTL_SECONDS).toBe(3600);
    expect(PROFILE_CACHE_TTL_SECONDS).toBe(600);
    expect(EXTRACTION_WATERMARK_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
  });
});

describe("the tool-result field", () => {
  it("SORTS the argument keys, so two argument orders are ONE cache entry", () => {
    expect(toolResultField("search", { b: 2, a: 1 })).toBe(toolResultField("search", { a: 1, b: 2 }));
  });

  it("sorts at every depth", () => {
    expect(toolResultField("search", { outer: { b: 2, a: 1 } })).toBe(
      toolResultField("search", { outer: { a: 1, b: 2 } }),
    );
  });

  it("does NOT reorder an array, whose order is meaningful", () => {
    expect(toolResultField("search", { of: [1, 2] })).not.toBe(toolResultField("search", { of: [2, 1] }));
  });

  it("distinguishes two tools with the same arguments", () => {
    expect(toolResultField("search", { a: 1 })).not.toBe(toolResultField("lookup", { a: 1 }));
  });

  it("distinguishes two argument sets for one tool", () => {
    expect(toolResultField("search", { a: 1 })).not.toBe(toolResultField("search", { a: 2 }));
  });

  it("namespaces a pending action apart from a tool result", () => {
    expect(pendingActionField("act-1")).toBe("action:act-1");
    expect(WORKING_ENTITIES_FIELD).toBe("entities");
  });
});

describe("working entities", () => {
  const sam: WorkingEntity = { type: "person", name: "Sam", id: null };

  it("adds a mention", () => {
    expect(addWorkingEntity([], sam)).toEqual([sam]);
  });

  it("de-duplicates on the (type, name) PAIR", () => {
    const twice = addWorkingEntity([sam], { ...sam, id: "ent-1" });
    expect(twice).toHaveLength(1);
  });

  it("keeps a person and a project that share a name apart", () => {
    const project: WorkingEntity = { type: "project", name: "Sam", id: null };
    expect(addWorkingEntity([sam], project)).toHaveLength(2);
  });

  it("returns the SAME array when nothing changed, so a caller can tell", () => {
    const existing = [sam];
    expect(addWorkingEntity(existing, sam)).toBe(existing);
  });

  it("never mutates the input", () => {
    const existing = [sam];
    addWorkingEntity(existing, { type: "org", name: "Acme", id: null });
    expect(existing).toHaveLength(1);
  });
});

describe("renderWorkingContext", () => {
  it("renders each mention as `type: name`", () => {
    expect(
      renderWorkingContext([
        { type: "person", name: "Sam", id: null },
        { type: "org", name: "Acme", id: null },
      ]),
    ).toBe("[Working Memory] Entities mentioned in this conversation: person: Sam, org: Acme");
  });

  it("renders NOTHING for an empty set rather than an empty header", () => {
    expect(renderWorkingContext([])).toBe("");
  });
});

describe("the extraction watermark", () => {
  it("is redundant only when the stored head IS the current head", () => {
    expect(isSweepRedundant("turn-9", asIdentifier<TurnId>("turn-9"))).toBe(true);
    expect(isSweepRedundant("turn-8", asIdentifier<TurnId>("turn-9"))).toBe(false);
  });

  it("a MISSING watermark means sweep, which is the safe direction", () => {
    expect(isSweepRedundant(null, asIdentifier<TurnId>("turn-9"))).toBe(false);
  });

  it("a thread with no turns is never redundant", () => {
    expect(isSweepRedundant("turn-9", null)).toBe(false);
  });
});
