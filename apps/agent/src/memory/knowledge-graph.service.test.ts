import { describe, expect, it, vi } from "vitest";
import { KnowledgeGraphService } from "./knowledge-graph.service";

const scope = {
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  agentId: "agent-a",
};

const now = new Date("2026-08-18T00:00:00.000Z");

function entity(overrides: Record<string, unknown> = {}) {
  return {
    id: "entity-id",
    environmentId: scope.environmentId,
    endUserId: "end-user",
    agentId: "agent-a",
    clusterId: "persisted-cluster",
    entityKey: "shared-person",
    entityType: "person",
    label: "Shared person",
    aliases: [],
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function prisma(
  bindings: Record<string, string | null>,
  storedEntity = entity(),
  candidates: Array<{ id: string; agentId: string; clusterId: string | null }> = [
    {
      id: storedEntity.id,
      agentId: storedEntity.agentId,
      clusterId: storedEntity.clusterId,
    },
  ]
) {
  const transactionMemoryEntity = {
    findFirst: vi.fn(async () => ({ id: storedEntity.id })),
    findMany: vi.fn(async (_args: any) => candidates),
    findUniqueOrThrow: vi.fn(async () => storedEntity),
    create: vi.fn(async ({ data }: any) => ({ ...storedEntity, ...data })),
    update: vi.fn(async ({ data }: any) => ({ ...storedEntity, ...data })),
  };
  const agentBindings = Object.entries(bindings).map(([agentId, clusterId]) => ({
    agentId,
    clusterId,
  }));
  const agentBinding = {
    findFirst: vi.fn(async ({ where }: any) => ({
      agentId: where.agentId,
      clusterId: bindings[where.agentId] ?? null,
    })),
    findMany: vi.fn(async ({ where }: any) =>
      where.agentId
        ? agentBindings.filter((binding) => where.agentId.in.includes(binding.agentId))
        : agentBindings
    ),
  };
  const tx = {
    memoryEntity: transactionMemoryEntity,
    agentBinding,
    $queryRaw: vi.fn(async () => []),
  };
  const clientMemoryEntity = {
    count: vi.fn(async () => 1),
    findMany: vi.fn(async (_args: any) => [storedEntity]),
  };
  return {
    client: {
      environment: { findFirst: vi.fn(async () => ({ id: scope.environmentId })) },
      endUser: {
        findFirst: vi.fn(async () => ({
          id: "end-user",
          identities: [{ subject: "subject" }],
        })),
      },
      endUserIdentity: {
        findFirst: vi.fn(async () => ({ endUserId: "end-user", subject: "subject" })),
      },
      agentBinding,
      memoryEntity: clientMemoryEntity,
      $transaction: vi.fn(async (input: ((client: typeof tx) => unknown) | Promise<unknown>[]) =>
        Array.isArray(input) ? Promise.all(input) : input(tx)),
      $executeRawUnsafe: vi.fn(),
    } as any,
    memoryEntity: transactionMemoryEntity,
    clientMemoryEntity,
    tx,
  };
}

describe("KnowledgeGraphService.upsertEntity", () => {
  it("selects an existing sibling entity by the persisted cluster key", async () => {
    const db = prisma({
      "agent-a": "persisted-cluster",
      "agent-b": "persisted-cluster",
    });
    const service = new KnowledgeGraphService(db.client);

    const result = await service.upsertEntity(
      { ...scope, clusterId: "caller-forged-cluster" } as any,
      {
        userId: "subject",
        agentId: "agent-b",
        entityKey: "shared-person",
        label: "Updated by sibling",
      }
    );

    expect(result.id).toBe("entity-id");
    expect(db.memoryEntity.findMany).toHaveBeenCalledWith({
      where: {
        environmentId: scope.environmentId,
        endUserId: "end-user",
        entityKey: "shared-person",
        OR: [{ clusterId: "persisted-cluster" }, { agentId: "agent-b", clusterId: null }],
      },
      select: { id: true, agentId: true, clusterId: true },
    });
    expect(db.memoryEntity.update).toHaveBeenCalledWith({
      where: { id: "entity-id" },
      data: { label: "Updated by sibling" },
    });
  });

  it("keeps standalone entity upserts isolated by persisted agent", async () => {
    const stored = entity({ agentId: "agent-a", clusterId: null });
    const db = prisma({ "agent-a": null }, stored);
    const service = new KnowledgeGraphService(db.client);

    await service.upsertEntity(scope as any, {
      userId: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce",
      entityKey: "shared-person",
    });

    expect(db.memoryEntity.findFirst).toHaveBeenCalledWith({
      where: {
        environmentId: scope.environmentId,
        endUserId: "end-user",
        agentId: "agent-a",
        clusterId: null,
        entityKey: "shared-person",
      },
      select: { id: true },
    });
    expect(db.memoryEntity.update).toHaveBeenCalledWith({
      where: { id: "entity-id" },
      data: {},
    });
  });

  it("defaults sibling reads to the persisted cluster selector", async () => {
    const shared = entity({ agentId: "agent-a", clusterId: "persisted-cluster" });
    const db = prisma(
      {
        "agent-a": "persisted-cluster",
        "agent-b": "persisted-cluster",
      },
      shared
    );
    const service = new KnowledgeGraphService(db.client);

    const rows = await service.getEntities({ ...scope, agentId: "agent-b" } as any, {
      userId: "subject",
    });

    expect(rows.map(({ id }) => id)).toEqual(["entity-id"]);
    expect(db.clientMemoryEntity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clusterId: "persisted-cluster" }),
      })
    );
    expect(db.clientMemoryEntity.findMany.mock.calls[0]![0].where).not.toHaveProperty("agentId");
  });

  it("promotes and reuses a same-agent standalone row", async () => {
    const standalone = entity({ agentId: "agent-a", clusterId: null });
    const db = prisma({ "agent-a": "persisted-cluster" }, standalone, [
      { id: standalone.id, agentId: standalone.agentId, clusterId: null },
    ]);
    const service = new KnowledgeGraphService(db.client);

    const result = await service.upsertEntity(scope as any, {
      userId: "subject",
      entityKey: "shared-person",
      label: "Promoted",
    });

    expect(result.id).toBe("entity-id");
    expect(db.memoryEntity.update).toHaveBeenCalledWith({
      where: { id: "entity-id" },
      data: { clusterId: "persisted-cluster", label: "Promoted" },
    });
  });

  it("fails before mutation when standalone promotion conflicts with a cluster row", async () => {
    const standalone = entity({ id: "standalone-id", agentId: "agent-a", clusterId: null });
    const db = prisma({ "agent-a": "persisted-cluster" }, standalone, [
      { id: "cluster-id", agentId: "agent-b", clusterId: "persisted-cluster" },
      { id: "standalone-id", agentId: "agent-a", clusterId: null },
    ]);
    const service = new KnowledgeGraphService(db.client);

    await expect(
      service.upsertEntity(scope as any, {
        userId: "subject",
        entityKey: "shared-person",
      })
    ).rejects.toThrow("standalone entity conflicts with an existing clustered entity");
    expect(db.memoryEntity.update).not.toHaveBeenCalled();
    expect(db.memoryEntity.create).not.toHaveBeenCalled();
  });

  it("keeps encryption on write and embedding persistence off the upsert path", async () => {
    const db = prisma({ "agent-a": "persisted-cluster" });
    let resolveEmbedding!: (vector: number[]) => void;
    const embedding = new Promise<number[]>((resolve) => {
      resolveEmbedding = resolve;
    });
    const crypto = {
      encryptJsonField: vi.fn((value: unknown) => ({ __platos_enc: 1, value })),
      decryptJsonField: vi.fn((value: any) => value?.value ?? value),
    };
    const embeddings = { embed: vi.fn(() => embedding) };
    const service = new KnowledgeGraphService(db.client, crypto as any, embeddings as any);

    const result = await service.upsertEntity(scope as any, {
      userId: "subject",
      entityKey: "shared-person",
      label: "Encrypted label",
      metadata: { private: true },
    });

    expect(result.id).toBe("entity-id");
    expect(db.memoryEntity.update).toHaveBeenCalledWith({
      where: { id: "entity-id" },
      data: {
        label: JSON.stringify({ __platos_enc: 1, value: "Encrypted label" }),
        metadata: { __platos_enc: 1, value: { private: true } },
      },
    });
    expect(embeddings.embed).toHaveBeenCalledWith("Encrypted label", scope);
    expect(db.client.$executeRawUnsafe).not.toHaveBeenCalled();

    resolveEmbedding([0.25]);
    await vi.waitFor(() =>
      expect(db.client.$executeRawUnsafe).toHaveBeenCalledWith(
        `UPDATE "MemoryEntity" SET "embedding" = $1::vector WHERE "id" = $2::uuid`,
        "[0.25]",
        "entity-id"
      )
    );
  });
});

describe("KnowledgeGraphService.createRelationship", () => {
  it("stores an object metadata root when optional relationship metadata is omitted", async () => {
    const memoryRelationship = {
      upsert: vi.fn(async ({ create }: any) => ({
        id: "relationship-id",
        ...create,
        createdAt: now,
      })),
    };
    const database = {
      environment: { findFirst: vi.fn(async () => ({ id: scope.environmentId })) },
      endUser: {
        findFirst: vi.fn(async () => ({
          id: "end-user",
          identities: [{ subject: "subject" }],
        })),
      },
      endUserIdentity: {
        findFirst: vi.fn(async () => ({ endUserId: "end-user", subject: "subject" })),
      },
      memoryEntity: {
        findMany: vi.fn(async () => [
          { id: "from-entity", agentId: "agent-a", clusterId: null },
          { id: "to-entity", agentId: "agent-a", clusterId: null },
        ]),
      },
      agentBinding: {
        findFirst: vi.fn(async () => ({ agentId: "agent-a", clusterId: null })),
      },
      memoryRelationship,
    } as any;
    const service = new KnowledgeGraphService(database);

    const relationship = await service.createRelationship(scope as any, {
      userId: "46123e5c-e5b2-4829-898d-00ec8a6ae1ce",
      fromEntityId: "from-entity",
      toEntityId: "to-entity",
      relationshipType: "knows",
    });

    expect(relationship.metadata).toEqual({});
    expect(memoryRelationship.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ metadata: {} }),
      update: expect.objectContaining({ metadata: {} }),
    }));
  });
});
