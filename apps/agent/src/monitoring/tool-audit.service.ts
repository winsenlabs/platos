import { Injectable, Inject, Optional } from "@nestjs/common";
import type {
  Prisma,
  ToolCallAudit,
  WorkStatus,
} from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
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
  /**
   * MCP per-user isolation — the PlatosEndUser.externalUserId substituted into
   * a `connectionKind="mcp"` dispatch's `{{endUserId}}`. Verbatim (like
   * mcpUserId), null for wire/legacy rows. Replay reads it back into `origin`.
   */
  endUserId: string | null;
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
  /**
   * MCP per-user isolation — the resolved end-user identity (externalUserId)
   * substituted into a `connectionKind="mcp"` dispatch. Nullable; wire calls
   * pass none.
   */
  endUserId?: string | null;
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
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {}

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
      const auditMetadata = {
        entityId: input.entityId ?? null,
        entityPk: input.entityPk ?? null,
        userId: input.userId ?? null,
        spanId: input.spanId ?? null,
        parentSpanId: input.parentSpanId ?? null,
        source: input.source ?? null,
        mcpUserId: input.mcpUserId ?? null,
        mcpClientId: input.mcpClientId ?? null,
        endUserId: input.endUserId ?? null,
        status: input.status,
      };
      const row = await this.prisma.toolCallAudit.create({
        data: {
          environmentId: input.scope.environmentId,
          toolId: input.toolId ?? null,
          toolName: input.toolName,
          agentId: input.agentId ?? null,
          threadId: input.threadId ?? null,
          traceId: input.traceId ?? null,
          arguments: {
            __platosAudit: auditMetadata,
            value: encArgs,
          } as Prisma.InputJsonObject,
          result: this.jsonResult(encResult),
          error: encError,
          status: this.persistedStatus(input.status),
          latencyMs: Math.max(0, Math.round(input.latencyMs)),
          costCents: input.costCents ?? null,
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

    const where: Prisma.ToolCallAuditWhereInput = {
      ...environmentScopeWhere(scope),
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
    };
    const metadataFilters: Prisma.ToolCallAuditWhereInput[] = [];
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.toolName) where.toolName = filters.toolName;
    if (filters.status === "success") where.status = "SUCCEEDED";
    if (filters.status === "failed") where.status = "FAILED";
    if (filters.status === "timeout") {
      metadataFilters.push({
        arguments: {
          path: ["__platosAudit", "status"],
          equals: "timeout",
        },
      });
    }
    if (filters.entityId) {
      metadataFilters.push({
        arguments: {
          path: ["__platosAudit", "entityId"],
          equals: filters.entityId,
        },
      });
    }
    if (metadataFilters.length > 0) where.AND = metadataFilters;

    const [total, rawRows] = await Promise.all([
      this.prisma.toolCallAudit.count({ where }),
      this.prisma.toolCallAudit.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
    ]);

    return {
      rows: rawRows.map((row) => this.toRecord(scope, row)),
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
    const row = await this.prisma.toolCallAudit.findFirst({
      where: {
        id,
        ...environmentScopeWhere(scope),
      },
    });
    return row ? this.toRecord(scope, row) : null;
  }

  private toRecord(scope: ScopeTuple, r: ToolCallAudit): ToolAuditRecord {
    // EOBD.20 — transparent decryption on read. `decryptJsonField` is a
    // passthrough for rows that pre-date encryption (no __platos_enc
    // marker), so mixed corpora during rollout both decrypt correctly.
    const storedArgs = r.arguments as {
      __platosAudit?: Record<string, unknown>;
      value?: unknown;
    };
    const adapted = !!storedArgs.__platosAudit;
    const metadata = storedArgs.__platosAudit ?? {};
    const argumentValue = adapted ? (storedArgs.value ?? {}) : r.arguments;
    const args =
      this.crypto?.decryptJsonField(argumentValue) ?? argumentValue;
    const storedResult = r.result as { __platosScalarResult?: unknown } | null;
    const resultValue =
      storedResult && "__platosScalarResult" in storedResult
        ? storedResult.__platosScalarResult
        : r.result;
    const result =
      this.crypto?.decryptJsonField(resultValue ?? null) ??
      (resultValue ?? null);
    return {
      id: r.id,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: r.environmentId,
      toolId: r.toolId ?? null,
      toolName: r.toolName,
      entityId: (metadata.entityId as string | null | undefined) ?? null,
      entityPk: (metadata.entityPk as string | null | undefined) ?? null,
      agentId: r.agentId ?? null,
      threadId: r.threadId ?? null,
      userId: (metadata.userId as string | null | undefined) ?? null,
      traceId: r.traceId ?? null,
      spanId: (metadata.spanId as string | null | undefined) ?? null,
      parentSpanId:
        (metadata.parentSpanId as string | null | undefined) ?? null,
      args,
      result,
      error: r.error ?? null,
      status: (metadata.status as string | undefined) ?? r.status.toLowerCase(),
      latencyMs: r.latencyMs,
      costCents: r.costCents === null ? null : Number(r.costCents),
      source: (metadata.source as string | null | undefined) ?? null,
      mcpUserId: (metadata.mcpUserId as string | null | undefined) ?? null,
      mcpClientId: (metadata.mcpClientId as string | null | undefined) ?? null,
      endUserId: (metadata.endUserId as string | null | undefined) ?? null,
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    };
  }

  private persistedStatus(
    status: RecordToolAuditInput["status"],
  ): WorkStatus {
    return status === "success" ? "SUCCEEDED" : "FAILED";
  }

  private jsonResult(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "object") return value as Prisma.InputJsonValue;
    return { __platosScalarResult: value } as Prisma.InputJsonObject;
  }
}
