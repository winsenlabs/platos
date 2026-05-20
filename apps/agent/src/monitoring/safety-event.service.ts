import { Injectable, Inject, Optional } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { MessageCryptoService } from "./message-crypto.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

// PRELAUNCH-A3-4 — added "rate_limit" + "budget" so enforcement-layer
// denials get their own detector ledger entries instead of being aliased
// onto "exfiltration" (which carried a misleading semantic).
export type DetectorKind =
  | "pii"
  | "injection"
  | "grounded"
  | "exfiltration"
  | "tool_param"
  | "rate_limit"
  | "budget"
  // Issue #1 — emitted by ToolExecutorService when the optional
  // 4-tier permission gate (PLATOS_TOOL_DISPATCH_PERMISSION_GATE=1)
  // blocks or flags a dispatch.
  | "dispatcher_permission_gate";
export type DetectorAction = "flag" | "redact" | "block" | "warn";

export interface SafetyEventRow {
  id: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  agentId: string | null;
  threadId: string | null;
  messageId: string | null;
  userId: string | null;
  detector: DetectorKind;
  action: DetectorAction;
  severity: "low" | "medium" | "high";
  detail: string | null;
  meta: any;
  toolName: string | null;
  toolCallId: string | null;
  createdAt: Date;
}

/**
 * Theme H — Safety event ledger.
 *
 * Thin CRUD + query layer for the governance dashboard. Writes are fire-
 * and-forget from the SafetyService / detector pipelines; the governance
 * dashboard reads back with filters + pagination.
 */
@Injectable()
export class SafetyEventService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    @Optional() private readonly crypto?: MessageCryptoService,
  ) {
    this.prisma = prisma;
  }

  async record(
    scope: ScopeTuple,
    data: {
      detector: DetectorKind;
      action: DetectorAction;
      severity: "low" | "medium" | "high";
      detail?: string | null;
      meta?: unknown;
      agentId?: string | null;
      threadId?: string | null;
      messageId?: string | null;
      userId?: string | null;
      toolName?: string | null;
      toolCallId?: string | null;
    },
  ): Promise<void> {
    try {
      // EOBD.21 — PII-bearing fields (detail, meta) encrypted at rest.
      // detail is a String column — wrap in JSON.stringify envelope when
      // crypto available; leave plaintext otherwise so dashboards still
      // work in dev.
      const encDetail = this.encryptString(data.detail);
      const encMeta =
        this.crypto?.encryptJsonField(data.meta ?? null) ?? (data.meta ?? null);
      await this.prisma.platosSafetyEvent.create({
        data: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          detector: data.detector,
          action: data.action,
          severity: data.severity,
          detail: encDetail,
          meta: encMeta as any,
          agentId: data.agentId ?? null,
          threadId: data.threadId ?? null,
          messageId: data.messageId ?? null,
          userId: data.userId ?? null,
          toolName: data.toolName ?? null,
          toolCallId: data.toolCallId ?? null,
        },
      });
    } catch {
      // Best-effort — safety signals should never break a turn.
    }
  }

  /** Envelope-stringify a String field so String columns can hold encrypted PII. */
  private encryptString(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!this.crypto) return value;
    const wrapped = this.crypto.encryptJsonField(value);
    if (wrapped && typeof wrapped === "object" && (wrapped as any).__platos_enc === 1) {
      return JSON.stringify(wrapped);
    }
    return value;
  }

  private decryptString(value: string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (!this.crypto) return value;
    if (!value.startsWith("{\"__platos_enc\"")) return value;
    try {
      const parsed = JSON.parse(value);
      const plain = this.crypto.decryptJsonField(parsed);
      return typeof plain === "string" ? plain : value;
    } catch {
      return value;
    }
  }

  async list(
    scope: ScopeTuple,
    options: {
      detector?: DetectorKind;
      action?: DetectorAction;
      threadId?: string;
      agentId?: string;
      userId?: string;
      severity?: "low" | "medium" | "high";
      sinceDays?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<{ rows: SafetyEventRow[]; total: number; limit: number; offset: number }> {
    const sinceDays = Math.max(1, Math.min(options.sinceDays ?? 30, 365));
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
    const offset = Math.max(0, options.offset ?? 0);

    const where: any = {
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      createdAt: { gte: new Date(Date.now() - sinceDays * 86400_000) },
    };
    if (options.detector) where.detector = options.detector;
    if (options.action) where.action = options.action;
    if (options.threadId) where.threadId = options.threadId;
    if (options.agentId) where.agentId = options.agentId;
    if (options.userId) where.userId = options.userId;
    if (options.severity) where.severity = options.severity;

    const [rawRows, total] = await Promise.all([
      this.prisma.platosSafetyEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.platosSafetyEvent.count({ where }),
    ]);

    // EOBD.21 — transparent decryption on read. Unencrypted rows pass through.
    const rows = rawRows.map((r: any) => ({
      ...r,
      detail: this.decryptString(r.detail),
      meta: this.crypto?.decryptJsonField(r.meta ?? null) ?? (r.meta ?? null),
    }));

    return { rows, total, limit, offset };
  }

  async summary(
    scope: ScopeTuple,
    options: { sinceDays?: number } = {},
  ): Promise<{
    total: number;
    byDetector: Record<string, number>;
    byAction: Record<string, number>;
    bySeverity: Record<string, number>;
  }> {
    const sinceDays = Math.max(1, Math.min(options.sinceDays ?? 30, 365));
    const since = new Date(Date.now() - sinceDays * 86400_000);
    const rows: Array<{ detector: string; action: string; severity: string }> =
      await this.prisma.platosSafetyEvent.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          createdAt: { gte: since },
        },
        select: { detector: true, action: true, severity: true },
      });
    const byDetector: Record<string, number> = {};
    const byAction: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const r of rows) {
      byDetector[r.detector] = (byDetector[r.detector] ?? 0) + 1;
      byAction[r.action] = (byAction[r.action] ?? 0) + 1;
      bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    }
    return { total: rows.length, byDetector, byAction, bySeverity };
  }
}
