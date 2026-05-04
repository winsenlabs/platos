import { Injectable, Inject, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { MessageCryptoService } from "./message-crypto.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface ToolAuditRecord {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  toolId: string | null;
  toolName: string;
  entityId: string | null;
  entityPk: string | null;
  agentId: string | null;
  threadId: string | null;
  userId: string | null;
  traceId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  args: unknown;
  result: unknown;
  error: string | null;
  status: string;
  latencyMs: number;
  costCents: number | null;
  /** PIFSP-21 — origin of the dispatch. Null for legacy rows. */
  source: string | null;
  mcpUserId: string | null;
  mcpClientId: string | null;
  createdAt: string;
}

export interface ToolAuditFilters {
  threadId?: string;
  agentId?: string;
  toolName?: string;
  status?: string;
  entityId?: string;
  sinceDays?: number;
  limit?: number;
  offset?: number;
}

export interface RecordToolAuditInput {
  scope: ScopeTuple;
  toolId?: string | null;
  toolName: string;
  entityId?: string | null;
  entityPk?: string | null;
  agentId?: string | null;
  threadId?: string | null;
  userId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string | null;
  status: "success" | "failed" | "timeout";
  latencyMs: number;
  costCents?: number | null;
  /** PIFSP-21 — dispatch origin tagging. All three nullable. */
  source?: string | null;
  mcpUserId?: string | null;
  mcpClientId?: string | null;
}

/**
 * ToolAuditService — persistence + query surface for the tool-call audit log.
 * Theme E.5.
 *
 * The audit row is the durable record of every entity-side tool dispatch. It's
 * scope-stamped on write (the same scope that gated the dispatch) and every
 * read path filters on (org, project, env), so cross-scope enumeration or
 * replay is structurally impossible.
 *
 * The call-site that writes audit rows is {@link
 * ../tool-gateway/tool-executor.service.ts#execute}. This service only exposes:
 *
 * - `record(...)` — called from ToolExecutorService after every dispatch.
 * - `list(scope, filters)` — the GET endpoint.
 * - `getById(scope, id)` — the scope-gated read used by the replay endpoint.
 */
@Injectable()
export class ToolAuditService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {
    this.prisma = prisma;
  }

  /**
   * Append a single audit row. Called from ToolExecutorService — never fails
   * the originating tool call on audit-write failure.
   */
  async record(input: RecordToolAuditInput): Promise<string | null> {
    try {
      // EOBD.20 — encrypt PII-bearing Json fields at rest (args, result).
      // Tool calls routinely carry the user's question, API params, and
      // row data returned by the entity backend. Non-PII identifying
      // fields (toolName, status, entityId) stay plaintext so dashboards
      // + indexes keep working.
      //
      // `error` is a String column so the envelope wrapper doesn't fit
      // cleanly; error messages are typically stack traces + HTTP codes
      // rather than user PII. Tracked as a follow-up (store error as
      // stringified envelope when crypto is available).
      const encArgs = this.crypto?.encryptJsonField(input.args ?? {}) ?? (input.args ?? {});
      const encResult =
        this.crypto?.encryptJsonField(input.result ?? null) ?? (input.result ?? null);
      const encError = input.error ?? null;
      const row = await this.prisma.platosToolCallAudit.create({
        data: {
          organizationId: input.scope.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          toolId: input.toolId ?? null,
          toolName: input.toolName,
          entityId: input.entityId ?? null,
          entityPk: input.entityPk ?? null,
          agentId: input.agentId ?? null,
          threadId: input.threadId ?? null,
          userId: input.userId ?? null,
          traceId: input.traceId ?? null,
          spanId: input.spanId ?? null,
          parentSpanId: input.parentSpanId ?? null,
          args: encArgs as any,
          result: encResult as any,
          error: encError,
          status: input.status,
          latencyMs: Math.max(0, Math.round(input.latencyMs)),
          costCents: input.costCents ?? null,
          // PIFSP-21 — origin tagging. Nullable so legacy callers that
          // don't pass any of these three keep writing `null` columns.
          source: input.source ?? null,
          mcpUserId: input.mcpUserId ?? null,
          mcpClientId: input.mcpClientId ?? null,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      // Audit failures must never surface to the model — log and move on.
      console.error("[Platos ToolAudit] record failed:", err);
      return null;
    }
  }

  /**
   * Paginated audit list, scope-filtered. Newest first.
   */
  async list(
    scope: ScopeTuple,
    filters: ToolAuditFilters = {},
  ): Promise<{ rows: ToolAuditRecord[]; total: number; limit: number; offset: number }> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const sinceDays = filters.sinceDays ?? 30;

    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
    };
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.toolName) where.toolName = filters.toolName;
    if (filters.status) where.status = filters.status;
    if (filters.entityId) where.entityId = filters.entityId;

    const [total, rawRows] = await Promise.all([
      this.prisma.platosToolCallAudit.count({ where }),
      this.prisma.platosToolCallAudit.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
    ]);

    return {
      rows: (rawRows as any[]).map((r) => this.toRecord(r)),
      total,
      limit,
      offset,
    };
  }

  /**
   * Fetch a single audit row, scope-gated. Cross-scope reads return null so
   * the controller returns 404.
   */
  async getById(scope: ScopeTuple, id: string): Promise<ToolAuditRecord | null> {
    const row = await this.prisma.platosToolCallAudit.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return row ? this.toRecord(row) : null;
  }

  private toRecord(r: any): ToolAuditRecord {
    // EOBD.20 — transparent decryption on read. `decryptJsonField` is a
    // passthrough for rows that pre-date encryption (no __platos_enc
    // marker), so mixed corpora during rollout both decrypt correctly.
    const args = this.crypto?.decryptJsonField(r.args ?? {}) ?? (r.args ?? {});
    const result = this.crypto?.decryptJsonField(r.result ?? null) ?? (r.result ?? null);
    return {
      id: r.id,
      organizationId: r.organizationId,
      projectId: r.projectId,
      environmentId: r.environmentId,
      toolId: r.toolId ?? null,
      toolName: r.toolName,
      entityId: r.entityId ?? null,
      entityPk: r.entityPk ?? null,
      agentId: r.agentId ?? null,
      threadId: r.threadId ?? null,
      userId: r.userId ?? null,
      traceId: r.traceId ?? null,
      spanId: r.spanId ?? null,
      parentSpanId: r.parentSpanId ?? null,
      args,
      result,
      error: r.error ?? null,
      status: r.status,
      latencyMs: r.latencyMs,
      costCents: r.costCents ?? null,
      source: r.source ?? null,
      mcpUserId: r.mcpUserId ?? null,
      mcpClientId: r.mcpClientId ?? null,
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    };
  }
}
