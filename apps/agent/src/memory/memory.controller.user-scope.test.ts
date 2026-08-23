import { describe, expect, it, vi } from "vitest";
import { MemoryController } from "./memory.controller";

const baseScope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  agentId: "agent-selected",
};

function request(principal: "operator" | "end-user") {
  return {
    scope: {
      ...baseScope,
      principal,
      userId: principal === "operator" ? "operator-user" : "46123e5c-e5b2-4829-898d-00ec8a6ae1ce",
    },
  } as any;
}

function harness(operatorSelectionValid = true) {
  const database = {
    environment: { findFirst: vi.fn().mockResolvedValue({ id: baseScope.environmentId }) },
    endUser: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where.id === "end-user-selected" && operatorSelectionValid) {
          return { id: "end-user-selected", identities: [{ subject: "external-selected" }] };
        }
        if (where.id === "46123e5c-e5b2-4829-898d-00ec8a6ae1ce") {
          return { id: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce", identities: [{ subject: "verified-external" }] };
        }
        return null;
      }),
    },
    endUserIdentity: { findFirst: vi.fn().mockResolvedValue(null) },
    thread: { findFirst: vi.fn().mockResolvedValue({ id: "thread-1" }) },
  };
  const memoryService = {
    add: vi.fn().mockResolvedValue({ id: "memory-1" }),
    update: vi.fn().mockResolvedValue({ id: "memory-1" }),
    list: vi.fn().mockResolvedValue([]),
    semanticSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    deleteAllForUser: vi.fn().mockResolvedValue(0),
  };
  const graph = {
    getEntities: vi.fn().mockResolvedValue([]),
    getRelationships: vi.fn().mockResolvedValue({ entity: {}, outbound: [], inbound: [] }),
    shortestPath: vi.fn().mockResolvedValue([]),
    upsertEntity: vi.fn(async (_scope: unknown, input: any) => ({ id: `entity-${input.entityKey}` })),
    createRelationship: vi.fn().mockResolvedValue({ id: "relationship-1" }),
  };
  const extraction = {
    extractFromThread: vi.fn().mockResolvedValue({ memoriesCreated: 1 }),
  };
  const exportResponse = response();
  const controller = new MemoryController(
    memoryService as any,
    graph as any,
    extraction as any,
    database as any,
    {} as any,
  );
  return { controller, database, memoryService, graph, extraction, exportResponse };
}

function response() {
  const res = {
    setHeader: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as any;
}

type CaseHarness = ReturnType<typeof harness>;
type HandlerCase = {
  name: string;
  invoke: (h: CaseHarness, principal: "operator" | "end-user", requestedUserId: string) => Promise<unknown>;
  assertUser: (h: CaseHarness, expectedUserId: string, expectedEndUserId: string) => void;
  assertNotCalled: (h: CaseHarness) => void;
  assertRejected?: (h: CaseHarness, result: unknown) => void;
};

const cases: HandlerCase[] = [
  {
    name: "list",
    invoke: (h, principal, userId) => h.controller.listMemories(request(principal), userId),
    assertUser: (h, userId) => expect(h.memoryService.list).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.memoryService.list).not.toHaveBeenCalled(),
  },
  {
    name: "search",
    invoke: (h, principal, userId) => h.controller.searchMemories(request(principal), "query", userId),
    assertUser: (h, userId) => expect(h.memoryService.semanticSearch).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.memoryService.semanticSearch).not.toHaveBeenCalled(),
  },
  {
    name: "create",
    invoke: (h, principal, userId) => h.controller.createMemory(request(principal), { userId, content: "Remember this" }),
    assertUser: (h, userId) => expect(h.memoryService.add).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.memoryService.add).not.toHaveBeenCalled(),
  },
  {
    name: "update/toggle",
    invoke: (h, principal, userId) => h.controller.updateMemory(request(principal), "memory-1", { userId, agentVisible: true }),
    assertUser: (h, userId) => expect(h.memoryService.update).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), "memory-1", expect.objectContaining({ agentVisible: true }), userId),
    assertNotCalled: (h) => expect(h.memoryService.update).not.toHaveBeenCalled(),
  },
  {
    name: "delete",
    invoke: (h, principal, userId) => h.controller.deleteMemory(request(principal), "memory-1", userId),
    assertUser: (h, userId) => expect(h.memoryService.delete).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), "memory-1", userId),
    assertNotCalled: (h) => expect(h.memoryService.delete).not.toHaveBeenCalled(),
  },
  {
    name: "extract",
    invoke: (h, principal, userId) => h.controller.manualExtract(request(principal), { userId, threadId: "thread-1" }),
    assertUser: (h, _userId, endUserId) => {
      expect(h.database.thread.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ endUserId }) }));
      expect(h.extraction.extractFromThread).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ threadId: "thread-1" }));
    },
    assertNotCalled: (h) => expect(h.extraction.extractFromThread).not.toHaveBeenCalled(),
  },
  {
    name: "import",
    invoke: (h, principal, userId) => h.controller.importBundle(request(principal), { userId, bundle: { memories: [{ content: "Imported", kind: "fact" }] } }),
    assertUser: (h, userId) => expect(h.memoryService.add).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId, agentId: baseScope.agentId, source: "imported" })),
    assertNotCalled: (h) => expect(h.memoryService.add).not.toHaveBeenCalled(),
  },
  {
    name: "export",
    invoke: (h, principal, userId) => h.controller.exportBundle(request(principal), h.exportResponse, userId),
    assertUser: (h, userId) => {
      expect(h.memoryService.list).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId, includeArchived: true }));
      expect(h.graph.getEntities).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId }));
    },
    assertNotCalled: (h) => expect(h.memoryService.list).not.toHaveBeenCalled(),
    assertRejected: (h) => {
      expect(h.exportResponse.status).toHaveBeenCalledWith(400);
      expect(h.exportResponse.json).toHaveBeenCalledWith({
        error: "Memory end user not found or access denied",
      });
    },
  },
  {
    name: "graph entities",
    invoke: (h, principal, userId) => h.controller.listEntities(request(principal), userId),
    assertUser: (h, userId) => expect(h.graph.getEntities).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.graph.getEntities).not.toHaveBeenCalled(),
  },
  {
    name: "graph relationships",
    invoke: (h, principal, userId) => h.controller.getRelationships(request(principal), "entity-1", userId),
    assertUser: (h, userId) => expect(h.graph.getRelationships).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), { entityId: "entity-1" }, userId),
    assertNotCalled: (h) => expect(h.graph.getRelationships).not.toHaveBeenCalled(),
  },
  {
    name: "graph path",
    invoke: (h, principal, userId) => h.controller.getShortestPath(request(principal), "entity-from", "entity-to", userId),
    assertUser: (h, userId) => expect(h.graph.shortestPath).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.graph.shortestPath).not.toHaveBeenCalled(),
  },
  {
    name: "relate",
    invoke: (h, principal, userId) => h.controller.relate(request(principal), { userId, fromEntityKey: "from", toEntityKey: "to", relationshipType: "knows" }),
    assertUser: (h, userId) => {
      expect(h.graph.upsertEntity).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId, agentId: baseScope.agentId }));
      expect(h.graph.createRelationship).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId, agentId: baseScope.agentId }));
    },
    assertNotCalled: (h) => expect(h.graph.upsertEntity).not.toHaveBeenCalled(),
  },
];

describe.each(cases)("MemoryController $name EndUser propagation", (handler) => {
  it("accepts the operator-selected active same-Organization EndUser and preserves the Agent pin", async () => {
    const h = harness(true);
    await handler.invoke(h, "operator", "end-user-selected");
    handler.assertUser(h, "external-selected", "end-user-selected");
  });

  it("rejects an invalid or cross-Organization operator EndUser before the handler service runs", async () => {
    const h = harness(false);
    const result = await handler.invoke(h, "operator", "foreign-end-user");
    if (handler.assertRejected) handler.assertRejected(h, result);
    else {
      expect(result).toMatchObject({
        error: "Memory end user not found or access denied",
        status: 400,
      });
    }
    handler.assertNotCalled(h);
  });

  it("ignores a forged body/query EndUser for non-operators and uses verified scope.userId", async () => {
    const h = harness(true);
    await handler.invoke(h, "end-user", "forged-end-user");
    handler.assertUser(h, "verified-external", "46123e5c-e5b2-4829-898d-00ec8a6ae1ce");
    expect(h.database.endUser.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce", organizationId: baseScope.organizationId }),
    }));
  });
});

describe("MemoryController POST route registration", () => {
  it("registers the literal relate endpoint before the parameterized update endpoint", () => {
    const methods = Object.getOwnPropertyNames(MemoryController.prototype);

    expect(methods.indexOf("relate")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("updateMemory")).toBeGreaterThan(methods.indexOf("relate"));
  });
});
