import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistryService } from "./tool-registry.service";

/**
 * Registry invalidation — the two paths that only ever added.
 *
 * Both live bugs came from the same shape: `scopedToolCache` was written by
 * `registerTools` and cleared in exactly one place (`reconcileEntityTools`),
 * which only the MCP discovery path ever called. So over the WebSocket
 * transport a shrinking tool set never shrank, and a deleted entity's tools
 * stayed injected until the process restarted — resolving at dispatch against
 * an entity row that no longer existed.
 */

type Row = { id: string; toolId: string; entityId: string; environmentId: string; tool: { id: string; name: string } };

function makePrisma(rows: Row[], entities: any[]) {
  const state = { rows: [...rows] };
  return {
    state,
    platosToolDefinition: {
      findMany: async () => state.rows.map((r) => ({ ...r.tool, description: "", paramSchema: {}, category: null })),
    },
    platosEntityToolMapping: {
      findMany: async ({ where }: any) => {
        let out = state.rows;
        if (where?.entityId) out = out.filter((r) => r.entityId === where.entityId);
        if (where?.environmentId) out = out.filter((r) => r.environmentId === where.environmentId);
        return out.map((r) => ({
          ...r,
          enabled: true,
          callbackUrl: "http://x",
          entity: entities.find((e) => e.id === r.entityId) ?? null,
        }));
      },
      deleteMany: async ({ where }: any) => {
        const before = state.rows.length;
        if (where?.id?.in) state.rows = state.rows.filter((r) => !where.id.in.includes(r.id));
        else if (where?.entityId) state.rows = state.rows.filter((r) => r.entityId !== where.entityId);
        return { count: before - state.rows.length };
      },
      count: async ({ where }: any) => state.rows.filter((r) => r.toolId === where.toolId).length,
    },
    platosConnectedEntity: {
      findFirst: async ({ where }: any) => entities.find((e) => e.id === where.id) ?? null,
    },
  };
}

const entity = {
  id: "pk_walle",
  entityId: "walle-tools",
  organizationId: "org1",
  projectId: "proj1",
  linkedAgentIds: [],
  mcpConfig: null,
};

const rowsFor = (names: string[]): Row[] =>
  names.map((n, i) => ({
    id: `m${i}`,
    toolId: `t_${n}`,
    entityId: "pk_walle",
    environmentId: "env1",
    tool: { id: `t_${n}`, name: n },
  }));

function makeRegistry(prisma: any) {
  const svc = new ToolRegistryService(prisma as any);
  return svc;
}

describe("reconcileEntityTools — shrinking a declared tool set", () => {
  it("removes the tools a fresh declaration no longer reports", async () => {
    const prisma = makePrisma(rowsFor(["a", "b", "c", "d"]), [entity]);
    const svc = makeRegistry(prisma);
    await svc.rebuildIndex();

    // Entity re-declares a smaller surface — the case that stayed at 22.
    const res = await svc.reconcileEntityTools("pk_walle", "env1", ["a", "b"]);

    expect(res.removed).toBe(2);
    expect(prisma.state.rows.map((r) => r.tool.name).sort()).toEqual(["a", "b"]);
  });

  it("is a no-op when the declaration is unchanged", async () => {
    const prisma = makePrisma(rowsFor(["a", "b"]), [entity]);
    const svc = makeRegistry(prisma);
    await svc.rebuildIndex();
    expect((await svc.reconcileEntityTools("pk_walle", "env1", ["a", "b"])).removed).toBe(0);
  });
});

describe("purgeEntity — deleting an entity", () => {
  it("drops the mappings and evicts the cache bucket", async () => {
    const prisma = makePrisma(rowsFor(["a", "b", "c"]), [entity]);
    const svc = makeRegistry(prisma);
    await svc.rebuildIndex();
    expect(svc.getIndexStats().cachedScopeEntityPairs).toBe(1);

    const res = await svc.purgeEntity("pk_walle");

    expect(res.mappingsRemoved).toBe(3);
    expect(res.bucketsEvicted).toBe(1);
    expect(prisma.state.rows).toHaveLength(0);
    // The condition that produced "Entity walle-tools not registered": tools
    // still resolvable from cache after the entity is gone.
    expect(svc.getIndexStats().cachedScopeEntityPairs).toBe(0);
    expect(
      svc.getScopedTools({ organizationId: "org1", projectId: "proj1", environmentId: "env1" }),
    ).toHaveLength(0);
  });

  it("still evicts when the entity row is already deleted", async () => {
    // purge called after the row is gone — the key cannot be rebuilt, so the
    // bucket has to be found by the entityPk stamped on its entries.
    const prisma = makePrisma(rowsFor(["a"]), [entity]);
    const svc = makeRegistry(prisma);
    await svc.rebuildIndex();

    prisma.platosConnectedEntity.findFirst = async () => null;
    const res = await svc.purgeEntity("pk_walle");

    expect(res.bucketsEvicted).toBe(1);
    expect(svc.getIndexStats().cachedScopeEntityPairs).toBe(0);
  });
});

describe("rebuildIndex — must replace, not merge", () => {
  it("clears a bucket whose entity no longer has mappings", async () => {
    const prisma = makePrisma(rowsFor(["a", "b"]), [entity]);
    const svc = makeRegistry(prisma);
    await svc.rebuildIndex();
    expect(svc.getIndexStats().cachedScopeEntityPairs).toBe(1);

    // Entity deleted out from under the process (what actually happened live).
    prisma.state.rows = [];
    await svc.rebuildIndex();

    expect(svc.getIndexStats().cachedScopeEntityPairs).toBe(0);
  });
});
