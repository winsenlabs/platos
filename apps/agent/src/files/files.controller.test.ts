import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FileBrowserStore } from "./file-browser.store";
import { FilesController } from "./files.controller";

const scope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
  principal: "operator" as const,
};

const req = (overrides: Record<string, unknown> = {}) => ({
  scope: { ...scope, ...overrides },
}) as any;

describe("FilesController clean attachment transport", () => {
  it("browses agents by joining MessageAttachment through Turn and canonical Thread scope", async () => {
    const lastAt = new Date("2026-08-15T10:00:00.000Z");
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ agentId: "agent-a", name: "Ada", _count: 3, lastAt }])
      .mockResolvedValueOnce([{ total: 1 }]);
    const controller = new FilesController(
      new FileBrowserStore({ $queryRaw: queryRaw } as any),
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    const result = await controller.listAgents(req(), "25");

    const query = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const sql = query.strings.join(" ");
    expect(sql).toContain('JOIN "Turn" turn ON turn."threadId" = t.id');
    expect(sql).toContain('JOIN "MessageAttachment" att ON att."turnId" = turn.id');
    expect(sql).toContain('JOIN "Environment" environment ON environment.id = t."environmentId"');
    expect(sql.match(/CAST\(\s+AS uuid\)/g)).toHaveLength(4);
    expect(query.values).toEqual([
      "env-a",
      "env-a",
      "project-a",
      "org-a",
      25,
      0,
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(result.agents).toEqual([
      {
        agentId: "agent-a",
        name: "Ada",
        attachmentCount: 3,
        lastAttachmentAt: lastAt.toISOString(),
      },
    ]);
    expect(result).toMatchObject({ total: 1, limit: 25, offset: 0, hasMore: false });
    expect(result.pagination).toMatchObject({ from: 1, to: 1, totalPages: 1 });
  });

  it("lists users only through the requested Agent and canonical persisted ancestry", async () => {
    const lastAt = new Date("2026-08-15T10:00:00.000Z");
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ userId: "end-user-a", attachmentCount: 2, distinctThreads: 1, lastAt }])
      .mockResolvedValueOnce([{ total: 1 }]);
    const controller = new FilesController(
      new FileBrowserStore({ $queryRaw: queryRaw } as any),
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    const result = await controller.listUsers(req(), "agent-a", "25");

    const query = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const sql = query.strings.join(" ");
    expect(sql).toContain('JOIN "AgentBinding" binding ON binding."agentId" = t."agentId"');
    expect(sql).toContain('WHERE t."agentId" = CAST(');
    expect(query.values).toEqual(["agent-a", "env-a", "project-a", "org-a", 25, 0]);
    expect(result).toMatchObject({
      agentId: "agent-a",
      users: [{
        userId: "end-user-a",
        attachmentCount: 2,
        distinctThreads: 1,
        lastAttachmentAt: lastAt.toISOString(),
      }],
      total: 1,
    });
  });

  it("lists MessageAttachments through Turn.threadId and returns clean Turn identifiers", async () => {
    const createdAt = new Date("2026-08-15T10:00:00.000Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "attachment-a",
        originalName: "report.pdf",
        mimeType: "application/pdf",
        bytes: 1234,
        createdAt,
        storageKey: "objects/report.pdf",
        turnId: "turn-a",
        kind: "file",
      },
      {
        id: "attachment-b",
        originalName: "image.png",
        mimeType: "image/png",
        bytes: 456,
        createdAt,
        storageKey: "objects/image.png",
        turnId: "turn-b",
        kind: "image",
      },
    ]);
    const presign = vi
      .fn()
      .mockResolvedValueOnce("https://files.example/report.pdf")
      .mockRejectedValueOnce(new Error("object store unavailable"));
    const count = vi.fn().mockResolvedValue(2);
    const controller = new FilesController(
      new FileBrowserStore({ messageAttachment: { findMany, count } } as any),
      { getPresignedDownloadUrl: presign } as any,
    );

    const result = await controller.listAttachments(
      req(),
      "thread-a",
      "20",
      undefined,
      undefined,
    );

    expect(findMany).toHaveBeenCalledWith({
      where: {
        environmentId: "env-a",
        environment: {
          project: { id: "project-a", organizationId: "org-a" },
        },
        turn: { threadId: "thread-a" },
      },
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
      take: 20,
      skip: 0,
    });
    expect(count).toHaveBeenCalledWith({ where: expect.objectContaining({ turn: { threadId: "thread-a" } }) });
    expect(result.attachments).toEqual([
      {
        id: "attachment-a",
        filename: "report.pdf",
        mimeType: "application/pdf",
        kind: "file",
        bytes: 1234,
        uploadedAt: createdAt.toISOString(),
        messageId: "turn-a",
        turnId: "turn-a",
        downloadUrl: "https://files.example/report.pdf",
      },
      {
        id: "attachment-b",
        filename: "image.png",
        mimeType: "image/png",
        kind: "image",
        bytes: 456,
        uploadedAt: createdAt.toISOString(),
        messageId: "turn-b",
        turnId: "turn-b",
        downloadUrl: null,
      },
    ]);
    expect(result).toMatchObject({ total: 2, limit: 20, offset: 0, hasMore: false });
  });

  it("applies search and MIME filters before counting and paging attachments", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const controller = new FilesController(
      new FileBrowserStore({ messageAttachment: { findMany, count } } as any),
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    const result = await controller.listAttachments(
      req(),
      "thread-a",
      "25",
      "25",
      undefined,
      "invoice",
      "application/",
    );

    const expectedWhere = {
      environmentId: "env-a",
      environment: { project: { id: "project-a", organizationId: "org-a" } },
      turn: { threadId: "thread-a" },
      OR: [
        { originalName: { contains: "invoice", mode: "insensitive" } },
        { mimeType: { contains: "invoice", mode: "insensitive" } },
      ],
      mimeType: { startsWith: "application/", mode: "insensitive" },
    };
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expectedWhere, take: 25, skip: 25 }));
    expect(count).toHaveBeenCalledWith({ where: expectedWhere });
    expect(result.filters).toEqual({ search: "invoice", mime: "application/" });
  });

  it("rejects end-user file browsing before querying attachment metadata", async () => {
    const findMany = vi.fn();
    const controller = new FilesController(
      new FileBrowserStore({ messageAttachment: { findMany } } as any),
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    await expect(
      controller.listAttachments(
        req({ principal: "end_user" }),
        "thread-a",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/**
 * WIN-258 T6 — the page and its total are ONE predicate, not two spellings.
 *
 * Each raw level ran two statements: one for the rows, one for the count. They
 * were written out separately, so the tenancy clause that confines results to
 * one organization, project and environment existed in SIX independent copies
 * across the three levels. Two failures follow, and neither shows up in a review
 * that reads one query at a time — a total computed from a WIDER predicate than
 * its page (so `hasMore` lies, undetectably), and a scope clause weakened in one
 * copy only (a cross-tenant leak on a surface that mints presigned URLs for
 * other users' files).
 *
 * The assertion below is a JOIN BETWEEN THE TWO STATEMENTS rather than a
 * restatement of either: whatever the page query binds, minus the two paging
 * parameters, must be exactly what the count query binds. It holds no expected
 * SQL of its own, so it cannot drift with the queries — and it goes red the
 * moment the two predicates stop being the same object.
 */
describe("FileBrowserStore counts the same rows it pages", () => {
  const levels = [
    {
      name: "agents",
      call: (controller: FilesController) => controller.listAgents(req(), "25", "10", undefined, "ada"),
    },
    {
      name: "users",
      call: (controller: FilesController) => controller.listUsers(req(), "agent-a", "25", "10", undefined, "ada"),
    },
    {
      name: "conversations",
      call: (controller: FilesController) =>
        controller.listConversations(req(), "agent-a", "user-a", "25", "10", undefined, "ada"),
    },
  ];

  it.each(levels)("binds one predicate for both statements at the $name level", async ({ call }) => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);
    const controller = new FilesController(
      new FileBrowserStore({ $queryRaw: queryRaw } as any),
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    await call(controller);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const page = queryRaw.mock.calls[0][0] as { values: unknown[] };
    const count = queryRaw.mock.calls[1][0] as { values: unknown[] };

    // The page binds exactly two more values than the count — LIMIT and OFFSET,
    // in that order, and nothing else.
    expect(page.values.slice(-2)).toEqual([25, 10]);
    expect(page.values.slice(0, -2)).toEqual(count.values);
  });

  it("carries the search term into the count, not only into the page", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ total: 0 }]);
    const controller = new FilesController(
      new FileBrowserStore({ $queryRaw: queryRaw } as any),
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    await controller.listAgents(req(), "25", "0", undefined, "ada");

    const count = queryRaw.mock.calls[1][0] as { values: unknown[] };
    // A count that dropped the filter would return the unfiltered total while
    // the page returned the filtered rows — the exact bug this shape prevents.
    expect(count.values).toContain("%ada%");
  });
});
