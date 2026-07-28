import { describe, it, expect } from "vitest";
import { fuseContextRetrieval } from "./context-retrieval";

const hit = (id: string, meta: Record<string, unknown> = {}) =>
  ({ id, content: `c${id}`, kind: "fact", score: 0.5, metadata: meta, createdAt: new Date(0) }) as any;

const ent = (id: string, key: string, label: string) =>
  ({
    id,
    entityKey: key,
    entityType: "person",
    label,
    aliases: [],
    organizationId: "o",
    projectId: "p",
    environmentId: "e",
    userId: "u",
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as any;

const scope = { organizationId: "o", projectId: "p", environmentId: "e" } as any;

describe("fuseContextRetrieval", () => {
  it("boosts a memory connected to a resolved entity above unconnected ones", async () => {
    const deps = {
      memory: {
        semanticSearch: async () => [hit("m1"), hit("m2", { entities: ["acme"] }), hit("m3")],
      },
      graph: {
        searchEntities: async () => [{ entity: ent("e1", "acme", "Acme"), score: 1 }],
        getRelationships: async () => ({ entity: ent("e1", "acme", "Acme"), outbound: [], inbound: [] }),
      },
    };
    const out = await fuseContextRetrieval(deps as any, scope, { query: "acme deal", userId: "u", agentId: "a" });
    // m2 collects both dense AND graph contributions → ranks first.
    expect(out.memories[0].id).toBe("m2");
    expect(out.entities.map((e) => e.key)).toContain("acme");
    expect(out.signals.graphConnected).toBe(1);
  });

  it("surfaces the 1-hop relationship slice", async () => {
    const acme = ent("e1", "acme", "Acme");
    const priya = ent("e2", "priya", "Priya");
    const deps = {
      memory: { semanticSearch: async () => [hit("m1", { entities: ["acme"] })] },
      graph: {
        searchEntities: async () => [{ entity: acme, score: 1 }],
        getRelationships: async () => ({
          entity: acme,
          outbound: [{ relationship: { relationshipType: "employs" }, to: priya }],
          inbound: [],
        }),
      },
    };
    const out = await fuseContextRetrieval(deps as any, scope, { query: "acme", userId: "u" });
    expect(out.relationships).toContainEqual({ from: "Acme", type: "employs", to: "Priya" });
    expect(out.entities.map((e) => e.key).sort()).toEqual(["acme", "priya"]);
  });

  it("returns dense-only results when no graph service is wired", async () => {
    const deps = { memory: { semanticSearch: async () => [hit("m1"), hit("m2")] } };
    const out = await fuseContextRetrieval(deps as any, scope, { query: "x", userId: "u" });
    expect(out.memories.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(out.entities).toEqual([]);
    expect(out.signals.graphConnected).toBe(0);
  });

  it("degrades to dense when the graph signal throws", async () => {
    const deps = {
      memory: { semanticSearch: async () => [hit("m1")] },
      graph: {
        searchEntities: async () => {
          throw new Error("boom");
        },
        getRelationships: async () => null,
      },
    };
    const out = await fuseContextRetrieval(deps as any, scope, { query: "x", userId: "u" });
    expect(out.memories.map((m) => m.id)).toEqual(["m1"]);
  });
});
