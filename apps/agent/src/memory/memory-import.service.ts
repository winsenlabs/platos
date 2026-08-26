import { Inject, Injectable, Optional } from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import { normalizeMemoryProfileKey, Prisma } from "@platos/tenancy-database";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { EmbeddingService } from "./embedding.service";
import {
  assertEnvironmentScope,
  canShareAgentScope,
  environmentScopeWhere,
  resolveEndUser,
  resolveReadAgentIds,
  resolveWriteBinding,
} from "./memory-scope";
import type { ScopeTuple } from "./memory.service";
import type {
  ValidatedBundleMemory,
  ValidatedMemoryBundle,
} from "./memory-bundle";

interface PreparedMemory extends ValidatedBundleMemory {
  embedding: string | null;
  storedContent: string;
  storedMetadata: unknown;
  profileKey: string | null;
  sourceThreadId: string | null;
  sourceTurnIds: string[];
  originalSource: string;
  originalSourceThreadId: string | null;
  originalSourceTurnIds: string[];
}

@Injectable()
export class MemoryImportService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    private readonly embeddings: EmbeddingService,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {}

  async importBundle(
    scope: ScopeTuple,
    userId: string,
    bundle: ValidatedMemoryBundle,
    mode: "merge" | "replace",
  ) {
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = await resolveEndUser(this.prisma, scope, userId);
    const binding = await resolveWriteBinding(this.prisma, scope, scope.agentId ?? null);
    const readAgentIds = await resolveReadAgentIds(this.prisma, scope, binding.agentId);
    const provenance = await this.validProvenance(scope, endUser.id, binding, bundle.memories);
    const prepared = await mapWithConcurrency(bundle.memories, 8, async (memory) => {
      const validatedProvenance = memory.sourceThreadId
        ? provenance.get(memory.sourceThreadId)
        : undefined;
      const sourceTurnIds = validatedProvenance
        ? memory.sourceTurnIds.filter((turnId) => validatedProvenance.has(turnId))
        : [];
      const vector = memory.kind === "profile"
        ? null
        : await this.embeddings.embed(memory.content, scope);
      const storedMetadata = this.crypto?.encryptJsonField(memory.metadata ?? null)
        ?? memory.metadata
        ?? null;
      return {
        ...memory,
        embedding: vector ? `[${vector.join(",")}]` : null,
        storedContent: this.encryptString(memory.content),
        storedMetadata,
        profileKey: memory.kind === "profile"
          ? normalizeMemoryProfileKey(String((memory.metadata as Record<string, unknown>).profileKey))
          : null,
        sourceThreadId: validatedProvenance ? memory.sourceThreadId : null,
        sourceTurnIds,
        originalSource: memory.originalSource ?? memory.source,
        originalSourceThreadId: memory.originalSourceThreadId ?? memory.sourceThreadId,
        originalSourceTurnIds: memory.originalSourceTurnIds.length
          ? memory.originalSourceTurnIds
          : memory.sourceTurnIds,
      } satisfies PreparedMemory;
    });

    return this.prisma.$transaction(async (tx: any) => {
      const ownerWhere = binding.clusterId
        ? { clusterId: binding.clusterId }
        : { agentId: { in: readAgentIds }, clusterId: null };
      let memoriesDeleted = 0;
      if (mode === "replace") {
        await tx.memoryRelationship.deleteMany({
          where: {
            ...environmentScopeWhere(scope),
            endUserId: endUser.id,
            ...ownerWhere,
          },
        });
        await tx.memoryEntity.deleteMany({
          where: {
            ...environmentScopeWhere(scope),
            endUserId: endUser.id,
            ...ownerWhere,
          },
        });
        const deleted = await tx.memory.deleteMany({
          where: {
            ...environmentScopeWhere(scope),
            endUserId: endUser.id,
            ...ownerWhere,
          },
        });
        memoriesDeleted = deleted.count;
      }

      const memoryIdMap = new Map<string, string>();
      for (const memory of prepared) {
        const importedId = await this.insertMemory(tx, scope, endUser.id, binding, memory);
        memoryIdMap.set(memory.exportedId, importedId);
      }

      const entityIdMap = new Map<string, string>();
      const entityKeyMap = new Map<string, string>();
      for (const entity of bundle.entities) {
        const existing = await tx.memoryEntity.findFirst({
          where: {
            ...environmentScopeWhere(scope),
            endUserId: endUser.id,
            entityKey: entity.entityKey,
            ...(binding.clusterId
              ? { clusterId: binding.clusterId }
              : { agentId: binding.agentId, clusterId: null }),
          },
          select: { id: true },
        });
        const storedEntityMetadata = this.crypto?.encryptJsonField(entity.metadata ?? null)
          ?? entity.metadata
          ?? null;
        const data = {
          agentId: binding.agentId,
          clusterId: binding.clusterId,
          entityType: entity.entityType,
          label: this.encryptString(entity.label),
          aliases: entity.aliases,
          metadata: storedEntityMetadata === null ? Prisma.DbNull : storedEntityMetadata as any,
          updatedAt: entity.updatedAt ?? new Date(),
        };
        const row = existing
          ? await tx.memoryEntity.update({ where: { id: existing.id }, data })
          : await tx.memoryEntity.create({
              data: {
                id: randomUUID(),
                environmentId: scope.environmentId,
                endUserId: endUser.id,
                entityKey: entity.entityKey,
                createdAt: entity.createdAt ?? new Date(),
                ...data,
              },
            });
        entityIdMap.set(entity.exportedId, row.id);
        entityKeyMap.set(entity.entityKey, row.id);
      }

      for (const relationship of bundle.relationships) {
        const fromEntityId = entityIdMap.get(relationship.fromEntityId)
          ?? entityKeyMap.get(relationship.fromEntityKey);
        const toEntityId = entityIdMap.get(relationship.toEntityId)
          ?? entityKeyMap.get(relationship.toEntityKey);
        if (!fromEntityId || !toEntityId) {
          throw importError("MEMORY_IMPORT_RELATIONSHIP_MAPPING_FAILED", "validated relationship mapping disappeared during import");
        }
        const sourceMemoryId = relationship.sourceMemoryId
          ? memoryIdMap.get(relationship.sourceMemoryId)
          : null;
        if (relationship.sourceMemoryId && !sourceMemoryId) {
          throw importError("MEMORY_IMPORT_SOURCE_MAPPING_FAILED", "validated source memory mapping disappeared during import");
        }
        const metadata = this.crypto?.encryptJsonField(relationship.metadata ?? {})
          ?? relationship.metadata
          ?? {};
        await tx.memoryRelationship.upsert({
          where: {
            fromEntityId_toEntityId_relationshipType: {
              fromEntityId,
              toEntityId,
              relationshipType: relationship.relationshipType,
            },
          },
          create: {
            id: randomUUID(),
            environmentId: scope.environmentId,
            endUserId: endUser.id,
            agentId: binding.agentId,
            clusterId: binding.clusterId,
            fromEntityId,
            toEntityId,
            relationshipType: relationship.relationshipType,
            weight: relationship.weight,
            metadata: metadata as any,
            sourceMemoryId,
            createdAt: relationship.createdAt ?? new Date(),
          },
          update: {
            agentId: binding.agentId,
            clusterId: binding.clusterId,
            weight: relationship.weight,
            metadata: metadata as any,
            sourceMemoryId,
          },
        });
      }

      return {
        ok: true as const,
        mode,
        memoriesDeleted,
        memoriesImported: prepared.length,
        entitiesImported: bundle.entities.length,
        relationshipsImported: bundle.relationships.length,
        skipped: 0,
      };
    }, { isolationLevel: "Serializable", timeout: 120_000 });
  }

  private async validProvenance(
    scope: ScopeTuple,
    endUserId: string,
    binding: { agentId: string; clusterId: string | null },
    memories: ValidatedBundleMemory[],
  ): Promise<Map<string, Set<string>>> {
    const threadIds = Array.from(new Set(memories.flatMap((memory) =>
      memory.sourceThreadId && isUuid(memory.sourceThreadId) ? [memory.sourceThreadId] : [],
    )));
    if (!threadIds.length) return new Map();
    const threads = await this.prisma.thread.findMany({
      where: {
        id: { in: threadIds },
        ...environmentScopeWhere(scope),
        endUserId,
      },
      select: {
        id: true,
        agentId: true,
        clusterId: true,
        turns: { select: { id: true } },
      },
    });
    return new Map(threads.flatMap((thread) =>
      canShareAgentScope(binding, thread)
        ? [[thread.id, new Set(thread.turns.map((turn) => turn.id))] as const]
        : [],
    ));
  }

  private async insertMemory(
    tx: any,
    scope: ScopeTuple,
    endUserId: string,
    binding: { agentId: string; clusterId: string | null },
    memory: PreparedMemory,
  ): Promise<string> {
    const id = randomUUID();
    const contentHash = memory.sourceThreadId
      ? createHash("sha256").update(memory.content).digest("hex")
      : null;
    const conflict = memory.kind === "profile"
      ? binding.clusterId
        ? `ON CONFLICT ("environmentId", "endUserId", "clusterId", "profileKey")
             WHERE "kind" = 'profile' AND "clusterId" IS NOT NULL AND "profileKey" IS NOT NULL`
        : `ON CONFLICT ("environmentId", "endUserId", "agentId", "profileKey")
             WHERE "kind" = 'profile' AND "clusterId" IS NULL AND "profileKey" IS NOT NULL`
      : `ON CONFLICT ("environmentId", "endUserId", "sourceThreadId", "contentHash")`;
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO "Memory" (
         "id", "environmentId", "endUserId", "agentId", "clusterId", "kind", "profileKey",
         "content", "metadata", "agentVisible", "visibility", "source", "embedding",
         "sourceThreadId", "sourceTurnIds", "extractorVersion", "contentHash", "confidence",
         "originalSource", "originalSourceThreadId", "originalSourceTurnIds",
         "lastAccessedAt", "quarantinedAt", "archivedAt", "createdAt", "updatedAt"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
         $8, $9::jsonb, $10, $11, $12, $13::vector,
         $14::uuid, $15::uuid[], $16, $17, $18,
         $19, $20, $21,
         $22, $23, $24, $25, $26
       )
       ${conflict}
       DO UPDATE SET
         "content" = EXCLUDED."content",
         "metadata" = EXCLUDED."metadata",
         "agentVisible" = EXCLUDED."agentVisible",
         "visibility" = EXCLUDED."visibility",
         "source" = EXCLUDED."source",
         "embedding" = EXCLUDED."embedding",
         "sourceThreadId" = EXCLUDED."sourceThreadId",
         "sourceTurnIds" = EXCLUDED."sourceTurnIds",
         "extractorVersion" = EXCLUDED."extractorVersion",
         "originalSource" = EXCLUDED."originalSource",
         "originalSourceThreadId" = EXCLUDED."originalSourceThreadId",
         "originalSourceTurnIds" = EXCLUDED."originalSourceTurnIds",
         "confidence" = EXCLUDED."confidence",
         "lastAccessedAt" = EXCLUDED."lastAccessedAt",
         "quarantinedAt" = EXCLUDED."quarantinedAt",
         "archivedAt" = EXCLUDED."archivedAt",
         "updatedAt" = EXCLUDED."updatedAt"
       RETURNING "id"`,
      id,
      scope.environmentId,
      endUserId,
      binding.agentId,
      binding.clusterId,
      memory.kind,
      memory.profileKey,
      memory.storedContent,
      memory.storedMetadata == null ? null : JSON.stringify(memory.storedMetadata),
      memory.agentVisible,
      memory.visibility,
      "imported",
      memory.embedding,
      memory.sourceThreadId,
      memory.sourceTurnIds,
      memory.extractorVersion,
      contentHash,
      memory.confidence,
      memory.originalSource,
      memory.originalSourceThreadId,
      memory.originalSourceTurnIds,
      memory.lastAccessedAt,
      memory.quarantinedAt,
      memory.archivedAt,
      memory.createdAt ?? new Date(),
      memory.updatedAt ?? new Date(),
    ) as Array<{ id: string }>;
    if (!rows[0]) throw importError("MEMORY_IMPORT_PERSISTENCE_FAILED", "memory import did not return a persisted row");
    return rows[0].id;
  }

  private encryptString(value: string): string {
    if (!this.crypto) return value;
    const wrapped = this.crypto.encryptJsonField(value);
    return wrapped && typeof wrapped === "object" && (wrapped as any).__platos_enc === 1
      ? JSON.stringify(wrapped)
      : value;
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return output;
}

function importError(code: string, message: string): Error {
  const error = new Error(message);
  (error as any).code = code;
  return error;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
