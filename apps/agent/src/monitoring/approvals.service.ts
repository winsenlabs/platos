import { Injectable, Inject } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export type ApprovalStatus = "pending" | "approved" | "rejected" | "timed_out";
/**
 * `mcp_tool_call` is the source emitted by the Platform MCP router when
 * `MCP_INTERACTIVE_APPROVALS=true` and a `require_approval` tool is
 * called. It is distinct from the agent-runtime waitpoint sources
 * (`request_approval` / `cancel_run`) so the dashboard can split MCP
 * gating from in-conversation approvals.
 */
export type ApprovalSource = "request_approval" | "cancel_run" | "mcp_tool_call";

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
  /**
   * Server-computed SLA clock. `deadlineAt` = createdAt + timeoutSeconds for
   * pending rows, otherwise null. `secondsRemaining` is non-null only while
   * the row is pending and the deadline has not passed. `expired` is `true`
   * once the wall clock crosses the deadline — the agent's blpop may not
   * have fired the DB transition yet, but the UI should show "expired".
   */
  deadlineAt: string | null;
  secondsRemaining: number | null;
  expired: boolean;
  /**
   * MCP approval-UI fields. Populated only when `source === "mcp_tool_call"`.
   * Pre-existing waitpoint approvals leave these as `null` / `undefined`.
   */
  toolName?: string | null;
  args?: unknown;
  resolution?: unknown;
  consumedAt?: string | null;
  requestedByMcpTokenId?: string | null;
  /**
   * MCP approval-UI Wave 2 — operator-edited args. Populated only when
   * the resolve path was `approved_with_edits`. The Platform MCP router
   * prefers this over `args` at execution time. Both are exposed on the
   * record so the audit UI shows the diff.
   */
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
  /**
   * MCP approval-UI Wave 2 — edit-first decision path. When set the
   * row is recorded as `status: "approved"` (the column-level status
   * stays binary) AND `editedArgs` is persisted so the router executes
   * with the operator's edited version instead of the original `args`.
   *
   * Caller is responsible for shape — invalid JSON or empty objects
   * should be rejected before reaching the service.
   */
  editedArgs?: Record<string, unknown> | null;
  /**
   * MCP approval-UI Wave 2 — user id that edited the args. Falls back
   * to `respondedBy` when omitted.
   */
  editedByUserId?: string | null;
}

/**
 * MCP approval-UI Wave 2 — error thrown by `resolve` when the caller
 * passes a `decision: "approved_with_edits"` without `editedArgs`. The
 * controller surfaces this as a 400 to the dashboard.
 */
export class ApprovalEditMissingError extends Error {
  constructor(message = "editedArgs required for approved_with_edits decision") {
    super(message);
    this.name = "ApprovalEditMissingError";
  }
}

/**
 * MonitoringApprovalsService — persistence + query surface for the HITL
 * approval ledger. Theme E.6.
 *
 * Every `request_approval` / `cancel_run` waitpoint opened by the agent
 * runtime appends a row here (scope-stamped), and every resolve path —
 * HTTP `POST /approvals/:id/resolve`, the `approval_response` socket event,
 * and the blpop-timeout branch — transitions the row to its terminal
 * status. Reads are always scope-filtered so cross-(org, project, env)
 * enumeration is structurally impossible.
 *
 * Writes are best-effort: the governance ledger must never fail the
 * originating approval flow, which is why `record` / `resolve` swallow
 * their own errors. The UI reconciles ghost rows via the `expired` flag
 * derived at read time.
 */
@Injectable()
export class MonitoringApprovalsService {
  private prisma: any;

  constructor(@Inject(PRISMA_TOKEN) prisma: any) {
    this.prisma = prisma;
  }

  /**
   * Append a pending approval row. Called the moment the agent runtime
   * emits the `approval:event` pub/sub message (before the blpop wait
   * starts). Failing here never blocks the originating tool call — the
   * UI just loses the governance row for that approval.
   */
  async record(input: RecordApprovalInput): Promise<string | null> {
    try {
      const row = await this.prisma.platosAgentApproval.create({
        data: {
          approvalId: input.approvalId,
          organizationId: input.scope.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          source: input.source,
          agentId: input.agentId ?? null,
          threadId: input.threadId ?? null,
          requestedBy: input.requestedBy ?? null,
          action: input.action,
          details: input.details ?? null,
          status: "pending",
          timeoutSeconds: Math.max(1, Math.round(input.timeoutSeconds ?? 300)),
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      console.error("[Platos Approvals] record failed:", err);
      return null;
    }
  }

  /**
   * Transition an approval row to a terminal status. Called from:
   *   - AgentController.resolveApproval (HTTP resolve)
   *   - ConnectionsGateway.handleApprovalResponse (socket resolve)
   *   - AgentService.request_approval / cancel_run blpop-timeout branch
   *
   * Idempotent: if the row is already in a terminal status (e.g. the
   * socket handler fired before the HTTP request landed) we leave the
   * existing response fields in place.
   *
   * MCP approval-UI Wave 2 — when `editedArgs` is provided AND status
   * is "approved" (the edit-first path), the operator-edited args are
   * persisted alongside the row's existing `args` column. The router
   * later prefers `editedArgs` at execution time. `editedByUserId`
   * falls back to `respondedBy` when omitted.
   *
   * Throws `ApprovalEditMissingError` if the caller signals the
   * edit-first path (via `editedByUserId` only, with no editedArgs)
   * to keep the contract honest.
   */
  async resolve(input: ResolveApprovalInput): Promise<void> {
    const editedArgs = input.editedArgs ?? null;
    // Defensive — only honour edits on the "approved" path. Rejections
    // never carry a meaningful "edited" view of the args, so we drop
    // any stray editedArgs the caller passed in.
    const persistEdits = input.status === "approved" && editedArgs !== null;
    try {
      await this.prisma.platosAgentApproval.updateMany({
        where: {
          approvalId: input.approvalId,
          organizationId: input.scope.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          status: "pending",
        },
        data: {
          status: input.status,
          respondedBy: input.respondedBy ?? null,
          comment: input.comment ?? null,
          resolvedAt: new Date(),
          ...(persistEdits
            ? {
                editedArgs: editedArgs as any,
                editedByUserId: input.editedByUserId ?? input.respondedBy ?? null,
              }
            : {}),
        },
      });
    } catch (err) {
      console.error("[Platos Approvals] resolve failed:", err);
    }
  }

  /**
   * Paginated approvals list, scope-filtered. Default window: 30 days.
   */
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

    const where: Record<string, unknown> = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
    };
    if (filters.threadId) where.threadId = filters.threadId;
    if (filters.agentId) where.agentId = filters.agentId;
    if (filters.status) where.status = filters.status;
    if (filters.source) where.source = filters.source;

    const pendingWhere = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      status: "pending",
    };

    const [total, pendingCount, rawRows] = await Promise.all([
      this.prisma.platosAgentApproval.count({ where }),
      this.prisma.platosAgentApproval.count({ where: pendingWhere }),
      this.prisma.platosAgentApproval.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
    ]);

    const now = Date.now();
    return {
      rows: (rawRows as any[]).map((r) => this.toRecord(r, now)),
      total,
      pendingCount,
      limit,
      offset,
    };
  }

  /**
   * Scope-gated single-row fetch — cross-scope ids return null so the
   * controller surfaces 404.
   */
  async getById(scope: ScopeTuple, approvalId: string): Promise<ApprovalRecord | null> {
    const row = await this.prisma.platosAgentApproval.findFirst({
      where: {
        approvalId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    return row ? this.toRecord(row, Date.now()) : null;
  }

  /**
   * Sweep stuck-pending rows that have outrun their timeout window. Called
   * opportunistically at list-time so the governance dashboard doesn't
   * stall on ghost rows (e.g. if the agent process crashed between opening
   * the waitpoint and the blpop-timeout branch firing). Best-effort.
   */
  async sweepExpired(scope: ScopeTuple): Promise<number> {
    try {
      // Pull pending rows, compute deadline in-memory, flip the ones past it.
      const rows = await this.prisma.platosAgentApproval.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          status: "pending",
        },
        select: { id: true, createdAt: true, timeoutSeconds: true },
      });
      const now = Date.now();
      const expiredIds = (rows as any[])
        .filter((r) => {
          const created = r.createdAt instanceof Date ? r.createdAt.getTime() : Date.parse(String(r.createdAt));
          return now - created > (r.timeoutSeconds ?? 300) * 1000;
        })
        .map((r) => r.id);
      if (expiredIds.length === 0) return 0;
      const res = await this.prisma.platosAgentApproval.updateMany({
        where: { id: { in: expiredIds }, status: "pending" },
        data: { status: "timed_out", resolvedAt: new Date() },
      });
      return res?.count ?? 0;
    } catch (err) {
      console.error("[Platos Approvals] sweepExpired failed:", err);
      return 0;
    }
  }

  /**
   * PPR-67 — scheduled sweep across every scope with pending approvals.
   * Enumerates the distinct scope tuples from `PlatosAgentApproval` rows in
   * `pending` status and runs the per-scope sweep for each. Returns totals
   * per-scope for observability.
   *
   * Called by the `platos.approvals.expiry_sweep` trigger.dev schedule via
   * the admin endpoint (see agent.controller.ts). Invoking this from the
   * list endpoint is opportunistic — the scheduled sweep is the safety net
   * that runs even when nobody is reading the governance dashboard.
   */
  async sweepExpiredAllScopes(): Promise<{
    scopesScanned: number;
    totalExpired: number;
    perScope: Array<{ organizationId: string; projectId: string; environmentId: string; expired: number }>;
  }> {
    try {
      // Distinct scope tuples with at least one pending row. findMany +
      // distinct is cheap — the PlatosAgentApproval table is small by
      // design (pending rows are short-lived).
      const tuples = await this.prisma.platosAgentApproval.findMany({
        where: { status: "pending" },
        distinct: ["organizationId", "projectId", "environmentId"],
        select: { organizationId: true, projectId: true, environmentId: true },
      });
      let totalExpired = 0;
      const perScope: Array<{ organizationId: string; projectId: string; environmentId: string; expired: number }> = [];
      for (const t of tuples as Array<{ organizationId: string; projectId: string; environmentId: string }>) {
        const expired = await this.sweepExpired(t);
        totalExpired += expired;
        perScope.push({ ...t, expired });
      }
      return { scopesScanned: tuples.length, totalExpired, perScope };
    } catch (err) {
      console.error("[Platos Approvals] sweepExpiredAllScopes failed:", err);
      return { scopesScanned: 0, totalExpired: 0, perScope: [] };
    }
  }

  private toRecord(r: any, now: number): ApprovalRecord {
    const createdAt = r.createdAt instanceof Date ? r.createdAt : new Date(String(r.createdAt));
    const updatedAt = r.updatedAt instanceof Date ? r.updatedAt : new Date(String(r.updatedAt));
    const timeoutSeconds = r.timeoutSeconds ?? 300;
    const deadlineMs = createdAt.getTime() + timeoutSeconds * 1000;
    const isPending = r.status === "pending";
    const expired = isPending && now >= deadlineMs;
    const secondsRemaining = isPending && !expired
      ? Math.max(0, Math.floor((deadlineMs - now) / 1000))
      : null;
    return {
      id: r.id,
      approvalId: r.approvalId,
      organizationId: r.organizationId,
      projectId: r.projectId,
      environmentId: r.environmentId,
      source: r.source,
      agentId: r.agentId ?? null,
      threadId: r.threadId ?? null,
      requestedBy: r.requestedBy ?? null,
      action: r.action,
      details: r.details ?? null,
      status: r.status,
      timeoutSeconds,
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      resolvedAt: r.resolvedAt
        ? (r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : String(r.resolvedAt))
        : null,
      respondedBy: r.respondedBy ?? null,
      comment: r.comment ?? null,
      deadlineAt: isPending ? new Date(deadlineMs).toISOString() : null,
      secondsRemaining,
      expired,
      toolName: r.toolName ?? null,
      args: r.args ?? null,
      resolution: r.resolution ?? null,
      consumedAt: r.consumedAt
        ? r.consumedAt instanceof Date
          ? r.consumedAt.toISOString()
          : String(r.consumedAt)
        : null,
      requestedByMcpTokenId: r.requestedByMcpTokenId ?? null,
      editedArgs: r.editedArgs ?? null,
      editedByUserId: r.editedByUserId ?? null,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // MCP approval-UI helpers — only used when MCP_INTERACTIVE_APPROVALS
  // is enabled. The waitpoint-mirror methods above are unaffected.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Compute the deterministic idempotency hash for a Platform MCP call.
   * Same scope + tool + args ⇒ same hash ⇒ deduped against any pending
   * row. Caller passes already-redacted args.
   */
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

  /**
   * Find a still-valid pending MCP approval matching `(scope, requestHash)`.
   * Used to dedupe concurrent retries — re-issuing the same call returns
   * the in-flight approval id instead of opening a fresh row each time.
   */
  async findPendingByRequestHash(
    scope: ScopeTuple,
    requestHash: string,
  ): Promise<ApprovalRecord | null> {
    const cutoff = new Date(); // expiry is computed in `toRecord`
    void cutoff;
    const row = await this.prisma.platosAgentApproval.findFirst({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        requestHash,
        status: "pending",
        source: "mcp_tool_call",
      },
      orderBy: { createdAt: "desc" },
    });
    if (!row) return null;
    const rec = this.toRecord(row, Date.now());
    // If the row has aged out of its SLA window, treat as missing so the
    // caller mints a fresh approval rather than re-using a dead row.
    if (rec.expired) return null;
    return rec;
  }

  /**
   * Open a new MCP approval row. Caller is responsible for redacting
   * `args` of any secret-bearing keys before calling.
   *
   * Returns the created (or rediscovered) record. Idempotent against
   * `requestHash` — a concurrent caller racing on the same hash gets
   * the original row back rather than a duplicate.
   */
  async createMcpApproval(input: {
    scope: ScopeTuple;
    toolName: string;
    args: Record<string, unknown>;
    requestHash: string;
    requestedByUserId?: string | null;
    requestedByMcpTokenId?: string | null;
    timeoutSeconds?: number;
    /** Short human-readable verb for the action column. */
    actionLabel?: string;
  }): Promise<ApprovalRecord> {
    // Race-fix: re-check pending hash within the same path even when the
    // caller already checked, to close the create→duplicate window. The
    // unique index on `(scope, approvalId)` is the backstop.
    const existing = await this.findPendingByRequestHash(input.scope, input.requestHash);
    if (existing) return existing;

    const approvalId = `appr_mcp_${randomBytes(8).toString("hex")}`;
    const action = input.actionLabel ?? `MCP tool call: ${input.toolName}`;
    try {
      const created = await this.prisma.platosAgentApproval.create({
        data: {
          approvalId,
          organizationId: input.scope.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          source: "mcp_tool_call" as ApprovalSource,
          agentId: null,
          threadId: null,
          requestedBy: input.requestedByUserId ?? null,
          action,
          details: null,
          status: "pending",
          timeoutSeconds: Math.max(60, Math.round(input.timeoutSeconds ?? 3600)),
          toolName: input.toolName,
          args: input.args as any,
          requestHash: input.requestHash,
          requestedByMcpTokenId: input.requestedByMcpTokenId ?? null,
        },
      });
      return this.toRecord(created, Date.now());
    } catch (err) {
      // Concurrent insert with the same approvalId is structurally
      // impossible (we mint a fresh one above). Concurrent insert with
      // the same requestHash is possible if two callers raced past the
      // findPendingByRequestHash check — re-read and return whichever
      // landed first.
      const fallback = await this.findPendingByRequestHash(input.scope, input.requestHash);
      if (fallback) return fallback;
      throw err;
    }
  }

  /**
   * Stamp an MCP approval as consumed (the tool actually executed) and
   * cache its result. The next retry of the same call returns this
   * cached result so the operation is idempotent.
   */
  async markMcpConsumed(
    scope: ScopeTuple,
    approvalId: string,
    resolution: unknown,
  ): Promise<void> {
    try {
      await this.prisma.platosAgentApproval.updateMany({
        where: {
          approvalId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          source: "mcp_tool_call",
        },
        data: {
          consumedAt: new Date(),
          resolution: resolution as any,
        },
      });
    } catch (err) {
      console.error("[Platos Approvals] markMcpConsumed failed:", err);
    }
  }
}
