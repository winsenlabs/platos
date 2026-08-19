import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@platos/tenancy-database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeGraphService } from "./knowledge-graph.service";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

describe("KnowledgeGraphService PostgreSQL clustered upsert", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: KnowledgeGraphService;
  let ids: {
    organizationId: string;
    projectId: string;
    environmentId: string;
    otherEnvironmentId: string;
    endUserId: string;
    clusterId: string;
    otherClusterId: string;
    otherEnvironmentClusterId: string;
    agentAId: string;
    agentBId: string;
    standaloneAgentId: string;
    otherClusterAgentId: string;
    otherEnvironmentAgentId: string;
    transitionAgentId: string;
    concurrentTransitionAgentId: string;
    conflictTransitionAgentId: string;
  };

  const scope = (environmentId: string, agentId: string) =>
    ({
      organizationId: ids.organizationId,
      projectId: ids.projectId,
      environmentId,
      agentId,
    }) as any;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(
      resolve(process.cwd(), "../../node_modules/.bin/prisma"),
      [
        "migrate",
        "deploy",
        "--schema",
        resolve(process.cwd(), "../../internal-packages/tenancy-database/prisma/schema.prisma"),
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: "pipe",
      }
    );
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

    const organization = await prisma.organization.create({
      data: { slug: "memory-entity-upsert", name: "Memory Entity Upsert" },
    });
    const project = await prisma.project.create({
      data: {
        organizationId: organization.id,
        slug: "memory-entity-upsert",
        name: "Memory Entity Upsert",
      },
    });
    const [environment, otherEnvironment] = await Promise.all([
      prisma.environment.create({
        data: { projectId: project.id, slug: "primary", name: "Primary" },
      }),
      prisma.environment.create({
        data: { projectId: project.id, slug: "other", name: "Other" },
      }),
    ]);
    const user = await prisma.user.create({
      data: { email: "memory-entity-upsert@test.invalid", displayName: "Memory Entity Upsert" },
    });
    const endUser = await prisma.endUser.create({
      data: { organizationId: organization.id, displayName: "Memory Subject" },
    });
    await prisma.endUserIdentity.create({
      data: {
        endUserId: endUser.id,
        organizationId: organization.id,
        issuer: "platos",
        channel: "session",
        subject: "memory-subject",
        verifiedAt: new Date(),
      },
    });

    const [
      agentA,
      agentB,
      standaloneAgent,
      otherClusterAgent,
      otherEnvironmentAgent,
      transitionAgent,
      concurrentTransitionAgent,
      conflictTransitionAgent,
    ] = await Promise.all(
      [
        "cluster-a",
        "cluster-b",
        "standalone",
        "other-cluster",
        "other-environment",
        "transition",
        "concurrent-transition",
        "conflict-transition",
      ].map(async (slug) => {
        const agent = await prisma.agent.create({
          data: { projectId: project.id, slug, name: slug },
        });
        const version = await prisma.agentVersion.create({
          data: {
            agentId: agent.id,
            versionNumber: 1,
            model: "fixture:model",
            createdBy: user.id,
          },
        });
        return { ...agent, versionId: version.id };
      })
    );
    const [cluster, otherCluster, otherEnvironmentCluster] = await Promise.all([
      prisma.agentCluster.create({
        data: { environmentId: environment.id, slug: "shared", name: "Shared" },
      }),
      prisma.agentCluster.create({
        data: { environmentId: environment.id, slug: "other", name: "Other" },
      }),
      prisma.agentCluster.create({
        data: { environmentId: otherEnvironment.id, slug: "shared", name: "Shared" },
      }),
    ]);
    await Promise.all([
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: agentA.id,
          activeAgentVersionId: agentA.versionId,
          clusterId: cluster.id,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: agentB.id,
          activeAgentVersionId: agentB.versionId,
          clusterId: cluster.id,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: standaloneAgent.id,
          activeAgentVersionId: standaloneAgent.versionId,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: otherClusterAgent.id,
          activeAgentVersionId: otherClusterAgent.versionId,
          clusterId: otherCluster.id,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: otherEnvironment.id,
          agentId: otherEnvironmentAgent.id,
          activeAgentVersionId: otherEnvironmentAgent.versionId,
          clusterId: otherEnvironmentCluster.id,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: transitionAgent.id,
          activeAgentVersionId: transitionAgent.versionId,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: concurrentTransitionAgent.id,
          activeAgentVersionId: concurrentTransitionAgent.versionId,
        },
      }),
      prisma.agentBinding.create({
        data: {
          environmentId: environment.id,
          agentId: conflictTransitionAgent.id,
          activeAgentVersionId: conflictTransitionAgent.versionId,
        },
      }),
    ]);

    ids = {
      organizationId: organization.id,
      projectId: project.id,
      environmentId: environment.id,
      otherEnvironmentId: otherEnvironment.id,
      endUserId: endUser.id,
      clusterId: cluster.id,
      otherClusterId: otherCluster.id,
      otherEnvironmentClusterId: otherEnvironmentCluster.id,
      agentAId: agentA.id,
      agentBId: agentB.id,
      standaloneAgentId: standaloneAgent.id,
      otherClusterAgentId: otherClusterAgent.id,
      otherEnvironmentAgentId: otherEnvironmentAgent.id,
      transitionAgentId: transitionAgent.id,
      concurrentTransitionAgentId: concurrentTransitionAgent.id,
      conflictTransitionAgentId: conflictTransitionAgent.id,
    };
    service = new KnowledgeGraphService(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it("shares one entity ID within a cluster and isolates standalone, cross-cluster, and cross-environment writes", async () => {
    const input = { userId: ids.endUserId, entityKey: "shared-key", entityType: "person" };
    const sharedA = await service.upsertEntity(scope(ids.environmentId, ids.agentAId), input);
    const sharedB = await service.upsertEntity(scope(ids.environmentId, ids.agentBId), input);
    const standalone = await service.upsertEntity(
      scope(ids.environmentId, ids.standaloneAgentId),
      input
    );
    const otherCluster = await service.upsertEntity(
      scope(ids.environmentId, ids.otherClusterAgentId),
      input
    );
    const otherEnvironment = await service.upsertEntity(
      scope(ids.otherEnvironmentId, ids.otherEnvironmentAgentId),
      input
    );

    expect(sharedB.id).toBe(sharedA.id);
    expect(new Set([sharedA.id, standalone.id, otherCluster.id, otherEnvironment.id]).size).toBe(4);
    await expect(
      prisma.memoryEntity.findMany({
        where: { endUserId: ids.endUserId, entityKey: input.entityKey },
        select: { environmentId: true, agentId: true, clusterId: true },
      })
    ).resolves.toHaveLength(4);
    expect(sharedA).toMatchObject({
      environmentId: ids.environmentId,
      clusterId: ids.clusterId,
    });
    expect(standalone).toMatchObject({
      environmentId: ids.environmentId,
      agentId: ids.standaloneAgentId,
      clusterId: null,
    });
    expect(otherCluster.clusterId).toBe(ids.otherClusterId);
    expect(otherEnvironment).toMatchObject({
      environmentId: ids.otherEnvironmentId,
      clusterId: ids.otherEnvironmentClusterId,
    });
  });

  it("makes concurrent sibling upserts idempotent", async () => {
    const writes = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        service.upsertEntity(
          scope(ids.environmentId, index % 2 === 0 ? ids.agentAId : ids.agentBId),
          {
            userId: ids.endUserId,
            entityKey: "concurrent-shared-key",
            label: `Concurrent ${index}`,
          }
        )
      )
    );

    expect(new Set(writes.map(({ id }) => id)).size).toBe(1);
    await expect(
      prisma.memoryEntity.count({
        where: {
          environmentId: ids.environmentId,
          endUserId: ids.endUserId,
          clusterId: ids.clusterId,
          entityKey: "concurrent-shared-key",
        },
      })
    ).resolves.toBe(1);
  });

  it("lets a sibling list, get, traverse, and search the persisted cluster graph by default", async () => {
    const start = await service.upsertEntity(scope(ids.environmentId, ids.agentAId), {
      userId: ids.endUserId,
      entityKey: "sibling-read-start",
      label: "Sibling Search Start",
    });
    const target = await service.upsertEntity(scope(ids.environmentId, ids.agentAId), {
      userId: ids.endUserId,
      entityKey: "sibling-read-target",
      label: "Sibling Search Target",
    });
    const relationship = await service.createRelationship(scope(ids.environmentId, ids.agentAId), {
      userId: ids.endUserId,
      fromEntityId: start.id,
      toEntityId: target.id,
      relationshipType: "connects",
      metadata: {},
    });
    const siblingScope = scope(ids.environmentId, ids.agentBId);

    const listed = await service.getEntities(siblingScope, { userId: ids.endUserId });
    expect(listed.map(({ id }) => id)).toEqual(expect.arrayContaining([start.id, target.id]));
    await expect(
      service.getEntityById(siblingScope, start.id, ids.endUserId)
    ).resolves.toMatchObject({ id: start.id, clusterId: ids.clusterId });
    await expect(
      service.getRelationships(siblingScope, { entityId: start.id }, ids.endUserId)
    ).resolves.toMatchObject({
      entity: { id: start.id },
      outbound: [{ relationship: { id: relationship.id }, to: { id: target.id } }],
    });
    await expect(
      service.searchEntities(siblingScope, {
        userId: ids.endUserId,
        query: "Sibling Search Start",
      })
    ).resolves.toContainEqual(
      expect.objectContaining({ entity: expect.objectContaining({ id: start.id }) })
    );
    await expect(
      service.shortestPath(siblingScope, {
        userId: ids.endUserId,
        fromEntityId: start.id,
        toEntityId: target.id,
      })
    ).resolves.toEqual([
      expect.objectContaining({ entity: expect.objectContaining({ id: start.id }) }),
      expect.objectContaining({
        entity: expect.objectContaining({ id: target.id }),
        relationship: expect.objectContaining({ id: relationship.id }),
      }),
    ]);

    await expect(
      service.getEntityById(
        scope(ids.environmentId, ids.standaloneAgentId),
        start.id,
        ids.endUserId
      )
    ).resolves.toBeNull();
    await expect(
      service.getEntityById(
        scope(ids.environmentId, ids.otherClusterAgentId),
        start.id,
        ids.endUserId
      )
    ).resolves.toBeNull();
    await expect(
      service.getEntityById(
        scope(ids.otherEnvironmentId, ids.otherEnvironmentAgentId),
        start.id,
        ids.endUserId
      )
    ).resolves.toBeNull();
  });

  it("promotes and reuses an existing standalone entity when its Agent joins a cluster", async () => {
    const standalone = await service.upsertEntity(scope(ids.environmentId, ids.transitionAgentId), {
      userId: ids.endUserId,
      entityKey: "transition-key",
      label: "Standalone",
    });
    await expect(
      prisma.memoryEntity.create({
        data: {
          environmentId: ids.environmentId,
          endUserId: ids.endUserId,
          agentId: ids.transitionAgentId,
          entityKey: "transition-key",
          entityType: "other",
          label: "Duplicate standalone",
        },
      })
    ).rejects.toThrow();
    await prisma.agentBinding.update({
      where: {
        environmentId_agentId: {
          environmentId: ids.environmentId,
          agentId: ids.transitionAgentId,
        },
      },
      data: { clusterId: ids.clusterId },
    });

    const promoted = await service.upsertEntity(scope(ids.environmentId, ids.transitionAgentId), {
      userId: ids.endUserId,
      entityKey: "transition-key",
      label: "Promoted",
    });

    expect(promoted).toMatchObject({
      id: standalone.id,
      agentId: ids.transitionAgentId,
      clusterId: ids.clusterId,
      label: "Promoted",
    });
    await expect(
      prisma.memoryEntity.count({
        where: {
          environmentId: ids.environmentId,
          endUserId: ids.endUserId,
          entityKey: "transition-key",
        },
      })
    ).resolves.toBe(1);
    await expect(
      prisma.memoryEntity.update({
        where: { id: promoted.id },
        data: { clusterId: null },
      })
    ).rejects.toThrow(/only promote from standalone/);
    await expect(
      prisma.memoryEntity.findUnique({ where: { id: promoted.id } })
    ).resolves.toMatchObject({ clusterId: ids.clusterId });
  });

  it("serializes concurrent standalone-to-cluster promotion", async () => {
    const standalone = await service.upsertEntity(
      scope(ids.environmentId, ids.concurrentTransitionAgentId),
      { userId: ids.endUserId, entityKey: "concurrent-transition-key" }
    );
    await prisma.agentBinding.update({
      where: {
        environmentId_agentId: {
          environmentId: ids.environmentId,
          agentId: ids.concurrentTransitionAgentId,
        },
      },
      data: { clusterId: ids.clusterId },
    });

    const writes = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        service.upsertEntity(scope(ids.environmentId, ids.concurrentTransitionAgentId), {
          userId: ids.endUserId,
          entityKey: "concurrent-transition-key",
          label: `Transition ${index}`,
        })
      )
    );

    expect(new Set(writes.map(({ id }) => id))).toEqual(new Set([standalone.id]));
    await expect(
      prisma.memoryEntity.count({
        where: {
          environmentId: ids.environmentId,
          endUserId: ids.endUserId,
          entityKey: "concurrent-transition-key",
        },
      })
    ).resolves.toBe(1);
  });

  it("rolls back a transition when a conflicting cluster entity already exists", async () => {
    const clustered = await service.upsertEntity(scope(ids.environmentId, ids.agentAId), {
      userId: ids.endUserId,
      entityKey: "transition-conflict-key",
      label: "Cluster canonical",
    });
    const standalone = await service.upsertEntity(
      scope(ids.environmentId, ids.conflictTransitionAgentId),
      {
        userId: ids.endUserId,
        entityKey: "transition-conflict-key",
        label: "Standalone canonical",
      }
    );
    await prisma.agentBinding.update({
      where: {
        environmentId_agentId: {
          environmentId: ids.environmentId,
          agentId: ids.conflictTransitionAgentId,
        },
      },
      data: { clusterId: ids.clusterId },
    });

    await expect(
      service.upsertEntity(scope(ids.environmentId, ids.conflictTransitionAgentId), {
        userId: ids.endUserId,
        entityKey: "transition-conflict-key",
        label: "Must roll back",
      })
    ).rejects.toThrow("standalone entity conflicts with an existing clustered entity");

    await expect(
      prisma.memoryEntity.findMany({
        where: {
          environmentId: ids.environmentId,
          endUserId: ids.endUserId,
          entityKey: "transition-conflict-key",
        },
        orderBy: { label: "asc" },
        select: { id: true, clusterId: true, label: true },
      })
    ).resolves.toEqual([
      { id: clustered.id, clusterId: ids.clusterId, label: "Cluster canonical" },
      { id: standalone.id, clusterId: null, label: "Standalone canonical" },
    ]);
  });
});
