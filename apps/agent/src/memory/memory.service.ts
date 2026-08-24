import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN, type ControlDatabaseClient } from "../shared/database.provider";
import { EmbeddingService } from "./embedding.service";
import { requireValidMemoryPayload } from "./memory-kind.validator";
import { MessageCryptoService } from "../monitoring/message-crypto.service";
import { legacyFeedbackMetadataState } from "./memory-feedback-legacy";
import {
  assertEnvironmentScope,
  canShareAgentScope,
  environmentScopeWhere,
  resolveAgentBinding,
  resolveEndUser,
  resolveReadAgentIds,
  resolveWriteBinding,
  type MemoryScope,
} from "./memory-scope";

export type ScopeTuple = MemoryScope;

export type MemoryKind = "fact" | "preference" | "event" | "relationship" | "profile";
export type MemorySource = "manual" | "extracted" | "imported" | "rag";
export const RAG_MEMORY_SOURCE = "rag" as const;
export type MemoryVisibility = "agent_visible" | "hidden" | "private";

export interface MemoryRow {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string | null;
  userId: string;
  kind: string;
  content: string;
  metadata: unknown;
  agentVisible: boolean;
  visibility: MemoryVisibility;
  source: string;
  sourceThreadId: string | null;
  sourceTurnIds: string[];
  /** @deprecated Read-only API alias. Values are clean Turn IDs. */
  sourceMessageIds: string[];
  extractorVersion: string | null;
  confidence: number | null;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
  quarantinedAt: Date | null;
  archivedAt: Date | null;
}

export interface MemorySearchHit extends MemoryRow {
  /** Cosine similarity. Preserved for backwards compatibility and minScore semantics. */
  score: number;
  /** 80% cosine similarity + 20% confidence (null confidence is neutral at 0.5). */
  rankingScore: number;
}

export interface AddMemoryInput {
  userId: string;
  agentId?: string | null;
  content: string;
  kind?: MemoryKind;
  metadata?: unknown;
  agentVisible?: boolean;
  visibility?: MemoryVisibility;
  source?: MemorySource;
  sourceThreadId?: string | null;
  sourceTurnIds?: string[];
  extractorVersion?: string | null;
  confidence?: number | null;
}

export interface UpdateMemoryInput {
  content?: string;
  kind?: MemoryKind;
  metadata?: unknown;
  agentVisible?: boolean;
  visibility?: MemoryVisibility;
}

export interface SemanticSearchInput {
  query: string;
  userId: string;
  kind?: MemoryKind | string;
  agentId?: string | null;
  agentIds?: string[];
  limit?: number;
  minScore?: number;
  agentVisibleOnly?: boolean;
  visibilityIn?: MemoryVisibility[];
  includeArchived?: boolean;
  excludeRag?: boolean;
}

export interface ListMemoriesInput {
  userId: string;
  kind?: MemoryKind | string;
  agentId?: string | null;
  agentIds?: string[];
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    private readonly embeddings: EmbeddingService,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {}

  private encryptContent(value: string): string {
    if (!this.crypto) return value;
    const wrapped = this.crypto.encryptJsonField(value);
    return wrapped && typeof wrapped === "object" && (wrapped as any).__platos_enc === 1
      ? JSON.stringify(wrapped)
      : value;
  }

  private decryptContent(value: string | null | undefined): string {
    if (!value) return "";
    if (!this.crypto || !value.startsWith("{\"__platos_enc\"")) return value;
    try {
      const plain = this.crypto.decryptJsonField(JSON.parse(value));
      return typeof plain === "string" ? plain : value;
    } catch {
      return value;
    }
  }

  private decryptMetadata(value: unknown): unknown {
    return this.crypto?.decryptJsonField(value ?? null) ?? value ?? null;
  }

  private async scopeAndUser(scope: ScopeTuple, userId: string) {
    await assertEnvironmentScope(this.prisma, scope);
    return resolveEndUser(this.prisma, scope, userId);
  }

  async add(scope: ScopeTuple, input: AddMemoryInput): Promise<MemoryRow> {
    if (!input.userId) throw new Error("MemoryService.add: `userId` is required");
    const validated = requireValidMemoryPayload({
      kind: input.kind,
      content: input.content,
      metadata: input.metadata,
    });
    if (
      input.confidence !== undefined &&
      input.confidence !== null &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    ) {
      throw new Error("Memory confidence must be between 0 and 1");
    }
    const endUser = await this.scopeAndUser(scope, input.userId);
    const binding = await resolveWriteBinding(
      this.prisma,
      scope,
      input.agentId,
      input.sourceThreadId,
    );
    const source = input.source || "manual";
    const visibility = normalizeVisibility(input.visibility, input.agentVisible);
    const agentVisible = visibility === "agent_visible";
    const sourceTurnIds = Array.from(new Set(input.sourceTurnIds ?? []));
    if (sourceTurnIds.length && !input.sourceThreadId) {
      throw new Error("Memory sourceTurnIds require a sourceThreadId");
    }
    if (input.sourceThreadId) {
      const sourceThread = await this.prisma.thread.findFirst({
        where: {
          id: input.sourceThreadId,
          ...environmentScopeWhere(scope),
          endUserId: endUser.id,
        },
        select: { agentId: true, clusterId: true },
      });
      if (!sourceThread || !canShareAgentScope(binding, sourceThread)) {
        throw new Error("Memory source thread not found or outside the acting Agent scope");
      }
      if (sourceTurnIds.length) {
        const sourceTurnCount = await this.prisma.turn.count({
          where: { id: { in: sourceTurnIds }, threadId: input.sourceThreadId },
        });
        if (sourceTurnCount !== sourceTurnIds.length) {
          throw new Error("Memory sourceTurnIds must belong to the source thread");
        }
      }
    }
    const contentHash = input.sourceThreadId
      ? crypto.createHash("sha256").update(validated.content).digest("hex")
      : null;

    const vector = validated.kind === "profile"
      ? null
      : await this.embeddings.embed(validated.content, scope);
    const id = crypto.randomUUID();
    const storedMetadata = this.crypto?.encryptJsonField(validated.metadata ?? null)
      ?? validated.metadata
      ?? null;

    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "Memory" (
         "id", "environmentId", "endUserId", "agentId", "clusterId",
         "kind", "content", "metadata", "agentVisible", "visibility", "source",
         "embedding", "sourceThreadId", "sourceTurnIds", "extractorVersion", "contentHash", "confidence",
         "createdAt", "updatedAt"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6, $7, $8::jsonb, $9, $10, $11,
         $12::vector, $13::uuid, $14::uuid[], $15, $16, $17, NOW(), NOW()
       )
       ON CONFLICT ("environmentId", "endUserId", "sourceThreadId", "contentHash")
       DO UPDATE SET
         "sourceTurnIds" = ARRAY(
           SELECT DISTINCT unnest("Memory"."sourceTurnIds" || EXCLUDED."sourceTurnIds")
         ),
         "extractorVersion" = EXCLUDED."extractorVersion",
         "confidence" = GREATEST(
           COALESCE("Memory"."confidence", 0),
           COALESCE(EXCLUDED."confidence", 0)
         ),
         "lastAccessedAt" = NOW(),
         "updatedAt" = NOW()`,
      id,
      scope.environmentId,
      endUser.id,
      binding.agentId,
      binding.clusterId,
      validated.kind,
      this.encryptContent(validated.content),
      storedMetadata === null ? null : JSON.stringify(storedMetadata),
      agentVisible,
      visibility,
      source,
      vector ? vectorToLiteral(vector) : null,
      input.sourceThreadId ?? null,
      sourceTurnIds,
      input.extractorVersion ?? null,
      contentHash,
      input.confidence ?? null,
    );

    const row = contentHash && input.sourceThreadId
      ? await this.prisma.memory.findFirst({
          where: {
            environmentId: scope.environmentId,
            endUserId: endUser.id,
            sourceThreadId: input.sourceThreadId,
            contentHash,
          },
        })
      : await this.prisma.memory.findUnique({ where: { id } });
    if (!row) throw new Error("Memory persistence completed without a readable row");
    return this.toMemoryRow(row, scope, endUser.externalId);
  }

  async update(
    scope: ScopeTuple,
    id: string,
    patch: UpdateMemoryInput,
    userId?: string,
  ): Promise<MemoryRow | null> {
    await assertEnvironmentScope(this.prisma, scope);
    const existing = await this.get(scope, id);
    if (!existing) return null;
    if (userId && existing.userId !== userId) return null;

    const validated = requireValidMemoryPayload({
      kind: patch.kind ?? existing.kind,
      content: patch.content ?? existing.content,
      metadata: patch.metadata === undefined ? existing.metadata : patch.metadata,
    });
    const visibility = patch.visibility
      ? normalizeVisibility(patch.visibility, patch.agentVisible)
      : patch.agentVisible !== undefined
        ? normalizeVisibility(undefined, patch.agentVisible)
        : existing.visibility;
    const changedContent = patch.content !== undefined && patch.content !== existing.content;
    const vector = changedContent && validated.kind !== "profile"
      ? await this.embeddings.embed(validated.content, scope)
      : null;
    const storedMetadata = this.crypto?.encryptJsonField(validated.metadata ?? null)
      ?? validated.metadata
      ?? null;
    const newHash = changedContent
      ? crypto.createHash("sha256").update(validated.content).digest("hex")
      : null;

    const result = await this.prisma.$executeRawUnsafe(
      `UPDATE "Memory"
       SET "kind" = $1,
           "content" = $2,
           "metadata" = $3::jsonb,
           "agentVisible" = $4,
           "visibility" = $5,
           "embedding" = CASE WHEN $6::vector IS NULL THEN "embedding" ELSE $6::vector END,
           "contentHash" = CASE WHEN $7::text IS NULL THEN "contentHash" ELSE $7 END,
           "updatedAt" = NOW()
       WHERE "id" = $8::uuid AND "environmentId" = $9::uuid`,
      validated.kind,
      this.encryptContent(validated.content),
      storedMetadata === null ? null : JSON.stringify(storedMetadata),
      visibility === "agent_visible",
      visibility,
      vector ? vectorToLiteral(vector) : null,
      newHash,
      id,
      scope.environmentId,
    );
    if (!result) return null;
    return this.get(scope, id);
  }

  async get(scope: ScopeTuple, id: string): Promise<MemoryRow | null> {
    await assertEnvironmentScope(this.prisma, scope);
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const row = await this.prisma.memory.findFirst({
      where: {
        id,
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
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
    const externalId = row.endUser.identities[0]?.subject ?? row.endUserId;
    return this.toMemoryRow(row, scope, externalId);
  }

  async delete(scope: ScopeTuple, id: string, userId?: string): Promise<boolean> {
    await assertEnvironmentScope(this.prisma, scope);
    const endUser = userId ? await resolveEndUser(this.prisma, scope, userId) : null;
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const result = await this.prisma.memory.deleteMany({
      where: {
        id,
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
        ...(endUser ? { endUserId: endUser.id } : {}),
      },
    });
    return result.count > 0;
  }

  async archive(
    scope: ScopeTuple,
    id: string,
  ): Promise<{ ok: boolean; archivedAt: string | null }> {
    await assertEnvironmentScope(this.prisma, scope);
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const now = new Date();
    const result = await this.prisma.memory.updateMany({
      where: {
        id,
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
        archivedAt: null,
      },
      data: { archivedAt: now },
    });
    return { ok: result.count > 0, archivedAt: result.count ? now.toISOString() : null };
  }

  async restore(
    scope: ScopeTuple,
    id: string,
  ): Promise<{ ok: boolean; memory: MemoryRow | null }> {
    await assertEnvironmentScope(this.prisma, scope);
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const result = await this.prisma.memory.updateMany({
      where: {
        id,
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
        archivedAt: { not: null },
      },
      data: { archivedAt: null },
    });
    if (!result.count) return { ok: false, memory: null };
    return { ok: true, memory: await this.get(scope, id) };
  }

  async bulkDelete(scope: ScopeTuple, ids: string[]): Promise<{ deleted: number }> {
    await assertEnvironmentScope(this.prisma, scope);
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    if (ids.length > 100) throw new Error("MemoryService.bulkDelete: max 100 memories per request");
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const result = await this.prisma.memory.deleteMany({
      where: {
        id: { in: ids },
        ...environmentScopeWhere(scope),
        agentId: { in: agentIds },
      },
    });
    return { deleted: result.count };
  }

  async list(scope: ScopeTuple, input: ListMemoriesInput): Promise<MemoryRow[]> {
    if (!input.userId) throw new Error("MemoryService.list: `userId` is required");
    const endUser = await this.scopeAndUser(scope, input.userId);
    const agentIds = await resolveReadAgentIds(
      this.prisma,
      scope,
      input.agentId,
      input.agentIds,
    );
    const rows = await this.prisma.memory.findMany({
      where: {
        ...environmentScopeWhere(scope),
        endUserId: endUser.id,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(agentIds.length ? { agentId: { in: agentIds } } : {}),
        ...(input.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [
        { lastAccessedAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
      ],
      take: clampInt(input.limit ?? 50, 1, 10_000),
      skip: clampInt(input.offset ?? 0, 0, 10_000),
    });
    return rows.map((row) => this.toMemoryRow(row, scope, endUser.externalId));
  }

  async semanticSearch(
    scope: ScopeTuple,
    input: SemanticSearchInput,
  ): Promise<MemorySearchHit[]> {
    const query = (input.query || "").trim();
    if (!query) throw new Error("MemoryService.semanticSearch: `query` is required");
    if (!input.userId) throw new Error("MemoryService.semanticSearch: `userId` is required");
    const endUser = await this.scopeAndUser(scope, input.userId);
    const agentIds = await resolveReadAgentIds(
      this.prisma,
      scope,
      input.agentId,
      input.agentIds,
    );
    const qvec = await this.embeddings.embed(query, scope);
    const legacyFilterRequired = !(await this.legacyFeedbackBackfillComplete(scope));
    const params: unknown[] = [vectorToLiteral(qvec), scope.environmentId, endUser.id];
    const clauses = [
      `"environmentId" = $2::uuid`,
      `"endUserId" = $3::uuid`,
      `"embedding" IS NOT NULL`,
    ];
    const addParam = (value: unknown, cast = "") => {
      params.push(value);
      return `$${params.length}${cast}`;
    };
    clauses.push(`"quarantinedAt" IS NULL`);
    if (!input.includeArchived) clauses.push(`"archivedAt" IS NULL`);
    if (input.kind) clauses.push(`"kind" = ${addParam(input.kind)}`);
    if (agentIds.length) clauses.push(`"agentId" = ANY(${addParam(agentIds, "::uuid[]")})`);
    if (input.agentVisibleOnly) clauses.push(`"agentVisible" = TRUE`);
    const visibility = input.visibilityIn?.length
      ? input.visibilityIn
      : ["agent_visible", "hidden"];
    clauses.push(`"visibility" = ANY(${addParam(visibility, "::text[]")})`);
    if (input.excludeRag) clauses.push(`"source" IS DISTINCT FROM ${addParam(RAG_MEMORY_SOURCE)}`);

    const limit = clampInt(input.limit ?? 10, 1, 50);
    // Preserve the HNSW cosine path for candidate generation, then let a
    // bounded confidence signal affect final recall. Overfetching is required:
    // reranking only the requested limit can never promote a slightly less
    // similar memory after positive feedback.
    const candidateLimit = Math.min(limit * 4, 200);
    const minScore = typeof input.minScore === "number" ? input.minScore : 0;
    const rows: any[] = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = 25000");
      const useExactScan = async () => {
        await tx.$executeRawUnsafe("SET LOCAL enable_indexscan = off");
        await tx.$executeRawUnsafe("SET LOCAL enable_indexonlyscan = off");
        await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      };
      const queryCandidates = (exactFallback = false) => tx.$queryRawUnsafe<any[]>(
        `SELECT "id", "environmentId", "endUserId", "agentId", "clusterId",
                "kind", "content", "metadata", "agentVisible", "visibility", "source",
                "sourceThreadId", "sourceTurnIds", "extractorVersion", "confidence",
                "createdAt", "updatedAt", "lastAccessedAt", "quarantinedAt", "archivedAt",
                1 - ("embedding" <=> $1::vector) AS "cosineScore"
         FROM "Memory"
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${exactFallback
           ? '("embedding" <=> $1::vector) + 0'
           : '"embedding" <=> $1::vector'}
         LIMIT ${candidateLimit}${exactFallback ? " /* exact fallback */" : ""}`,
        ...params,
      );
      const versions = await tx.$queryRawUnsafe<Array<{ extversion: string }>>(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      const pgvectorVersion = versions[0]?.extversion;
      if (pgvectorVersionAtLeast(pgvectorVersion, 0, 8)) {
        await tx.$executeRawUnsafe("SET LOCAL hnsw.iterative_scan = strict_order");
        await tx.$executeRawUnsafe(`SET LOCAL hnsw.ef_search = ${candidateLimit}`);
        const candidates = await queryCandidates();
        if (
          candidates.length >= candidateLimit &&
          (!legacyFilterRequired ||
            countLegacyApprovedCandidates(
              candidates,
              minScore,
              (metadata) => this.decryptMetadata(metadata),
            ) >= candidateLimit)
        ) {
          return candidates;
        }

        // max_scan_tuples and highly selective filters can still exhaust an
        // iterative HNSW scan. Retry exactly rather than returning a partial
        // page indistinguishable from a genuinely small result set.
        await useExactScan();
        if (legacyFilterRequired) {
          return queryLegacyApprovedCandidates(
            tx,
            params,
            clauses,
            candidateLimit,
            minScore,
            (metadata) => this.decryptMetadata(metadata),
          );
        }
        return queryCandidates(true);
      } else {
        // Before pgvector 0.8, ef_search alone cannot continue past candidates
        // rejected by selective filters. Disable index paths transaction-locally
        // so the distance expression is exact instead of silently underfilling.
        await useExactScan();
        if (legacyFilterRequired) {
          return queryLegacyApprovedCandidates(
            tx,
            params,
            clauses,
            candidateLimit,
            minScore,
            (metadata) => this.decryptMetadata(metadata),
          );
        }
        return queryCandidates(true);
      }
    }, { timeout: 30_000 });
    const hits = rows
      .map((row) => {
        const memoryRow = this.toMemoryRow(row, scope, endUser.externalId);
        return {
          ...memoryRow,
          score: numericScore(row.cosineScore),
          legacyBlocked: legacyFeedbackMetadataState(row.metadata, memoryRow.metadata).blocksRecall,
          rankingScore: blendedRecallScore(
            numericScore(row.cosineScore),
            row.confidence == null ? 0.5 : Number(row.confidence),
          ),
        };
      })
      .filter((row) => row.score >= minScore && (!legacyFilterRequired || !row.legacyBlocked))
      .sort((left, right) => {
        if (right.rankingScore !== left.rankingScore) {
          return right.rankingScore - left.rankingScore;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .slice(0, limit)
      .map(({ legacyBlocked: _legacyBlocked, ...row }) => row);

    if (hits.length) {
      const ids = hits.map((hit) => hit.id);
      void this.prisma.memory.updateMany({
        where: { id: { in: ids }, environmentId: scope.environmentId },
        data: { lastAccessedAt: new Date() },
      }).catch((error: unknown) => {
        this.logger.error(
          `Memory last-access persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    return hits;
  }

  async semanticSearchForCluster(
    scope: ScopeTuple,
    query: string,
    userId: string,
    options?: {
      limit?: number;
      minScore?: number;
      clusteringId?: string | null;
      agentId?: string | null;
    },
  ): Promise<MemorySearchHit[]> {
    const current = scope.agentId || options?.agentId;
    if (!current) throw new Error("Cluster memory recall requires the acting Agent");
    const binding = await resolveAgentBinding(this.prisma, scope, current);
    if (!binding.clusterId) {
      return this.semanticSearch(scope, {
        query,
        userId,
        agentId: binding.agentId,
        limit: options?.limit ?? 10,
        minScore: options?.minScore,
        excludeRag: true,
      });
    }
    if (options?.clusteringId && options.clusteringId !== binding.clusterId) {
      throw new Error("Caller-supplied AgentCluster does not match persisted Agent ownership");
    }
    const members = await this.prisma.agentBinding.findMany({
      where: { ...environmentScopeWhere(scope), clusterId: binding.clusterId },
      select: { agentId: true },
    });
    return this.semanticSearch(scope, {
      query,
      userId,
      agentIds: members.map((member) => member.agentId),
      limit: options?.limit ?? 10,
      minScore: options?.minScore,
      excludeRag: true,
    });
  }

  async deleteAllForUser(scope: ScopeTuple, userId: string): Promise<number> {
    if (!userId) throw new Error("MemoryService.deleteAllForUser: `userId` is required");
    const endUser = await this.scopeAndUser(scope, userId);
    const agentIds = await resolveReadAgentIds(this.prisma, scope);
    const result = await this.prisma.memory.deleteMany({
      where: {
        ...environmentScopeWhere(scope),
        endUserId: endUser.id,
        agentId: { in: agentIds },
      },
    });
    return result.count;
  }

  private toMemoryRow(row: any, scope: ScopeTuple, externalUserId: string): MemoryRow {
    const visibility = normalizeVisibility(
      typeof row.visibility === "string" ? row.visibility as MemoryVisibility : undefined,
      row.agentVisible,
    );
    const sourceTurnIds = Array.isArray(row.sourceTurnIds) ? row.sourceTurnIds : [];
    return {
      id: row.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: row.environmentId,
      agentId: row.agentId ?? null,
      userId: externalUserId,
      kind: row.kind,
      content: this.decryptContent(row.content),
      metadata: this.decryptMetadata(row.metadata),
      agentVisible: visibility === "agent_visible" && row.agentVisible !== false,
      visibility,
      source: row.source,
      sourceThreadId: row.sourceThreadId ?? null,
      sourceTurnIds,
      sourceMessageIds: sourceTurnIds,
      extractorVersion: row.extractorVersion ?? null,
      confidence: row.confidence == null ? null : Number(row.confidence),
      createdAt: asDate(row.createdAt),
      updatedAt: asDate(row.updatedAt),
      lastAccessedAt: row.lastAccessedAt ? asDate(row.lastAccessedAt) : null,
      quarantinedAt: row.quarantinedAt ? asDate(row.quarantinedAt) : null,
      archivedAt: row.archivedAt ? asDate(row.archivedAt) : null,
    };
  }

  private async legacyFeedbackBackfillComplete(scope: ScopeTuple): Promise<boolean> {
    const environment = await this.prisma.environment.findFirst({
      where: {
        id: scope.environmentId,
        projectId: scope.projectId,
        project: { organizationId: scope.organizationId },
      },
      select: { memoryFeedbackBackfillCompletedAt: true },
    });
    return !!environment?.memoryFeedbackBackfillCompletedAt;
  }
}

function normalizeVisibility(
  explicit: MemoryVisibility | undefined,
  legacy: boolean | undefined,
): MemoryVisibility {
  if (explicit === "agent_visible" || explicit === "hidden" || explicit === "private") {
    return explicit;
  }
  return legacy === false ? "hidden" : "agent_visible";
}

function vectorToLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Math.floor(Number(value));
  if (!Number.isFinite(normalized)) return min;
  return Math.min(Math.max(normalized, min), max);
}

function numericScore(value: unknown): number {
  return typeof value === "number" ? value : Number(value) || 0;
}

function blendedRecallScore(cosineScore: number, confidence: number): number {
  const boundedConfidence = Math.min(1, Math.max(0, confidence));
  return cosineScore * 0.8 + boundedConfidence * 0.2;
}

type RawQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

function countLegacyApprovedCandidates(
  rows: any[],
  minScore: number,
  decryptMetadata: (metadata: unknown) => unknown,
): number {
  return rows.reduce((count, row) => {
    if (numericScore(row.cosineScore) < minScore) return count;
    const decrypted = decryptLegacyMetadata(row.metadata, decryptMetadata);
    return legacyFeedbackMetadataState(row.metadata, decrypted).blocksRecall ? count : count + 1;
  }, 0);
}

async function queryLegacyApprovedCandidates(
  tx: RawQueryClient,
  params: unknown[],
  clauses: string[],
  candidateLimit: number,
  minScore: number,
  decryptMetadata: (metadata: unknown) => unknown,
): Promise<any[]> {
  // Keep memory bounded to one fixed-size page plus the normal 200-candidate
  // overfetch window. The caller's transaction and statement timeouts bound
  // total work; timeout failures surface instead of returning a silent partial.
  const approved: any[] = [];
  const pageLimit = 200;
  const minScoreParam = `$${params.length + 1}::double precision`;
  let cursor: { distance: number; id: string } | undefined;

  while (approved.length < candidateLimit) {
    const cursorClause = cursor
      ? `AND ROW(("embedding" <=> $1::vector), "id") >
             ROW($${params.length + 2}::double precision, $${params.length + 3}::uuid)`
      : "";
    const page = await tx.$queryRawUnsafe<any[]>(
      `SELECT "id", "environmentId", "endUserId", "agentId", "clusterId",
              "kind", "content", "metadata", "agentVisible", "visibility", "source",
              "sourceThreadId", "sourceTurnIds", "extractorVersion", "confidence",
              "createdAt", "updatedAt", "lastAccessedAt", "quarantinedAt", "archivedAt",
              "embedding" <=> $1::vector AS "distanceScore",
              1 - ("embedding" <=> $1::vector) AS "cosineScore"
       FROM "Memory"
       WHERE ${clauses.join(" AND ")}
         AND 1 - ("embedding" <=> $1::vector) >= ${minScoreParam}
         ${cursorClause}
       ORDER BY ("embedding" <=> $1::vector) + 0, "id" ASC
       LIMIT ${pageLimit} /* bounded legacy exact page */`,
      ...params,
      minScore,
      ...(cursor ? [cursor.distance, cursor.id] : []),
    );
    if (!page.length) break;

    for (const row of page) {
      const decrypted = decryptLegacyMetadata(row.metadata, decryptMetadata);
      if (!legacyFeedbackMetadataState(row.metadata, decrypted).blocksRecall) {
        approved.push(row);
        if (approved.length >= candidateLimit) break;
      }
    }

    const last = page[page.length - 1]!;
    cursor = { distance: numericScore(last.distanceScore), id: String(last.id) };
    if (page.length < pageLimit) break;
  }

  return approved;
}

function decryptLegacyMetadata(
  metadata: unknown,
  decryptMetadata: (metadata: unknown) => unknown,
): unknown {
  try {
    return decryptMetadata(metadata);
  } catch {
    return metadata;
  }
}

function pgvectorVersionAtLeast(
  version: string | undefined,
  requiredMajor: number,
  requiredMinor: number,
): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > requiredMajor || (major === requiredMajor && minor >= requiredMinor);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
