import { Injectable, Inject, Logger } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { ScopeTuple } from "./memory.service";

export interface EntityRow {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
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
  /** The relationship traversed to arrive at this entity. `null` for
   *  the start node (first hop) where no edge is traversed. */
  relationship: RelationshipRow | null;
  /** Direction the edge was traversed — "out" means the edge points
   *  from the previous node to this one; "in" means the opposite. */
  direction: "out" | "in" | null;
}

export interface ShortestPathInput {
  fromEntityId: string;
  toEntityId: string;
  userId: string;
  maxHops?: number;
}

export interface UpsertEntityInput {
  userId: string;
  /// L6 — acting agent (null for operator/non-agent-pinned callers). Stamped
  /// on CREATE only; entities are shared per (scope,userId,entityKey) so an
  /// existing node keeps its first-writer agentId.
  agentId?: string | null;
  entityKey: string;
  entityType?: string;
  label?: string;
  aliases?: string[];
  metadata?: unknown;
}

/**
 * Theme L.7 / L.8 — knowledge-graph query + mutation primitives.
 *
 * The graph is scoped like every other Platos surface: every read +
 * write filters on `(organizationId, projectId, environmentId,
 * userId)`. BFS is capped at `maxHops = 4` by default; callers may
 * raise but the upper bound is 6 to keep worst-case edge scans
 * bounded (per-node branching ≤ relationship count).
 */
import { Optional } from "@nestjs/common";
import { MessageCryptoService } from "../monitoring/message-crypto.service";

@Injectable()
export class KnowledgeGraphService {
  private readonly logger = new Logger(KnowledgeGraphService.name);
  private static readonly DEFAULT_MAX_HOPS = 4;
  private static readonly HARD_MAX_HOPS = 6;

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {}

  /** EOBD.22 — envelope-stringify for String columns carrying PII. */
  private encString(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (!this.crypto) return v;
    const wrapped = this.crypto.encryptJsonField(v);
    if (wrapped && typeof wrapped === "object" && (wrapped as any).__platos_enc === 1) {
      return JSON.stringify(wrapped);
    }
    return v;
  }

  private decString(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (!this.crypto) return v;
    if (!v.startsWith("{\"__platos_enc\"")) return v;
    try {
      const plain = this.crypto.decryptJsonField(JSON.parse(v));
      return typeof plain === "string" ? plain : v;
    } catch {
      return v;
    }
  }

  /** List entities for a user. Newest first. */
  async getEntities(
    scope: ScopeTuple,
    input: { userId: string; entityType?: string; limit?: number; offset?: number },
  ): Promise<EntityRow[]> {
    this.requireScope(scope);
    if (!input.userId) throw new Error("KnowledgeGraphService.getEntities: `userId` is required");
    const limit = clampInt(input.limit ?? 100, 1, 500);
    const offset = clampInt(input.offset ?? 0, 0, 10_000);
    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      userId: input.userId,
    };
    if (input.entityType) where.entityType = input.entityType;
    const rows = await this.prisma.platosMemoryEntity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
    return rows.map((r: any) =>
      toEntityRow(r, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v),
    );
  }

  /**
   * Upsert an entity by `entityKey`. Used by the `relate` meta-tool so
   * repeated calls with the same slug are idempotent — the second
   * invocation updates the label/aliases/metadata if supplied, but
   * keeps the id stable so relationships stay connected.
   */
  async upsertEntity(scope: ScopeTuple, input: UpsertEntityInput): Promise<EntityRow> {
    this.requireScope(scope);
    if (!input.userId) throw new Error("KnowledgeGraphService.upsertEntity: `userId` is required");
    if (!input.entityKey) throw new Error("KnowledgeGraphService.upsertEntity: `entityKey` is required");

    const row = await this.prisma.platosMemoryEntity.upsert({
      where: {
        organizationId_projectId_environmentId_userId_entityKey: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: input.userId,
          entityKey: input.entityKey,
        },
      },
      create: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: input.userId,
        agentId: input.agentId ?? null,
        entityKey: input.entityKey,
        entityType: input.entityType || "other",
        // EOBD.22 — encrypt label + metadata at rest (label is typically
        // a full user/entity name; metadata is freeform PII). Aliases
        // left plaintext for this wave (low-risk display strings, short
        // array) — tracked as follow-up.
        label: this.encString(input.label || input.entityKey) ?? input.entityKey,
        aliases: input.aliases ?? [],
        metadata: (this.crypto?.encryptJsonField(input.metadata ?? null) ??
          input.metadata ??
          undefined) as any,
      },
      update: {
        ...(input.entityType ? { entityType: input.entityType } : {}),
        ...(input.label ? { label: this.encString(input.label) ?? input.label } : {}),
        ...(input.aliases ? { aliases: input.aliases } : {}),
        ...(input.metadata !== undefined
          ? {
              metadata: (this.crypto?.encryptJsonField(input.metadata) ??
                (input.metadata as any)) as any,
            }
          : {}),
      },
    });
    return toEntityRow(row, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v);
  }

  async getEntityById(scope: ScopeTuple, id: string, userId?: string): Promise<EntityRow | null> {
    this.requireScope(scope);
    // SECURITY (audit H9) — when a userId is supplied, gate the entity to that
    // user (KG entities carry userId). The session-token REST path passes
    // scope.userId so it can't read another user's entity by id; operator MCP
    // tools omit it (scope-only, operator-trusted).
    const row = await this.prisma.platosMemoryEntity.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        ...(userId ? { userId } : {}),
      },
    });
    return row ? toEntityRow(row, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v) : null;
  }

  /**
   * Return both inbound and outbound relationships for a given entity
   * id, each joined with the counterpart entity row so the caller
   * doesn't have to follow up with per-id lookups.
   */
  async getRelationships(
    scope: ScopeTuple,
    input: { entityId: string },
    userId?: string,
  ): Promise<EntityRelationships | null> {
    this.requireScope(scope);
    // SECURITY (audit H9) — gate the root entity by userId (the getEntityById
    // call returns null for a foreign entity), and filter the relationship
    // rows by userId too when supplied.
    const entity = await this.getEntityById(scope, input.entityId, userId);
    if (!entity) return null;

    const [outRows, inRows] = await Promise.all([
      this.prisma.platosMemoryRelationship.findMany({
        where: {
          fromEntityId: input.entityId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          ...(userId ? { userId } : {}),
        },
        include: { toEntity: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      this.prisma.platosMemoryRelationship.findMany({
        where: {
          toEntityId: input.entityId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          ...(userId ? { userId } : {}),
        },
        include: { fromEntity: true },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
    ]);

    return {
      entity,
      outbound: outRows.map((r: any) => ({
        relationship: toRelationshipRow(r),
        to: toEntityRow(r.toEntity, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v),
      })),
      inbound: inRows.map((r: any) => ({
        relationship: toRelationshipRow(r),
        from: toEntityRow(r.fromEntity, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v),
      })),
    };
  }

  /**
   * BFS shortest-path between two entities. Treats relationships as
   * undirected for path-finding but the returned hop list carries the
   * traversal direction so callers can reconstruct the edge. Returns
   * `null` when no path exists within `maxHops`.
   */
  async shortestPath(scope: ScopeTuple, input: ShortestPathInput): Promise<ShortestPathHop[] | null> {
    this.requireScope(scope);
    if (!input.userId) throw new Error("KnowledgeGraphService.shortestPath: `userId` is required");
    if (input.fromEntityId === input.toEntityId) {
      const entity = await this.getEntityById(scope, input.fromEntityId);
      if (!entity) return null;
      return [{ entity, relationship: null, direction: null }];
    }

    const maxHops = clampInt(
      input.maxHops ?? KnowledgeGraphService.DEFAULT_MAX_HOPS,
      1,
      KnowledgeGraphService.HARD_MAX_HOPS,
    );

    // Frontier BFS — at depth d we know every node reachable in d hops.
    // For each node we remember the previous node + the relationship
    // row used, so a final backtrace produces the hop list.
    interface Trace {
      prev: string | null;
      relationship: RelationshipRow | null;
      direction: "out" | "in" | null;
    }
    const visited = new Map<string, Trace>();
    visited.set(input.fromEntityId, { prev: null, relationship: null, direction: null });

    let frontier: string[] = [input.fromEntityId];
    for (let depth = 0; depth < maxHops && frontier.length > 0; depth++) {
      // Pull every outgoing + incoming edge from the current frontier
      // in one round-trip. Scope filter is mandatory.
      const edges: any[] = await this.prisma.platosMemoryRelationship.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          userId: input.userId,
          OR: [{ fromEntityId: { in: frontier } }, { toEntityId: { in: frontier } }],
        },
      });

      const nextFrontier: string[] = [];
      for (const edge of edges) {
        const [prev, neighbour, direction]: [string, string, "out" | "in"] =
          frontier.includes(edge.fromEntityId)
            ? [edge.fromEntityId, edge.toEntityId, "out"]
            : [edge.toEntityId, edge.fromEntityId, "in"];
        if (visited.has(neighbour)) continue;
        visited.set(neighbour, {
          prev,
          relationship: toRelationshipRow(edge),
          direction,
        });
        if (neighbour === input.toEntityId) {
          return this.backtrace(scope, visited, input.fromEntityId, input.toEntityId);
        }
        nextFrontier.push(neighbour);
      }
      frontier = nextFrontier;
    }

    return null;
  }

  private async backtrace(
    scope: ScopeTuple,
    visited: Map<string, { prev: string | null; relationship: RelationshipRow | null; direction: "out" | "in" | null }>,
    from: string,
    to: string,
  ): Promise<ShortestPathHop[]> {
    // Walk prev pointers from `to` back to `from`, collect hops, reverse.
    const idsReversed: string[] = [];
    const edgesReversed: (RelationshipRow | null)[] = [];
    const dirsReversed: ("out" | "in" | null)[] = [];
    let cursor: string | null = to;
    while (cursor) {
      const trace = visited.get(cursor);
      if (!trace) break;
      idsReversed.push(cursor);
      edgesReversed.push(trace.relationship);
      dirsReversed.push(trace.direction);
      cursor = trace.prev;
      if (cursor === from) {
        idsReversed.push(from);
        edgesReversed.push(null);
        dirsReversed.push(null);
        break;
      }
    }
    const ids = idsReversed.reverse();
    const edges = edgesReversed.reverse();
    const dirs = dirsReversed.reverse();

    // Fetch all entity rows in one shot to avoid N round-trips.
    const rows: any[] = await this.prisma.platosMemoryEntity.findMany({
      where: {
        id: { in: ids },
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    const byId = new Map<string, EntityRow>();
    for (const r of rows) byId.set(r.id, toEntityRow(r, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v));

    const hops: ShortestPathHop[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const ent = byId.get(id);
      if (!ent) continue; // defensive — scope mismatch, skip
      hops.push({
        entity: ent,
        relationship: edges[i] ?? null,
        direction: dirs[i] ?? null,
      });
    }
    return hops;
  }

  /**
   * Create a relationship row between two entities. Scope + userId
   * must match both endpoints; we reject cross-user edges to preserve
   * the per-user memory boundary (Theme O invariant).
   */
  async createRelationship(
    scope: ScopeTuple,
    input: {
      userId: string;
      /// L6 — acting agent (null for operator/non-agent-pinned callers).
      agentId?: string | null;
      fromEntityId: string;
      toEntityId: string;
      relationshipType: string;
      weight?: number | null;
      metadata?: unknown;
      sourceMemoryId?: string | null;
    },
  ): Promise<RelationshipRow> {
    this.requireScope(scope);
    if (!input.userId) throw new Error("KnowledgeGraphService.createRelationship: `userId` is required");
    if (!input.relationshipType) {
      throw new Error("KnowledgeGraphService.createRelationship: `relationshipType` is required");
    }
    // Verify both endpoints live in the same scope + user so the graph
    // invariants hold.
    const [from, to] = await Promise.all([
      this.getEntityById(scope, input.fromEntityId),
      this.getEntityById(scope, input.toEntityId),
    ]);
    if (!from || !to) {
      throw new Error("KnowledgeGraphService.createRelationship: endpoint not found in scope");
    }
    if (from.userId !== input.userId || to.userId !== input.userId) {
      throw new Error(
        "KnowledgeGraphService.createRelationship: cross-user relationships are not allowed",
      );
    }
    const row = await this.prisma.platosMemoryRelationship.create({
      data: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: input.userId,
        agentId: input.agentId ?? null,
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
        relationshipType: input.relationshipType,
        weight: input.weight ?? null,
        metadata: input.metadata as any,
        sourceMemoryId: input.sourceMemoryId ?? null,
      },
    });
    return toRelationshipRow(row);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // MCPF-W5 — search, partial update, cascade delete, link discovery.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Substring-match search over entity `label` + `aliases` for a user.
   * Case-insensitive. MVP scoring (v1):
   *   - exact label match               → 1.0
   *   - label.startsWith(query)         → 0.9
   *   - label.includes(query)           → 0.7
   *   - alias substring match           → 0.5
   *
   * For larger graphs (>1000 entities/user), swap to Postgres tsvector
   * or pgvector embeddings — out of scope for v1. Hard-caps the candidate
   * scan at 1000 rows so memory stays bounded.
   */
  async searchEntities(
    scope: ScopeTuple,
    input: { userId: string; query: string; limit?: number },
  ): Promise<Array<{ entity: EntityRow; score: number }>> {
    this.requireScope(scope);
    if (!input.userId) {
      throw new Error("KnowledgeGraphService.searchEntities: `userId` is required");
    }
    const limit = clampInt(input.limit ?? 20, 1, 100);
    const q = (input.query ?? "").trim().toLowerCase();
    if (!q) return [];

    const candidates = await this.prisma.platosMemoryEntity.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: input.userId,
      },
      take: 1000,
      orderBy: { updatedAt: "desc" },
    });

    const scored: Array<{ entity: EntityRow; score: number }> = [];
    for (const c of candidates) {
      const decoded = toEntityRow(
        c,
        (v) => this.decString(v),
        (v) => this.crypto?.decryptJsonField(v) ?? v,
      );
      const label = (decoded.label ?? "").toLowerCase();
      const aliases = (decoded.aliases ?? []).map((a) => (a ?? "").toLowerCase());
      let score = 0;
      if (label === q) score = 1.0;
      else if (label.startsWith(q)) score = 0.9;
      else if (label.includes(q)) score = 0.7;
      else if (aliases.some((a) => a.includes(q))) score = 0.5;
      if (score > 0) scored.push({ entity: decoded, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Partial-patch update of an entity by id.
   * Only `label`, `aliases`, `metadata`, and `entityType` may be patched —
   * `entityKey` is the upsert key and immutable; scope columns are immutable.
   *
   * Uses `updateMany` with the full scope filter so cross-tenant id probes
   * never mutate; returns `null` when no row matched (caller surfaces as
   * `not_found`).
   */
  async updateEntityById(
    scope: ScopeTuple,
    id: string,
    patch: {
      label?: string;
      aliases?: string[];
      metadata?: unknown;
      entityType?: string;
    },
  ): Promise<EntityRow | null> {
    this.requireScope(scope);

    const data: Record<string, unknown> = {};
    if (patch.label !== undefined) {
      data.label = this.encString(patch.label) ?? patch.label;
    }
    if (patch.aliases !== undefined) {
      data.aliases = patch.aliases;
    }
    if (patch.metadata !== undefined) {
      data.metadata = (this.crypto?.encryptJsonField(patch.metadata) ?? patch.metadata) as any;
    }
    if (patch.entityType !== undefined) {
      data.entityType = patch.entityType;
    }

    if (Object.keys(data).length === 0) {
      // Nothing to patch — fast-path: just refetch + return.
      return this.getEntityById(scope, id);
    }

    const result = await this.prisma.platosMemoryEntity.updateMany({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      data,
    });
    if (result.count === 0) return null;

    return this.getEntityById(scope, id);
  }

  /**
   * Cascade-delete an entity AND every relationship pointing to or from it.
   * Verifies scope before issuing the destructive op so cross-tenant id
   * probes return `{ ok: false }` rather than silently no-op'ing.
   *
   * Both deletes run in a single transaction so an entity is never left
   * orphaned with dangling edges (PlatosMemoryRelationship FKs already
   * cascade on entity delete, but doing it explicitly inside the txn lets
   * us return a stable count + keeps the audit trail symmetric).
   */
  async deleteEntity(scope: ScopeTuple, id: string): Promise<{ ok: boolean; deletedRelationships: number }> {
    this.requireScope(scope);
    const entity = await this.getEntityById(scope, id);
    if (!entity) return { ok: false, deletedRelationships: 0 };

    const [relResult, entityResult] = await this.prisma.$transaction([
      this.prisma.platosMemoryRelationship.deleteMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          OR: [{ fromEntityId: id }, { toEntityId: id }],
        },
      }),
      this.prisma.platosMemoryEntity.deleteMany({
        where: {
          id,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
      }),
    ]);

    return {
      ok: (entityResult?.count ?? 0) > 0,
      deletedRelationships: relResult?.count ?? 0,
    };
  }

  /**
   * Suggest candidate edges via shared-neighbor heuristic. Returns pairs
   * `(a, b)` where:
   *   - `a` and `b` are not directly linked (in either direction)
   *   - `a` and `b` share at least `minSharedNeighbors` common neighbors
   *
   * Sorted by shared-neighbor count desc; capped at 50 suggestions.
   * Hard cap at 5000 entities to avoid OOM on pathologically large graphs.
   *
   * Approval-gated at the tool surface — pair-iteration is O(n²) in the
   * candidate set and the result can leak relationship structure if abused.
   */
  async discoverLinks(
    scope: ScopeTuple,
    input: { userId: string; limit?: number; minSharedNeighbors?: number },
  ): Promise<{
    suggestions: Array<{
      from: EntityRow;
      to: EntityRow;
      sharedNeighbors: number;
      reason: string;
    }>;
  }> {
    this.requireScope(scope);
    if (!input.userId) {
      throw new Error("KnowledgeGraphService.discoverLinks: `userId` is required");
    }
    const limit = clampInt(input.limit ?? 20, 1, 50);
    const minShared = clampInt(input.minSharedNeighbors ?? 2, 1, 100);

    const entities = await this.prisma.platosMemoryEntity.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: input.userId,
      },
      select: { id: true },
      take: 5000,
    });
    const ids: string[] = entities.map((e: any) => e.id);
    if (ids.length < 2) return { suggestions: [] };

    const edges = await this.prisma.platosMemoryRelationship.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        userId: input.userId,
        OR: [{ fromEntityId: { in: ids } }, { toEntityId: { in: ids } }],
      },
      select: { fromEntityId: true, toEntityId: true },
    });

    const adj = new Map<string, Set<string>>();
    for (const id of ids) adj.set(id, new Set());
    for (const e of edges) {
      adj.get(e.fromEntityId)?.add(e.toEntityId);
      adj.get(e.toEntityId)?.add(e.fromEntityId);
    }

    type Pair = { fromId: string; toId: string; shared: number };
    const candidates: Pair[] = [];
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i]!;
      const aSet = adj.get(a)!;
      for (let j = i + 1; j < ids.length; j++) {
        const b = ids[j]!;
        if (aSet.has(b)) continue; // already linked (either direction)
        const bSet = adj.get(b)!;
        let shared = 0;
        // Iterate the smaller set for fewer lookups.
        const [smaller, bigger] = aSet.size <= bSet.size ? [aSet, bSet] : [bSet, aSet];
        for (const n of smaller) {
          if (bigger.has(n)) shared++;
        }
        if (shared >= minShared) candidates.push({ fromId: a, toId: b, shared });
      }
    }

    candidates.sort((x, y) => y.shared - x.shared);
    const top = candidates.slice(0, limit);

    if (top.length === 0) return { suggestions: [] };

    // Hydrate entity rows for the top suggestions.
    const idSet = new Set<string>();
    for (const s of top) {
      idSet.add(s.fromId);
      idSet.add(s.toId);
    }
    const rows = await this.prisma.platosMemoryEntity.findMany({
      where: {
        id: { in: Array.from(idSet) },
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    const byId = new Map<string, EntityRow>();
    for (const r of rows) {
      byId.set(
        r.id,
        toEntityRow(r, (v) => this.decString(v), (v) => this.crypto?.decryptJsonField(v) ?? v),
      );
    }

    const suggestions = top
      .map((s) => {
        const from = byId.get(s.fromId);
        const to = byId.get(s.toId);
        if (!from || !to) return null;
        return {
          from,
          to,
          sharedNeighbors: s.shared,
          reason: `${s.shared} shared neighbor${s.shared === 1 ? "" : "s"}`,
        };
      })
      .filter((s): s is { from: EntityRow; to: EntityRow; sharedNeighbors: number; reason: string } => s !== null);

    return { suggestions };
  }

  private requireScope(scope: ScopeTuple): void {
    if (!scope?.organizationId || !scope?.projectId || !scope?.environmentId) {
      throw new Error("KnowledgeGraphService: scope tuple is required");
    }
  }
}

function toEntityRow(
  row: any,
  decString?: (v: string | null | undefined) => string | null,
  decJson?: (v: unknown) => unknown,
): EntityRow {
  // EOBD.22 — transparent decryption on read. Pre-encryption rows pass through.
  const label = decString ? (decString(row.label) ?? row.label) : row.label;
  const metadata = decJson ? decJson(row.metadata ?? null) : (row.metadata ?? null);
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    userId: row.userId,
    entityKey: row.entityKey,
    entityType: row.entityType,
    label,
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    metadata,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  };
}

function toRelationshipRow(row: any): RelationshipRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    userId: row.userId,
    fromEntityId: row.fromEntityId,
    toEntityId: row.toEntityId,
    relationshipType: row.relationshipType,
    weight: row.weight ?? null,
    metadata: row.metadata ?? null,
    sourceMemoryId: row.sourceMemoryId ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}
