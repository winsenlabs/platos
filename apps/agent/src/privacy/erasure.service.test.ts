import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@platos/tenancy-database";
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
    status: "CANCELLED",
    scopes: [],
    stores: [],
    inventory: {},
    policyVersion: ERASURE_POLICY_VERSION,
    legalHoldPolicyId: "hold_1",
    retryCount: 0,
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
      erasureOperation: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    service = new ErasureService(prisma, {} as any);
  });

  it("scopes the same idempotency key independently across organizations", async () => {
    prisma.erasureOperation.findFirst.mockResolvedValue(null);
    vi.spyOn(service, "discoverSubject").mockResolvedValue({
      platosEndUserIds: ["end_user_1"],
      legacyUserIds: ["person_1"],
      scopes: [{ organizationId: "org_1", projectId: "project_1", environmentId: "env_1" }],
    });
    vi.spyOn(service, "inventory").mockResolvedValue({ resolved: 1 });
    prisma.erasureOperation.create.mockImplementation(async ({ data }: any) =>
      operation(data)
    );

    const receipt = await service.requestErasure({
      externalUserId: "person_1",
      organizationId: "org_1",
      idempotencyKey: "shared_key",
      legalHoldPolicyId: "hold_1",
    });

    expect(prisma.erasureOperation.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "org_1", idempotencyKey: "shared_key" },
    });
    expect(prisma.erasureOperation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: "org_1", idempotencyKey: "shared_key" }),
    });
    expect(receipt.operationId).toBeDefined();
  });

  it("rejects reuse in one organization for a different subject", async () => {
    const boundHash = (service as any).hash("person_1", "org_1");
    prisma.erasureOperation.findFirst.mockResolvedValue(
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
    prisma.erasureOperation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(operation({ subjectKeyHash: hash }));
    prisma.erasureOperation.create.mockRejectedValue({ code: "P2002" });
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
    expect(prisma.erasureOperation.findFirst).toHaveBeenLastCalledWith({
      where: { organizationId: "org_1", idempotencyKey: "key_1" },
    });
  });

  it("rejects a retry subject mismatch before discovery or deletion", async () => {
    const hash = (service as any).hash("person_1", "org_1");
    prisma.erasureOperation.findFirst.mockResolvedValue(operation({ subjectKeyHash: hash }));
    const discover = vi.spyOn(service, "discoverSubject");
    const executors = vi.spyOn(service as any, "executors");

    await expect(service.retryErasureById("operation_1", "person_2")).resolves.toBeNull();
    expect(discover).not.toHaveBeenCalled();
    expect(executors).not.toHaveBeenCalled();
    expect(prisma.erasureOperation.update).not.toHaveBeenCalled();
  });
});

describe("ErasureService canonical subject discovery and runtime metadata", () => {
  it("resolves only the canonical external identity tuple", async () => {
    const findFirst = vi.fn().mockResolvedValue({ endUserId: "end_user_external" });
    const environmentFindMany = vi.fn().mockResolvedValue([
      { id: "env_1", projectId: "project_1" },
    ]);
    const service = new ErasureService(
      {
        endUserIdentity: { findFirst },
        environment: { findMany: environmentFindMany },
      } as any,
      {} as any,
    );

    await expect(service.discoverSubject("duplicate-subject", "org_1")).resolves.toEqual({
      platosEndUserIds: ["end_user_external"],
      legacyUserIds: ["duplicate-subject"],
      scopes: [
        { organizationId: "org_1", projectId: "project_1", environmentId: "env_1" },
      ],
    });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org_1",
        issuer: "platos:external",
        channel: "external",
        subject: "duplicate-subject",
        disabledAt: null,
      },
      select: { endUserId: true },
    });
  });

  it("matches every audit adapter field, redacts content, and verifies within one organization", async () => {
    const deleted = vi.fn().mockResolvedValue({ count: 0 });
    const safetyDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const auditUpdate = vi.fn().mockResolvedValue({});
    const auditFindMany = vi.fn().mockResolvedValue([
      {
        id: "audit_1",
      },
    ]);
    const tx = {
      messageRating: { deleteMany: deleted },
      messageAttachment: { deleteMany: deleted },
      memoryRelationship: { deleteMany: deleted },
      memoryEntity: { deleteMany: deleted },
      memory: { deleteMany: deleted },
      safetyEvent: { deleteMany: safetyDeleteMany },
      thread: { deleteMany: deleted },
      toolCallAudit: { findMany: auditFindMany, update: auditUpdate },
      endUserIdentity: { deleteMany: deleted },
      endUser: { deleteMany: deleted },
    };
    const auditCount = vi.fn().mockResolvedValue(0);
    const retainedAuditFindMany = vi.fn().mockResolvedValue([
      {
        id: "audit_1",
        endUserId: null,
        arguments: {
          __platosAudit: {
            userId: null,
            mcpUserId: null,
            endUserId: null,
          },
        },
        result: null,
        error: null,
      },
    ]);
    const safetyCount = vi.fn().mockResolvedValue(0);
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      thread: { count: vi.fn().mockResolvedValue(0) },
      memory: { count: vi.fn().mockResolvedValue(0) },
      toolCallAudit: { count: auditCount, findMany: retainedAuditFindMany },
      safetyEvent: { count: safetyCount },
      endUser: { count: vi.fn().mockResolvedValue(0) },
    };
    const service = new ErasureService(prisma as any, {} as any);

    const result = await (service as any).postgresExecutor({
      platosEndUserIds: ["end_user_1"],
      legacyUserIds: ["external_1"],
      scopes: [],
    }, "org_1");

    const auditWhere = {
      environment: { project: { organizationId: "org_1" } },
      OR: [
        { endUserId: { in: ["end_user_1"] } },
        {
          arguments: {
            path: ["__platosAudit", "userId"],
            equals: "external_1",
          },
        },
        {
          arguments: {
            path: ["__platosAudit", "mcpUserId"],
            equals: "external_1",
          },
        },
        {
          arguments: {
            path: ["__platosAudit", "endUserId"],
            equals: "external_1",
          },
        },
      ],
    };
    const safetyWhere = {
      environment: { project: { organizationId: "org_1" } },
      OR: [
        { endUserId: { in: ["end_user_1"] } },
        {
          metadata: {
            path: ["__platosSafety", "userId"],
            equals: "external_1",
          },
        },
      ],
    };
    expect(auditFindMany).toHaveBeenCalledWith({
      where: auditWhere,
      select: { id: true },
    });
    expect(auditUpdate).toHaveBeenCalledWith({
      where: { id: "audit_1" },
      data: {
        endUserId: null,
        arguments: {
          __platosAudit: {
            userId: null,
            mcpUserId: null,
            endUserId: null,
          },
        },
        result: Prisma.DbNull,
        error: null,
      },
    });
    expect(safetyDeleteMany).toHaveBeenCalledWith({ where: safetyWhere });
    expect(auditCount).toHaveBeenCalledWith({ where: auditWhere });
    expect(retainedAuditFindMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["audit_1"] },
        environment: { project: { organizationId: "org_1" } },
      },
      select: {
        id: true,
        endUserId: true,
        arguments: true,
        result: true,
        error: true,
      },
    });
    expect(safetyCount).toHaveBeenCalledWith({ where: safetyWhere });
    expect(result).toMatchObject({
      status: "done",
      verificationStatus: "passed",
      anonymized: 1,
    });
  });

  it("addresses ClickHouse by the thread ids Postgres still holds", async () => {
    // ClickHouse runs THIRD for this reason: the thread ids its rows are keyed
    // by are Postgres rows, and Postgres is about to delete them.
    const threadFindMany = vi.fn().mockResolvedValue([{ id: "thread_1" }]);
    const statements: Array<{ sql: string; params?: Record<string, string> }> = [];
    let submitted = false;
    const clickhouse = {
      available: true,
      query: async (sql: string, options: any = {}) => {
        statements.push({ sql, params: options.params });
        if (sql.startsWith("SELECT database, table, name")) {
          return ["organization_id", "user_id", "thread_id"]
            .map((column) => `platos_telemetry\tplatos_spans_v1\t${column}`)
            .join("\n");
        }
        if (sql.startsWith("SELECT database, table, mutation_id")) {
          return submitted ? "platos_telemetry\tplatos_spans_v1\tmutation_1\t1\t0\n" : "\n";
        }
        if (sql.startsWith("ALTER TABLE")) {
          submitted = true;
          return "";
        }
        return "0\n";
      },
    };
    const service = new ErasureService(
      { thread: { findMany: threadFindMany } } as any,
      {} as any,
      undefined,
      clickhouse as any,
    );

    const executors = (service as any).executors("org_1", "b".repeat(64));
    const outcome = await executors.clickhouse({
      platosEndUserIds: ["end_user_1"],
      legacyUserIds: ["external_1"],
      scopes: [],
    });

    expect(threadFindMany).toHaveBeenCalledWith({
      where: { endUserId: { in: ["end_user_1"] } },
      select: { id: true },
    });
    const mutation = statements.find((s) => s.sql.startsWith("ALTER TABLE"));
    expect(mutation?.sql).toContain("ALTER TABLE platos_telemetry.platos_spans_v1 DELETE WHERE");
    expect(mutation?.params).toMatchObject({
      organization: "org_1",
      ids: "['end_user_1','external_1']",
      threads: "['thread_1']",
      hashes: `['${"b".repeat(64)}']`,
    });
    expect(outcome).toMatchObject({ store: "clickhouse", status: "done" });
  });

  it("does not query Postgres for a ClickHouse this deployment does not have", async () => {
    const threadFindMany = vi.fn();
    const service = new ErasureService({ thread: { findMany: threadFindMany } } as any, {} as any);

    const outcome = await (service as any).clickhouseExecutor(
      { platosEndUserIds: ["end_user_1"], legacyUserIds: ["external_1"], scopes: [] },
      "org_1",
      "c".repeat(64),
    );

    expect(threadFindMany).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      status: "not_provisioned",
      verificationStatus: "not_applicable",
      deleted: 0,
      anonymized: 0,
    });
  });

  it("uses the same three adapter fields and organization ancestry for inventory", async () => {
    const auditCount = vi.fn().mockResolvedValue(1);
    const safetyCount = vi.fn().mockResolvedValue(1);
    const zero = vi.fn().mockResolvedValue(0);
    const service = new ErasureService({
      thread: { count: zero },
      memory: { count: zero },
      messageRating: { count: zero },
      messageAttachment: { count: zero },
      toolCallAudit: { count: auditCount },
      safetyEvent: { count: safetyCount },
    } as any, {} as any);

    await expect(service.inventory({
      platosEndUserIds: ["end_user_1"],
      legacyUserIds: ["external_1"],
      scopes: [],
    }, "org_1")).resolves.toMatchObject({ toolCallAudits: 1, safetyEvents: 1 });

    expect(auditCount).toHaveBeenCalledWith({
      where: {
        environment: { project: { organizationId: "org_1" } },
        OR: [
          { endUserId: { in: ["end_user_1"] } },
          { arguments: { path: ["__platosAudit", "userId"], equals: "external_1" } },
          { arguments: { path: ["__platosAudit", "mcpUserId"], equals: "external_1" } },
          { arguments: { path: ["__platosAudit", "endUserId"], equals: "external_1" } },
        ],
      },
    });
    expect(safetyCount).toHaveBeenCalledWith({
      where: {
        environment: { project: { organizationId: "org_1" } },
        OR: [
          { endUserId: { in: ["end_user_1"] } },
          { metadata: { path: ["__platosSafety", "userId"], equals: "external_1" } },
        ],
      },
    });
  });
});
