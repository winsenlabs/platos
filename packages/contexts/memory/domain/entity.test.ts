import { asIdentifier, environmentScope } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitEntityKey,
  applyEntityDraft,
  DEFAULT_ENTITY_TYPE,
  MAX_ENTITY_KEY_LENGTH,
  mergeAliases,
  planEntityUpsert,
  promoteEntity,
  stableSlug,
  taggedEntityKeys,
  type EntityDraft,
  type MemoryEntity,
} from "./entity.js";
import type { AgentId, ClusterId, EndUserId, EntityKey, MemoryEntityId } from "./identifiers.js";
import { memorySubject, type MemoryOwnership } from "./scope.js";

const ENVIRONMENT = environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1"));
const SUBJECT = memorySubject(ENVIRONMENT, asIdentifier<EndUserId>("user-1"));
const NOW = new Date("2026-09-03T12:00:00.000Z");
const LATER = new Date("2026-09-03T13:00:00.000Z");

const AGENT = asIdentifier<AgentId>("agent-1");
const CLUSTER = asIdentifier<ClusterId>("cluster-1");
const SOLO: MemoryOwnership = { agentId: AGENT, clusterId: null };
const CLUSTERED: MemoryOwnership = { agentId: AGENT, clusterId: CLUSTER };
const KEY = asIdentifier<EntityKey>("acme-corp");

function entity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    entityId: asIdentifier<MemoryEntityId>("ent-1"),
    subject: SUBJECT,
    ownership: SOLO,
    entityKey: KEY,
    entityType: "org",
    label: "Acme Corp",
    aliases: ["Acme"],
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("stableSlug", () => {
  it("lower-cases and collapses every run of non-alphanumerics to one dash", () => {
    expect(stableSlug("Acme  Corp, Inc.")).toBe("acme-corp-inc");
  });

  it("trims leading and trailing dashes", () => {
    expect(stableSlug("  ...Acme...  ")).toBe("acme");
  });

  it("folds accents through NFKD, so one person is one node", () => {
    expect(stableSlug("José")).toBe(stableSlug("Jose"));
    expect(stableSlug("José")).toBe("jose");
  });

  it("caps the slug so a long name still indexes", () => {
    expect(stableSlug("x".repeat(200))).toHaveLength(MAX_ENTITY_KEY_LENGTH);
  });

  it("is empty for a string with nothing alphanumeric in it", () => {
    expect(stableSlug("!!! ??? ...")).toBe("");
  });

  it("is idempotent — slugging a slug changes nothing", () => {
    const once = stableSlug("Acme Corp, Inc.");
    expect(stableSlug(once)).toBe(once);
  });
});

describe("admitEntityKey", () => {
  it("derives the key from a display name", () => {
    const admitted = admitEntityKey("Acme Corp");
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("acme-corp");
  });

  it("refuses a name that slugs to nothing", () => {
    const admitted = admitEntityKey("???");
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("MEMORY_ENTITY_KEY_INVALID");
  });
});

describe("planEntityUpsert — the three-case ownership rule", () => {
  const draft: EntityDraft = { entityKey: KEY, label: "Acme Corp" };

  it("an UNCLUSTERED agent creates when it holds no node for that key", () => {
    const plan = planEntityUpsert(SOLO, { clustered: null, standalone: null }, draft);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.action).toBe("create");
  });

  it("an UNCLUSTERED agent updates its own node", () => {
    const plan = planEntityUpsert(SOLO, { clustered: null, standalone: entity() }, draft);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.action).toBe("update");
  });

  it("an UNCLUSTERED agent ignores a cluster-owned node it cannot own", () => {
    const plan = planEntityUpsert(
      SOLO,
      { clustered: entity({ ownership: CLUSTERED }), standalone: null },
      draft,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.action).toBe("create");
  });

  it("a CLUSTERED agent updates the cluster's node", () => {
    const plan = planEntityUpsert(
      CLUSTERED,
      { clustered: entity({ ownership: CLUSTERED }), standalone: null },
      draft,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.action).toBe("update");
  });

  it("a CLUSTERED agent PROMOTES its own standalone node rather than duplicating it", () => {
    const plan = planEntityUpsert(CLUSTERED, { clustered: null, standalone: entity() }, draft);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.action).toBe("promote");
  });

  it("REFUSES when both a clustered and a standalone node hold the key", () => {
    const plan = planEntityUpsert(
      CLUSTERED,
      { clustered: entity({ ownership: CLUSTERED }), standalone: entity() },
      draft,
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("unreachable");
    expect(plan.error.code).toBe("MEMORY_ENTITY_OWNERSHIP_CONFLICT");
    expect(plan.error.category).toBe("conflict");
  });

  it("creates when the cluster holds nothing for that key", () => {
    const plan = planEntityUpsert(CLUSTERED, { clustered: null, standalone: null }, draft);
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("unreachable");
    expect(plan.value.action).toBe("create");
  });
});

describe("applyEntityDraft", () => {
  it("an ABSENT field leaves the stored value", () => {
    const folded = applyEntityDraft(entity(), { entityKey: KEY }, LATER);
    expect(folded.entityType).toBe("org");
    expect(folded.label).toBe("Acme Corp");
    expect(folded.aliases).toEqual(["Acme"]);
  });

  it("a PRESENT field replaces it", () => {
    const folded = applyEntityDraft(entity(), { entityKey: KEY, label: "Acme Ltd" }, LATER);
    expect(folded.label).toBe("Acme Ltd");
  });

  it("UNIONS aliases rather than replacing them", () => {
    const folded = applyEntityDraft(entity(), { entityKey: KEY, aliases: ["ACME Inc"] }, LATER);
    expect(folded.aliases).toEqual(["Acme", "ACME Inc"]);
  });

  it("advances `updatedAt` and never `createdAt`", () => {
    const folded = applyEntityDraft(entity(), { entityKey: KEY }, LATER);
    expect(folded.updatedAt).toBe(LATER);
    expect(folded.createdAt).toBe(NOW);
  });

  it("does not mutate the stored node", () => {
    const stored = entity();
    applyEntityDraft(stored, { entityKey: KEY, label: "Other" }, LATER);
    expect(stored.label).toBe("Acme Corp");
  });

  it("promotion is an ownership change PLUS the ordinary fold", () => {
    const promoted = promoteEntity(entity(), CLUSTERED, { entityKey: KEY, label: "Acme Ltd" }, LATER);
    expect(promoted.ownership).toEqual(CLUSTERED);
    expect(promoted.label).toBe("Acme Ltd");
    expect(promoted.entityId).toBe("ent-1");
  });
});

describe("mergeAliases", () => {
  it("preserves first-seen order and drops duplicates", () => {
    expect(mergeAliases(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("trims and drops blanks", () => {
    expect(mergeAliases([], ["  a  ", "   ", ""])).toEqual(["a"]);
  });

  it("is stable, so a repeated upsert does not rewrite the row", () => {
    const merged = mergeAliases(["a", "b"], ["a", "b"]);
    expect(merged).toEqual(["a", "b"]);
  });
});

describe("taggedEntityKeys", () => {
  it("reads the slugs extraction stamped on a memory", () => {
    expect(taggedEntityKeys({ entities: ["acme-corp", "sam"] })).toEqual(["acme-corp", "sam"]);
  });

  it("yields nothing for a memory written by hand", () => {
    expect(taggedEntityKeys(null)).toEqual([]);
    expect(taggedEntityKeys({ topic: "tea" })).toEqual([]);
  });

  it("drops non-string members rather than failing", () => {
    expect(taggedEntityKeys({ entities: ["acme", 7, null] })).toEqual(["acme"]);
  });

  it("yields nothing when `entities` is not a list", () => {
    expect(taggedEntityKeys({ entities: "acme" })).toEqual([]);
  });
});

describe("the default entity type", () => {
  it("is `other`, which is what the extractor falls back to", () => {
    expect(DEFAULT_ENTITY_TYPE).toBe("other");
  });
});
