import { Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@platos/tenancy-database";
import { PRISMA_TOKEN } from "../shared/database.provider";

/**
 * Every query behind the four-level attachment browser.
 *
 * WIN-258's open clause is "no transport imports Prisma".
 * `files.controller.ts` held EIGHT queries — six hand-written `$queryRaw`
 * blocks and one delegate pair — and with them the whole tenancy predicate of
 * an operator-only surface that hands out presigned download URLs across users.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS ACTUALLY WRONG WITH IT, BEYOND THE IMPORT
 *
 * Each of the three raw levels ran TWO queries: one for the page and one for
 * the total. The join tree and the WHERE were written out separately in each,
 * so every level had two independent copies of the clause that confines results
 * to one organization, project and environment — six copies in all, plus the
 * delegate pair's. Two failure modes follow directly, and neither is visible in
 * a review that reads one query at a time:
 *
 *   - A total computed from a DIFFERENT predicate than its page. The paginator
 *     then reports a count from a wider set than it returned, and "hasMore"
 *     lies. Nothing in the response makes that detectable.
 *   - A scope clause weakened in ONE of the copies. That is a cross-tenant leak
 *     on a surface whose whole purpose is issuing download URLs for other
 *     users' files.
 *
 * Below, each level builds its FROM and its WHERE ONCE and hands the same two
 * fragments to both statements. The page and its count cannot disagree, because
 * they are no longer two spellings of the same intent — they are one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `FilesContract`
 *
 * `packages/contexts/files/` publishes `createFilesContract`, and it is the
 * NEAREST MISS in this tranche: of the ports in `FilesDependencies`, the
 * repository is `postgres-tenancy` (constructed), `unitOfWork` is on that same
 * adapter, and `tenancy` is the one context the composition root can build.
 * Exactly ONE slot blocks it — `objectStore: ObjectStore`, bound to
 * `packages/adapters/objectstore-minio`, which is named in
 * `UNIMPLEMENTED_ADAPTERS`: its `src/adapter.ts` is the generated interface and
 * exports no constructor.
 *
 * That is worth stating precisely, because it is the shortest path from here to
 * the clause's stronger reading: implement one adapter and this context becomes
 * composable. The second blocker is unchanged — `apps/agent` depends on no
 * `@platos/context-*` package and has no seam through which a composed contract
 * could reach its Nest container.
 */

/** The tenancy axes every query in this file is confined to. */
export interface FileBrowserScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export interface BrowsePage {
  readonly pageSize: number;
  readonly offset: number;
  readonly search?: string | null;
}

export interface AgentWithAttachments {
  readonly agentId: string;
  readonly name: string;
  readonly attachmentCount: number;
  readonly lastAttachmentAt: Date | null;
}

export interface UserWithAttachments {
  readonly userId: string;
  readonly attachmentCount: number;
  readonly distinctThreads: number;
  readonly lastAttachmentAt: Date | null;
}

export interface ConversationWithAttachments {
  readonly threadId: string;
  readonly title: string | null;
  readonly attachmentCount: number;
  readonly lastActivityAt: Date | null;
}

export interface AttachmentRecord {
  readonly id: string;
  readonly originalName: string | null;
  readonly mimeType: string;
  readonly bytes: number;
  readonly createdAt: Date;
  readonly storageKey: string;
  readonly turnId: string | null;
  readonly kind: string;
}

export interface Counted<Row> {
  readonly rows: readonly Row[];
  readonly total: number;
}

/** `%term%`, or the empty fragment when there is no term. */
function contains(term: string | null | undefined): string {
  return `%${term ?? ""}%`;
}

/**
 * The join tree shared by the user and conversation levels.
 *
 * Written once because the two levels' trees were character-identical, and a
 * tree that is copied is a tree that can be edited in one place only.
 */
const THREAD_ATTACHMENT_JOINS = Prisma.sql`
  FROM "Thread" t
  JOIN "Turn" turn ON turn."threadId" = t.id
  JOIN "MessageAttachment" att ON att."turnId" = turn.id
    AND att."environmentId" = t."environmentId"
    AND att."endUserId" = t."endUserId"
  JOIN "Environment" environment ON environment.id = t."environmentId"
  JOIN "Project" project ON project.id = environment."projectId"
  JOIN "AgentBinding" binding ON binding."agentId" = t."agentId"
    AND binding."environmentId" = t."environmentId"
`;

/** The tenancy predicate for a thread-rooted query. Never inlined twice. */
function threadScopePredicate(scope: FileBrowserScope): Prisma.Sql {
  return Prisma.sql`
    t."environmentId" = CAST(${scope.environmentId} AS uuid)
    AND project.id = CAST(${scope.projectId} AS uuid)
    AND project."organizationId" = CAST(${scope.organizationId} AS uuid)
  `;
}

@Injectable()
export class FileBrowserStore {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  /** Level 1 — agents with at least one attachment in scope. */
  async agents(
    scope: FileBrowserScope,
    page: BrowsePage,
  ): Promise<Counted<AgentWithAttachments>> {
    const search = page.search
      ? Prisma.sql`AND (a.name ILIKE ${contains(page.search)} OR CAST(a.id AS text) ILIKE ${contains(page.search)})`
      : Prisma.empty;

    // This level roots at Agent rather than Thread, so it has its own tree.
    const joins = Prisma.sql`
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
    `;
    const where = Prisma.sql`
      WHERE environment.id = CAST(${scope.environmentId} AS uuid)
        AND project.id = CAST(${scope.projectId} AS uuid)
        AND project."organizationId" = CAST(${scope.organizationId} AS uuid)
        AND a."projectId" = project.id
        ${search}
    `;

    const [rows, totals] = (await Promise.all([
      this.prisma.$queryRaw(Prisma.sql`
        SELECT
          a.id AS "agentId",
          a.name,
          COUNT(att.id)::int AS "_count",
          MAX(att."createdAt") AS "lastAt"
        ${joins}
        ${where}
        GROUP BY a.id, a.name
        ORDER BY "lastAt" DESC, a.id DESC
        LIMIT ${page.pageSize}
        OFFSET ${page.offset}
      `),
      this.prisma.$queryRaw(Prisma.sql`
        SELECT COUNT(DISTINCT a.id)::int AS total
        ${joins}
        ${where}
      `),
    ])) as [
      Array<{ agentId: string; name: string; _count: number; lastAt: Date | null }>,
      Array<{ total: number }>,
    ];

    return {
      rows: rows.map((row) => ({
        agentId: row.agentId,
        name: row.name,
        attachmentCount: row._count,
        lastAttachmentAt: row.lastAt ?? null,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  /** Level 2 — end users who have attachments on one agent. */
  async users(
    scope: FileBrowserScope,
    agentId: string,
    page: BrowsePage,
  ): Promise<Counted<UserWithAttachments>> {
    const search = page.search
      ? Prisma.sql`AND CAST(t."endUserId" AS text) ILIKE ${contains(page.search)}`
      : Prisma.empty;
    const where = Prisma.sql`
      WHERE t."agentId" = CAST(${agentId} AS uuid)
        AND ${threadScopePredicate(scope)}
        ${search}
    `;

    const [rows, totals] = (await Promise.all([
      this.prisma.$queryRaw(Prisma.sql`
        SELECT t."endUserId" AS "userId",
          COUNT(att.id)::int AS "attachmentCount",
          COUNT(DISTINCT t.id)::int AS "distinctThreads",
          MAX(att."createdAt") AS "lastAt"
        ${THREAD_ATTACHMENT_JOINS}
        ${where}
        GROUP BY t."endUserId"
        ORDER BY "lastAt" DESC, t."endUserId" DESC
        LIMIT ${page.pageSize} OFFSET ${page.offset}
      `),
      this.prisma.$queryRaw(Prisma.sql`
        SELECT COUNT(DISTINCT t."endUserId")::int AS total
        ${THREAD_ATTACHMENT_JOINS}
        ${where}
      `),
    ])) as [
      Array<{
        userId: string;
        attachmentCount: number;
        distinctThreads: number;
        lastAt: Date | null;
      }>,
      Array<{ total: number }>,
    ];

    return {
      rows: rows.map((row) => ({
        userId: row.userId,
        attachmentCount: row.attachmentCount,
        distinctThreads: row.distinctThreads,
        lastAttachmentAt: row.lastAt ?? null,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  /** Level 3 — threads carrying attachments for one user on one agent. */
  async conversations(
    scope: FileBrowserScope,
    agentId: string,
    userId: string,
    page: BrowsePage,
  ): Promise<Counted<ConversationWithAttachments>> {
    const search = page.search
      ? Prisma.sql`AND (COALESCE(t.title, '') ILIKE ${contains(page.search)} OR CAST(t.id AS text) ILIKE ${contains(page.search)})`
      : Prisma.empty;
    const where = Prisma.sql`
      WHERE t."agentId" = CAST(${agentId} AS uuid)
        AND t."endUserId" = CAST(${userId} AS uuid)
        AND ${threadScopePredicate(scope)}
        ${search}
    `;

    const [rows, totals] = (await Promise.all([
      this.prisma.$queryRaw(Prisma.sql`
        SELECT t.id AS "threadId", t.title,
          COUNT(att.id)::int AS "attachmentCount",
          MAX(att."createdAt") AS "lastAt"
        ${THREAD_ATTACHMENT_JOINS}
        ${where}
        GROUP BY t.id, t.title
        ORDER BY "lastAt" DESC, t.id DESC
        LIMIT ${page.pageSize} OFFSET ${page.offset}
      `),
      this.prisma.$queryRaw(Prisma.sql`
        SELECT COUNT(DISTINCT t.id)::int AS total
        ${THREAD_ATTACHMENT_JOINS}
        ${where}
      `),
    ])) as [
      Array<{
        threadId: string;
        title: string | null;
        attachmentCount: number;
        lastAt: Date | null;
      }>,
      Array<{ total: number }>,
    ];

    return {
      rows: rows.map((row) => ({
        threadId: row.threadId,
        title: row.title,
        attachmentCount: row.attachmentCount,
        lastActivityAt: row.lastAt ?? null,
      })),
      total: totals[0]?.total ?? 0,
    };
  }

  /** Level 4 — the attachments themselves, still without their URLs. */
  async attachments(
    scope: FileBrowserScope,
    threadId: string,
    page: BrowsePage,
    mime: string | null,
  ): Promise<Counted<AttachmentRecord>> {
    const where: Prisma.MessageAttachmentWhereInput = {
      environmentId: scope.environmentId,
      environment: {
        project: {
          id: scope.projectId,
          organizationId: scope.organizationId,
        },
      },
      turn: { threadId },
      ...(page.search
        ? {
            OR: [
              { originalName: { contains: page.search, mode: "insensitive" } },
              { mimeType: { contains: page.search, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(mime ? { mimeType: { startsWith: mime, mode: "insensitive" } } : {}),
    };

    const [rows, total] = (await Promise.all([
      this.prisma.messageAttachment.findMany({
        where,
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
        take: page.pageSize,
        skip: page.offset,
      }),
      this.prisma.messageAttachment.count({ where }),
    ])) as [AttachmentRecord[], number];

    return { rows, total };
  }
}
