import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@platos/tenancy-database";
import { MemoryImportService } from "./memory-import.service";
import { validateMemoryBundle } from "./memory-bundle";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce",
  agentId: "3ec2a3f1-10f9-41a7-9e21-3b6739e84ca1",
};
const endUserId = "0f2e2f4c-5246-4495-980c-9fd7e99da9fb";
const threadId = "1296b621-4865-4d8e-a1c9-75906e8ba2d7";
const turnId = "2596b621-4865-4d8e-a1c9-75906e8ba2d7";

function rawBundle() {
  return {
    version: 2 as const,
    memories: [{
      id: "memory-exported-1",
      kind: "fact",
      content: "Round trip memory",
      metadata: { entities: ["person:ada"] },
      visibility: "hidden",
      agentVisible: false,
      source: "extracted",
      sourceThreadId: threadId,
      sourceTurnIds: [turnId, "3596b621-4865-4d8e-a1c9-75906e8ba2d7"],
      extractorVersion: "extractor-v7",
      confidence: 0.87,
      createdAt: "2026-08-20T10:00:00.000Z",
      updatedAt: "2026-08-21T10:00:00.000Z",
      lastAccessedAt: "2026-08-22T10:00:00.000Z",
      quarantinedAt: null,
      archivedAt: "2026-08-23T10:00:00.000Z",
    }],
    entities: [
      { id: "entity-exported-1", entityKey: "person:ada", entityType: "person", label: "Ada", aliases: [], metadata: null },
      { id: "entity-exported-2", entityKey: "company:platos", entityType: "company", label: "Platos", aliases: [], metadata: null },
    ],
    relationships: [{
      id: "relationship-exported-1",
      fromEntityId: "entity-exported-1",
      toEntityId: "entity-exported-2",
      fromEntityKey: "person:ada",
      toEntityKey: "company:platos",
      relationshipType: "works_at",
      weight: 0.9,
      metadata: { since: 2026 },
      sourceMemoryId: "memory-exported-1",
    }],
  };
}

function harness(options: { embeddingReject?: Error; relationshipReject?: Error } = {}) {
  const tx = {
    memoryRelationship: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      upsert: options.relationshipReject
        ? vi.fn().mockRejectedValue(options.relationshipReject)
        : vi.fn().mockResolvedValue({ id: "relationship-imported-1" }),
    },
    memoryEntity: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn()
        .mockResolvedValueOnce({ id: "entity-imported-1" })
        .mockResolvedValueOnce({ id: "entity-imported-2" }),
      update: vi.fn(),
    },
    memory: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ id: "memory-imported-1" }]),
  };
  const prisma = {
    environment: { findFirst: vi.fn().mockResolvedValue({ id: scope.environmentId }) },
    endUserIdentity: { findFirst: vi.fn().mockResolvedValue({ endUserId, subject: "user-a" }) },
    endUser: { findFirst: vi.fn() },
    agentBinding: {
      findFirst: vi.fn().mockResolvedValue({ agentId: scope.agentId, clusterId: null }),
      findMany: vi.fn().mockResolvedValue([{ agentId: scope.agentId, clusterId: null }]),
    },
    thread: {
      findMany: vi.fn().mockResolvedValue([{ id: threadId, agentId: scope.agentId, clusterId: null, turns: [{ id: turnId }] }]),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const embeddings = {
    embed: options.embeddingReject
      ? vi.fn().mockRejectedValue(options.embeddingReject)
      : vi.fn().mockResolvedValue([0.1, 0.2]),
  };
  return {
    service: new MemoryImportService(prisma as any, embeddings as any),
    prisma,
    embeddings,
    tx,
  };
}

describe("MemoryImportService", () => {
  it("stages embeddings before replace and aborts without opening a transaction on failure", async () => {
    const h = harness({ embeddingReject: new Error("embedding unavailable") });

    await expect(h.service.importBundle(
      scope,
      "user-a",
      validateMemoryBundle(rawBundle()),
      "replace",
    )).rejects.toThrow("embedding unavailable");

    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.tx.memoryRelationship.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.memory.deleteMany).not.toHaveBeenCalled();
  });

  it("replaces all scoped graph and memory rows, preserving lifecycle and remapping provenance", async () => {
    const h = harness();

    await expect(h.service.importBundle(
      scope,
      "user-a",
      validateMemoryBundle(rawBundle()),
      "replace",
    )).resolves.toMatchObject({
      ok: true,
      mode: "replace",
      memoriesDeleted: 3,
      memoriesImported: 1,
      entitiesImported: 2,
      relationshipsImported: 1,
      skipped: 0,
    });

    expect(h.tx.memoryRelationship.deleteMany).toHaveBeenCalledBefore(h.tx.memoryEntity.deleteMany);
    expect(h.tx.memoryEntity.deleteMany).toHaveBeenCalledBefore(h.tx.memory.deleteMany);
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('"archivedAt"'),
      expect.any(String),
      scope.environmentId,
      endUserId,
      scope.agentId,
      null,
      "fact",
      null,
      "Round trip memory",
      JSON.stringify({ entities: ["person:ada"] }),
      false,
      "hidden",
      "imported",
      "[0.1,0.2]",
      threadId,
      [turnId],
      "extractor-v7",
      expect.any(String),
      0.87,
      "extracted",
      threadId,
      [turnId, "3596b621-4865-4d8e-a1c9-75906e8ba2d7"],
      new Date("2026-08-22T10:00:00.000Z"),
      null,
      new Date("2026-08-23T10:00:00.000Z"),
      new Date("2026-08-20T10:00:00.000Z"),
      new Date("2026-08-21T10:00:00.000Z"),
    );
    expect(h.tx.memoryRelationship.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        fromEntityId: "entity-imported-1",
        toEntityId: "entity-imported-2",
        sourceMemoryId: "memory-imported-1",
      }),
    }));
    expect(h.tx.memoryEntity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ metadata: Prisma.DbNull }),
    }));
    expect(h.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 120_000,
    });
  });

  it("fails the transaction on a required relationship instead of reporting a skipped success", async () => {
    const h = harness({ relationshipReject: new Error("relationship persistence failed") });

    await expect(h.service.importBundle(
      scope,
      "user-a",
      validateMemoryBundle(rawBundle()),
      "replace",
    )).rejects.toThrow("relationship persistence failed");

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.memory.deleteMany).toHaveBeenCalledTimes(1);
    expect(h.tx.memoryRelationship.upsert).toHaveBeenCalledTimes(1);
  });

  it("makes stale cross-scope thread and turn provenance inert", async () => {
    const h = harness();
    const stale = rawBundle();
    stale.memories[0]!.sourceThreadId = "4596b621-4865-4d8e-a1c9-75906e8ba2d7";
    stale.memories[0]!.sourceTurnIds = ["5596b621-4865-4d8e-a1c9-75906e8ba2d7"];

    await h.service.importBundle(scope, "user-a", validateMemoryBundle(stale), "merge");

    const args = h.tx.$queryRawUnsafe.mock.calls[0]!;
    expect(args[14]).toBeNull();
    expect(args[15]).toEqual([]);
    expect(args[19]).toBe("extracted");
    expect(args[20]).toBe("4596b621-4865-4d8e-a1c9-75906e8ba2d7");
    expect(args[21]).toEqual(["5596b621-4865-4d8e-a1c9-75906e8ba2d7"]);
  });

  it("rejects inconsistent relationship id/key pairs before any persistence", async () => {
    const h = harness();
    const invalid = rawBundle();
    invalid.relationships[0]!.fromEntityKey = "company:platos";

    expect(() => validateMemoryBundle(invalid)).toThrowError(expect.objectContaining({
      code: "MEMORY_IMPORT_INVALID_RELATIONSHIP",
    }));
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });
});
