import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { AttachmentsService } from "../agent-runtime/attachments.service";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { Inject } from "@nestjs/common";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";

/**
 * PIFSP-16 — File System: 4-level hierarchy for browsing attachments.
 *   Level 1: agents with attachments in scope
 *   Level 2: users per agent
 *   Level 3: conversations (threads) per user+agent
 *   Level 4: attachments per thread
 *
 * All endpoints scope-gated by ScopeGuard (X-Platos-* headers → req.scope).
 */
@Controller("api/v1/agent/files")
export class FilesController {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly attachmentsService: AttachmentsService,
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

  /** Level 1 — agents that have at least one attachment. */
  @Get("agents")
  async listAgents(
    @Req() req: Request,
    @Query("limit") limitRaw?: string,
    @Query("cursor") cursor?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const limit = Math.min(200, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 50 : 50));

    const rows: Array<{
      agentId: string;
      _count: number;
      lastAt: Date;
    }> = await this.prisma.$queryRaw`
      SELECT
        a.id AS "agentId",
        COUNT(att.id)::int AS "_count",
        MAX(att."createdAt") AS "lastAt"
      FROM "Agent" a
      JOIN "AgentBinding" binding ON binding."agentId" = a.id
        AND binding."environmentId" = ${scope.environmentId}
      JOIN "Thread" t ON t."agentId" = a.id
        AND t."environmentId" = binding."environmentId"
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id
        AND att."environmentId" = t."environmentId"
        AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      WHERE environment.id = ${scope.environmentId}
        AND project.id = ${scope.projectId}
        AND project."organizationId" = ${scope.organizationId}
        AND a."projectId" = project.id
      GROUP BY a.id
      ORDER BY "lastAt" DESC
      LIMIT ${limit}
    `;

    // Fetch agent names
    const agentIds = rows.map((r) => r.agentId);
    const agentRows: Array<{ id: string; name: string }> = agentIds.length
      ? await this.prisma.agent.findMany({
          where: {
            id: { in: agentIds },
            projectId: scope.projectId,
            project: { organizationId: scope.organizationId },
            bindings: { some: { environmentId: scope.environmentId } },
          },
          select: { id: true, name: true },
        })
      : [];
    const nameMap = new Map(agentRows.map((a) => [a.id, a.name]));

    let agents = rows.map((r) => ({
      agentId: r.agentId,
      name: nameMap.get(r.agentId) ?? r.agentId,
      attachmentCount: r._count,
      lastAttachmentAt: r.lastAt?.toISOString() ?? null,
    }));

    if (search) {
      const q = search.toLowerCase();
      agents = agents.filter((a) => a.name.toLowerCase().includes(q) || a.agentId.toLowerCase().includes(q));
    }

    return { agents, fetchedAt: new Date().toISOString() };
  }

  /** Level 2 — users for a given agent. */
  @Get("agents/:agentId/users")
  async listUsers(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("limit") limitRaw?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const limit = Math.min(200, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 50 : 50));

    const rows: Array<{
      userId: string;
      attachmentCount: number;
      distinctThreads: number;
      lastAt: Date;
    }> = await this.prisma.$queryRaw`
      SELECT
        t."endUserId" AS "userId",
        COUNT(att.id)::int AS "attachmentCount",
        COUNT(DISTINCT t.id)::int AS "distinctThreads",
        MAX(att."createdAt") AS "lastAt"
      FROM "Thread" t
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id
        AND att."environmentId" = t."environmentId"
        AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      JOIN "AgentBinding" binding ON binding."agentId" = t."agentId"
        AND binding."environmentId" = t."environmentId"
      WHERE t."agentId" = ${agentId}
        AND t."environmentId" = ${scope.environmentId}
        AND project.id = ${scope.projectId}
        AND project."organizationId" = ${scope.organizationId}
      GROUP BY t."endUserId"
      ORDER BY "lastAt" DESC
      LIMIT ${limit}
    `;

    let users = rows.map((r) => ({
      userId: r.userId,
      attachmentCount: r.attachmentCount,
      distinctThreads: r.distinctThreads,
      lastAttachmentAt: r.lastAt?.toISOString() ?? null,
    }));

    if (search) {
      const q = search.toLowerCase();
      users = users.filter((u) => u.userId.toLowerCase().includes(q));
    }

    return { agentId, users, fetchedAt: new Date().toISOString() };
  }

  /** Level 3 — conversations (threads) for a user on an agent. */
  @Get("agents/:agentId/users/:userId/conversations")
  async listConversations(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("userId") userId: string,
    @Query("limit") limitRaw?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const limit = Math.min(200, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 50 : 50));

    const rows: Array<{
      threadId: string;
      title: string | null;
      attachmentCount: number;
      lastAt: Date;
    }> = await this.prisma.$queryRaw`
      SELECT
        t.id AS "threadId",
        t.title,
        COUNT(att.id)::int AS "attachmentCount",
        MAX(att."createdAt") AS "lastAt"
      FROM "Thread" t
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id
        AND att."environmentId" = t."environmentId"
        AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      JOIN "AgentBinding" binding ON binding."agentId" = t."agentId"
        AND binding."environmentId" = t."environmentId"
      WHERE t."agentId" = ${agentId}
        AND t."endUserId" = ${userId}
        AND t."environmentId" = ${scope.environmentId}
        AND project.id = ${scope.projectId}
        AND project."organizationId" = ${scope.organizationId}
      GROUP BY t.id, t.title
      ORDER BY "lastAt" DESC
      LIMIT ${limit}
    `;

    let conversations = rows.map((r) => ({
      threadId: r.threadId,
      title: r.title,
      attachmentCount: r.attachmentCount,
      lastActivityAt: r.lastAt?.toISOString() ?? null,
    }));

    if (search) {
      const q = search.toLowerCase();
      conversations = conversations.filter(
        (c) => (c.title ?? "").toLowerCase().includes(q) || c.threadId.toLowerCase().includes(q),
      );
    }

    return { agentId, userId, conversations, fetchedAt: new Date().toISOString() };
  }

  /** Level 4 — attachments for a thread, with presigned download URLs. */
  @Get("threads/:threadId/attachments")
  async listAttachments(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Query("limit") limitRaw?: string,
    @Query("search") search?: string,
    @Query("mime") mimeFilter?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const limit = Math.min(200, Math.max(1, limitRaw ? parseInt(limitRaw, 10) || 50 : 50));

    const whereBase: Record<string, unknown> = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
      turn: { threadId },
    };

    const rows: Array<{
      id: string;
      originalName: string | null;
      mimeType: string;
      bytes: number;
      createdAt: Date;
      storageKey: string;
      turnId: string | null;
      kind: string;
    }> = await this.prisma.messageAttachment.findMany({
      where: whereBase,
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        bytes: true,
        createdAt: true,
        storageKey: true,
        turnId: true,
        kind: true,
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Apply search/mime filter
    let filtered = rows;
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (r) => (r.originalName ?? "").toLowerCase().includes(q) || r.mimeType.toLowerCase().includes(q),
      );
    }
    if (mimeFilter) {
      filtered = filtered.filter((r) => r.mimeType.startsWith(mimeFilter));
    }

    // Generate presigned download URLs
    const attachments = await Promise.all(
      filtered.map(async (r) => {
        let downloadUrl: string | null = null;
        try {
          downloadUrl = await this.attachmentsService.getPresignedDownloadUrl(r.storageKey);
        } catch {
          // MinIO unavailable — client gets null download URL
        }
        return {
          id: r.id,
          filename: r.originalName ?? r.id,
          mimeType: r.mimeType,
          kind: r.kind,
          bytes: r.bytes,
          uploadedAt: r.createdAt.toISOString(),
          // Compatibility name for existing clients; the identifier is now a
          // clean Turn id, not one half of a legacy message pair.
          messageId: r.turnId,
          turnId: r.turnId,
          downloadUrl,
        };
      }),
    );

    return { threadId, attachments, fetchedAt: new Date().toISOString() };
  }
}
