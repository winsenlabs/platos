import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { AttachmentsService } from "../agent-runtime/attachments.service";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { Inject } from "@nestjs/common";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";
import { Prisma } from "@platos/tenancy-database";
import { pageMetadata, parsePageRequest, parseTextFilter } from "../shared/pagination";

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
    @Query("offset") offsetRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search }, { defaultPageSize: 50 });
    const searchPredicate = request.search
      ? Prisma.sql`AND (a.name ILIKE ${`%${request.search}%`} OR CAST(a.id AS text) ILIKE ${`%${request.search}%`})`
      : Prisma.empty;

    const [rows, totalRows] = await Promise.all([this.prisma.$queryRaw(Prisma.sql`
      SELECT
        a.id AS "agentId",
        a.name,
        COUNT(att.id)::int AS "_count",
        MAX(att."createdAt") AS "lastAt"
      FROM "Agent" a
      JOIN "AgentBinding" binding ON binding."agentId" = a.id
        AND binding."environmentId" = CAST(${scope.environmentId} AS uuid)
      JOIN "Thread" t ON t."agentId" = a.id
        AND t."environmentId" = binding."environmentId"
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id
        AND att."environmentId" = t."environmentId"
        AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      WHERE environment.id = CAST(${scope.environmentId} AS uuid)
        AND project.id = CAST(${scope.projectId} AS uuid)
        AND project."organizationId" = CAST(${scope.organizationId} AS uuid)
        AND a."projectId" = project.id
        ${searchPredicate}
      GROUP BY a.id, a.name
      ORDER BY "lastAt" DESC, a.id DESC
      LIMIT ${request.pageSize}
      OFFSET ${request.offset}
    `), this.prisma.$queryRaw(Prisma.sql`
      SELECT COUNT(DISTINCT a.id)::int AS total
      FROM "Agent" a
      JOIN "AgentBinding" binding ON binding."agentId" = a.id
        AND binding."environmentId" = CAST(${scope.environmentId} AS uuid)
      JOIN "Thread" t ON t."agentId" = a.id AND t."environmentId" = binding."environmentId"
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id
        AND att."environmentId" = t."environmentId" AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      WHERE environment.id = CAST(${scope.environmentId} AS uuid)
        AND project.id = CAST(${scope.projectId} AS uuid)
        AND project."organizationId" = CAST(${scope.organizationId} AS uuid)
        AND a."projectId" = project.id
        ${searchPredicate}
    `)]) as [Array<{
      agentId: string;
      name: string;
      _count: number;
      lastAt: Date;
    }>, Array<{ total: number }>];
    const total = totalRows[0]?.total ?? 0;
    const agents = rows.map((r) => ({
      agentId: r.agentId,
      name: r.name,
      attachmentCount: r._count,
      lastAttachmentAt: r.lastAt?.toISOString() ?? null,
    }));
    const pagination = pageMetadata(total, request);
    return { agents, items: agents, total, limit: request.pageSize, offset: request.offset, hasMore: pagination.hasNext, pagination, filters: { search: request.search }, fetchedAt: new Date().toISOString() };
  }

  /** Level 2 — users for a given agent. */
  @Get("agents/:agentId/users")
  async listUsers(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search }, { defaultPageSize: 50 });
    const searchPredicate = request.search
      ? Prisma.sql`AND CAST(t."endUserId" AS text) ILIKE ${`%${request.search}%`}`
      : Prisma.empty;

    const [rows, totalRows] = await Promise.all([this.prisma.$queryRaw(Prisma.sql`
      SELECT t."endUserId" AS "userId", COUNT(att.id)::int AS "attachmentCount",
        COUNT(DISTINCT t.id)::int AS "distinctThreads", MAX(att."createdAt") AS "lastAt"
      FROM "Thread" t
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id AND att."environmentId" = t."environmentId" AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      JOIN "AgentBinding" binding ON binding."agentId" = t."agentId" AND binding."environmentId" = t."environmentId"
      WHERE t."agentId" = CAST(${agentId} AS uuid) AND t."environmentId" = CAST(${scope.environmentId} AS uuid)
        AND project.id = CAST(${scope.projectId} AS uuid) AND project."organizationId" = CAST(${scope.organizationId} AS uuid)
        ${searchPredicate}
      GROUP BY t."endUserId"
      ORDER BY "lastAt" DESC, t."endUserId" DESC
      LIMIT ${request.pageSize} OFFSET ${request.offset}
    `), this.prisma.$queryRaw(Prisma.sql`
      SELECT COUNT(DISTINCT t."endUserId")::int AS total
      FROM "Thread" t
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id AND att."environmentId" = t."environmentId" AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      JOIN "AgentBinding" binding ON binding."agentId" = t."agentId" AND binding."environmentId" = t."environmentId"
      WHERE t."agentId" = CAST(${agentId} AS uuid) AND t."environmentId" = CAST(${scope.environmentId} AS uuid)
        AND project.id = CAST(${scope.projectId} AS uuid) AND project."organizationId" = CAST(${scope.organizationId} AS uuid)
        ${searchPredicate}
    `)]) as [Array<{
      userId: string;
      attachmentCount: number;
      distinctThreads: number;
      lastAt: Date;
    }>, Array<{ total: number }>];
    const total = totalRows[0]?.total ?? 0;
    const users = rows.map((r) => ({
      userId: r.userId,
      attachmentCount: r.attachmentCount,
      distinctThreads: r.distinctThreads,
      lastAttachmentAt: r.lastAt?.toISOString() ?? null,
    }));

    const pagination = pageMetadata(total, request);
    return { agentId, users, items: users, total, limit: request.pageSize, offset: request.offset, hasMore: pagination.hasNext, pagination, filters: { search: request.search }, fetchedAt: new Date().toISOString() };
  }

  /** Level 3 — conversations (threads) for a user on an agent. */
  @Get("agents/:agentId/users/:userId/conversations")
  async listConversations(
    @Req() req: Request,
    @Param("agentId") agentId: string,
    @Param("userId") userId: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("search") search?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search }, { defaultPageSize: 50 });
    const searchPredicate = request.search
      ? Prisma.sql`AND (COALESCE(t.title, '') ILIKE ${`%${request.search}%`} OR CAST(t.id AS text) ILIKE ${`%${request.search}%`})`
      : Prisma.empty;

    const [rows, totalRows] = await Promise.all([this.prisma.$queryRaw(Prisma.sql`
      SELECT t.id AS "threadId", t.title, COUNT(att.id)::int AS "attachmentCount", MAX(att."createdAt") AS "lastAt"
      FROM "Thread" t
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id AND att."environmentId" = t."environmentId" AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      JOIN "AgentBinding" binding ON binding."agentId" = t."agentId" AND binding."environmentId" = t."environmentId"
      WHERE t."agentId" = CAST(${agentId} AS uuid) AND t."endUserId" = CAST(${userId} AS uuid)
        AND t."environmentId" = CAST(${scope.environmentId} AS uuid) AND project.id = CAST(${scope.projectId} AS uuid)
        AND project."organizationId" = CAST(${scope.organizationId} AS uuid) ${searchPredicate}
      GROUP BY t.id, t.title
      ORDER BY "lastAt" DESC, t.id DESC
      LIMIT ${request.pageSize} OFFSET ${request.offset}
    `), this.prisma.$queryRaw(Prisma.sql`
      SELECT COUNT(DISTINCT t.id)::int AS total
      FROM "Thread" t
      JOIN "Turn" turn ON turn."threadId" = t.id
      JOIN "MessageAttachment" att ON att."turnId" = turn.id AND att."environmentId" = t."environmentId" AND att."endUserId" = t."endUserId"
      JOIN "Environment" environment ON environment.id = t."environmentId"
      JOIN "Project" project ON project.id = environment."projectId"
      JOIN "AgentBinding" binding ON binding."agentId" = t."agentId" AND binding."environmentId" = t."environmentId"
      WHERE t."agentId" = CAST(${agentId} AS uuid) AND t."endUserId" = CAST(${userId} AS uuid)
        AND t."environmentId" = CAST(${scope.environmentId} AS uuid) AND project.id = CAST(${scope.projectId} AS uuid)
        AND project."organizationId" = CAST(${scope.organizationId} AS uuid) ${searchPredicate}
    `)]) as [Array<{
      threadId: string;
      title: string | null;
      attachmentCount: number;
      lastAt: Date;
    }>, Array<{ total: number }>];
    const total = totalRows[0]?.total ?? 0;
    const conversations = rows.map((r) => ({
      threadId: r.threadId,
      title: r.title,
      attachmentCount: r.attachmentCount,
      lastActivityAt: r.lastAt?.toISOString() ?? null,
    }));

    const pagination = pageMetadata(total, request);
    return { agentId, userId, conversations, items: conversations, total, limit: request.pageSize, offset: request.offset, hasMore: pagination.hasNext, pagination, filters: { search: request.search }, fetchedAt: new Date().toISOString() };
  }

  /** Level 4 — attachments for a thread, with presigned download URLs. */
  @Get("threads/:threadId/attachments")
  async listAttachments(
    @Req() req: Request,
    @Param("threadId") threadId: string,
    @Query("limit") limitRaw?: string,
    @Query("offset") offsetRaw?: string,
    @Query("page") pageRaw?: string,
    @Query("search") search?: string,
    @Query("mime") mimeFilter?: string,
  ) {
    const scope = this.getScope(req);
    requireOperator(scope); // SECURITY (audit H10) — file browser is operator-only (cross-user presigned URLs)
    const request = parsePageRequest({ page: pageRaw, limit: limitRaw, offset: offsetRaw, search }, { defaultPageSize: 50 });
    const mime = parseTextFilter(mimeFilter, "mime");

    const whereBase: Prisma.MessageAttachmentWhereInput = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
      turn: { threadId },
      ...(request.search
        ? {
            OR: [
              { originalName: { contains: request.search, mode: "insensitive" } },
              { mimeType: { contains: request.search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(mime ? { mimeType: { startsWith: mime, mode: "insensitive" } } : {}),
    };

    const [rows, total] = await Promise.all([this.prisma.messageAttachment.findMany({
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
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: request.pageSize,
      skip: request.offset,
    }), this.prisma.messageAttachment.count({ where: whereBase })]) as [Array<{
      id: string;
      originalName: string | null;
      mimeType: string;
      bytes: number;
      createdAt: Date;
      storageKey: string;
      turnId: string | null;
      kind: string;
    }>, number];

    // Generate presigned download URLs
    const attachments = await Promise.all(
      rows.map(async (r) => {
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

    const pagination = pageMetadata(total, request);
    return { threadId, attachments, items: attachments, total, limit: request.pageSize, offset: request.offset, hasMore: pagination.hasNext, pagination, filters: { search: request.search, mime }, fetchedAt: new Date().toISOString() };
  }
}
