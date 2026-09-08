import { Controller, Get, Param, Query, Req } from "@nestjs/common";
import { API_VERSION } from "../http/api-surface";
import type { Request } from "express";
import { AttachmentsService } from "../agent-runtime/attachments.service";
import type { RequestScope } from "../auth/scope.guard";
import { requireOperator } from "../auth/scope.guard";
import { pageMetadata, parsePageRequest, parseTextFilter } from "../shared/pagination";
import { FileBrowserStore } from "./file-browser.store";

/**
 * PIFSP-16 — File System: 4-level hierarchy for browsing attachments.
 *   Level 1: agents with attachments in scope
 *   Level 2: users per agent
 *   Level 3: conversations (threads) per user+agent
 *   Level 4: attachments per thread
 *
 * All endpoints scope-gated by ScopeGuard (X-Platos-* headers → req.scope).
 *
 * WIN-258: the eight queries behind these four levels — six hand-written
 * `$queryRaw` blocks and one delegate pair — now live in `FileBrowserStore`.
 * What is left here is the transport's own work: operator admission, page
 * parsing, presigned URL minting and the response envelope.
 */
@Controller({ path: "agent/files", version: API_VERSION })
export class FilesController {
  constructor(
    private readonly browser: FileBrowserStore,
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

    const { rows, total } = await this.browser.agents(scope, {
      pageSize: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    const agents = rows.map((row) => ({
      agentId: row.agentId,
      name: row.name,
      attachmentCount: row.attachmentCount,
      lastAttachmentAt: row.lastAttachmentAt?.toISOString() ?? null,
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

    const { rows, total } = await this.browser.users(scope, agentId, {
      pageSize: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    const users = rows.map((row) => ({
      userId: row.userId,
      attachmentCount: row.attachmentCount,
      distinctThreads: row.distinctThreads,
      lastAttachmentAt: row.lastAttachmentAt?.toISOString() ?? null,
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

    const { rows, total } = await this.browser.conversations(scope, agentId, userId, {
      pageSize: request.pageSize,
      offset: request.offset,
      search: request.search,
    });
    const conversations = rows.map((row) => ({
      threadId: row.threadId,
      title: row.title,
      attachmentCount: row.attachmentCount,
      lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
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

    const { rows, total } = await this.browser.attachments(
      scope,
      threadId,
      { pageSize: request.pageSize, offset: request.offset, search: request.search },
      mime,
    );

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
