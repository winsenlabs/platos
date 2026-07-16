import { Injectable, Inject, Logger, Optional } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { EmbeddingService } from "./embedding.service";
import { requireValidMemoryPayload } from "./memory-kind.validator";
import { MessageCryptoService } from "../monitoring/message-crypto.service";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export type MemoryKind =
  | "fact"
  | "preference"
  | "event"
  | "relationship"
  /** Theme M.1 — structured per-user fact keyed by metadata.profileKey. */
  | "profile";
export type MemorySource = "manual" | "extracted" | "imported";
/** Theme O.6 — authoritative visibility state. */
export type MemoryVisibility = "agent_visible" | "hidden" | "private";

/** Shape returned to callers. Excludes the raw embedding — that's only
 *  ever used internally for similarity search. */
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
  /** Theme O.6 — authoritative visibility state. */
  visibility: MemoryVisibility;
  source: string;
  sourceThreadId: string | null;
  sourceMessageIds: string[];
  extractorVersion: string | null;
  /**
   * Theme M.1 / M.5 — per-memory confidence score in [0, 1]. Set by the
   * extractor judge LLM and bumped up (+0.1) on thumbs-up ratings. NULL
   * for pre-M.1 rows; recall ranking treats NULL as 0 (no boost).
   */
  confidence: number | null;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date | null;
  /**
   * MCPF-W2 — soft-delete marker. `null` for live rows; non-null for
   * archived rows hidden from default list/search. Set via
   * `MemoryService.archive`, cleared via `MemoryService.restore`.
   */
  archivedAt: Date | null;
}

export interface MemorySearchHit extends MemoryRow {
  /** Cosine similarity in [0, 1]. Higher = closer. */
  score: number;
}

export interface AddMemoryInput {
  userId: string;
  agentId?: string | null;
  /** FK to PlatosEndUser when known. Null for legacy/anonymous rows. */
  platosEndUserId?: string | null;
  content: string;
  kind?: MemoryKind;
  metadata?: unknown;
  agentVisible?: boolean;
  /** Theme O.6 — preferred over `agentVisible`. When omitted, derived. */
  visibility?: MemoryVisibility;
  source?: MemorySource;
  sourceThreadId?: string | null;
  sourceMessageIds?: string[];
  extractorVersion?: string | null;
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
  limit?: number;
  minScore?: number;
  /**
   * When set, only return memories with `agentVisible = true`.
   *
   * Theme O.6 — semanticSearch now also respects `visibility`. The
   * agent-facing `recall` path filters to `visibility IN ('agent_visible',
   * 'hidden')` regardless of this flag: "hidden" still lets the agent read
   * the row (it's just the UI that skips it). "private" is always excluded
   * from the agent path.
   */
  agentVisibleOnly?: boolean;
  /**
   * Theme O.6 — explicit visibility filter. When omitted, semanticSearch
   * uses the invariant default: excludes `private` so the agent never
   * surfaces a user-marked-private memory, but includes both
   * `agent_visible` and `hidden`. Pass `["agent_visible", "hidden",
   * "private"]` explicitly from editor-only paths that need the full set.
   */
  visibilityIn?: MemoryVisibility[];
  /**
   * Restrict to a set of agents (cluster-member search). Wins alongside
   * the scope+user filters; mutually exclusive with `agentId` in practice.
   */
  agentIds?: string[];
  /**
   * MCPF-W2 — when `true`, semantic search includes archived rows. Default
   * `false` — archived rows are filtered out so the agent never recalls
   * them. Restore via `MemoryService.restore`.
   */
  includeArchived?: boolean;
}

export interface ListMemoriesInput {
  userId: string;
  kind?: MemoryKind | string;
  agentId?: string | null;
  /** Restrict to a set of agents (cluster-member listing). */
  agentIds?: string[];
  limit?: number;
  offset?: number;
  /**
   * MCPF-W2 — when `true`, the read path returns archived rows alongside
   * live ones. Default `false` — list/search always filter
   * `archivedAt IS NULL`. Restore via `MemoryService.restore`.
   */
  includeArchived?: boolean;
}

/**
 * Theme L — semantic memory service (L3). Wraps the `PlatosMemory`
 * table plus the pgvector similarity query. The KG side lives in
 * `KnowledgeGraphService` to keep both files focused.
 *
 * Scope discipline: every method takes a `ScopeTuple` and every SQL
 * touch filters on `(organizationId, projectId, environmentId)`. The
 * controller pulls the scope from `ScopeGuard` before calling here —
 * callers never construct a scope from tool inputs.
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly embeddings: EmbeddingService,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {}

  /**
   * EOBD.22 — envelope-stringify a String memory column so it can hold
   * encrypted PII while remaining passthrough-compatible with pre-
   * encryption rows. Embeddings MUST be computed on plaintext BEFORE
   * we encrypt — the stored `content` becomes base64 ciphertext; the
   * vector stays semantically meaningful because it was embedded from
   * the plain text.
   */
  private encryptContent(value: string | null | undefined): string {
    if (value === null || value === undefined) return "";
    if (!this.crypto) return value;
    const wrapped = this.crypto.encryptJsonField(value);
    if (wrapped && typeof wrapped === "object" && (wrapped as any).__platos_enc === 1) {
      return JSON.stringify(wrapped);
    }
    return value;
  }

  private decryptContent(value: string | null | undefined): string {
    if (value === null || value === undefined) return "";
    if (!this.crypto) return value;
    if (!value.startsWith("{\"__platos_enc\"")) return value;
    try {
      const plain = this.crypto.decryptJsonField(JSON.parse(value));
      return typeof plain === "string" ? plain : value;
    } catch {
      return value;
    }
  }

  /**
   * Insert a new memory row. Computes the embedding inline so a failure
   * in the embedding pipeline surfaces on the write path — we never
   * want to silently commit a row with a null vector if the caller
   * intended to have one. If the embedding provider is unavailable we
   * throw; callers may pass `agentVisible: false` for editor-only
   * imports that don't need to be recall-searchable yet.
   */
  async add(scope: ScopeTuple, input: AddMemoryInput): Promise<MemoryRow> {
    this.requireScope(scope);
    if (!input.userId) throw new Error("MemoryService.add: `userId` is required");

    // Theme O.4 — validate kind + content + metadata shape before we spend
    // an embedding round-trip on garbage input. `requireValidMemoryPayload`
    // throws a 400-stamped Error on failure.
    const validated = requireValidMemoryPayload({
      kind: input.kind,
      content: input.content,
      metadata: input.metadata,
    });

    const source: string = input.source || "manual";
    // Theme O.6 — visibility is the authoritative flag; derive agentVisible
    // so legacy readers that still reach for the boolean stay consistent.
    const visibility: MemoryVisibility = normalizeVisibility(
      input.visibility,
      input.agentVisible,
    );
    const agentVisible = visibility !== "private";

    // EOBD.46 — dedupe extractor re-runs. Compute sha256(content) and,
    // when a sourceThreadId is present (only extractor rows have one),
    // check for an existing row with the same (scope, user, thread,
    // hash). Found → merge sourceMessageIds + bump lastAccessedAt +
    // return the existing row. Manual rows (no sourceThreadId) skip
    // the dedupe check — they're user-driven and should always insert.
    const contentHash = input.sourceThreadId
      ? crypto.createHash("sha256").update(validated.content).digest("hex")
      : null;
    if (input.sourceThreadId && contentHash) {
      const dup = await this.prisma.platosMemory.findFirst({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: input.userId,
          sourceThreadId: input.sourceThreadId,
          contentHash,
        },
      });
      if (dup) {
        const mergedSourceIds = Array.from(
          new Set([...(dup.sourceMessageIds ?? []), ...(input.sourceMessageIds ?? [])]),
        );
        const updated = await this.prisma.platosMemory.update({
          where: { id: dup.id },
          data: {
            sourceMessageIds: mergedSourceIds,
            lastAccessedAt: new Date(),
          },
        });
        return toMemoryRow(
          updated,
          (v) => this.decryptContent(v),
          (v) => this.crypto?.decryptJsonField(v) ?? v,
        );
      }
    }

    // EOBD.22 — embedding MUST be computed on plaintext so semantic
    // search works; ciphertext is only the at-rest storage form.
    //
    // Theme M (follow-up) — `kind: "profile"` rows are key-value only:
    // `recall_user_profile` does Prisma findMany with a metadata filter,
    // not vector search, and the memory-injection path excludes profile
    // rows via `visibilityIn: ["agent_visible","hidden"]` (profile rows
    // are `private`). Skipping the embed call here means profile writes
    // no longer require an embedding provider API key to be configured,
    // which was silently failing `update_user_profile` calls whenever
    // OPENAI_API_KEY was unset on the scope. Embedding column is
    // nullable — the pgvector index simply skips NULL rows.
    const needsEmbedding = validated.kind !== "profile";
    const vector = needsEmbedding
      ? await this.embeddings.embed(validated.content, scope)
      : null;
    const storedContent = this.encryptContent(validated.content);
    // metadata is a Json column — envelope-wrap when crypto available.
    const storedMetadata =
      this.crypto?.encryptJsonField(validated.metadata ?? null) ?? (validated.metadata ?? null);

    // Two-step: Prisma can't write the Unsupported("vector") column,
    // so we insert via raw SQL then re-read the row via findFirst.
    // `$10::vector` on a NULL bind is a no-op cast returning NULL — the
    // embedding column is nullable (profile rows + async back-fill rows
    // both leave it NULL at insert time).
    const id = createCuid();
    const vectorParam = vector === null ? null : vectorToLiteral(vector);
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "PlatosMemory" (
          "id","organizationId","projectId","environmentId","agentId","userId","platosEndUserId",
          "kind","content","metadata","embedding","agentVisible","visibility","source",
          "sourceThreadId","sourceMessageIds","extractorVersion","contentHash",
          "createdAt","updatedAt","lastAccessedAt"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::vector,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW(),NULL)`,
      id,
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      input.agentId ?? null,
      input.userId,
      input.platosEndUserId ?? null,
      validated.kind,
      storedContent,
      storedMetadata === null ? null : JSON.stringify(storedMetadata),
      vectorParam,
      agentVisible,
      visibility,
      source,
      input.sourceThreadId ?? null,
      input.sourceMessageIds ?? [],
      input.extractorVersion ?? null,
      contentHash,
    );

    const row = await this.prisma.platosMemory.findFirst({ where: { id } });
    return toMemoryRow(row, (v) => this.decryptContent(v), (v) => this.crypto?.decryptJsonField(v) ?? v);
  }

  /**
   * Theme O.7 — patch/update an existing memory row. Re-validates the
   * kind+content+metadata tuple if any of them change. Re-embeds when
   * `content` changes. Scope-guarded.
   */
  async update(scope: ScopeTuple, id: string, patch: UpdateMemoryInput): Promise<MemoryRow | null> {
    this.requireScope(scope);
    const existing = await this.get(scope, id);
    if (!existing) return null;

    const nextKind: string = patch.kind ?? existing.kind;
    const nextContent: string = patch.content ?? existing.content;
    const nextMetadata: unknown = patch.metadata === undefined ? existing.metadata : patch.metadata;

    const validated = requireValidMemoryPayload({
      kind: nextKind,
      content: nextContent,
      metadata: nextMetadata,
    });

    // Re-embed only when content changed AND the kind isn't "profile"
    // (profile rows are key-value, never semantic-searched — see add()).
    const needsEmbed =
      validated.kind !== "profile" &&
      patch.content !== undefined &&
      patch.content !== existing.content;
    const vector = needsEmbed ? await this.embeddings.embed(validated.content, scope) : null;

    const visibility: MemoryVisibility = patch.visibility
      ? normalizeVisibility(patch.visibility, patch.agentVisible)
      : patch.agentVisible !== undefined
        ? normalizeVisibility(undefined, patch.agentVisible)
        : existing.visibility;
    const agentVisible = visibility !== "private";

    const setParts: string[] = [
      `"kind" = $1`,
      `"content" = $2`,
      `"metadata" = $3::jsonb`,
      `"agentVisible" = $4`,
      `"visibility" = $5`,
      `"updatedAt" = NOW()`,
    ];
    // EOBD.22 — encrypt on update too. Embedding stays plaintext-derived.
    const storedContent = this.encryptContent(validated.content);
    const storedMetadata =
      this.crypto?.encryptJsonField(validated.metadata ?? null) ?? (validated.metadata ?? null);
    const params: any[] = [
      validated.kind,
      storedContent,
      storedMetadata === null ? null : JSON.stringify(storedMetadata),
      agentVisible,
      visibility,
    ];
    let nextIdx = params.length + 1;
    if (needsEmbed && vector) {
      setParts.push(`"embedding" = $${nextIdx}::vector`);
      params.push(vectorToLiteral(vector));
      nextIdx++;
    }
    // EOBD.46 review follow-up — recompute contentHash when content
    // changes. Without this, a user edit leaves the hash stale and a
    // future extractor run could skip dedupe and insert a logical
    // duplicate. Only bump the hash when content actually changed (so
    // a metadata-only edit doesn't invalidate the dedupe linkage).
    if (needsEmbed) {
      const newHash = crypto.createHash("sha256").update(validated.content).digest("hex");
      setParts.push(`"contentHash" = $${nextIdx}`);
      params.push(newHash);
      nextIdx++;
    }
    setParts.push(
      `"id" = "id"`, // no-op placeholder to keep trailing comma symmetry off
    );
    setParts.pop();

    const sql = `UPDATE "PlatosMemory"
        SET ${setParts.join(", ")}
      WHERE "id" = $${nextIdx}
        AND "organizationId" = $${nextIdx + 1}
        AND "projectId" = $${nextIdx + 2}
        AND "environmentId" = $${nextIdx + 3}`;
    params.push(id, scope.organizationId, scope.projectId, scope.environmentId);

    await this.prisma.$executeRawUnsafe(sql, ...params);

    return this.get(scope, id);
  }

  /** Fetch a single memory by id, scope-guarded. */
  async get(scope: ScopeTuple, id: string): Promise<MemoryRow | null> {
    this.requireScope(scope);
    const row = await this.prisma.platosMemory.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return row ? toMemoryRow(row, (v) => this.decryptContent(v), (v) => this.crypto?.decryptJsonField(v) ?? v) : null;
  }

  /**
   * Delete a memory row. Returns `true` when a row was removed and
   * `false` when the id didn't match anything in the current scope
   * (silent no-op rather than an exception — the `forget` meta-tool
   * prefers idempotent behaviour).
   */
  async delete(scope: ScopeTuple, id: string): Promise<boolean> {
    this.requireScope(scope);
    const res = await this.prisma.platosMemory.deleteMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return (res?.count ?? 0) > 0;
  }

  /**
   * MCPF-W2 — soft-delete a memory. Sets `archivedAt = now()`. Idempotent:
   * archiving an already-archived row returns `{ ok: false, archivedAt: null }`
   * (the WHERE narrows on `archivedAt: null`). Live read paths
   * (`list` + `semanticSearch`) filter archived rows out by default.
   */
  async archive(
    scope: ScopeTuple,
    id: string,
  ): Promise<{ ok: boolean; archivedAt: string | null }> {
    this.requireScope(scope);
    const now = new Date();
    const res = await this.prisma.platosMemory.updateMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        archivedAt: null,
      },
      data: { archivedAt: now },
    });
    return {
      ok: (res?.count ?? 0) > 0,
      archivedAt: (res?.count ?? 0) > 0 ? now.toISOString() : null,
    };
  }

  /**
   * MCPF-W2 — clear `archivedAt` so the memory is live again. Returns the
   * restored row, or `{ ok: false, memory: null }` when the id wasn't an
   * archived row in this scope. Idempotent for live rows (no-op).
   */
  async restore(
    scope: ScopeTuple,
    id: string,
  ): Promise<{ ok: boolean; memory: MemoryRow | null }> {
    this.requireScope(scope);
    const res = await this.prisma.platosMemory.updateMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        archivedAt: { not: null },
      },
      data: { archivedAt: null },
    });
    if ((res?.count ?? 0) === 0) return { ok: false, memory: null };
    const memory = await this.get(scope, id);
    return { ok: true, memory };
  }

  /**
   * MCPF-W2 — hard-delete up to 100 memories by id in one round-trip. The
   * scope filter is authoritative — cross-scope ids in the list are
   * silently ignored (they'll fail the WHERE). Returns the count of rows
   * actually removed.
   */
  async bulkDelete(
    scope: ScopeTuple,
    ids: string[],
  ): Promise<{ deleted: number }> {
    this.requireScope(scope);
    if (!Array.isArray(ids) || ids.length === 0) return { deleted: 0 };
    if (ids.length > 100) {
      throw new Error("MemoryService.bulkDelete: max 100 memories per request");
    }
    const res = await this.prisma.platosMemory.deleteMany({
      where: {
        id: { in: ids },
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return { deleted: res?.count ?? 0 };
  }

  /**
   * List memories for a user (without embeddings) — used by the editor
   * UI and the `list_memories` meta-tool. Orders by `lastAccessedAt`
   * descending with nulls last, then `createdAt` descending.
   */
  async list(scope: ScopeTuple, input: ListMemoriesInput): Promise<MemoryRow[]> {
    this.requireScope(scope);
    if (!input.userId) throw new Error("MemoryService.list: `userId` is required");
    const limit = clampInt(input.limit ?? 50, 1, 200);
    const offset = clampInt(input.offset ?? 0, 0, 10_000);

    // Raw query so we can use PostgreSQL's NULLS LAST and skip the
    // embedding column (its pgvector type trips Prisma's selector).
    // MCPF-W2 — filter archived rows by default; pass `includeArchived: true`
    // to return them too (admin/editor paths only).
    const includeArchived = input.includeArchived === true;
    const rows: any[] = await this.prisma.$queryRawUnsafe(
      `SELECT
          "id","organizationId","projectId","environmentId","agentId","userId",
          "kind","content","metadata","agentVisible","visibility","source",
          "sourceThreadId","sourceMessageIds","extractorVersion","confidence",
          "createdAt","updatedAt","lastAccessedAt","archivedAt"
       FROM "PlatosMemory"
       WHERE "organizationId" = $1
         AND "projectId" = $2
         AND "environmentId" = $3
         AND "userId" = $4
         ${includeArchived ? "" : `AND "archivedAt" IS NULL`}
         ${input.kind ? `AND "kind" = $5` : ""}
         ${input.agentId !== undefined ? `AND "agentId" ${input.agentId === null ? "IS NULL" : `= $${input.kind ? 6 : 5}`}` : ""}
         ${
           input.agentIds && input.agentIds.length > 0
             ? `AND "agentId" = ANY($${
                 4 +
                 (input.kind ? 1 : 0) +
                 (input.agentId !== undefined && input.agentId !== null ? 1 : 0) +
                 1
               }::text[])`
             : ""
         }
       ORDER BY "lastAccessedAt" DESC NULLS LAST, "createdAt" DESC
       LIMIT ${limit} OFFSET ${offset}`,
      ...buildListArgs(scope, input),
    );
    return rows.map((r: any) =>
      toMemoryRow(r, (v) => this.decryptContent(v), (v) => this.crypto?.decryptJsonField(v) ?? v),
    );
  }

  /**
   * Semantic search. Embeds the query once, then runs a pgvector
   * cosine-distance filter. Returns hits ordered by cosine similarity
   * (highest first) with a `score` in [0, 1].
   */
  async semanticSearch(scope: ScopeTuple, input: SemanticSearchInput): Promise<MemorySearchHit[]> {
    this.requireScope(scope);
    const query = (input.query || "").trim();
    if (!query) throw new Error("MemoryService.semanticSearch: `query` is required");
    if (!input.userId) throw new Error("MemoryService.semanticSearch: `userId` is required");
    const limit = clampInt(input.limit ?? 10, 1, 50);
    const minScore = typeof input.minScore === "number" ? input.minScore : 0;

    const qvec = await this.embeddings.embed(query, scope);
    const vecLit = vectorToLiteral(qvec);

    // Build the filter clause dynamically. Parameters are numbered
    // 1..N; pgvector's `<=>` operator returns cosine distance in
    // [0, 2]; we convert to similarity in [-1, 1] but clamp against
    // 0 since both vectors are OpenAI-normalized (practically [0, 1]).
    const params: any[] = [vecLit, scope.organizationId, scope.projectId, scope.environmentId, input.userId];
    let nextIdx = params.length + 1;
    const wheres: string[] = [
      `"organizationId" = $2`,
      `"projectId" = $3`,
      `"environmentId" = $4`,
      `"userId" = $5`,
      `"embedding" IS NOT NULL`,
    ];
    // MCPF-W2 — filter archived rows out of recall by default. Editor-only
    // paths can pass `includeArchived: true` to see them.
    if (input.includeArchived !== true) {
      wheres.push(`"archivedAt" IS NULL`);
    }
    if (input.kind) {
      params.push(input.kind);
      wheres.push(`"kind" = $${nextIdx++}`);
    }
    if (input.agentId !== undefined) {
      if (input.agentId === null) {
        wheres.push(`"agentId" IS NULL`);
      } else {
        params.push(input.agentId);
        wheres.push(`"agentId" = $${nextIdx++}`);
      }
    }
    if (input.agentIds && input.agentIds.length > 0) {
      params.push(input.agentIds);
      wheres.push(`"agentId" = ANY($${nextIdx++}::text[])`);
    }
    if (input.agentVisibleOnly) {
      wheres.push(`"agentVisible" = TRUE`);
    }

    // Theme O.6 — visibility filter. Default excludes "private" so the agent
    // never surfaces a user-marked-private memory. Callers that need the
    // full set (editor-only paths) pass `visibilityIn` explicitly.
    const visibilityIn: MemoryVisibility[] =
      input.visibilityIn && input.visibilityIn.length > 0
        ? input.visibilityIn
        : ["agent_visible", "hidden"];
    const visPlaceholders = visibilityIn
      .map(() => `$${nextIdx++}`)
      .join(", ");
    for (const v of visibilityIn) params.push(v);
    wheres.push(`"visibility" IN (${visPlaceholders})`);

    const sql = `SELECT
          "id","organizationId","projectId","environmentId","agentId","userId",
          "kind","content","metadata","agentVisible","visibility","source",
          "sourceThreadId","sourceMessageIds","extractorVersion","confidence",
          "createdAt","updatedAt","lastAccessedAt","archivedAt",
          1 - ("embedding" <=> $1::vector) AS score
       FROM "PlatosMemory"
       WHERE ${wheres.join(" AND ")}
       ORDER BY "embedding" <=> $1::vector
       LIMIT ${limit}`;

    const rows: any[] = await this.prisma.$queryRawUnsafe(sql, ...params);
    const hits = rows.map((r) => ({
      ...toMemoryRow(r, (v) => this.decryptContent(v), (v) => this.crypto?.decryptJsonField(v) ?? v),
      score: typeof r.score === "number" ? r.score : Number(r.score) || 0,
    }));
    const filtered = hits.filter((h) => h.score >= minScore);

    // Bump lastAccessedAt for returned rows fire-and-forget; keeps
    // recall-ranking signals up to date without blocking the response.
    if (filtered.length) {
      const ids = filtered.map((h) => h.id);
      this.prisma
        .$executeRawUnsafe(
          `UPDATE "PlatosMemory" SET "lastAccessedAt" = NOW() WHERE "id" = ANY($1::text[])`,
          ids,
        )
        .catch((err: any) =>
          this.logger.warn(`lastAccessedAt bump failed: ${err?.message || err}`),
        );
    }

    return filtered;
  }

  /**
   * PRA-AC: cluster-wide semantic search — omits the agentId filter so
   * all memories for this user across every agent in the cluster are searched.
   * Scope tuple still enforces org/project/env isolation.
   */
  async semanticSearchForCluster(
    scope: ScopeTuple,
    query: string,
    userId: string,
    options?: { limit?: number; minScore?: number; clusteringId?: string | null },
  ): Promise<MemorySearchHit[]> {
    // Cluster share means the cluster's MEMBERS — not every agent in the
    // scope. Resolve the member ids and filter to them; without a
    // clusteringId (legacy callers) fall back to the old scope-wide search.
    let agentIds: string[] | undefined;
    if (options?.clusteringId) {
      const members: Array<{ id: string }> = await this.prisma.platosAgent.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          clusteringId: options.clusteringId,
        },
        select: { id: true },
      });
      agentIds = members.map((m) => m.id);
    }
    return this.semanticSearch(scope, {
      query,
      userId,
      limit: options?.limit ?? 10,
      minScore: options?.minScore,
      ...(agentIds && agentIds.length > 0 ? { agentIds } : {}),
    });
  }

  /**
   * Theme O.9 — delete every memory belonging to a given user in this
   * scope. Used by the "replace" import mode so a bundle can be restored
   * deterministically. Returns the count of rows removed.
   *
   * Scope + userId are both required — there is no cross-scope variant.
   */
  async deleteAllForUser(scope: ScopeTuple, userId: string): Promise<number> {
    this.requireScope(scope);
    if (!userId) throw new Error("MemoryService.deleteAllForUser: `userId` is required");
    const res = await this.prisma.platosMemory.deleteMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId,
      },
    });
    return res?.count ?? 0;
  }

  private requireScope(scope: ScopeTuple): void {
    if (!scope?.organizationId || !scope?.projectId || !scope?.environmentId) {
      throw new Error("MemoryService: scope tuple is required");
    }
  }
}

function toMemoryRow(
  row: any,
  decryptContent?: (v: string | null | undefined) => string,
  decryptJson?: (v: unknown) => unknown,
): MemoryRow {
  // Theme O.6 — derive visibility from the new column when present; fall
  // back to agentVisible for older rows (migration backfills all rows, but
  // keep the coercion so test fixtures without the column still work).
  const rawVisibility: string | undefined =
    typeof row.visibility === "string" ? row.visibility : undefined;
  const visibility: MemoryVisibility =
    rawVisibility === "agent_visible" ||
    rawVisibility === "hidden" ||
    rawVisibility === "private"
      ? rawVisibility
      : row.agentVisible === false
        ? "hidden"
        : "agent_visible";
  // EOBD.22 — transparent decryption on read. Unencrypted rows (no
  // __platos_enc envelope marker) pass through unchanged.
  const content = decryptContent ? decryptContent(row.content) : row.content;
  const metadata = decryptJson
    ? decryptJson(row.metadata ?? null)
    : (row.metadata ?? null);
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    agentId: row.agentId ?? null,
    userId: row.userId,
    kind: row.kind,
    content,
    metadata,
    agentVisible: visibility !== "private" && row.agentVisible !== false,
    visibility,
    source: row.source,
    sourceThreadId: row.sourceThreadId ?? null,
    sourceMessageIds: Array.isArray(row.sourceMessageIds) ? row.sourceMessageIds : [],
    extractorVersion: row.extractorVersion ?? null,
    confidence:
      typeof row.confidence === "number"
        ? row.confidence
        : row.confidence == null
          ? null
          : Number.isFinite(Number(row.confidence))
            ? Number(row.confidence)
            : null,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
    lastAccessedAt: row.lastAccessedAt
      ? row.lastAccessedAt instanceof Date
        ? row.lastAccessedAt
        : new Date(row.lastAccessedAt)
      : null,
    archivedAt: row.archivedAt
      ? row.archivedAt instanceof Date
        ? row.archivedAt
        : new Date(row.archivedAt)
      : null,
  };
}

/**
 * Theme O.6 — resolve visibility from the two possible inputs. Prefer the
 * explicit `visibility` value; fall back to the legacy `agentVisible`
 * boolean (false → `hidden`). Defaults to `agent_visible` when both are
 * unset.
 */
function normalizeVisibility(
  explicit: MemoryVisibility | undefined,
  legacy: boolean | undefined,
): MemoryVisibility {
  if (
    explicit === "agent_visible" ||
    explicit === "hidden" ||
    explicit === "private"
  ) {
    return explicit;
  }
  if (legacy === false) return "hidden";
  return "agent_visible";
}

/** pgvector accepts a string literal like `[0.1,0.2,…]`. Cast to `vector`
 *  in the SQL so Postgres parses it into the fixed-dim column type. */
function vectorToLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function buildListArgs(scope: ScopeTuple, input: ListMemoriesInput): any[] {
  const args: any[] = [scope.organizationId, scope.projectId, scope.environmentId, input.userId];
  if (input.kind) args.push(input.kind);
  if (input.agentId !== undefined && input.agentId !== null) args.push(input.agentId);
  return args;
}

/**
 * Lightweight CUID-ish id generator for raw SQL inserts. We don't pull
 * in the `cuid` package just for this — a timestamp + randomness hybrid
 * is collision-safe in practice and deliberately distinct from Prisma's
 * default-generated ids (which our raw INSERT bypasses).
 */
function createCuid(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  const extra =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `pm_${ts}${rand}${extra}`;
}
