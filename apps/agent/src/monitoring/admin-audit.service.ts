import { Injectable, Inject, Logger } from "@nestjs/common";
import type { Prisma } from "@platos/database";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

/**
 * EOBD.44 — Admin-action audit log.
 *
 * Complements `PlatosToolCallAudit` (tool dispatches only). Every
 * destructive admin operation must land a row here so we can answer
 * "who deleted agent X at time Y, and what did it look like before?"
 *
 * Recording is fire-and-forget from the caller's perspective — a DB
 * hiccup mid-audit must not fail the admin action itself. The caller
 * `await`s if they want transactional guarantees (see `recordSync`).
 *
 * Known integration points (update as we wire them):
 *   - agent CRUD: delete, rollback, canary-split change, feature toggle
 *   - entity CRUD: secret rotation, initial-secret reveal
 *   - memory CRUD: delete, import-replace
 *   - approvals: resolve
 *   - skills: enable/disable
 */
export type AdminAuditInput = {
  action: string;
  subjectType: string;
  subjectId?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  reason?: string;
  source?: "ui" | "api" | "scheduled" | string;
};

@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  /**
   * Fire-and-forget. Logs + swallows DB errors so the originating
   * admin action can succeed even if the audit write fails.
   */
  record(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">,
    input: AdminAuditInput,
  ): void {
    this.recordSync(scope, input).catch((err) => {
      this.logger.warn(
        `admin-audit write failed (action=${input.action}, subject=${input.subjectType}/${input.subjectId}): ${err?.message}`,
      );
    });
  }

  /**
   * Awaits the write. Use when the caller wants transactional
   * guarantees (e.g. within the same transaction as the delete).
   */
  async recordSync(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">,
    input: AdminAuditInput,
  ): Promise<void> {
    await this.prisma.adminAudit.create({
      data: {
        environmentId: scope.environmentId,
        actorUserId: scope.userId ?? null,
        action: input.action,
        subjectType: input.subjectType,
        subjectId: input.subjectId ?? null,
        before: (input.beforeJson ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        after: (input.afterJson ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        reason: input.reason ?? null,
        source: input.source ?? "api",
      },
    });
  }
}
