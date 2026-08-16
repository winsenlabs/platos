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

type QueryRaw = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

describe("FilesController clean attachment transport", () => {
  it("browses agents by joining MessageAttachment through Turn and canonical Thread scope", async () => {
    const lastAt = new Date("2026-08-15T10:00:00.000Z");
    const queryRaw = vi.fn<QueryRaw>().mockResolvedValue([
      { agentId: "agent-a", _count: 3, lastAt },
    ]);
    const agentFindMany = vi.fn().mockResolvedValue([
      { id: "agent-a", name: "Ada" },
    ]);
    const controller = new FilesController(
      { $queryRaw: queryRaw, agent: { findMany: agentFindMany } } as any,
      { getPresignedDownloadUrl: vi.fn() } as any,
    );

    const result = await controller.listAgents(req(), "25");

    const [sqlParts, ...values] = queryRaw.mock.calls[0];
    const sql = Array.from(sqlParts).join(" ");
    expect(sql).toContain('JOIN "Turn" turn ON turn."threadId" = t.id');
    expect(sql).toContain('JOIN "MessageAttachment" att ON att."turnId" = turn.id');
    expect(sql).toContain('JOIN "Environment" environment ON environment.id = t."environmentId"');
    expect(values).toEqual([
      "env-a",
      "env-a",
      "project-a",
      "org-a",
      25,
    ]);
    expect(agentFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["agent-a"] },
        projectId: "project-a",
        project: { organizationId: "org-a" },
        bindings: { some: { environmentId: "env-a" } },
      },
      select: { id: true, name: true },
    });
    expect(result.agents).toEqual([
      {
        agentId: "agent-a",
        name: "Ada",
        attachmentCount: 3,
        lastAttachmentAt: lastAt.toISOString(),
      },
    ]);
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
    const controller = new FilesController(
      { messageAttachment: { findMany } } as any,
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
      orderBy: { createdAt: "desc" },
      take: 20,
    });
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
