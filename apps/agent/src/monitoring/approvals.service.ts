import { Inject, Injectable } from "@nestjs/common";
import type {
  AgentApproval,
  ApprovalStatus as DatabaseApprovalStatus,
  Prisma,
} from "@platos/tenancy-database";
import { createHash, randomBytes } from "node:crypto";
import {
  type ControlDatabaseClient,
  environmentScopeWhere,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { isUuid } from "../shared/pagination";

type ScopeTuple = Pick<
  RequestScope,
  "organizationId" | "projectId" | "environmentId"
>;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "timed_out";
export type ApprovalSource =
  | "request_approval"
  | "cancel_run"
  | "mcp_tool_call";

export interface ApprovalRecord {
  id: string;
  approvalId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  source: ApprovalSource | string;
  agentId: string | null;
  threadId: string | null;
  requestedBy: string | null;
  action: string;
  details: string | null;
  status: ApprovalStatus | string;
  timeoutSeconds: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  respondedBy: string | null;
  comment: string | null;
  deadlineAt: string | null;
  secondsRemaining: number | null;
  expired: boolean;
  toolName?: string | null;
  args?: unknown;
  resolution?: unknown;
  consumedAt?: string | null;
  requestedByMcpTokenId?: string | null;
  editedArgs?: unknown;
  editedByUserId?: string | null;
}

export interface ApprovalFilters {
  threadId?: string;
  agentId?: string;
  status?: string;
  source?: string;
  sinceDays?: number;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface RecordApprovalInput {
  scope: ScopeTuple;
  approvalId: string;
  source: ApprovalSource;
  agentId?: string | null;
  threadId?: string | null;
  requestedBy?: string | null;
  action: string;
  details?: string | null;
  timeoutSeconds?: number;
}

export interface ResolveApprovalInput {
  scope: ScopeTuple;
  approvalId: string;
  status: Exclude<ApprovalStatus, "pending">;
  respondedBy?: string | null;
  comment?: string | null;
  editedArgs?: Record<string, unknown> | null;
  editedByUserId?: string | null;
}

export class ApprovalEditMissingError extends Error {
  constructor(
    message = "editedArgs required for approved_with_edits decision",
  ) {
    super(message);
    this.name = "ApprovalEditMissingError";
  }
}

interface ApprovalMetadata {
  approvalId: string;
  source: string;
  requestedBy: string | null;
  requestHash: string | null;
  requestedByMcpTokenId: string | null;
  consumedAt: string | null;
  editedArgs: Record<string, unknown> | null;
  editedByUserId: string | null;
}

interface StoredApprovalArguments {
  __platosApproval: ApprovalMetadata;
  value: Record<string, unknown> | null;
}

@Injectable()
export class MonitoringApprovalsService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  async record(input: RecordApprovalInput): Promise<string | null> {
    try {
      const row = await this.prisma.agentApproval.create({
        data: {
          environmentId: input.scope.environmentId,
          agentId: input.agentId ?? null,
          threadId: input.threadId ?? null,
          action: input.action,
          details: input.details ?? null,
          status: "PENDING",
          timeoutSeconds: Math.max(
            1,
            Math.round(input.timeoutSeconds ?? 300),
          ),
          arguments: this.storeArguments(
            this.metadata({
              approvalId: input.approvalId,
              source: input.source,
              requestedBy: input.requestedBy ?? null,
            }),
            null,
          ),
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      console.error("[Platos Approvals] record failed:", err);
      return null;
    }
  }

  async resolve(input: ResolveApprovalInput): Promise<boolean> {
    try {
      const row = await this.findRawByApprovalId(
        input.scope,
        input.approvalId,
      );
      if (!row || row.status !== "PENDING") return false;
      const stored = this.readArguments(row.arguments);
      const persistEdits =
        input.status === "approved" && input.editedArgs != null;
      const result = await this.prisma.agentApproval.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: {
          status: this.databaseStatus(input.status),
          respondedBy: input.respondedBy ?? null,
          comment: input.comment ?? null,
          resolvedAt: new Date(),
          arguments: this.storeArguments(
            {
              ...stored.__platosApproval,
              editedArgs: persistEdits ? input.editedArgs! : null,
              editedByUserId: persistEdits
                ? (input.editedByUserId ?? input.respondedBy ?? null)
                : null,
            },
            stored.value,
          ),
        },
      });
      return result.count === 1;
    } catch (err) {
      console.error("[Platos Approvals] resolve failed:", err);
      return false;
    }
  }

  async list(
    scope: ScopeTuple,
    filters: ApprovalFilters = {},
  ): Promise<{
    rows: ApprovalRecord[];
    total: number;
    pendingCount: number;
    limit: number;
    offset: number;
  }> {
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const sinceDays = filters.sinceDays ?? 30;
    const where: Prisma.AgentApprovalWhereInput = {
      ...environmentScopeWhere(scope),
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
    };
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.status) {
      where.status = this.databaseStatus(filters.status as ApprovalStatus);
    }
    if (filters.source) {
      where.AND = [this.metadataWhere("source", filters.source)];
    }
    if (filters.search) {
      where.OR = [
        ...(isUuid(filters.search) ? [{ id: { equals: filters.search } }] : []),
        { action: { contains: filters.search, mode: "insensitive" } },
        { details: { contains: filters.search, mode: "insensitive" } },
      ];
    }

    const pendingWhere: Prisma.AgentApprovalWhereInput = {
      ...environmentScopeWhere(scope),
      status: "PENDING",
    };
    const [total, pendingCount, rawRows] = await Promise.all([
      this.prisma.agentApproval.count({ where }),
      this.prisma.agentApproval.count({ where: pendingWhere }),
      this.prisma.agentApproval.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        skip: offset,
      }),
    ]);
    const now = Date.now();
    return {
      rows: rawRows.map((row) => this.toRecord(scope, row, now)),
      total,
      pendingCount,
      limit,
      offset,
    };
  }

  async getById(
    scope: ScopeTuple,
    approvalId: string,
  ): Promise<ApprovalRecord | null> {
    const row = await this.findRawByApprovalId(scope, approvalId);
    return row ? this.toRecord(scope, row, Date.now()) : null;
  }

  async sweepExpired(scope: ScopeTuple): Promise<number> {
    try {
      const rows = await this.prisma.agentApproval.findMany({
        where: { ...environmentScopeWhere(scope), status: "PENDING" },
        select: { id: true, createdAt: true, timeoutSeconds: true },
      });
      const now = Date.now();
      const expiredIds = rows
        .filter(
          (row) =>
            now - row.createdAt.getTime() > row.timeoutSeconds * 1000,
        )
        .map((row) => row.id);
      if (expiredIds.length === 0) return 0;
      const result = await this.prisma.agentApproval.updateMany({
        where: { id: { in: expiredIds }, status: "PENDING" },
        data: { status: "EXPIRED", resolvedAt: new Date() },
      });
      return result.count;
    } catch (err) {
      console.error("[Platos Approvals] sweepExpired failed:", err);
      return 0;
    }
  }

  async sweepExpiredAllScopes(): Promise<{
    scopesScanned: number;
    totalExpired: number;
    perScope: Array<
      ScopeTuple & {
        expired: number;
      }
    >;
  }> {
    try {
      const tuples = await this.prisma.agentApproval.findMany({
        where: { status: "PENDING" },
        distinct: ["environmentId"],
        select: {
          environmentId: true,
          environment: {
            select: {
              projectId: true,
              project: { select: { organizationId: true } },
            },
          },
        },
      });
      let totalExpired = 0;
      const perScope: Array<ScopeTuple & { expired: number }> = [];
      for (const tuple of tuples) {
        const scope = {
          organizationId: tuple.environment.project.organizationId,
          projectId: tuple.environment.projectId,
          environmentId: tuple.environmentId,
        };
        const expired = await this.sweepExpired(scope);
        totalExpired += expired;
        perScope.push({ ...scope, expired });
      }
      return { scopesScanned: tuples.length, totalExpired, perScope };
    } catch (err) {
      console.error(
        "[Platos Approvals] sweepExpiredAllScopes failed:",
        err,
      );
      return { scopesScanned: 0, totalExpired: 0, perScope: [] };
    }
  }

  static computeRequestHash(
    scope: ScopeTuple,
    toolName: string,
    redactedArgs: Record<string, unknown>,
  ): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          o: scope.organizationId,
          p: scope.projectId,
          e: scope.environmentId,
          t: toolName,
          a: redactedArgs,
        }),
      )
      .digest("hex");
  }

  async findPendingByRequestHash(
    scope: ScopeTuple,
    requestHash: string,
  ): Promise<ApprovalRecord | null> {
    const row = await this.prisma.agentApproval.findFirst({
      where: {
        ...environmentScopeWhere(scope),
        status: "PENDING",
        AND: [
          this.metadataWhere("requestHash", requestHash),
          this.metadataWhere("source", "mcp_tool_call"),
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;
    const record = this.toRecord(scope, row, Date.now());
    return record.expired ? null : record;
  }

  async createMcpApproval(input: {
    scope: ScopeTuple;
    toolName: string;
    args: Record<string, unknown>;
    requestHash: string;
    requestedByUserId?: string | null;
    requestedByMcpTokenId?: string | null;
    timeoutSeconds?: number;
    actionLabel?: string;
  }): Promise<ApprovalRecord> {
    const existing = await this.findPendingByRequestHash(
      input.scope,
      input.requestHash,
    );
    if (existing) return existing;

    const approvalId = `appr_mcp_${randomBytes(8).toString("hex")}`;
    try {
      const created = await this.prisma.agentApproval.create({
        data: {
          environmentId: input.scope.environmentId,
          action:
            input.actionLabel ?? `MCP tool call: ${input.toolName}`,
          status: "PENDING",
          timeoutSeconds: Math.max(
            60,
            Math.round(input.timeoutSeconds ?? 3600),
          ),
          toolName: input.toolName,
          arguments: this.storeArguments(
            this.metadata({
              approvalId,
              source: "mcp_tool_call",
              requestedBy: input.requestedByUserId ?? null,
              requestHash: input.requestHash,
              requestedByMcpTokenId:
                input.requestedByMcpTokenId ?? null,
            }),
            input.args,
          ),
        },
      });
      return this.toRecord(input.scope, created, Date.now());
    } catch (err) {
      const fallback = await this.findPendingByRequestHash(
        input.scope,
        input.requestHash,
      );
      if (fallback) return fallback;
      throw err;
    }
  }

  async markMcpConsumed(
    scope: ScopeTuple,
    approvalId: string,
    resolution: unknown,
  ): Promise<void> {
    try {
      const row = await this.findRawByApprovalId(scope, approvalId);
      if (!row) return;
      const stored = this.readArguments(row.arguments);
      await this.prisma.agentApproval.update({
        where: { id: row.id },
        data: {
          arguments: this.storeArguments(
            {
              ...stored.__platosApproval,
              consumedAt: new Date().toISOString(),
            },
            stored.value,
          ),
          resolution: this.jsonObject(resolution),
        },
      });
    } catch (err) {
      console.error("[Platos Approvals] markMcpConsumed failed:", err);
    }
  }

  private async findRawByApprovalId(
    scope: ScopeTuple,
    approvalId: string,
  ): Promise<AgentApproval | null> {
    return this.prisma.agentApproval.findFirst({
      where: {
        ...environmentScopeWhere(scope),
        AND: [this.metadataWhere("approvalId", approvalId)],
      },
    });
  }

  private metadata(
    input: Pick<ApprovalMetadata, "approvalId" | "source" | "requestedBy"> &
      Partial<ApprovalMetadata>,
  ): ApprovalMetadata {
    return {
      approvalId: input.approvalId,
      source: input.source,
      requestedBy: input.requestedBy,
      requestHash: input.requestHash ?? null,
      requestedByMcpTokenId: input.requestedByMcpTokenId ?? null,
      consumedAt: input.consumedAt ?? null,
      editedArgs: input.editedArgs ?? null,
      editedByUserId: input.editedByUserId ?? null,
    };
  }

  private metadataWhere(
    field: keyof ApprovalMetadata,
    value: string,
  ): Prisma.AgentApprovalWhereInput {
    return {
      arguments: {
        path: ["__platosApproval", field],
        equals: value,
      },
    };
  }

  private storeArguments(
    metadata: ApprovalMetadata,
    value: Record<string, unknown> | null,
  ): Prisma.InputJsonObject {
    return {
      __platosApproval: metadata as unknown as Prisma.InputJsonObject,
      value: value as Prisma.InputJsonObject | null,
    };
  }

  private readArguments(value: Prisma.JsonValue | null): StoredApprovalArguments {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const stored = value as unknown as Partial<StoredApprovalArguments>;
      if (stored.__platosApproval?.approvalId) {
        return {
          __platosApproval: stored.__platosApproval,
          value: stored.value ?? null,
        };
      }
    }
    return {
      __platosApproval: this.metadata({
        approvalId: "",
        source: "request_approval",
        requestedBy: null,
      }),
      value: null,
    };
  }

  private jsonObject(value: unknown): Prisma.InputJsonObject | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "object" && !Array.isArray(value)) {
      return value as Prisma.InputJsonObject;
    }
    return { value } as Prisma.InputJsonObject;
  }

  private databaseStatus(status: ApprovalStatus): DatabaseApprovalStatus {
    switch (status) {
      case "approved":
        return "APPROVED";
      case "rejected":
        return "REJECTED";
      case "timed_out":
        return "EXPIRED";
      default:
        return "PENDING";
    }
  }

  private publicStatus(status: DatabaseApprovalStatus): ApprovalStatus {
    switch (status) {
      case "APPROVED":
        return "approved";
      case "REJECTED":
        return "rejected";
      case "EXPIRED":
        return "timed_out";
      default:
        return "pending";
    }
  }

  private toRecord(
    scope: ScopeTuple,
    row: AgentApproval,
    now: number,
  ): ApprovalRecord {
    const stored = this.readArguments(row.arguments);
    const metadata = stored.__platosApproval;
    const status = this.publicStatus(row.status);
    const deadlineMs =
      row.createdAt.getTime() + row.timeoutSeconds * 1000;
    const isPending = status === "pending";
    const expired = isPending && now >= deadlineMs;
    return {
      id: row.id,
      approvalId: metadata.approvalId,
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: row.environmentId,
      source: metadata.source,
      agentId: row.agentId,
      threadId: row.threadId,
      requestedBy: metadata.requestedBy,
      action: row.action,
      details: row.details,
      status,
      timeoutSeconds: row.timeoutSeconds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      respondedBy: row.respondedBy,
      comment: row.comment,
      deadlineAt: isPending ? new Date(deadlineMs).toISOString() : null,
      secondsRemaining:
        isPending && !expired
          ? Math.max(0, Math.floor((deadlineMs - now) / 1000))
          : null,
      expired,
      toolName: row.toolName,
      args: stored.value,
      resolution: row.resolution,
      consumedAt: metadata.consumedAt,
      requestedByMcpTokenId: metadata.requestedByMcpTokenId,
      editedArgs: metadata.editedArgs,
      editedByUserId: metadata.editedByUserId,
    };
  }
}
