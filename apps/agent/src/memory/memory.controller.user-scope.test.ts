import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readdir } from "node:fs/promises";
import { MemoryController } from "./memory.controller";

const baseScope = {
  organizationId: "org",
  projectId: "project",
  environmentId: "environment",
  agentId: "agent-selected",
};

const validBundle = {
  version: 2 as const,
  memories: [{
    id: "memory-exported-1",
    kind: "fact",
    content: "Imported",
    metadata: null,
    visibility: "agent_visible",
    agentVisible: true,
    source: "manual",
    sourceThreadId: null,
    sourceTurnIds: [],
  }],
  entities: [],
  relationships: [],
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
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({ snapshot: true })),
  };
  const memoryService = {
    add: vi.fn().mockResolvedValue({ id: "memory-1" }),
    update: vi.fn().mockResolvedValue({ id: "memory-1" }),
    listPage: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, hasNext: false }),
    listExportPage: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0, hasNext: false }),
    listExportKeysetPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    semanticSearch: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    archive: vi.fn().mockResolvedValue({ ok: true, archivedAt: new Date().toISOString() }),
    restore: vi.fn().mockResolvedValue({ ok: true, memory: { id: "memory-1" } }),
    deleteAllForUser: vi.fn().mockResolvedValue(0),
  };
  const graph = {
    getEntitiesPage: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0, hasNext: false }),
    getEntitiesExportPage: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 1000, offset: 0, hasNext: false }),
    getEntitiesExportKeysetPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getRelationshipsExportKeysetPage: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listRelationshipsPage: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0, hasNext: false }),
    getRelationships: vi.fn().mockResolvedValue({ entity: {}, outbound: [], inbound: [] }),
    shortestPath: vi.fn().mockResolvedValue([]),
    upsertEntity: vi.fn(async (_scope: unknown, input: any) => ({ id: `entity-${input.entityKey}` })),
    createRelationship: vi.fn().mockResolvedValue({ id: "relationship-1" }),
    resolveEntityReference: vi.fn(async (_scope: unknown, _userId: string, reference: string) => ({ id: reference })),
  };
  const extraction = {
    extractFromThread: vi.fn().mockResolvedValue({ memoriesCreated: 1 }),
  };
  const exportResponse = response();
  const memoryImport = { importBundle: vi.fn().mockResolvedValue({ ok: true, skipped: 0 }) };
  const controller = new MemoryController(
    memoryService as any,
    graph as any,
    memoryImport as any,
    extraction as any,
    database as any,
    {} as any,
  );
  return { controller, database, memoryService, graph, memoryImport, extraction, exportResponse };
}

function response() {
  const res = {
    setHeader: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    destroy: vi.fn(),
    headersSent: false,
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
    assertUser: (h, userId) => expect(h.memoryService.listPage).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.memoryService.listPage).not.toHaveBeenCalled(),
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
    name: "archive",
    invoke: (h, principal, userId) => h.controller.archiveMemory(request(principal), "memory-1", { userId }),
    assertUser: (h, userId) => expect(h.memoryService.archive).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), "memory-1", userId),
    assertNotCalled: (h) => expect(h.memoryService.archive).not.toHaveBeenCalled(),
  },
  {
    name: "restore",
    invoke: (h, principal, userId) => h.controller.restoreMemory(request(principal), "memory-1", { userId }),
    assertUser: (h, userId) => expect(h.memoryService.restore).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), "memory-1", userId),
    assertNotCalled: (h) => expect(h.memoryService.restore).not.toHaveBeenCalled(),
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
    invoke: (h, principal, userId) => h.controller.importBundle(request(principal), { userId, bundle: validBundle }),
    assertUser: (h, userId) => expect(h.memoryImport.importBundle).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: baseScope.agentId }),
      userId,
      expect.objectContaining({ version: 2, memories: [expect.objectContaining({ exportedId: "memory-exported-1" })] }),
      "merge",
    ),
    assertNotCalled: (h) => expect(h.memoryImport.importBundle).not.toHaveBeenCalled(),
  },
  {
    name: "export",
    invoke: (h, principal, userId) => h.controller.exportBundle(request(principal), h.exportResponse, userId),
    assertUser: (h, userId) => {
      expect(h.memoryService.listExportKeysetPage).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: baseScope.agentId }), userId, null, 500, expect.anything(),
      );
      expect(h.graph.getEntitiesExportKeysetPage).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: baseScope.agentId }), userId, null, 500, expect.anything(),
      );
      expect(h.graph.getRelationshipsExportKeysetPage).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: baseScope.agentId }), userId, null, 500, expect.anything(),
      );
    },
    assertNotCalled: (h) => expect(h.memoryService.listExportKeysetPage).not.toHaveBeenCalled(),
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
    assertUser: (h, userId) => expect(h.graph.getEntitiesPage).toHaveBeenCalledWith(expect.objectContaining({ agentId: baseScope.agentId }), expect.objectContaining({ userId })),
    assertNotCalled: (h) => expect(h.graph.getEntitiesPage).not.toHaveBeenCalled(),
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
    let result: unknown;
    let error: unknown;
    try {
      result = await handler.invoke(h, "operator", "foreign-end-user");
    } catch (caught) {
      error = caught;
    }
    if (handler.assertRejected) handler.assertRejected(h, result);
    else {
      expect(error).toMatchObject({ status: 400 });
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
    expect(methods.indexOf("archiveMemory")).toBeGreaterThan(methods.indexOf("relate"));
    expect(methods.indexOf("restoreMemory")).toBeGreaterThan(methods.indexOf("archiveMemory"));
    expect(methods.indexOf("updateMemory")).toBeGreaterThan(methods.indexOf("restoreMemory"));
    expect(methods.indexOf("updateMemory")).toBeGreaterThan(methods.indexOf("relate"));
  });
});

describe("MemoryController HTTP and pagination contracts", () => {
  it("returns truthful page metadata instead of deriving total from page length", async () => {
    const h = harness(true);
    h.memoryService.listPage.mockResolvedValue({
      items: [{ id: "memory-1" }],
      total: 384,
      limit: 50,
      offset: 350,
      hasNext: false,
    });

    await expect(h.controller.listMemories(
      request("operator"),
      "end-user-selected",
      undefined,
      undefined,
      undefined,
      undefined,
      "50",
      "350",
    )).resolves.toMatchObject({ total: 384, limit: 50, offset: 350, hasNext: false });
  });

  it("throws a genuine HTTP 400 for an unknown explicit visibility", async () => {
    const h = harness(true);
    const error = Object.assign(new Error("visibility must be one of agent_visible, hidden, private"), {
      code: "MEMORY_INVALID_VISIBILITY",
    });
    h.memoryService.add.mockRejectedValue(error);

    await expect(h.controller.createMemory(request("operator"), {
      userId: "end-user-selected",
      content: "Remember this",
      visibility: "cluster" as any,
    })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an invalid public source before the write service and preserves trusted-source errors", async () => {
    const invalid = harness(true);
    await expect(invalid.controller.createMemory(request("operator"), {
      userId: "end-user-selected",
      content: "Forged",
      source: "invented" as any,
    })).rejects.toMatchObject({ status: 400, response: { code: "MEMORY_INVALID_SOURCE" } });
    expect(invalid.memoryService.add).not.toHaveBeenCalled();

    const forged = harness(true);
    forged.memoryService.add.mockRejectedValue(Object.assign(
      new Error("source 'extracted' requires a trusted provenance writer"),
      { code: "MEMORY_UNTRUSTED_SOURCE" },
    ));
    await expect(forged.controller.createMemory(request("operator"), {
      userId: "end-user-selected",
      content: "Forged extraction",
      source: "extracted",
    })).rejects.toMatchObject({ status: 400, response: { code: "MEMORY_UNTRUSTED_SOURCE" } });
  });

  it("fully validates replace bundles before delegating to transactional import", async () => {
    const h = harness(true);
    await expect(h.controller.importBundle(request("operator"), {
      userId: "end-user-selected",
      mode: "replace",
      confirmReplace: true,
      bundle: { ...validBundle, memories: [{ ...validBundle.memories[0], source: "invented" }] },
    } as any)).rejects.toMatchObject({ status: 400, response: { code: "MEMORY_IMPORT_INVALID_SOURCE" } });
    expect(h.memoryImport.importBundle).not.toHaveBeenCalled();
  });

  it("closes the repeatable snapshot before waiting for response drain", async () => {
    const h = harness(true);
    let drain: (() => void) | undefined;
    h.exportResponse.write
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    h.exportResponse.once.mockImplementation((event: string, listener: () => void) => {
      if (event === "drain") drain = listener;
      return h.exportResponse;
    });

    const pending = h.controller.exportBundle(
      request("operator"),
      h.exportResponse,
      "end-user-selected",
    );
    await vi.waitFor(() => expect(drain).toBeTypeOf("function"));
    expect(h.memoryService.listExportKeysetPage).toHaveBeenCalledTimes(1);
    expect(h.database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
      timeout: 120_000,
    });
    drain!();
    await pending;

    expect(h.exportResponse.end).toHaveBeenCalledTimes(1);
  });

  it("cancels a closed response and removes its temporary export artifact", async () => {
    const h = harness(true);
    const responseEvents = new EventEmitter();
    const requestEvents = new EventEmitter();
    const req = Object.assign(request("operator"), {
      once: requestEvents.once.bind(requestEvents),
      off: requestEvents.off.bind(requestEvents),
    });
    h.exportResponse.once.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      responseEvents.once(event, listener);
      return h.exportResponse;
    });
    h.exportResponse.off.mockImplementation((event: string, listener: (...args: any[]) => void) => {
      responseEvents.off(event, listener);
      return h.exportResponse;
    });
    h.exportResponse.write.mockReturnValue(false);
    const before = await exportArtifactNames();

    const pending = h.controller.exportBundle(req, h.exportResponse, "end-user-selected");
    await vi.waitFor(() => expect(h.exportResponse.write).toHaveBeenCalled());
    responseEvents.emit("close");
    await pending;

    expect(h.exportResponse.destroy).toHaveBeenCalledTimes(1);
    expect(await exportArtifactNames()).toEqual(before);
  });
});

async function exportArtifactNames(): Promise<string[]> {
  return (await readdir("/var/tmp"))
    .filter((name) => name.startsWith("platos-memory-export-"))
    .sort();
}
