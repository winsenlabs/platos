import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  Inject,
  NotFoundException,
  HttpException,
} from "@nestjs/common";
import {
  MEMORY_ARCHIVE_STATES,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  MEMORY_VISIBILITIES,
  isMemoryArchiveState,
  isMemoryKind,
  isMemorySource,
  isMemoryVisibility,
  type MemoryArchiveState,
} from "@platos/tenancy-database";
import * as crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { WriteStream } from "node:fs";
import type { Request, Response } from "express";
import { MemoryService, type MemoryVisibility, type MemoryKind } from "./memory.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";
import { MemoryImportService } from "./memory-import.service";
import { validateMemoryBundle } from "./memory-bundle";
import { MemoryExtractionService } from "./memory-extraction.service";
import type { RequestScope } from "../auth/scope.guard";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type RedisType from "ioredis";
import { env } from "../shared/env";
import {
  environmentScopeWhere,
  MemoryEndUserContextError,
  resolveEndUser,
  resolveOperatorSelectedEndUser,
  type ResolvedEndUser,
} from "./memory-scope";

/**
 * Theme L.5 – L.8 REST surface. Every handler:
 *   - pulls scope from `ScopeGuard` via `req.scope`;
 *   - delegates to the service layer for all DB / embedding work;
 *   - lets Nest map domain failures to genuine non-2xx HTTP responses.
 *
 * Routes are mounted under `/api/v1/memory` to match the doc spec —
 * keeping them distinct from `/api/v1/agent` so feature flags at the
 * edge can gate the memory API independently.
 */
@Controller(["api/v1/memory", "api/v1/platos/memory"])
export class MemoryController {
  constructor(
    private readonly memoryService: MemoryService,
    private readonly graph: KnowledgeGraphService,
    private readonly memoryImport: MemoryImportService,
    private readonly extraction: MemoryExtractionService,
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Inject(REDIS_TOKEN) private readonly redis: RedisType,
  ) {}

  private getScope(req: Request): RequestScope {
    return (
      (req as any).scope || {
        organizationId: "unknown",
        projectId: "unknown",
        environmentId: "unknown",
        userId: "unknown",
      }
    );
  }

  /**
   * SECURITY (audit H7) — an end-user / entity / guest token must NOT read or
   * write another user's memories by supplying ?userId= or body.userId.
   * Operators may select an active canonical EndUser id in the current
   * Organization; every other principal is FORCED to its verified scope.userId.
   */
  private async effectiveEndUser(
    scope: RequestScope,
    requested?: string | null,
  ): Promise<ResolvedEndUser> {
    const memoryScope = this.scopeTuple(scope);
    if (scope.principal === "operator") {
      return resolveOperatorSelectedEndUser(this.prisma, memoryScope, requested?.trim() ?? "");
    }
    return resolveEndUser(this.prisma, memoryScope, scope.userId);
  }

  private async effectiveUserId(scope: RequestScope, requested?: string | null): Promise<string> {
    return (await this.effectiveEndUser(scope, requested)).externalId;
  }

  private scopeTuple(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      agentId: scope.agentId ?? null,
    };
  }

  private requiresOperatorEndUserContext(
    scope: RequestScope,
    requestedUserId: string | undefined,
    error: unknown,
  ): error is MemoryEndUserContextError {
    return scope.principal === "operator" && !requestedUserId && error instanceof MemoryEndUserContextError;
  }

  private badRequest(error: unknown, fallback: string): never {
    if (error instanceof HttpException) throw error;
    const source = error as { message?: string; code?: string; validationErrors?: unknown };
    throw new BadRequestException({
      code: source?.code || "MEMORY_INVALID_REQUEST",
      message: source?.message || fallback,
      ...(source?.validationErrors
        ? { details: { validationErrors: source.validationErrors } }
        : {}),
    });
  }

  private requireKind(value?: string): MemoryKind | undefined {
    if (!value) return undefined;
    if (isMemoryKind(value)) return value;
    throw new BadRequestException({
      code: "MEMORY_INVALID_KIND",
      message: `kind must be one of ${MEMORY_KINDS.join(", ")}`,
    });
  }

  private requireSource(value?: string) {
    if (!value) return undefined;
    if (isMemorySource(value)) return value;
    throw new BadRequestException({
      code: "MEMORY_INVALID_SOURCE",
      message: `source must be one of ${MEMORY_SOURCES.join(", ")}`,
    });
  }

  private requireArchiveState(value?: string): MemoryArchiveState | undefined {
    if (!value) return undefined;
    if (isMemoryArchiveState(value)) return value;
    throw new BadRequestException({
      code: "MEMORY_INVALID_ARCHIVE_STATE",
      message: `archiveState must be one of ${MEMORY_ARCHIVE_STATES.join(", ")}`,
    });
  }

  private requireVisibilities(value?: string | string[]): MemoryVisibility[] {
    const values = (Array.isArray(value) ? value : value?.split(",") ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!values.length) return [...MEMORY_VISIBILITIES];
    if (values.every(isMemoryVisibility)) return Array.from(new Set(values));
    throw new BadRequestException({
      code: "MEMORY_INVALID_VISIBILITY",
      message: `visibility must contain only ${MEMORY_VISIBILITIES.join(", ")}`,
    });
  }

  // ─── Memories ────────────────────────────────────────────────

  @Post()
  async createMemory(
    @Req() req: Request,
    @Body() body: {
      content: string;
      userId?: string;
      kind?: MemoryKind;
      agentId?: string | null;
      metadata?: unknown;
      agentVisible?: boolean;
      visibility?: MemoryVisibility;
      source?: "manual" | "extracted" | "imported" | "rag";
      sourceThreadId?: string | null;
      sourceTurnIds?: string[];
      sourceMessageIds?: string[];
      extractorVersion?: string | null;
    },
  ) {
    const scope = this.getScope(req);
    try {
      const row = await this.memoryService.add(this.scopeTuple(scope), {
        userId: await this.effectiveUserId(scope, body.userId),
        content: body.content,
        kind: body.kind,
        agentId: body.agentId ?? null,
        metadata: body.metadata,
        agentVisible: body.agentVisible,
        visibility: body.visibility,
        source: this.requireSource(body.source),
        sourceThreadId: body.sourceThreadId ?? null,
        sourceTurnIds: body.sourceTurnIds ?? body.sourceMessageIds,
        extractorVersion: body.extractorVersion ?? null,
      });
      return { memory: row };
    } catch (err: any) {
      this.badRequest(err, "create memory failed");
    }
  }

  /**
   * Theme O.1 / O.7 — kick off a manual extraction for a thread. The
   * body takes a `threadId` and an optional `policyOverride`. Returns
   * the counts so the UI / SDK can surface a live result.
   *
   * Declared ahead of `@Post(":id")` so Express matches this literal
   * path first and doesn't treat "extract" as a memory id.
   */
  @Post("extract")
  async manualExtract(
    @Req() req: Request,
    @Body() body: {
      threadId: string;
      policyOverride?: {
        enabled?: boolean;
        kinds?: MemoryKind[];
        confidenceThreshold?: number;
        maxPerSession?: number;
        minMessagesBeforeRun?: number;
      };
      userId?: string;
    },
  ) {
    const scope = this.getScope(req);
    if (!body?.threadId) {
      throw new BadRequestException({
        code: "MEMORY_THREAD_REQUIRED",
        message: "`threadId` is required",
      });
    }
    try {
      const endUser = await this.effectiveEndUser(scope, body.userId);
      const thread = await this.prisma.thread.findFirst({
        where: {
          id: body.threadId,
          ...environmentScopeWhere(this.scopeTuple(scope)),
          endUserId: endUser.id,
        },
        select: { id: true },
      });
      if (!thread) {
        throw new NotFoundException({
          code: "MEMORY_SOURCE_THREAD_NOT_FOUND",
          message: "source thread not found or access denied",
        });
      }
      const out = await this.extraction.extractFromThread(this.scopeTuple(scope), {
        threadId: body.threadId,
        policyOverride: body.policyOverride,
      });
      return out;
    } catch (err: any) {
      this.badRequest(err, "extraction failed");
    }
  }

  /**
   * Theme O.9 — export every memory + entity + relationship for a user
   * under the current scope as a single JSON bundle. Embeddings are
   * omitted — the importer re-computes them locally.
   */
  @Get("export")
  async exportBundle(
    @Req() req: Request,
    @Res() res: Response,
    @Query("userId") userId?: string,
  ) {
    const scope = this.getScope(req);
    const abort = new AbortController();
    const abortExport = () => abort.abort();
    (req as any).once?.("aborted", abortExport);
    res.once("close", () => {
      if (!(res as any).writableEnded) abortExport();
    });
    let artifactDirectory: string | null = null;
    let artifact: WriteStream | null = null;
    try {
      const uid = await this.effectiveUserId(scope, userId);
      const scopeTuple = this.scopeTuple(scope);
      artifactDirectory = await mkdtemp("/var/tmp/platos-memory-export-");
      const artifactPath = join(artifactDirectory, "bundle.json");
      const artifactWriter = createWriteStream(artifactPath, { encoding: "utf8" });
      artifact = artifactWriter;
      // Materialize incrementally to local storage under one repeatable-read
      // snapshot. Client backpressure is handled only after this transaction
      // closes, so a slow download cannot pin a database snapshot.
      await this.prisma.$transaction(async (tx: any) => {
        await writeChunk(artifactWriter, JSON.stringify({
          version: 2,
          exportedAt: new Date().toISOString(),
          scope: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          userId: uid,
        }).slice(0, -1), abort.signal);
        await writeChunk(artifactWriter, ',"memories":[', abort.signal);
        await streamKeysetCollection(artifactWriter, async (cursor) => {
          const page = await this.memoryService.listExportKeysetPage(
            scopeTuple,
            uid,
            cursor,
            500,
            tx,
          );
          return {
            items: page.items.map((memory) => ({
              id: memory.id,
              kind: memory.kind,
              content: memory.content,
              metadata: memory.metadata,
              visibility: memory.visibility,
              agentVisible: memory.agentVisible,
              source: memory.source,
              sourceThreadId: memory.sourceThreadId,
              sourceTurnIds: memory.sourceTurnIds,
              extractorVersion: memory.extractorVersion,
              originalSource: memory.originalSource,
              originalSourceThreadId: memory.originalSourceThreadId,
              originalSourceTurnIds: memory.originalSourceTurnIds,
              confidence: memory.confidence,
              createdAt: memory.createdAt,
              updatedAt: memory.updatedAt,
              lastAccessedAt: memory.lastAccessedAt,
              quarantinedAt: memory.quarantinedAt,
              archivedAt: memory.archivedAt,
            })),
            nextCursor: page.nextCursor,
          };
        }, abort.signal);
        await writeChunk(artifactWriter, '],"entities":[', abort.signal);
        await streamKeysetCollection(artifactWriter, async (cursor) => {
          const page = await this.graph.getEntitiesExportKeysetPage(scopeTuple, uid, cursor, 500, tx);
          return {
            items: page.items.map((entity) => ({
              id: entity.id,
              entityKey: entity.entityKey,
              entityType: entity.entityType,
              label: entity.label,
              aliases: entity.aliases,
              metadata: entity.metadata,
              createdAt: entity.createdAt,
              updatedAt: entity.updatedAt,
            })),
            nextCursor: page.nextCursor,
          };
        }, abort.signal);
        await writeChunk(artifactWriter, '],"relationships":[', abort.signal);
        await streamKeysetCollection(artifactWriter, async (cursor) => {
          const page = await this.graph.getRelationshipsExportKeysetPage(scopeTuple, uid, cursor, 500, tx);
          return {
            items: page.items.map((relationship) => ({
              id: relationship.id,
              fromEntityId: relationship.fromEntityId,
              toEntityId: relationship.toEntityId,
              fromEntityKey: relationship.fromEntityKey,
              toEntityKey: relationship.toEntityKey,
              relationshipType: relationship.relationshipType,
              weight: relationship.weight,
              metadata: relationship.metadata,
              sourceMemoryId: relationship.sourceMemoryId,
              createdAt: relationship.createdAt,
            })),
            nextCursor: page.nextCursor,
          };
        }, abort.signal);
        await writeChunk(artifactWriter, "]}", abort.signal);
      }, { isolationLevel: "RepeatableRead", timeout: 120_000 });
      artifactWriter.end();
      await finished(artifactWriter);

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="platos-memory-${uid}.json"`,
      );
      for await (const chunk of createReadStream(artifactPath)) {
        await writeChunk(res, chunk, abort.signal);
      }
      res.end();
      return;
    } catch (err: any) {
      if (res.headersSent || abort.signal.aborted) {
        res.destroy(err instanceof Error ? err : new Error("export failed"));
        return;
      }
      res.status(400).json({ error: err?.message || "export failed" });
      return;
    } finally {
      (req as any).off?.("aborted", abortExport);
      if (artifact && !artifact.closed) artifact.destroy();
      if (artifactDirectory) {
        await rm(artifactDirectory, { recursive: true, force: true });
      }
    }
  }

  /**
   * Theme O.9 — import a previously-exported bundle. The importer uses the
   * separately validated operator selection, or the verified scope.userId for
   * non-operators. Any identity inside the untrusted bundle remains ignored.
   *
   * `mode: "replace"` deletes prior memories for the userId before import.
   * `mode: "merge"` (default) appends alongside existing rows.
   */
  @Post("import")
  async importBundle(
    @Req() req: Request,
    @Body() body: {
      version?: number;
      bundle?: {
        memories?: Array<Record<string, unknown>>;
        entities?: Array<Record<string, unknown>>;
        relationships?: Array<Record<string, unknown>>;
      };
      mode?: "merge" | "replace";
      confirmReplace?: boolean;
      userId?: string;
    },
  ) {
    const scope = this.getScope(req);
    const scopeTuple = this.scopeTuple(scope);
    const bundle = body?.bundle;
    if (!bundle || typeof bundle !== "object") {
      throw new BadRequestException({
        code: "MEMORY_IMPORT_BUNDLE_REQUIRED",
        message: "`bundle` is required",
      });
    }
    const mode = body?.mode === "replace" ? "replace" : "merge";
    if (mode === "replace" && body.confirmReplace !== true) {
      throw new BadRequestException({
        code: "MEMORY_IMPORT_REPLACE_CONFIRMATION_REQUIRED",
        message: "replace mode requires explicit destructive confirmation",
      });
    }

    try {
      const userId = await this.effectiveUserId(scope, body.userId);
      // Full structural/canonical validation happens before embeddings are
      // staged and before the replace transaction can delete a single row.
      const validated = validateMemoryBundle(bundle);
      return await this.memoryImport.importBundle(scopeTuple, userId, validated, mode);
    } catch (err: any) {
      this.badRequest(err, "import failed");
    }
  }

  /**
   * Theme M.5 / O.1 — admin cron-sweep endpoint.
   *
   * Called hourly by the `platos.memory.extract` scheduled trigger.dev
   * task. Scans every thread with recent activity (last 90 minutes) +
   * turnCount >= 2 across ALL scopes, then invokes
   * `MemoryExtractionService.extractFromThread` for each. Dedup + idempotency
   * live in the extractor itself (content-hash index from EOBD.46), so a
   * double-fire of the cron can only produce duplicate work, never duplicate
   * memories.
   *
   * Gated by `X-Platos-Internal-Auth` (timing-safe). The endpoint
   * acquires a Redis SET-NX lock (`lock:memory-extraction-cron`,
   * 5-min TTL) and exits early on contention — two trigger.dev
   * workers tick the same cron minute + we don't want both running
   * the sweep in parallel.
   *
   * Rate limits:
   *   - max 500 threads per run (most-recent-first)
   *   - per-thread errors are swallowed + counted, never aborting the run
   *
   * Thrown exceptions are caught by the adapter + surfaced as 500; the
   * task itself treats any non-2xx as a transient error + retries next
   * cron tick.
   */
  @Post("admin/extraction-sweep")
  async adminExtractionSweep(@Req() req: Request) {
    const expected = env.PLATOS_INTERNAL_AUTH_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_INTERNAL_AUTH_TOKEN not set" };
    }
    const provided = req.headers["x-platos-internal-auth"];
    const isValid =
      typeof provided === "string" &&
      provided.length === expected.length &&
      (() => {
        try {
          return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
        } catch {
          return false;
        }
      })();
    if (!isValid) {
      return { status: "forbidden" };
    }

    // Singleton lock — SET NX with 5-minute TTL. The redis client runs
    // with keyPrefix `platos:` so the on-wire key is
    // `platos:lock:memory-extraction-cron`.
    const LOCK_KEY = "lock:memory-extraction-cron";
    const LOCK_TTL_SEC = 300;
    const lockToken = crypto.randomBytes(16).toString("hex");
    let acquired = false;
    try {
      const setRes = await this.redis.set(
        LOCK_KEY,
        lockToken,
        "EX",
        LOCK_TTL_SEC,
        "NX",
      );
      acquired = setRes === "OK";
    } catch {
      // Redis hiccup — skip this tick; the next cron run will retry.
      return { status: "skipped", reason: "redis-lock-unavailable" };
    }
    if (!acquired) {
      return { status: "skipped", reason: "already-running" };
    }

    const startedAt = Date.now();
    const stats = {
      status: "ok" as const,
      threadsScanned: 0,
      threadsExtracted: 0,
      memoriesCreated: 0,
      entitiesCreated: 0,
      relationshipsCreated: 0,
      skipped: 0,
      errors: 0,
      durationMs: 0,
    };

    try {
      // Threshold — last 90 minutes of activity. 90 not 60 so the sweep
      // still picks up threads that updated in the minute between the
      // cron firing + the task actually running.
      const since = new Date(Date.now() - 90 * 60_000);
      const threads: Array<{
        id: string;
        environmentId: string;
        environment: { project: { id: string; organizationId: string } };
      }> = await this.prisma.thread.findMany({
        where: {
          turns: { some: { status: "SUCCEEDED", completedAt: { gte: since } } },
        },
        select: {
          id: true,
          environmentId: true,
          environment: {
            select: { project: { select: { id: true, organizationId: true } } },
          },
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
      });
      stats.threadsScanned = threads.length;

      for (const t of threads) {
        try {
          const out = await this.extraction.extractFromThread(
            {
              organizationId: t.environment.project.organizationId,
              projectId: t.environment.project.id,
              environmentId: t.environmentId,
            },
            { threadId: t.id },
          );
          if (
            out.memoriesCreated > 0 ||
            out.entitiesCreated > 0 ||
            out.relationshipsCreated > 0
          ) {
            stats.threadsExtracted += 1;
          }
          stats.memoriesCreated += out.memoriesCreated;
          stats.entitiesCreated += out.entitiesCreated;
          stats.relationshipsCreated += out.relationshipsCreated;
          stats.skipped += out.skipped;
        } catch (error: any) {
          stats.errors += 1;
          console.error(
            `[memory-extraction] failed for thread ${t.id}: ${error?.message ?? error}`,
          );
        }
      }
    } finally {
      // Release the lock only if we still own it — token-compare so a
      // restart + lock-expired + new-holder scenario doesn't delete the
      // new holder's lock.
      try {
        const held = await this.redis.get(LOCK_KEY);
        if (held === lockToken) {
          await this.redis.del(LOCK_KEY);
        }
      } catch {
        // Best-effort release — TTL cleans up on next tick regardless.
      }
      stats.durationMs = Date.now() - startedAt;
    }

    return stats;
  }

  @Get()
  async listMemories(
    @Req() req: Request,
    @Query("userId") userId?: string,
    @Query("kind") kind?: string,
    @Query("source") source?: string,
    @Query("archiveState") archiveState?: string,
    @Query("visibility") visibility?: string | string[],
    @Query("agentId") agentId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const page = await this.memoryService.listPage(this.scopeTuple(scope), {
        userId: await this.effectiveUserId(scope, userId),
        kind: this.requireKind(kind),
        source: this.requireSource(source),
        archiveState: this.requireArchiveState(archiveState),
        visibilityIn: this.requireVisibilities(visibility),
        agentId: agentId || undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        offset: offset ? Number.parseInt(offset, 10) : undefined,
      });
      return {
        memories: page.items,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        hasNext: page.hasNext,
      };
    } catch (err: any) {
      if (this.requiresOperatorEndUserContext(scope, userId, err)) {
        return { memories: [], total: 0, requiresEndUserContext: true, code: err.code };
      }
      this.badRequest(err, "list memories failed");
    }
  }

  @Get("search")
  async searchMemories(
    @Req() req: Request,
    @Query("q") q: string,
    @Query("userId") userId?: string,
    @Query("kind") kind?: string,
    @Query("source") source?: string,
    @Query("archiveState") archiveState?: string,
    @Query("visibility") visibility?: string | string[],
    @Query("agentId") agentId?: string,
    @Query("limit") limit?: string,
    @Query("minScore") minScore?: string,
  ) {
    const scope = this.getScope(req);
    if (!q) {
      throw new BadRequestException({
        code: "MEMORY_SEARCH_QUERY_REQUIRED",
        message: "`q` query parameter is required",
      });
    }
    try {
      const hits = await this.memoryService.semanticSearch(this.scopeTuple(scope), {
        query: q,
        userId: await this.effectiveUserId(scope, userId),
        kind: this.requireKind(kind),
        source: this.requireSource(source),
        archiveState: this.requireArchiveState(archiveState),
        visibilityIn: this.requireVisibilities(visibility),
        agentId: agentId || undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        minScore: minScore ? Number.parseFloat(minScore) : undefined,
      });
      return { hits, resultCount: hits.length };
    } catch (err: any) {
      if (this.requiresOperatorEndUserContext(scope, userId, err)) {
        return { hits: [], requiresEndUserContext: true, code: err.code };
      }
      this.badRequest(err, "search failed");
    }
  }

  @Delete(":id")
  async deleteMemory(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("userId") userId?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const deleted = await this.memoryService.delete(
        this.scopeTuple(scope),
        id,
        await this.effectiveUserId(scope, userId),
      );
      if (!deleted) {
        throw new NotFoundException({ code: "MEMORY_NOT_FOUND", message: "memory not found" });
      }
      return { deleted: true };
    } catch (err: any) {
      this.badRequest(err, "delete failed");
    }
  }

  // ─── Knowledge graph ─────────────────────────────────────────

  @Get("graph/entities")
  async listEntities(
    @Req() req: Request,
    @Query("userId") userId?: string,
    @Query("entityType") entityType?: string,
    @Query("q") query?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const page = await this.graph.getEntitiesPage(this.scopeTuple(scope), {
        userId: await this.effectiveUserId(scope, userId),
        entityType: entityType || undefined,
        query: query || undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        offset: offset ? Number.parseInt(offset, 10) : undefined,
      });
      return {
        entities: page.items,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        hasNext: page.hasNext,
      };
    } catch (err: any) {
      if (this.requiresOperatorEndUserContext(scope, userId, err)) {
        return { entities: [], total: 0, requiresEndUserContext: true, code: err.code };
      }
      this.badRequest(err, "list entities failed");
    }
  }

  @Get("graph/entities/:id/relationships")
  async getRelationships(
    @Req() req: Request,
    @Param("id") id: string,
    @Query("userId") userId?: string,
  ) {
    const scope = this.getScope(req);
    try {
      // SECURITY (audit H9) — non-operators stay forced to scope.userId;
      // operators must provide a separately validated canonical EndUser id.
      const effectiveUserId = await this.effectiveUserId(scope, userId);
      const entity = await this.graph.resolveEntityReference(this.scopeTuple(scope), effectiveUserId, id);
      const res = entity && await this.graph.getRelationships(
        this.scopeTuple(scope),
        { entityId: entity.id },
        effectiveUserId,
      );
      if (!res) {
        throw new NotFoundException({ code: "MEMORY_ENTITY_NOT_FOUND", message: "entity not found" });
      }
      return res;
    } catch (err: any) {
      this.badRequest(err, "relationships failed");
    }
  }

  @Get("graph/path")
  async getShortestPath(
    @Req() req: Request,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("userId") userId?: string,
    @Query("maxHops") maxHops?: string,
  ) {
    const scope = this.getScope(req);
    if (!from || !to) {
      throw new BadRequestException({
        code: "MEMORY_GRAPH_PATH_ENDPOINTS_REQUIRED",
        message: "`from` and `to` query params are required",
      });
    }
    try {
      const effectiveUserId = await this.effectiveUserId(scope, userId);
      const [fromEntity, toEntity] = await Promise.all([
        this.graph.resolveEntityReference(this.scopeTuple(scope), effectiveUserId, from),
        this.graph.resolveEntityReference(this.scopeTuple(scope), effectiveUserId, to),
      ]);
      if (!fromEntity || !toEntity) {
        throw new NotFoundException({ code: "MEMORY_ENTITY_NOT_FOUND", message: "entity not found" });
      }
      const path = await this.graph.shortestPath(this.scopeTuple(scope), {
        fromEntityId: fromEntity.id,
        toEntityId: toEntity.id,
        userId: effectiveUserId,
        maxHops: maxHops ? Number.parseInt(maxHops, 10) : undefined,
      });
      return { path };
    } catch (err: any) {
      this.badRequest(err, "shortest path failed");
    }
  }

  @Post("relate")
  async relate(
    @Req() req: Request,
    @Body() body: {
      fromEntityKey: string;
      toEntityKey: string;
      relationshipType: string;
      userId?: string;
      fromEntityType?: string;
      fromLabel?: string;
      toEntityType?: string;
      toLabel?: string;
      weight?: number;
      metadata?: unknown;
      sourceMemoryId?: string | null;
    },
  ) {
    const scope = this.getScope(req);
    if (!body?.fromEntityKey || !body?.toEntityKey || !body?.relationshipType) {
      throw new BadRequestException({
        code: "MEMORY_RELATIONSHIP_FIELDS_REQUIRED",
        message: "`fromEntityKey`, `toEntityKey`, and `relationshipType` are required",
      });
    }
    try {
      const scopeTuple = this.scopeTuple(scope);
      const userId = await this.effectiveUserId(scope, body.userId);
      const [from, to] = await Promise.all([
        this.graph.upsertEntity(scopeTuple, {
          userId,
          agentId: scope.agentId ?? null,
          entityKey: body.fromEntityKey,
          entityType: body.fromEntityType || "other",
          label: body.fromLabel || body.fromEntityKey,
        }),
        this.graph.upsertEntity(scopeTuple, {
          userId,
          agentId: scope.agentId ?? null,
          entityKey: body.toEntityKey,
          entityType: body.toEntityType || "other",
          label: body.toLabel || body.toEntityKey,
        }),
      ]);
      const rel = await this.graph.createRelationship(scopeTuple, {
        userId,
        agentId: scope.agentId ?? null,
        fromEntityId: from.id,
        toEntityId: to.id,
        relationshipType: body.relationshipType,
        weight: body.weight ?? null,
        metadata: body.metadata,
        sourceMemoryId: body.sourceMemoryId ?? null,
      });
      return {
        relationshipId: rel.id,
        fromEntityId: from.id,
        toEntityId: to.id,
      };
    } catch (err: any) {
      this.badRequest(err, "relate failed");
    }
  }

  @Post(":id/archive")
  async archiveMemory(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { userId?: string },
  ) {
    const scope = this.getScope(req);
    try {
      const result = await this.memoryService.archive(
        this.scopeTuple(scope),
        id,
        await this.effectiveUserId(scope, body.userId),
      );
      if (!result.ok) {
        throw new NotFoundException({ code: "MEMORY_NOT_FOUND", message: "memory not found" });
      }
      return result;
    } catch (error) {
      this.badRequest(error, "archive failed");
    }
  }

  @Post(":id/restore")
  async restoreMemory(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: { userId?: string },
  ) {
    const scope = this.getScope(req);
    try {
      const result = await this.memoryService.restore(
        this.scopeTuple(scope),
        id,
        await this.effectiveUserId(scope, body.userId),
      );
      if (!result.ok) {
        throw new NotFoundException({ code: "MEMORY_NOT_FOUND", message: "memory not found" });
      }
      return result;
    } catch (error) {
      this.badRequest(error, "restore failed");
    }
  }

  /**
   * Theme O.7 — patch/update memory. POST rather than PATCH so browser
   * HTML forms can call this directly without a custom method override.
   *
   * This parameterized route must be declared after the literal POST routes
   * above. Express registers controller methods in declaration order; placing
   * it first makes `/memory/relate` dispatch here instead of to `relate`.
   */
  @Post(":id")
  async updateMemory(
    @Req() req: Request,
    @Param("id") id: string,
    @Body() body: {
      content?: string;
      kind?: MemoryKind;
      metadata?: unknown;
      agentVisible?: boolean;
      visibility?: MemoryVisibility;
      userId?: string;
    },
  ) {
    const scope = this.getScope(req);
    // Defense-in-depth — even if route-order regressed, the literal path
    // segments can never be a valid UUID memory id so reject them here.
    if (
      id === "extract" ||
      id === "import" ||
      id === "relate" ||
      id === "search" ||
      id === "export" ||
      id === "admin"
    ) {
      throw new BadRequestException({
        code: "MEMORY_RESERVED_PATH",
        message: `'${id}' is a reserved path segment`,
      });
    }
    try {
      const row = await this.memoryService.update(this.scopeTuple(scope), id, {
        content: body.content,
        kind: body.kind,
        metadata: body.metadata,
        agentVisible: body.agentVisible,
        visibility: body.visibility,
      }, await this.effectiveUserId(scope, body.userId));
      if (!row) {
        throw new NotFoundException({ code: "MEMORY_NOT_FOUND", message: "memory not found" });
      }
      return { memory: row };
    } catch (err: any) {
      this.badRequest(err, "update memory failed");
    }
  }
}

type ChunkWriter = Pick<NodeJS.WritableStream, "write" | "once" | "off">;

async function writeChunk(
  writer: ChunkWriter,
  chunk: string | Buffer,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("export cancelled");
  if (writer.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      writer.off("drain", onDrain);
      writer.off("error", onError);
      writer.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("export response closed before drain")); };
    const onAbort = () => { cleanup(); reject(new Error("export cancelled")); };
    writer.once("drain", onDrain);
    writer.once("error", onError);
    writer.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function streamKeysetCollection(
  writer: ChunkWriter,
  page: (cursor: string | null) => Promise<{
    items: unknown[];
    nextCursor: string | null;
  }>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor: string | null = null;
  let first = true;
  for (;;) {
    if (signal?.aborted) throw new Error("export cancelled");
    const current = await page(cursor);
    for (const item of current.items) {
      await writeChunk(writer, `${first ? "" : ","}${JSON.stringify(item)}`, signal);
      first = false;
    }
    if (!current.nextCursor || current.items.length === 0) return;
    if (current.nextCursor === cursor) {
      throw new Error("export keyset cursor did not advance");
    }
    cursor = current.nextCursor;
  }
}
