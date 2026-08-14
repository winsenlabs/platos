import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ErasureIdempotencyConflictError,
  ErasureService,
  ERASURE_POLICY_VERSION,
} from "./erasure.service";

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation_1",
    idempotencyKey: "key_1",
    subjectKeyHash: "00".repeat(32),
    organizationId: "org_1",
    status: "blocked_legal_hold",
    scopes: [],
    stores: [],
    inventory: {},
    policyVersion: ERASURE_POLICY_VERSION,
    legalHoldPolicyId: "hold_1",
    attempts: 0,
    requestedAt: new Date("2026-08-14T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe("ErasureService idempotency and retry subject binding", () => {
  let prisma: any;
  let service: ErasureService;

  beforeEach(() => {
    prisma = {
      platosErasureOperation: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    service = new ErasureService(prisma, {} as any);
  });

  it("scopes the same idempotency key independently across organizations", async () => {
    prisma.platosErasureOperation.findFirst.mockResolvedValue(null);
    vi.spyOn(service, "discoverSubject").mockResolvedValue({
      platosEndUserIds: ["end_user_1"],
      legacyUserIds: ["person_1"],
      scopes: [{ organizationId: "org_1", projectId: "project_1", environmentId: "env_1" }],
    });
    vi.spyOn(service, "inventory").mockResolvedValue({ resolved: 1 });
    prisma.platosErasureOperation.create.mockImplementation(async ({ data }: any) =>
      operation(data)
    );

    const receipt = await service.requestErasure({
      externalUserId: "person_1",
      organizationId: "org_1",
      idempotencyKey: "shared_key",
      legalHoldPolicyId: "hold_1",
    });

    expect(prisma.platosErasureOperation.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "org_1", idempotencyKey: "shared_key" },
    });
    expect(prisma.platosErasureOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org_1", idempotencyKey: "shared_key" }),
    });
    expect(receipt.operationId).toBeDefined();
  });

  it("rejects reuse in one organization for a different subject", async () => {
    const boundHash = (service as any).hash("person_1", "org_1");
    prisma.platosErasureOperation.findFirst.mockResolvedValue(
      operation({ subjectKeyHash: boundHash })
    );
    const discover = vi.spyOn(service, "discoverSubject");

    await expect(
      service.requestErasure({
        externalUserId: "person_2",
        organizationId: "org_1",
        idempotencyKey: "key_1",
      })
    ).rejects.toBeInstanceOf(ErasureIdempotencyConflictError);
    expect(discover).not.toHaveBeenCalled();
  });

  it("re-reads and validates the subject after a concurrent create conflict", async () => {
    const hash = (service as any).hash("person_1", "org_1");
    prisma.platosErasureOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation({ subjectKeyHash: hash }));
    prisma.platosErasureOperation.create.mockRejectedValue({ code: "P2002" });
    vi.spyOn(service, "discoverSubject").mockResolvedValue({
      platosEndUserIds: ["end_user_1"],
      legacyUserIds: ["person_1"],
      scopes: [],
    });
    vi.spyOn(service, "inventory").mockResolvedValue({ resolved: 1 });

    await expect(
      service.requestErasure({
        externalUserId: "person_1",
        organizationId: "org_1",
        idempotencyKey: "key_1",
        legalHoldPolicyId: "hold_1",
      })
    ).resolves.toMatchObject({ operationId: "operation_1" });
    expect(prisma.platosErasureOperation.findFirst).toHaveBeenLastCalledWith({
      where: { organizationId: "org_1", idempotencyKey: "key_1" },
    });
  });

  it("rejects a retry subject mismatch before discovery or deletion", async () => {
    const hash = (service as any).hash("person_1", "org_1");
    prisma.platosErasureOperation.findFirst.mockResolvedValue(operation({ subjectKeyHash: hash }));
    const discover = vi.spyOn(service, "discoverSubject");
    const executors = vi.spyOn(service as any, "executors");

    await expect(service.retryErasureById("operation_1", "person_2")).resolves.toBeNull();
    expect(discover).not.toHaveBeenCalled();
    expect(executors).not.toHaveBeenCalled();
    expect(prisma.platosErasureOperation.update).not.toHaveBeenCalled();
  });
});
