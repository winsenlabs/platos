import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  AgentVersionBucket,
  OrganizationRole,
  PrismaClient,
  ProjectRole,
} from "../generated/control";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AttachmentClaimError,
  AttachmentQuotaExceededError,
  attachmentUploadRetention,
  claimAttachmentUpload,
  reconcileAttachmentUploadBytes,
  reserveAttachmentUpload,
  sweepExpiredAttachmentUploadReservations,
} from "./attachments";
import { normalizeDashboardPreferences } from "./json";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("attachment upload reservation integration", () => {
  let container: StartedPostgreSqlContainer;
  let client: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    const databaseUrl = container.getConnectionUri();
    execFileSync(resolve(process.cwd(), "node_modules/.bin/prisma"), [
      "migrate",
      "deploy",
      "--schema",
      resolve(process.cwd(), "prisma/schema.prisma"),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
    client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  }, 120_000);

  afterAll(async () => {
    await client?.$disconnect();
    await container?.stop();
  });

  async function seedScope(label: string) {
    const user = await client.user.create({
      data: {
        email: `${label}-${randomUUID()}@example.test`,
        displayName: label,
        avatarUrl: `https://example.test/${label}.png`,
        dashboardPreferences: normalizeDashboardPreferences({ version: "1", projects: {} }),
      },
    });
    const organization = await client.organization.create({
      data: { slug: `${label}-${randomUUID()}`, name: label },
    });
    const organizationMembership = await client.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: user.id,
        role: OrganizationRole.OWNER,
      },
    });
    const project = await client.project.create({
      data: { organizationId: organization.id, slug: "project", name: "Project" },
    });
    await client.projectMembership.create({
      data: {
        projectId: project.id,
        organizationId: organization.id,
        organizationMembershipId: organizationMembership.id,
        role: ProjectRole.ADMIN,
      },
    });
    const environment = await client.environment.create({
      data: { projectId: project.id, slug: "production", name: "Production" },
    });
    const endUser = await client.endUser.create({
      data: { organizationId: organization.id, displayName: "Subject" },
    });
    const agent = await client.agent.create({
      data: { projectId: project.id, slug: "agent", name: "Agent" },
    });
    const version = await client.agentVersion.create({
      data: {
        agentId: agent.id,
        versionNumber: 1,
        model: "test:model",
        promptBlocks: [],
        dynamicBlocks: [],
        toolsBlockConfig: {},
        modelRoutes: [],
        createdBy: user.id,
      },
    });
    const thread = await client.thread.create({
      data: { environmentId: environment.id, agentId: agent.id, endUserId: endUser.id },
    });
    const firstTurn = await client.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: version.id,
        versionBucket: AgentVersionBucket.CURRENT,
        sequence: 1,
      },
    });
    const secondTurn = await client.turn.create({
      data: {
        threadId: thread.id,
        agentVersionId: version.id,
        versionBucket: AgentVersionBucket.CURRENT,
        sequence: 2,
      },
    });
    return { user, organization, project, environment, endUser, firstTurn, secondTurn };
  }

  test("round-trips avatar and object-root dashboard preferences", async () => {
    const scope = await seedScope("profile");
    await expect(client.user.findUnique({ where: { id: scope.user.id } })).resolves.toMatchObject({
      avatarUrl: expect.stringContaining("profile.png"),
      dashboardPreferences: { version: "1", projects: {} },
    });
    await expect(client.user.update({
      where: { id: scope.user.id },
      data: { dashboardPreferences: [] },
    })).rejects.toThrow();
  });

  test("serializes organization quota reservations across a concurrent race", async () => {
    const scope = await seedScope("quota-race");
    await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 8,
      storageKey: `quota/${randomUUID()}`,
      quotaBytes: 10,
    });

    const results = await Promise.allSettled([1, 2].map(() => reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 2,
      storageKey: `quota/${randomUUID()}`,
      quotaBytes: 10,
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(AttachmentQuotaExceededError);

    const usage = await client.attachmentUploadReservation.aggregate({
      where: { environmentId: scope.environment.id },
      _sum: { bytes: true },
    });
    expect(usage._sum.bytes).toBe(10);
  });

  test("claims once, retries idempotently, rejects another turn, and cascades on attachment delete", async () => {
    const scope = await seedScope("claim");
    const reservation = await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { endUserId: scope.endUser.id },
      kind: "image",
      mimeType: "image/png",
      bytes: 4,
      width: 1,
      height: 1,
      storageKey: `claim/${randomUUID()}`,
      quotaBytes: 100,
    });

    const claimed = await claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      turnId: scope.firstTurn.id,
    });
    const repeated = await claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      turnId: scope.firstTurn.id,
    });
    expect(repeated.id).toBe(claimed.id);
    await expect(claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      turnId: scope.secondTurn.id,
    })).rejects.toThrow(/another turn/);

    const stored = await client.attachmentUploadReservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(stored.messageAttachmentId).toBe(claimed.id);
    expect(stored.claimedAt).not.toBeNull();
    expect(stored.expiresAt.getTime() - stored.claimedAt!.getTime())
      .toBe(attachmentUploadRetention.claimedDays * DAY_MS);
    expect(claimed.expiresAt?.getTime()).toBe(stored.expiresAt.getTime());

    await expect(client.attachmentUploadReservation.delete({ where: { id: reservation.id } }))
      .rejects.toThrow(/retained through attachment deletion/);
    await client.messageAttachment.delete({ where: { id: claimed.id } });
    await expect(client.attachmentUploadReservation.findUnique({ where: { id: reservation.id } }))
      .resolves.toBeNull();
  });

  test("expired unclaimed reservations stop consuming quota and are sweepable", async () => {
    const scope = await seedScope("expiry");
    const createdAt = new Date(Date.now() - 8 * DAY_MS);
    const expired = await client.attachmentUploadReservation.create({
      data: {
        environmentId: scope.environment.id,
        uploadedByUserId: scope.user.id,
        kind: "document",
        mimeType: "text/plain",
        bytes: 100,
        storageKey: `expired/${randomUUID()}`,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + attachmentUploadRetention.unclaimedDays * DAY_MS),
      },
    });

    await expect(reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 1,
      storageKey: `active/${randomUUID()}`,
      quotaBytes: 1,
    })).resolves.toMatchObject({ bytes: 1 });
    await expect(claimAttachmentUpload(client, {
      reservationId: expired.id,
      environmentId: scope.environment.id,
      turnId: scope.firstTurn.id,
    })).rejects.toBeInstanceOf(AttachmentClaimError);

    const swept = await sweepExpiredAttachmentUploadReservations(client, 10);
    expect(swept).toContainEqual({ id: expired.id, storageKey: expired.storageKey });
    await expect(client.attachmentUploadReservation.findUnique({ where: { id: expired.id } }))
      .resolves.toBeNull();
  });

  test("denies cross-scope uploaders and claims through canonical ancestry", async () => {
    const first = await seedScope("scope-a");
    const second = await seedScope("scope-b");

    await expect(client.attachmentUploadReservation.create({
      data: {
        environmentId: first.environment.id,
        uploadedByEndUserId: second.endUser.id,
        kind: "document",
        mimeType: "text/plain",
        bytes: 1,
        storageKey: `cross-end-user/${randomUUID()}`,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      },
    })).rejects.toThrow(/ancestry/);
    await expect(client.attachmentUploadReservation.create({
      data: {
        environmentId: first.environment.id,
        uploadedByUserId: second.user.id,
        kind: "document",
        mimeType: "text/plain",
        bytes: 1,
        storageKey: `cross-operator/${randomUUID()}`,
        expiresAt: new Date(Date.now() + 7 * DAY_MS),
      },
    })).rejects.toThrow(/ancestry/);

    const reservation = await reserveAttachmentUpload(client, {
      environmentId: first.environment.id,
      uploader: { endUserId: first.endUser.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 1,
      storageKey: `cross-claim/${randomUUID()}`,
      quotaBytes: 10,
    });
    await expect(claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: second.environment.id,
      turnId: second.firstTurn.id,
    })).rejects.toThrow(/not accessible/);
    await expect(claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: first.environment.id,
      turnId: second.firstTurn.id,
    })).rejects.toThrow(/target turn/);
  });

  test("enforces one-to-one and immutable claimed lifecycle invariants in PostgreSQL", async () => {
    const scope = await seedScope("invariants");
    const reservation = await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 2,
      storageKey: `invariants/${randomUUID()}`,
      quotaBytes: 10,
    });
    const attachment = await claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      turnId: scope.firstTurn.id,
    });

    await expect(client.attachmentUploadReservation.update({
      where: { id: reservation.id },
      data: { messageAttachmentId: null, claimedAt: null },
    })).rejects.toThrow(/immutable/);
    await expect(client.messageAttachment.update({
      where: { id: attachment.id },
      data: { turnId: scope.secondTurn.id },
    })).rejects.toThrow(/immutable/);

    const secondReservation = await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
      storageKey: `invariants/${randomUUID()}`,
      quotaBytes: 10,
    });
    await expect(client.attachmentUploadReservation.update({
      where: { id: secondReservation.id },
      data: {
        messageAttachmentId: attachment.id,
        claimedAt: new Date(),
        expiresAt: attachment.expiresAt!,
      },
    })).rejects.toThrow();
  });

  test("corrects unclaimed bytes only through the quota-locked helper", async () => {
    const scope = await seedScope("correct-unclaimed");
    const reservation = await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 2,
      storageKey: `correct-unclaimed/${randomUUID()}`,
      quotaBytes: 10,
    });

    await expect(client.attachmentUploadReservation.update({
      where: { id: reservation.id },
      data: { bytes: 3 },
    })).rejects.toThrow(/immutable/);

    await expect(reconcileAttachmentUploadBytes(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      storageKey: reservation.storageKey,
      claimedBytes: 2,
      actualBytes: 3,
      quotaBytes: 10,
    })).resolves.toEqual({ claimedBytes: 2, actualBytes: 3, corrected: true });
    await expect(client.attachmentUploadReservation.findUnique({ where: { id: reservation.id } }))
      .resolves.toMatchObject({ bytes: 3, storageKey: reservation.storageKey });
  });

  test("atomically corrects a claimed reservation and its immutable attachment", async () => {
    const scope = await seedScope("correct-claimed");
    const reservation = await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 4,
      storageKey: `correct-claimed/${randomUUID()}`,
      quotaBytes: 10,
    });
    const attachment = await claimAttachmentUpload(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      turnId: scope.firstTurn.id,
    });

    await expect(client.messageAttachment.update({
      where: { id: attachment.id },
      data: { bytes: 5 },
    })).rejects.toThrow(/immutable/);
    await expect(reconcileAttachmentUploadBytes(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      storageKey: reservation.storageKey,
      claimedBytes: 4,
      actualBytes: 5,
      quotaBytes: 10,
    })).resolves.toEqual({ claimedBytes: 4, actualBytes: 5, corrected: true });

    const [storedReservation, storedAttachment] = await Promise.all([
      client.attachmentUploadReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      client.messageAttachment.findUniqueOrThrow({ where: { id: attachment.id } }),
    ]);
    expect(storedReservation.bytes).toBe(5);
    expect(storedAttachment.bytes).toBe(5);
    expect(storedReservation.storageKey).toBe(reservation.storageKey);
    expect(storedAttachment.storageKey).toBe(reservation.storageKey);
  });

  test("rejects byte correction that would exceed canonical organization quota", async () => {
    const scope = await seedScope("correct-quota");
    const reservation = await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 8,
      storageKey: `correct-quota/${randomUUID()}`,
      quotaBytes: 10,
    });
    await reserveAttachmentUpload(client, {
      environmentId: scope.environment.id,
      uploader: { userId: scope.user.id },
      kind: "document",
      mimeType: "text/plain",
      bytes: 2,
      storageKey: `correct-quota/${randomUUID()}`,
      quotaBytes: 10,
    });

    await expect(reconcileAttachmentUploadBytes(client, {
      reservationId: reservation.id,
      environmentId: scope.environment.id,
      storageKey: reservation.storageKey,
      claimedBytes: 8,
      actualBytes: 9,
      quotaBytes: 10,
    })).rejects.toThrow(/quota exceeded/i);
    await expect(client.attachmentUploadReservation.findUnique({ where: { id: reservation.id } }))
      .resolves.toMatchObject({ bytes: 8 });
  });
});
