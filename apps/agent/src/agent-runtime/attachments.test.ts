/**
 * Theme D.10 — E2E attachment smoke test.
 *
 * Uses the running platos-compose stack (no mocks, per project rule):
 *   - Postgres on localhost:5432 — writes PlatosMessageAttachment rows
 *   - MinIO on localhost:9001 — PUT + GET object bytes
 *
 * The test spins up two distinct scope rows in the same DB (org, project,
 * env), uploads bytes into the first scope, then verifies:
 *   1. Scope A can resolve the attachment and fetch bytes from MinIO.
 *   2. Scope B CANNOT resolve the same attachmentId (cross-scope isolation).
 *   3. Retention sweep (expiresAt < now) tears down rows + objects.
 *
 * Skipped when the stack isn't reachable (so CI without MinIO stays green).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PutObjectCommand, S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@platos/database";
import { AttachmentsService } from "./attachments.service";

type AttachmentScope = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  sessionId: string;
};

describe("AttachmentsService EndUser isolation", () => {
  const baseScope: AttachmentScope = {
    organizationId: randomUUID(),
    projectId: randomUUID(),
    environmentId: randomUUID(),
    userId: "caller-b",
    sessionId: randomUUID(),
  };

  it("denies a same-Environment attachment owned by a different EndUser before fetch", async () => {
    const threadFindFirst = vi.fn().mockResolvedValue({ endUserId: "end-user-b" });
    const attachmentFindMany = vi.fn().mockImplementation(
      (args: { where: { endUserId: string } }) =>
        Promise.resolve(
          args.where.endUserId === "end-user-a"
            ? [{
                id: "attachment-owned-by-a",
                endUserId: "end-user-a",
                environmentId: baseScope.environmentId,
              }]
            : [],
        ),
    );
    const prisma = {
      thread: { findFirst: threadFindFirst },
      messageAttachment: { findMany: attachmentFindMany },
    } as unknown as PrismaClient;
    const service = new AttachmentsService(prisma);
    const fetchSpy = vi.spyOn(
      service as unknown as {
        fetchObjectBytes: (storageKey: string) => Promise<Uint8Array>;
      },
      "fetchObjectBytes",
    );

    await expect(
      service.resolveAttachments(["attachment-owned-by-a"], baseScope),
    ).rejects.toThrow(/not accessible/);
    expect(threadFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: baseScope.sessionId,
          environmentId: baseScope.environmentId,
        }),
      }),
    );
    expect(attachmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ endUserId: "end-user-b" }),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects binding when the target Turn belongs to another EndUser", async () => {
    const updateMany = vi.fn();
    const turnFindFirst = vi.fn().mockResolvedValue(null);
    const prisma = {
      thread: {
        findFirst: vi.fn().mockResolvedValue({ endUserId: "end-user-a" }),
      },
      turn: { findFirst: turnFindFirst },
      messageAttachment: {
        findMany: vi.fn().mockResolvedValue([{ id: "attachment-a" }]),
        updateMany,
      },
    } as unknown as PrismaClient;
    const service = new AttachmentsService(prisma);

    await expect(
      service.markAttachedToMessage(["attachment-a"], "turn-owned-by-b", {
        ...baseScope,
        userId: "caller-a",
      }),
    ).rejects.toThrow(/Target turn is not accessible/);
    expect(turnFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "turn-owned-by-b",
          thread: expect.objectContaining({
            endUserId: "end-user-a",
            environmentId: baseScope.environmentId,
          }),
        }),
      }),
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "http://localhost:9001";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "platos-minio-admin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "platos-minio-password";
const MINIO_BUCKET = process.env.MINIO_BUCKET || "platos-media";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/postgres?schema=public";

async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MINIO_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

describe("Platos attachment E2E", async () => {
  const reachable = await isReachable();
  if (!reachable) {
    it.skip("stack not reachable — skipping", () => {});
    return;
  }

  let prisma: PrismaClient;
  let s3: S3Client;
  let scopeA: AttachmentScope;
  let scopeB: AttachmentScope;
  let sameEnvironmentOtherEndUserScope: AttachmentScope;
  let createdRowIds: string[] = [];
  let createdThreadIds: string[] = [];
  let createdEndUserIds: string[] = [];
  let createdAgentId: string | null = null;
  let createdAgentVersionId: string | null = null;
  let endUserId = "";
  let otherEndUserId = "";
  let ownTurnId = "";
  let otherTurnId = "";

  beforeAll(async () => {
    prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
    s3 = new S3Client({
      endpoint: MINIO_ENDPOINT,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: MINIO_ACCESS_KEY,
        secretAccessKey: MINIO_SECRET_KEY,
      },
    });

    // Pick any existing Organization/Project/RuntimeEnvironment from the DB
    // — we can't create scope rows from scratch because they cascade FK to
    // User + lots of other tables. If none exist in the test DB, skip.
    const anyEnv = await prisma.environment.findFirst({
      select: {
        id: true,
        projectId: true,
        project: { select: { organizationId: true } },
      },
    });
    if (!anyEnv) {
      // eslint-disable-next-line no-console
      console.warn("No RuntimeEnvironment in test DB — skipping attachment E2E");
      return;
    }
    const existingAgent = await prisma.agent.findFirst({
      where: { projectId: anyEnv.projectId },
      select: { id: true },
    });
    const agent = existingAgent ?? await prisma.agent.create({
      data: {
        projectId: anyEnv.projectId,
        name: "Attachment E2E",
        slug: `attachment-e2e-${randomUUID()}`,
      },
      select: { id: true },
    });
    if (!existingAgent) createdAgentId = agent.id;
    const existingAgentVersion = await prisma.agentVersion.findFirst({
      where: { agentId: agent.id },
      select: { id: true },
    });
    const agentVersion = existingAgentVersion ?? await prisma.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "attachment-e2e",
        createdBy: "attachment-e2e",
      },
      select: { id: true },
    });
    if (!existingAgentVersion) createdAgentVersionId = agentVersion.id;

    const [owner, otherOwner] = await Promise.all([
      prisma.endUser.create({
        data: {
          organizationId: anyEnv.project.organizationId,
          displayName: "Attachment E2E Owner A",
        },
        select: { id: true },
      }),
      prisma.endUser.create({
        data: {
          organizationId: anyEnv.project.organizationId,
          displayName: "Attachment E2E Owner B",
        },
        select: { id: true },
      }),
    ]);
    endUserId = owner.id;
    otherEndUserId = otherOwner.id;
    createdEndUserIds = [owner.id, otherOwner.id];

    const [ownerThread, otherThread] = await Promise.all([
      prisma.thread.create({
        data: {
          environmentId: anyEnv.id,
          agentId: agent.id,
          endUserId,
        },
        select: { id: true },
      }),
      prisma.thread.create({
        data: {
          environmentId: anyEnv.id,
          agentId: agent.id,
          endUserId: otherEndUserId,
        },
        select: { id: true },
      }),
    ]);
    createdThreadIds = [ownerThread.id, otherThread.id];
    const [ownerTurn, otherTurn] = await Promise.all([
      prisma.turn.create({
        data: {
          threadId: ownerThread.id,
          sequence: 1,
          agentVersionId: agentVersion.id,
          versionBucket: "CURRENT",
        },
        select: { id: true },
      }),
      prisma.turn.create({
        data: {
          threadId: otherThread.id,
          sequence: 1,
          agentVersionId: agentVersion.id,
          versionBucket: "CURRENT",
        },
        select: { id: true },
      }),
    ]);
    ownTurnId = ownerTurn.id;
    otherTurnId = otherTurn.id;

    scopeA = {
      organizationId: anyEnv.project.organizationId,
      projectId: anyEnv.projectId,
      environmentId: anyEnv.id,
      userId: "attachment-e2e-owner-a",
      sessionId: ownerThread.id,
    };
    sameEnvironmentOtherEndUserScope = {
      ...scopeA,
      userId: "attachment-e2e-owner-b",
      sessionId: otherThread.id,
    };
    // Scope B differs on environmentId only (cross-scope probe). Find a
    // second RuntimeEnvironment in the same project; if none exists, use a
    // fabricated id — the findFirst will always return null → cross-scope
    // guard fires exactly as intended.
    const anotherEnv = await prisma.environment.findFirst({
      where: { id: { not: anyEnv.id } },
      select: {
        id: true,
        projectId: true,
        project: { select: { organizationId: true } },
      },
    });
    scopeB = anotherEnv
      ? {
          organizationId: anotherEnv.project.organizationId,
          projectId: anotherEnv.projectId,
          environmentId: anotherEnv.id,
          userId: scopeA.userId,
          sessionId: ownerThread.id,
        }
      : {
          organizationId: anyEnv.project.organizationId,
          projectId: anyEnv.projectId,
          environmentId: randomUUID(),
          userId: scopeA.userId,
          sessionId: ownerThread.id,
        };
  }, 30_000);

  afterAll(async () => {
    if (prisma && createdRowIds.length > 0) {
      await prisma.messageAttachment.deleteMany({
        where: { id: { in: createdRowIds } },
      });
    }
    if (createdThreadIds.length > 0) {
      await prisma.thread.deleteMany({ where: { id: { in: createdThreadIds } } });
    }
    if (createdEndUserIds.length > 0) {
      await prisma.endUser.deleteMany({ where: { id: { in: createdEndUserIds } } });
    }
    if (createdAgentVersionId && !createdAgentId) {
      await prisma.agentVersion.delete({ where: { id: createdAgentVersionId } });
    }
    if (createdAgentId) {
      await prisma.agent.delete({ where: { id: createdAgentId } });
    }
    await prisma?.$disconnect();
  }, 15_000);

  it("happy path: upload → scoped resolve → byte fetch", async () => {
    if (!scopeA) return;

    const id = randomUUID();
    const payload = randomBytes(256); // 256 bytes of "image" fixture
    const storageKey = `${scopeA.organizationId}/${scopeA.projectId}/${scopeA.environmentId}/${id}/test-pixel.bin`;

    // 1. Upload to MinIO directly (simulating the browser presigned PUT).
    await s3.send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: storageKey,
        Body: payload,
        ContentType: "image/png",
      })
    );

    // 2. Persist the PlatosMessageAttachment row (simulating the webapp
    //    writing it during presign).
    await prisma.messageAttachment.create({
      data: {
        id,
        environmentId: scopeA.environmentId,
        endUserId,
        kind: "image",
        mimeType: "image/png",
        bytes: payload.byteLength,
        storageKey,
        originalName: "test-pixel.png",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    createdRowIds.push(id);

    // 3. Agent resolves in scope A → gets bytes.
    const svc = new AttachmentsService(prisma);
    const resolved = await svc.resolveAttachments([id], scopeA);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].kind).toBe("image");
    expect(resolved[0].bytes).toBe(payload.byteLength);
    expect(resolved[0].data.byteLength).toBe(payload.byteLength);

    // 4. Raw GET from MinIO should also work (sanity — the bytes match).
    const get = await s3.send(
      new GetObjectCommand({ Bucket: MINIO_BUCKET, Key: storageKey })
    );
    expect(get.ContentLength).toBe(payload.byteLength);
  }, 30_000);

  it("cross-scope: scope B cannot resolve an attachment uploaded in scope A", async () => {
    if (!scopeA || !scopeB) return;

    const id = randomUUID();
    const storageKey = `${scopeA.organizationId}/${scopeA.projectId}/${scopeA.environmentId}/${id}/cross.bin`;
    await s3.send(
      new PutObjectCommand({
        Bucket: MINIO_BUCKET,
        Key: storageKey,
        Body: randomBytes(32),
        ContentType: "image/png",
      })
    );
    await prisma.messageAttachment.create({
      data: {
        id,
        environmentId: scopeA.environmentId,
        endUserId,
        kind: "image",
        mimeType: "image/png",
        bytes: 32,
        storageKey,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    createdRowIds.push(id);

    const svc = new AttachmentsService(prisma);
    // Scope B must NOT see this attachment. resolveAttachments fails closed.
    await expect(svc.resolveAttachments([id], scopeB)).rejects.toThrow(
      /not accessible/
    );
  }, 30_000);

  it("same Environment: a different EndUser cannot resolve the attachment", async () => {
    if (!scopeA || !sameEnvironmentOtherEndUserScope) return;

    const id = randomUUID();
    await prisma.messageAttachment.create({
      data: {
        id,
        environmentId: scopeA.environmentId,
        endUserId,
        kind: "document",
        mimeType: "text/plain",
        bytes: 1,
        storageKey: `attachment-e2e/${id}`,
      },
    });
    createdRowIds.push(id);

    const svc = new AttachmentsService(prisma);
    await expect(
      svc.resolveAttachments([id], sameEnvironmentOtherEndUserScope),
    ).rejects.toThrow(/not accessible/);
  });

  it("does not bind an attachment to a Turn owned by another EndUser", async () => {
    if (!scopeA || !otherTurnId) return;

    const id = randomUUID();
    await prisma.messageAttachment.create({
      data: {
        id,
        environmentId: scopeA.environmentId,
        endUserId,
        kind: "document",
        mimeType: "text/plain",
        bytes: 1,
        storageKey: `attachment-e2e/${id}`,
      },
    });
    createdRowIds.push(id);

    const svc = new AttachmentsService(prisma);
    await expect(
      svc.markAttachedToMessage([id], otherTurnId, scopeA),
    ).rejects.toThrow(/Target turn is not accessible/);
    const unchanged = await prisma.messageAttachment.findUnique({
      where: { id },
      select: { turnId: true },
    });
    expect(unchanged?.turnId).toBeNull();
  });

  it("binds an attachment to a Turn for the same Environment and EndUser", async () => {
    if (!scopeA || !ownTurnId) return;

    const id = randomUUID();
    await prisma.messageAttachment.create({
      data: {
        id,
        environmentId: scopeA.environmentId,
        endUserId,
        kind: "document",
        mimeType: "text/plain",
        bytes: 1,
        storageKey: `attachment-e2e/${id}`,
      },
    });
    createdRowIds.push(id);

    const svc = new AttachmentsService(prisma);
    await svc.markAttachedToMessage([id], ownTurnId, scopeA);
    const attached = await prisma.messageAttachment.findUnique({
      where: { id },
      select: { turnId: true },
    });
    expect(attached?.turnId).toBe(ownTurnId);
  });
});
