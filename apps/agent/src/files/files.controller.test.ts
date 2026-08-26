import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
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
      { $queryRaw: queryRaw } as any,
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
      { $queryRaw: queryRaw } as any,
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
      { messageAttachment: { findMany, count } } as any,
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
      { messageAttachment: { findMany, count } } as any,
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
      { messageAttachment: { findMany } } as any,
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
