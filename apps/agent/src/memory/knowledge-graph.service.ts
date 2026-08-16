import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { EmbeddingService } from "./embedding.service";
import type { ScopeTuple } from "./memory.service";
import {
  assertEnvironmentScope,
  canShareAgentScope,
  environmentScopeWhere,
  resolveAgentBinding,
  resolveEndUser,
  resolveReadAgentIds,
  resolveWriteBinding,
} from "./memory-scope";

export interface EntityRow {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  agentId: string;
  clusterId: string | null;
  entityKey: string;
  entityType: string;
  label: string;
  aliases: string[];
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface RelationshipRow {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  agentId: string;
  clusterId: string | null;
  fromEntityId: string;
  toEntityId: string;
  relationshipType: string;
  weight: number | null;
  metadata: unknown;
  sourceMemoryId: string | null;
  createdAt: Date;
}

export interface EntityRelationships {
  entity: EntityRow;
  outbound: Array<{ relationship: RelationshipRow; to: EntityRow }>;
  inbound: Array<{ relationship: RelationshipRow; from: EntityRow }>;
}

export interface ShortestPathHop {
  entity: EntityRow;
  relationship: RelationshipRow | null;
  direction: "out" | "in" | null;
}

interface AgentReadInput {
  agentId?: string | null;
  agentIds?: string[];
}

export interface ShortestPathInput extends AgentReadInput {
  fromEntityId: string;
  toEntityId: string;
  userId: string;
  maxHops?: number;
}

export interface UpsertEntityInput {
  userId: string;
  agentId?: string | null;
  entityKey: string;
  entityType?: string;
  label?: string;
  aliases?: string[];
  metadata?: unknown;
}

@Injectable()
export class KnowledgeGraphService {
  private readonly logger = new Logger(KnowledgeGraphService.name);
  private static readonly DEFAULT_MAX_HOPS = 4;
  private static readonly HARD_MAX_HOPS = 6;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Optional() private readonly crypto?: MessageCryptoService,
    @Optional() private readonly embeddings?: EmbeddingService,
  ) {}

  private encString(value: string): string {
    if (!this.crypto) return value;
    const wrapped = this.crypto.encryptJsonField(value);
    return wrapped && typeof wrapped === "object" && (wrapped as any).__platos_enc === 1
      ? JSON.stringify(wrapped)
      : value;
  }

  private decString(value: string): string {
    if (!this.crypto || !value.startsWith("{\"__platos_enc\"")) return value;
    try {
      const plain = this.crypto.decryptJsonField(JSON.parse(value));
      return typeof plain === "string" ? plain : value;
    } catch {
      return value;
    }
  }

  private decMetadata(value: unknown): unknown {
    return this.crypto?.decryptJsonField(value ?? null) ?? value ?? null;
  }

  async getEntities(
    scope: ScopeTuple,
    input: {
      userId: string;
      entityType?: string;
      limit?: number;
      offset?: number;
      agentId?: string | null;
      agentIds?: string[];
    },
  ): Promise<EntityRow[]> {
    if (!input.userId) throw new Error("KnowledgeGraphService.getEntities: `userId` is required");
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = await resolveEndUser(this.prisma, scope, input.userId);
    const agentIds = await resolveReadAgentIds(this.prisma, scope, input.agentId, input.agentIds);
    const rows = await this.prisma.memoryEntity.findMany({
      where: {
        ...environmentScopeWhere(scope),
        endUserId: endUser.id,
        ...(input.entityType ? { entityType: input.entityType } : {}),
        ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: clampInt(input.limit ?? 100, 1, 500),
      skip: clampInt(input.offset ?? 0, 0, 10_000),
    });
    return rows.map((row) => this.toEntityRow(row, scope, endUser.externalId));
  }

  async upsertEntity(scope: ScopeTuple, input: UpsertEntityInput): Promise<EntityRow> {
    if (!input.userId) throw new Error("KnowledgeGraphService.upsertEntity: `userId` is required");
    if (!input.entityKey) throw new Error("KnowledgeGraphService.upsertEntity: `entityKey` is required");
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = await resolveEndUser(this.prisma, scope, input.userId);
    const binding = await resolveWriteBinding(this.prisma, scope, input.agentId);
    const storedMetadata = input.metadata === undefined
      ? undefined
      : this.crypto?.encryptJsonField(input.metadata) ?? input.metadata;
    const row = await this.prisma.memoryEntity.upsert({
      where: {
        environmentId_endUserId_agentId_entityKey: {
          environmentId: scope.environmentId,
          endUserId: endUser.id,
          agentId: binding.agentId,
          entityKey: input.entityKey,
        },
      },
      create: {
        environmentId: scope.environmentId,
        endUserId: endUser.id,
        agentId: binding.agentId,
        clusterId: binding.clusterId,
        entityKey: input.entityKey,
        entityType: input.entityType || "other",
        label: this.encString(input.label || input.entityKey),
        aliases: input.aliases ?? [],
        metadata: storedMetadata as any,
      },
      update: {
        clusterId: binding.clusterId,
        ...(input.entityType ? { entityType: input.entityType } : {}),
        ...(input.label ? { label: this.encString(input.label) } : {}),
        ...(input.aliases ? { aliases: input.aliases } : {}),
        ...(storedMetadata !== undefined ? { metadata: storedMetadata as any } : {}),
      },
    });

    if (this.embeddings) {
      const text = [input.label || input.entityKey, ...(input.aliases ?? [])].filter(Boolean).join(" ").trim();
      if (text) {
        void this.embeddings.embed(text, scope)
          .then((vector) => this.prisma.$executeRawUnsafe(
            `UPDATE "MemoryEntity" SET "embedding" = $1::vector WHERE "id" = $2::uuid`,
            vectorToLiteral(vector),
            row.id,
          ))
          .catch((error: unknown) => {
            this.logger.error(
              `MemoryEntity embedding persistence failed for ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
    }
    return this.toEntityRow(row, scope, endUser.externalId);
  }

  async getEntityById(
    scope: ScopeTuple,
    id: string,
    userId?: string,
    access: AgentReadInput = {},
  ): Promise<EntityRow | null> {
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = userId ? await resolveEndUser(this.prisma, scope, userId) : null;
    const agentIds = await resolveReadAgentIds(
      this.prisma,
      scope,
      access.agentId,
      access.agentIds,
    );
    const row = await this.prisma.memoryEntity.findFirst({
      where: {
        id,
        ...environmentScopeWhere(scope),
        ...(endUser ? { endUserId: endUser.id } : {}),
        ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
      },
      include: {
        endUser: {
          include: {
            identities: {
              where: { disabledAt: null },
              orderBy: { createdAt: "asc" },
              take: 1,
            },
          },
        },
      },
    });
    if (!row) return null;
    const externalId = endUser?.externalId ?? row.endUser.identities[0]?.subject ?? row.endUserId;
    return this.toEntityRow(row, scope, externalId);
  }

  async getRelationships(
    scope: ScopeTuple,
    input: { entityId: string; agentId?: string | null; agentIds?: string[] },
    userId?: string,
  ): Promise<EntityRelationships | null> {
    const access = { agentId: input.agentId, agentIds: input.agentIds };
    const entity = await this.getEntityById(scope, input.entityId, userId, access);
    if (!entity) return null;
    const agentIds = await resolveReadAgentIds(this.prisma, scope, input.agentId, input.agentIds);
    const endUser = await resolveEndUser(this.prisma, scope, userId || entity.userId);
    const where = {
      ...environmentScopeWhere(scope),
      endUserId: endUser.id,
      ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
    };
    const [outbound, inbound] = await Promise.all([
      this.prisma.memoryRelationship.findMany({
        where: { ...where, fromEntityId: input.entityId },
        include: { toEntity: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      this.prisma.memoryRelationship.findMany({
        where: { ...where, toEntityId: input.entityId },
        include: { fromEntity: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
    ]);
    return {
      entity,
      outbound: outbound.map((row) => ({
        relationship: this.toRelationshipRow(row, scope, endUser.externalId),
        to: this.toEntityRow(row.toEntity, scope, endUser.externalId),
      })),
      inbound: inbound.map((row) => ({
        relationship: this.toRelationshipRow(row, scope, endUser.externalId),
        from: this.toEntityRow(row.fromEntity, scope, endUser.externalId),
      })),
    };
  }

  async shortestPath(scope: ScopeTuple, input: ShortestPathInput): Promise<ShortestPathHop[] | null> {
    if (!input.userId) throw new Error("KnowledgeGraphService.shortestPath: `userId` is required");
    const access = { agentId: input.agentId, agentIds: input.agentIds };
    const start = await this.getEntityById(scope, input.fromEntityId, input.userId, access);
    const target = await this.getEntityById(scope, input.toEntityId, input.userId, access);
    if (!start || !target) return null;
    if (start.id === target.id) return [{ entity: start, relationship: null, direction: null }];

    const endUser = await resolveEndUser(this.prisma, scope, input.userId);
    const agentIds = await resolveReadAgentIds(this.prisma, scope, input.agentId, input.agentIds);
    const maxHops = clampInt(
      input.maxHops ?? KnowledgeGraphService.DEFAULT_MAX_HOPS,
      1,
      KnowledgeGraphService.HARD_MAX_HOPS,
    );
    type Trace = {
      previous: string | null;
      relationship: RelationshipRow | null;
      direction: "out" | "in" | null;
    };
    const visited = new Map<string, Trace>([
      [start.id, { previous: null, relationship: null, direction: null }],
    ]);
    let frontier = [start.id];
    for (let depth = 0; depth < maxHops && frontier.length; depth++) {
      const edges = await this.prisma.memoryRelationship.findMany({
        where: {
          ...environmentScopeWhere(scope),
          endUserId: endUser.id,
          ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
          OR: [{ fromEntityId: { in: frontier } }, { toEntityId: { in: frontier } }],
        },
      });
      const next: string[] = [];
      for (const edge of edges) {
        const outbound = frontier.includes(edge.fromEntityId);
        const previous = outbound ? edge.fromEntityId : edge.toEntityId;
        const neighbor = outbound ? edge.toEntityId : edge.fromEntityId;
        if (visited.has(neighbor)) continue;
        visited.set(neighbor, {
          previous,
          relationship: this.toRelationshipRow(edge, scope, endUser.externalId),
          direction: outbound ? "out" : "in",
        });
        if (neighbor === target.id) {
          return this.backtrace(scope, endUser.externalId, visited, start.id, target.id, agentIds);
        }
        next.push(neighbor);
      }
      frontier = next;
    }
    return null;
  }

  private async backtrace(
    scope: ScopeTuple,
    externalUserId: string,
    visited: Map<string, {
      previous: string | null;
      relationship: RelationshipRow | null;
      direction: "out" | "in" | null;
    }>,
    startId: string,
    targetId: string,
    agentIds: string[],
  ): Promise<ShortestPathHop[]> {
    const ids: string[] = [];
    const relationships: Array<RelationshipRow | null> = [];
    const directions: Array<"out" | "in" | null> = [];
    let cursor: string | null = targetId;
    while (cursor) {
      const trace = visited.get(cursor);
      if (!trace) break;
      ids.push(cursor);
      relationships.push(trace.relationship);
      directions.push(trace.direction);
      if (cursor === startId) break;
      cursor = trace.previous;
    }
    ids.reverse();
    relationships.reverse();
    directions.reverse();
    const rows = await this.prisma.memoryEntity.findMany({
      where: {
        id: { in: ids },
        ...environmentScopeWhere(scope),
        ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
      },
    });
    const byId = new Map(rows.map((row) => [row.id, this.toEntityRow(row, scope, externalUserId)]));
    return ids.flatMap((id, index) => {
      const entity = byId.get(id);
      return entity ? [{ entity, relationship: relationships[index] ?? null, direction: directions[index] ?? null }] : [];
    });
  }

  async createRelationship(
    scope: ScopeTuple,
    input: {
      userId: string;
      agentId?: string | null;
      fromEntityId: string;
      toEntityId: string;
      relationshipType: string;
      weight?: number | null;
      metadata?: unknown;
      sourceMemoryId?: string | null;
    },
  ): Promise<RelationshipRow> {
    if (!input.userId) throw new Error("KnowledgeGraphService.createRelationship: `userId` is required");
    if (!input.relationshipType) {
      throw new Error("KnowledgeGraphService.createRelationship: `relationshipType` is required");
    }
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = await resolveEndUser(this.prisma, scope, input.userId);
    const endpoints = await this.prisma.memoryEntity.findMany({
      where: {
        id: { in: [input.fromEntityId, input.toEntityId] },
        ...environmentScopeWhere(scope),
        endUserId: endUser.id,
      },
      select: { id: true, agentId: true, clusterId: true },
    });
    const from = endpoints.find((row) => row.id === input.fromEntityId);
    const to = endpoints.find((row) => row.id === input.toEntityId);
    if (!from || !to) throw new Error("KnowledgeGraphService.createRelationship: endpoint not found in scope");
    if (!canShareAgentScope(from, to)) {
      throw new Error("KnowledgeGraphService.createRelationship: endpoints are outside one Agent or AgentCluster");
    }
    const binding = await resolveWriteBinding(
      this.prisma,
      scope,
      input.agentId || (!scope.agentId ? from.agentId : null),
    );
    if (!canShareAgentScope(binding, from) || !canShareAgentScope(binding, to)) {
      throw new Error("KnowledgeGraphService.createRelationship: acting Agent cannot access both endpoints");
    }
    if (input.sourceMemoryId) {
      const source = await this.prisma.memory.findFirst({
        where: {
          id: input.sourceMemoryId,
          ...environmentScopeWhere(scope),
          endUserId: endUser.id,
        },
        select: { agentId: true, clusterId: true },
      });
      if (!source || !canShareAgentScope(binding, source)) {
        throw new Error("KnowledgeGraphService.createRelationship: source memory not found or access denied");
      }
    }
    const metadata = this.crypto?.encryptJsonField(input.metadata ?? null) ?? input.metadata ?? null;
    const row = await this.prisma.memoryRelationship.upsert({
      where: {
        fromEntityId_toEntityId_relationshipType: {
          fromEntityId: input.fromEntityId,
          toEntityId: input.toEntityId,
          relationshipType: input.relationshipType,
        },
      },
      create: {
        environmentId: scope.environmentId,
        endUserId: endUser.id,
        agentId: binding.agentId,
        clusterId: binding.clusterId,
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
        relationshipType: input.relationshipType,
        weight: input.weight ?? null,
        metadata: metadata as any,
        sourceMemoryId: input.sourceMemoryId ?? null,
      },
      update: {
        agentId: binding.agentId,
        clusterId: binding.clusterId,
        weight: input.weight ?? null,
        metadata: metadata as any,
        sourceMemoryId: input.sourceMemoryId ?? null,
      },
    });
    return this.toRelationshipRow(row, scope, endUser.externalId);
  }

  async searchEntities(
    scope: ScopeTuple,
    input: { userId: string; query: string; limit?: number; agentId?: string | null; agentIds?: string[] },
  ): Promise<Array<{ entity: EntityRow; score: number }>> {
    const query = (input.query || "").trim().toLowerCase();
    if (!query) return [];
    const rows = await this.getEntities(scope, {
      userId: input.userId,
      agentId: input.agentId,
      agentIds: input.agentIds,
      limit: 500,
    });
    const matches = rows.flatMap((entity) => {
      const label = entity.label.toLowerCase();
      const aliases = entity.aliases.map((alias) => alias.toLowerCase());
      const score = label === query
        ? 1
        : label.startsWith(query)
          ? 0.9
          : label.includes(query)
            ? 0.7
            : aliases.some((alias) => alias.includes(query))
              ? 0.5
              : 0;
      return score ? [{ entity, score }] : [];
    });
    return matches.sort((left, right) => right.score - left.score).slice(0, clampInt(input.limit ?? 20, 1, 100));
  }

  async updateEntityById(
    scope: ScopeTuple,
    id: string,
    patch: { label?: string; aliases?: string[]; metadata?: unknown; entityType?: string },
  ): Promise<EntityRow | null> {
    await assertEnvironmentScope(this.prisma, scope);
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const data: Record<string, unknown> = {};
    if (patch.label !== undefined) data.label = this.encString(patch.label);
    if (patch.aliases !== undefined) data.aliases = patch.aliases;
    if (patch.metadata !== undefined) {
      data.metadata = this.crypto?.encryptJsonField(patch.metadata) ?? patch.metadata;
    }
    if (patch.entityType !== undefined) data.entityType = patch.entityType;
    if (!Object.keys(data).length) return this.getEntityById(scope, id);
    const result = await this.prisma.memoryEntity.updateMany({
      where: {
        id,
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
      },
      data: data as any,
    });
    return result.count ? this.getEntityById(scope, id) : null;
  }

  async deleteEntity(
    scope: ScopeTuple,
    id: string,
  ): Promise<{ ok: boolean; deletedRelationships: number }> {
    await assertEnvironmentScope(this.prisma, scope);
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const entity = await this.prisma.memoryEntity.findFirst({
      where: {
        id,
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
      },
      select: { id: true },
    });
    if (!entity) return { ok: false, deletedRelationships: 0 };
    const [relationships, deleted] = await this.prisma.$transaction([
      this.prisma.memoryRelationship.deleteMany({
        where: {
          ...environmentScopeWhere(scope),
          OR: [{ fromEntityId: id }, { toEntityId: id }],
        },
      }),
      this.prisma.memoryEntity.deleteMany({
        where: {
          id,
          ...environmentScopeWhere(scope),
          agentId: { in: agentIds },
        },
      }),
    ]);
    return { ok: deleted.count > 0, deletedRelationships: relationships.count };
  }

  async discoverLinks(
    scope: ScopeTuple,
    input: {
      userId: string;
      limit?: number;
      minSharedNeighbors?: number;
      agentId?: string | null;
      agentIds?: string[];
    },
  ): Promise<{
    suggestions: Array<{ from: EntityRow; to: EntityRow; sharedNeighbors: number; reason: string }>;
  }> {
    const entities = await this.getEntities(scope, {
      userId: input.userId,
      agentId: input.agentId,
      agentIds: input.agentIds,
      limit: 500,
    });
    if (entities.length < 2) return { suggestions: [] };
    const endUser = await resolveEndUser(this.prisma, scope, input.userId);
    const agentIds = await resolveReadAgentIds(this.prisma, scope, input.agentId, input.agentIds);
    const ids = entities.map((entity) => entity.id);
    const edges = await this.prisma.memoryRelationship.findMany({
      where: {
        ...environmentScopeWhere(scope),
        endUserId: endUser.id,
        ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
        OR: [{ fromEntityId: { in: ids } }, { toEntityId: { in: ids } }],
      },
      select: { fromEntityId: true, toEntityId: true },
    });
    const adjacency = new Map(ids.map((id) => [id, new Set<string>()]));
    for (const edge of edges) {
      adjacency.get(edge.fromEntityId)?.add(edge.toEntityId);
      adjacency.get(edge.toEntityId)?.add(edge.fromEntityId);
    }
    const minimum = clampInt(input.minSharedNeighbors ?? 2, 1, 100);
    const candidates: Array<{ from: EntityRow; to: EntityRow; sharedNeighbors: number; reason: string }> = [];
    for (let left = 0; left < entities.length; left++) {
      for (let right = left + 1; right < entities.length; right++) {
        const from = entities[left]!;
        const to = entities[right]!;
        const fromSet = adjacency.get(from.id)!;
        if (fromSet.has(to.id)) continue;
        const toSet = adjacency.get(to.id)!;
        const shared = [...fromSet].filter((id) => toSet.has(id)).length;
        if (shared >= minimum) {
          candidates.push({
            from,
            to,
            sharedNeighbors: shared,
            reason: `${shared} shared neighbor${shared === 1 ? "" : "s"}`,
          });
        }
      }
    }
    candidates.sort((left, right) => right.sharedNeighbors - left.sharedNeighbors);
    return { suggestions: candidates.slice(0, clampInt(input.limit ?? 20, 1, 50)) };
  }

  private toEntityRow(row: any, scope: ScopeTuple, externalUserId: string): EntityRow {
    return {
      id: row.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: row.environmentId,
      userId: externalUserId,
      agentId: row.agentId,
      clusterId: row.clusterId ?? null,
      entityKey: row.entityKey,
      entityType: row.entityType,
      label: this.decString(row.label),
      aliases: Array.isArray(row.aliases) ? row.aliases : [],
      metadata: this.decMetadata(row.metadata),
      createdAt: asDate(row.createdAt),
      updatedAt: asDate(row.updatedAt),
    };
  }

  private toRelationshipRow(row: any, scope: ScopeTuple, externalUserId: string): RelationshipRow {
    return {
      id: row.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: row.environmentId,
      userId: externalUserId,
      agentId: row.agentId,
      clusterId: row.clusterId ?? null,
      fromEntityId: row.fromEntityId,
      toEntityId: row.toEntityId,
      relationshipType: row.relationshipType,
      weight: row.weight ?? null,
      metadata: this.decMetadata(row.metadata),
      sourceMemoryId: row.sourceMemoryId ?? null,
      createdAt: asDate(row.createdAt),
    };
  }
}

function vectorToLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized)) return min;
  return Math.min(Math.max(normalized, min), max);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
