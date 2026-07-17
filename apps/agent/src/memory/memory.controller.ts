import {
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
} from "@nestjs/common";
import * as crypto from "node:crypto";
import type { Request, Response } from "express";
import { MemoryService, type MemoryVisibility, type MemoryKind } from "./memory.service";
import { KnowledgeGraphService } from "./knowledge-graph.service";
import { MemoryExtractionService } from "./memory-extraction.service";
import type { RequestScope } from "../auth/scope.guard";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { REDIS_TOKEN } from "../shared/redis.provider";
import type RedisType from "ioredis";
import { env } from "../shared/env";

/**
 * Theme L.5 – L.8 REST surface. Every handler:
 *   - pulls scope from `ScopeGuard` via `req.scope`;
 *   - delegates to the service layer for all DB / embedding work;
 *   - returns JSON shaped like `{ data?, error?, status? }`.
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
   * Operators (the dashboard, via the internal path or a platform token) may
   * target any user; every other principal is FORCED to its own userId.
   */
  private effectiveUserId(scope: RequestScope, requested?: string | null): string {
    return scope.principal === "operator" ? (requested || scope.userId) : scope.userId;
  }

  private scopeTuple(scope: RequestScope) {
    return {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
    };
  }

  // ─── Memories ────────────────────────────────────────────────

  @Post()
  async createMemory(
    @Req() req: Request,
    @Body() body: {
      content: string;
      userId?: string;
      kind?: "fact" | "preference" | "event" | "relationship";
      agentId?: string | null;
      metadata?: unknown;
      agentVisible?: boolean;
      visibility?: MemoryVisibility;
      source?: "manual" | "extracted" | "imported";
      sourceThreadId?: string | null;
      sourceMessageIds?: string[];
      extractorVersion?: string | null;
    },
  ) {
    const scope = this.getScope(req);
    try {
      const row = await this.memoryService.add(this.scopeTuple(scope), {
        userId: this.effectiveUserId(scope, body.userId),
        content: body.content,
        kind: body.kind,
        agentId: body.agentId ?? null,
        metadata: body.metadata,
        agentVisible: body.agentVisible,
        visibility: body.visibility,
        source: body.source,
        sourceThreadId: body.sourceThreadId ?? null,
        sourceMessageIds: body.sourceMessageIds,
        extractorVersion: body.extractorVersion ?? null,
      });
      return { memory: row };
    } catch (err: any) {
      return {
        error: err?.message || "create memory failed",
        status: (err as any)?.status ?? 400,
        validationErrors: (err as any)?.validationErrors,
      };
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
    },
  ) {
    const scope = this.getScope(req);
    if (!body?.threadId) return { error: "`threadId` is required", status: 400 };
    try {
      const out = await this.extraction.extractFromThread(this.scopeTuple(scope), {
        threadId: body.threadId,
        policyOverride: body.policyOverride,
      });
      return out;
    } catch (err: any) {
      return { error: err?.message || "extraction failed", status: 400 };
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
    const uid = this.effectiveUserId(scope, userId);
    try {
      const scopeTuple = this.scopeTuple(scope);
      // MCPF-W2 — DSAR must include archived rows. Soft-deleted memories
      // are still the user's data; excluding them would silently violate
      // GDPR's right-of-access guarantee.
      const memories = await this.memoryService.list(scopeTuple, {
        userId: uid,
        limit: 10_000,
        includeArchived: true,
      });
      const entities = await this.graph.getEntities(scopeTuple, {
        userId: uid,
        limit: 500,
      });
      const entityIds = new Set(entities.map((e) => e.id));
      const relationships: Array<Record<string, unknown>> = [];
      // Pull relationships per-entity to stay inside the scope-gated API.
      for (const e of entities) {
        const details = await this.graph.getRelationships(scopeTuple, { entityId: e.id }, uid);
        if (!details) continue;
        for (const out of details.outbound) {
          if (!entityIds.has(out.to.id)) continue;
          relationships.push({
            fromEntityKey: e.entityKey,
            toEntityKey: out.to.entityKey,
            relationshipType: out.relationship.relationshipType,
            weight: out.relationship.weight,
            metadata: out.relationship.metadata,
            sourceMemoryId: out.relationship.sourceMemoryId,
            createdAt: out.relationship.createdAt,
          });
        }
      }
      const bundle = {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        scope: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        userId: uid,
        memories: memories.map((m) => ({
          kind: m.kind,
          content: m.content,
          metadata: m.metadata,
          visibility: m.visibility,
          agentVisible: m.agentVisible,
          source: m.source,
          sourceThreadId: m.sourceThreadId,
          sourceMessageIds: m.sourceMessageIds,
          extractorVersion: m.extractorVersion,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        })),
        entities: entities.map((e) => ({
          entityKey: e.entityKey,
          entityType: e.entityType,
          label: e.label,
          aliases: e.aliases,
          metadata: e.metadata,
        })),
        relationships,
      };
      // Stream as chunked JSON so huge exports don't balloon memory on one side.
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="platos-memory-${uid}.json"`,
      );
      res.write(JSON.stringify(bundle));
      res.end();
      return;
    } catch (err: any) {
      res.status(400).json({ error: err?.message || "export failed" });
      return;
    }
  }

  /**
   * Theme O.9 — import a previously-exported bundle. The importer ALWAYS
   * uses the current request's scope + userId (from the scope header).
   * The `userId` in the bundle body is deliberately ignored so a bundle
   * from user A can't be restored into user B's scope — preserves the
   * (org, project, env, userId) invariant.
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
    },
  ) {
    const scope = this.getScope(req);
    const scopeTuple = this.scopeTuple(scope);
    const userId = scope.userId;
    if (!userId) return { error: "request scope is missing userId", status: 400 };
    const bundle = body?.bundle;
    if (!bundle || typeof bundle !== "object") {
      return { error: "`bundle` is required", status: 400 };
    }
    const mode = body?.mode === "replace" ? "replace" : "merge";

    const counts = { memoriesDeleted: 0, memoriesImported: 0, entitiesImported: 0, relationshipsImported: 0, skipped: 0 };
    try {
      if (mode === "replace") {
        counts.memoriesDeleted = await this.memoryService.deleteAllForUser(scopeTuple, userId);
      }

      // Entities first — we need their ids to translate relationship keys to ids.
      const keyToId = new Map<string, string>();
      for (const e of bundle.entities ?? []) {
        const key = String((e as any).entityKey || "").trim();
        if (!key) {
          counts.skipped += 1;
          continue;
        }
        const ent = await this.graph.upsertEntity(scopeTuple, {
          userId,
          agentId: scope.agentId ?? null,
          entityKey: key,
          entityType: String((e as any).entityType || "other"),
          label: String((e as any).label || key),
          aliases: Array.isArray((e as any).aliases) ? (e as any).aliases : [],
          metadata: (e as any).metadata,
        });
        keyToId.set(key, ent.id);
        counts.entitiesImported += 1;
      }

      for (const m of bundle.memories ?? []) {
        try {
          await this.memoryService.add(scopeTuple, {
            userId,
            // FIX (audit L5) — stamp the acting agentId instead of writing
            // agentId=NULL for every imported row (cross-agent visibility
            // asymmetry vs extractor-written rows). Sourced from the VERIFIED
            // request scope, never from the untrusted bundle. Null when the
            // token isn't agent-pinned — unchanged from before for that case.
            agentId: scope.agentId ?? null,
            kind: (m as any).kind as MemoryKind,
            content: String((m as any).content || ""),
            metadata: (m as any).metadata,
            visibility: (m as any).visibility as MemoryVisibility | undefined,
            agentVisible: typeof (m as any).agentVisible === "boolean" ? (m as any).agentVisible : undefined,
            source: "imported",
            sourceThreadId: (m as any).sourceThreadId ?? null,
            sourceMessageIds: Array.isArray((m as any).sourceMessageIds)
              ? (m as any).sourceMessageIds
              : [],
            extractorVersion: (m as any).extractorVersion ?? null,
          });
          counts.memoriesImported += 1;
        } catch {
          counts.skipped += 1;
        }
      }

      for (const r of bundle.relationships ?? []) {
        const fromKey = String((r as any).fromEntityKey || "").trim();
        const toKey = String((r as any).toEntityKey || "").trim();
        const relType = String((r as any).relationshipType || "").trim();
        if (!fromKey || !toKey || !relType) {
          counts.skipped += 1;
          continue;
        }
        const fromId = keyToId.get(fromKey);
        const toId = keyToId.get(toKey);
        if (!fromId || !toId) {
          counts.skipped += 1;
          continue;
        }
        try {
          await this.graph.createRelationship(scopeTuple, {
            userId,
            agentId: scope.agentId ?? null,
            fromEntityId: fromId,
            toEntityId: toId,
            relationshipType: relType,
            weight: typeof (r as any).weight === "number" ? (r as any).weight : null,
            metadata: (r as any).metadata,
          });
          counts.relationshipsImported += 1;
        } catch {
          counts.skipped += 1;
        }
      }

      return { ok: true, mode, ...counts };
    } catch (err: any) {
      return { error: err?.message || "import failed", status: 400 };
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
   * Gated by `X-Platos-Admin-Token` (timing-safe). The endpoint
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
    const expected = env.PLATOS_ADMIN_TOKEN;
    if (!expected) {
      return { status: "skipped", reason: "PLATOS_ADMIN_TOKEN not set" };
    }
    const provided = req.headers["x-platos-admin-token"];
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
        organizationId: string;
        projectId: string;
        environmentId: string;
      }> = await this.prisma.platosAgentThread.findMany({
        where: {
          updatedAt: { gte: since },
          turnCount: { gte: 2 },
          // We scan userId !== null downstream in the extractor; threads
          // without a user return cheap reason=thread-has-no-user.
        },
        select: {
          id: true,
          organizationId: true,
          projectId: true,
          environmentId: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
      });
      stats.threadsScanned = threads.length;

      for (const t of threads) {
        try {
          const out = await this.extraction.extractFromThread(
            {
              organizationId: t.organizationId,
              projectId: t.projectId,
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
        } catch {
          stats.errors += 1;
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

  /**
   * Theme O.7 — patch/update memory. POST rather than PATCH so browser
   * HTML forms can call this directly without a custom method override.
   *
   * Declared AFTER the literal POST routes above so Express matches
   * those specific paths first ("extract", "import", "relate") and only
   * falls through to this one when the id slot carries something else.
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
    },
  ) {
    const scope = this.getScope(req);
    // Defense-in-depth — even if route-order regressed, the literal path
    // segments can never be a valid cuid id so reject them here.
    if (
      id === "extract" ||
      id === "import" ||
      id === "relate" ||
      id === "search" ||
      id === "export" ||
      id === "admin"
    ) {
      return { error: `'${id}' is a reserved path segment`, status: 400 };
    }
    try {
      const row = await this.memoryService.update(this.scopeTuple(scope), id, {
        content: body.content,
        kind: body.kind,
        metadata: body.metadata,
        agentVisible: body.agentVisible,
        visibility: body.visibility,
      }, this.effectiveUserId(scope));
      if (!row) return { error: "memory not found", status: 404 };
      return { memory: row };
    } catch (err: any) {
      return {
        error: err?.message || "update memory failed",
        status: (err as any)?.status ?? 400,
        validationErrors: (err as any)?.validationErrors,
      };
    }
  }

  @Get()
  async listMemories(
    @Req() req: Request,
    @Query("userId") userId?: string,
    @Query("kind") kind?: string,
    @Query("agentId") agentId?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const rows = await this.memoryService.list(this.scopeTuple(scope), {
        userId: this.effectiveUserId(scope, userId),
        kind: kind || undefined,
        agentId: agentId || undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        offset: offset ? Number.parseInt(offset, 10) : undefined,
      });
      return { memories: rows, total: rows.length };
    } catch (err: any) {
      return { error: err?.message || "list memories failed", status: 400 };
    }
  }

  @Get("search")
  async searchMemories(
    @Req() req: Request,
    @Query("q") q: string,
    @Query("userId") userId?: string,
    @Query("kind") kind?: string,
    @Query("agentId") agentId?: string,
    @Query("limit") limit?: string,
    @Query("minScore") minScore?: string,
  ) {
    const scope = this.getScope(req);
    if (!q) return { error: "`q` query parameter is required", status: 400 };
    try {
      const hits = await this.memoryService.semanticSearch(this.scopeTuple(scope), {
        query: q,
        userId: this.effectiveUserId(scope, userId),
        kind: kind || undefined,
        agentId: agentId || undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        minScore: minScore ? Number.parseFloat(minScore) : undefined,
      });
      return { hits };
    } catch (err: any) {
      return { error: err?.message || "search failed", status: 400 };
    }
  }

  @Delete(":id")
  async deleteMemory(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    try {
      const deleted = await this.memoryService.delete(this.scopeTuple(scope), id, this.effectiveUserId(scope));
      return { deleted };
    } catch (err: any) {
      return { error: err?.message || "delete failed", status: 400 };
    }
  }

  // ─── Knowledge graph ─────────────────────────────────────────

  @Get("graph/entities")
  async listEntities(
    @Req() req: Request,
    @Query("userId") userId?: string,
    @Query("entityType") entityType?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    const scope = this.getScope(req);
    try {
      const rows = await this.graph.getEntities(this.scopeTuple(scope), {
        userId: this.effectiveUserId(scope, userId),
        entityType: entityType || undefined,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        offset: offset ? Number.parseInt(offset, 10) : undefined,
      });
      return { entities: rows, total: rows.length };
    } catch (err: any) {
      return { error: err?.message || "list entities failed", status: 400 };
    }
  }

  @Get("graph/entities/:id/relationships")
  async getRelationships(@Req() req: Request, @Param("id") id: string) {
    const scope = this.getScope(req);
    try {
      // SECURITY (audit H9) — force the caller's own userId so a session token
      // can't walk another user's KG neighborhood by entity id.
      const res = await this.graph.getRelationships(this.scopeTuple(scope), { entityId: id }, this.effectiveUserId(scope));
      if (!res) return { error: "entity not found", status: 404 };
      return res;
    } catch (err: any) {
      return { error: err?.message || "relationships failed", status: 400 };
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
      return { error: "`from` and `to` query params are required", status: 400 };
    }
    try {
      const path = await this.graph.shortestPath(this.scopeTuple(scope), {
        fromEntityId: from,
        toEntityId: to,
        userId: this.effectiveUserId(scope, userId),
        maxHops: maxHops ? Number.parseInt(maxHops, 10) : undefined,
      });
      return { path };
    } catch (err: any) {
      return { error: err?.message || "shortest path failed", status: 400 };
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
      return {
        error: "`fromEntityKey`, `toEntityKey`, and `relationshipType` are required",
        status: 400,
      };
    }
    const scopeTuple = this.scopeTuple(scope);
    const userId = this.effectiveUserId(scope, body.userId);
    try {
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
      return { error: err?.message || "relate failed", status: 400 };
    }
  }
}
