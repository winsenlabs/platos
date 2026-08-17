import { beforeEach, describe, expect, it, vi } from "vitest";

const { env, logger, prisma, verifyAdminControlPlaneCredential } = vi.hoisted(() => {
  const count = () => ({ count: vi.fn() });
  const deletable = () => ({ ...count(), deleteMany: vi.fn() });
  const prisma: any = {
    adminAudit: deletable(),
    endUser: { findFirst: vi.fn() },
    endUserIdentity: { findFirst: vi.fn() },
    environment: { findFirst: vi.fn() },
    memory: deletable(),
    memoryEntity: deletable(),
    memoryRelationship: deletable(),
    messageAttachment: deletable(),
    messageRating: deletable(),
    step: { ...count(), deleteMany: vi.fn() },
    thread: deletable(),
    toolCall: { ...count(), deleteMany: vi.fn() },
    toolCallAudit: deletable(),
    turn: { ...count(), deleteMany: vi.fn() },
  };
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));

  return {
    env: { PLATOS_LEGAL_HOLD_USER_IDS: "" },
    logger: { warn: vi.fn() },
    prisma,
    verifyAdminControlPlaneCredential: vi.fn(),
  };
});

vi.mock("~/db.server", () => ({ prisma }));
vi.mock("~/env.server", () => ({ env }));
vi.mock("~/services/controlPlaneCredential.server", () => ({
  verifyAdminControlPlaneCredential,
}));
vi.mock("~/services/logger.server", () => ({ logger }));

import {
  action,
  loader,
} from "~/routes/api.v1.admin.users.$userId.data";

const ORGANIZATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ENVIRONMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const END_USER_A = "11111111-1111-4111-8111-111111111111";
const END_USER_B = "22222222-2222-4222-8222-222222222222";
const SHARED_SUBJECT = "shared-subject";

const duplicateSubjectIdentities = [
  {
    endUserId: END_USER_A,
    issuer: "issuer-a",
    channel: "web",
    subject: SHARED_SUBJECT,
  },
  {
    endUserId: END_USER_B,
    issuer: "issuer-b",
    channel: "slack",
    subject: SHARED_SUBJECT,
  },
];

function request(method: "GET" | "DELETE") {
  return new Request(
    `https://platos.example/api/v1/admin/users/id/data?organizationId=${ORGANIZATION_ID}&projectId=${PROJECT_ID}&environmentId=${ENVIRONMENT_ID}`,
    { method }
  );
}

function allDeleteMocks() {
  return [
    prisma.memoryRelationship.deleteMany,
    prisma.memoryEntity.deleteMany,
    prisma.memory.deleteMany,
    prisma.messageRating.deleteMany,
    prisma.messageAttachment.deleteMany,
    prisma.thread.deleteMany,
    prisma.turn.deleteMany,
    prisma.step.deleteMany,
    prisma.toolCall.deleteMany,
    prisma.adminAudit.deleteMany,
    prisma.toolCallAudit.deleteMany,
  ];
}

describe("admin user-data canonical EndUser erasure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
      callback(prisma)
    );
    verifyAdminControlPlaneCredential.mockResolvedValue({ id: "admin-token" });
    prisma.environment.findFirst.mockResolvedValue({ id: ENVIRONMENT_ID });
    prisma.endUserIdentity.findFirst.mockResolvedValue(duplicateSubjectIdentities[0]);
    prisma.endUser.findFirst.mockResolvedValue({ id: END_USER_A });

    for (const model of [
      prisma.thread,
      prisma.turn,
      prisma.step,
      prisma.toolCall,
      prisma.memory,
      prisma.memoryEntity,
      prisma.memoryRelationship,
      prisma.messageRating,
      prisma.messageAttachment,
      prisma.adminAudit,
      prisma.toolCallAudit,
    ]) {
      model.count.mockResolvedValue(1);
    }
    for (const deleteMany of allDeleteMocks()) {
      deleteMany.mockResolvedValue({ count: 1 });
    }
  });

  it("rejects a duplicated bare subject before lookup or transaction, leaving both graphs untouched", async () => {
    expect(duplicateSubjectIdentities).toEqual([
      expect.objectContaining({ endUserId: END_USER_A, subject: SHARED_SUBJECT }),
      expect.objectContaining({ endUserId: END_USER_B, subject: SHARED_SUBJECT }),
    ]);

    for (const response of [
      await loader({ request: request("GET"), params: { userId: SHARED_SUBJECT } } as any),
      await action({ request: request("DELETE"), params: { userId: SHARED_SUBJECT } } as any),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_end_user_id",
        message: "userId must be a canonical EndUser UUID",
      });
    }

    expect(verifyAdminControlPlaneCredential).not.toHaveBeenCalled();
    expect(prisma.environment.findFirst).not.toHaveBeenCalled();
    expect(prisma.endUserIdentity.findFirst).not.toHaveBeenCalled();
    expect(prisma.endUser.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    for (const deleteMany of allDeleteMocks()) {
      expect(deleteMany).not.toHaveBeenCalled();
    }
  });

  it("deletes only the selected UUID graph through its owning Thread cascade", async () => {
    const response = await action({
      request: request("DELETE"),
      params: { userId: END_USER_A },
    } as any);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userId: END_USER_A,
      scope: {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
      },
      deleted: {
        threads: 1,
        turns: 1,
        steps: 1,
        toolCalls: 1,
      },
    });
    expect(prisma.endUser.findFirst).toHaveBeenCalledWith({
      where: { id: END_USER_A, organizationId: ORGANIZATION_ID },
      select: { id: true },
    });
    expect(prisma.endUserIdentity.findFirst).not.toHaveBeenCalled();

    const selectedGraphWhere = {
      where: { environmentId: ENVIRONMENT_ID, endUserId: END_USER_A },
    };
    for (const deleteMany of [
      prisma.memoryRelationship.deleteMany,
      prisma.memoryEntity.deleteMany,
      prisma.memory.deleteMany,
      prisma.messageRating.deleteMany,
      prisma.messageAttachment.deleteMany,
      prisma.thread.deleteMany,
    ]) {
      expect(deleteMany).toHaveBeenCalledOnce();
      expect(deleteMany).toHaveBeenCalledWith(selectedGraphWhere);
      expect(JSON.stringify(deleteMany.mock.calls)).not.toContain(END_USER_B);
    }

    expect(prisma.turn.deleteMany).not.toHaveBeenCalled();
    expect(prisma.step.deleteMany).not.toHaveBeenCalled();
    expect(prisma.toolCall.deleteMany).not.toHaveBeenCalled();
    expect(prisma.thread.deleteMany).toHaveBeenCalledOnce();
  });
});
