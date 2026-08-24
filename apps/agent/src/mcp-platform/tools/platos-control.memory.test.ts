import { describe, expect, it, vi } from "vitest";
import { MEMORY_VISIBILITIES } from "@platos/tenancy-database";
import { buildPlatosControlToolHandlers } from "./platos-control";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  agentId: "agent-a",
  userId: "operator-a",
  principal: "operator",
} as any;

function harness() {
  const memory = {
    listPage: vi.fn(),
    semanticSearch: vi.fn().mockResolvedValue([]),
    listExportKeysetPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    deleteAllForUser: vi.fn(),
    delete: vi.fn().mockResolvedValue(true),
  };
  const graph = {
    getEntitiesExportKeysetPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getRelationshipsExportKeysetPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
  const memoryImport = { importBundle: vi.fn().mockResolvedValue({ ok: true, skipped: 0 }) };
  const prisma = {
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>, options: unknown) =>
      callback({ snapshot: true, options })),
  };
  const deps = {
    memory,
    memoryImport,
    memoryExtraction: {},
    conversation: {},
    graph,
    providers: {},
    approvals: {},
    budgets: {},
    evals: {},
    cost: {},
    toolAudit: { record: vi.fn().mockResolvedValue(undefined), list: vi.fn() },
    safetyEvents: { list: vi.fn() },
    prisma,
  } as any;
  const handlers = buildPlatosControlToolHandlers(deps);
  const execute = (name: string, params: Record<string, unknown>) => {
    const handler = handlers.find((candidate) => candidate.name === name);
    if (!handler) throw new Error(`missing handler ${name}`);
    return handler.execute(params, scope, {} as any);
  };
  return { execute, memory, memoryImport, graph, prisma };
}

function bundle() {
  return {
    version: 2,
    memories: [{
      id: "memory-exported-1",
      kind: "fact",
      content: "Round trip",
      metadata: null,
      visibility: "hidden",
      agentVisible: false,
      source: "extracted",
      sourceThreadId: null,
      sourceTurnIds: [],
      confidence: 0.81,
      archivedAt: "2026-08-24T10:00:00.000Z",
    }],
    entities: [],
    relationships: [],
  };
}

describe("Platos control Memory tools", () => {
  it("traverses a 384-row management scope with canonical page metadata and visibility", async () => {
    const h = harness();
    const rows = Array.from({ length: 384 }, (_, index) => ({ id: `memory-${index}` }));
    h.memory.listPage.mockImplementation(async (_scope: unknown, input: any) => {
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 50;
      const items = rows.slice(offset, offset + limit);
      return { items, total: rows.length, limit, offset, hasNext: offset + items.length < rows.length };
    });

    const seen: string[] = [];
    for (const offset of [0, 100, 200, 300]) {
      const page = await h.execute("memories.list", { userId: "user-a", limit: 100, offset }) as any;
      expect(page).toMatchObject({ total: 384, limit: 100, offset });
      seen.push(...page.memories.map((row: any) => row.id));
    }

    expect(seen).toHaveLength(384);
    expect(new Set(seen).size).toBe(384);
    expect(h.memory.listPage).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-a" }),
      expect.objectContaining({ visibilityIn: [...MEMORY_VISIBILITIES] }),
    );
  });

  it("exports uncapped keyset pages in one repeatable snapshot", async () => {
    const h = harness();
    h.memory.listExportKeysetPage
      .mockResolvedValueOnce({
        items: [{
          id: "memory-1", kind: "fact", content: "One", metadata: null,
          visibility: "agent_visible", agentVisible: true, source: "manual",
          sourceThreadId: null, sourceTurnIds: [], extractorVersion: null,
          confidence: null, createdAt: new Date(), updatedAt: new Date(),
          lastAccessedAt: null, quarantinedAt: null, archivedAt: null,
        }],
        nextCursor: "memory-1",
      })
      .mockResolvedValueOnce({ items: [], nextCursor: null });

    const exported = await h.execute("gdpr.export", { userId: "user-a" }) as any;

    expect(exported.version).toBe(2);
    expect(exported.memories).toHaveLength(1);
    expect(h.memory.listExportKeysetPage).toHaveBeenNthCalledWith(
      2, expect.anything(), "user-a", "memory-1", 500, expect.anything(),
    );
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
      timeout: 120_000,
    });
  });

  it("validates the full bundle before delegating transactional replace import", async () => {
    const h = harness();

    await h.execute("gdpr.import", {
      userId: "user-a",
      mode: "replace",
      confirmReplace: true,
      bundle: bundle(),
    });

    expect(h.memoryImport.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-a" }),
      "user-a",
      expect.objectContaining({
        version: 2,
        memories: [expect.objectContaining({
          source: "extracted",
          confidence: 0.81,
          archivedAt: new Date("2026-08-24T10:00:00.000Z"),
        })],
      }),
      "replace",
    );

    await expect(h.execute("gdpr.import", {
      userId: "user-a",
      bundle: { memories: [] },
    })).rejects.toMatchObject({ code: "MEMORY_IMPORT_INVALID_BUNDLE" });
    expect(h.memoryImport.importBundle).toHaveBeenCalledTimes(1);
  });

  it("returns the REST-equivalent stable not-found error for delete", async () => {
    const h = harness();
    h.memory.delete.mockResolvedValue(false);

    await expect(h.execute("memories.delete", { memoryId: "outside-scope" })).rejects.toMatchObject({
      code: "MEMORY_NOT_FOUND",
      status: 404,
      statusCode: 404,
      message: "memory not found",
    });
  });
});
