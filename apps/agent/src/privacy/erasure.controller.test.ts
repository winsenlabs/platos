import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErasureController } from "./erasure.controller";

function response() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

const adminCredential = {
  id: "credential_1",
  scope: { organizationId: "org_1", projectId: "proj_1", environmentId: "env_1" },
  permissions: ["*"],
  mintedByUserId: "user_1",
  expiresAt: null,
  tier: "admin" as const,
};

describe("ErasureController admin control-plane authorization", () => {
  let erasure: any;
  let credentials: any;
  let controller: ErasureController;

  beforeEach(() => {
    erasure = {
      requestErasure: vi.fn().mockResolvedValue({ id: "op_1", attempts: 1 }),
      operationBelongsToOrganization: vi.fn().mockResolvedValue(true),
      getErasure: vi.fn().mockResolvedValue({ id: "op_1" }),
      retryErasureById: vi.fn(),
      resumeErasure: vi.fn(),
      resumeDueErasures: vi.fn().mockResolvedValue([]),
      discoverSubject: vi.fn(),
      inventory: vi.fn(),
      auditInventoryRead: vi.fn(),
    };
    credentials = { verify: vi.fn() };
    controller = new ErasureController(erasure, credentials);
  });

  it("rejects static internal-auth headers without an admin bearer", async () => {
    const res = response();
    await controller.create(
      { headers: { "x-platos-internal-auth": "static-secret" } } as any,
      res,
      { externalUserId: "person", organizationId: "org_1", idempotencyKey: "key_1" },
    );

    expect(res.statusCode).toBe(401);
    expect(credentials.verify).not.toHaveBeenCalled();
    expect(erasure.requestErasure).not.toHaveBeenCalled();
  });

  it("rejects scope-tier credentials and credentials from another organization", async () => {
    credentials.verify
      .mockResolvedValueOnce({ ...adminCredential, tier: "scope" })
      .mockResolvedValueOnce({
        ...adminCredential,
        scope: { ...adminCredential.scope, organizationId: "org_2" },
      });

    for (const suffix of ["scope", "other-org"]) {
      const res = response();
      await controller.create(
        { headers: { authorization: `Bearer plt_mcp_${suffix}` } } as any,
        res,
        { externalUserId: "person", organizationId: "org_1", idempotencyKey: `key_${suffix}` },
      );
      expect(res.statusCode).toBe(401);
    }
    expect(erasure.requestErasure).not.toHaveBeenCalled();
  });

  it("allows an organization-bound admin credential to request erasure", async () => {
    credentials.verify.mockResolvedValue(adminCredential);
    const res = response();

    await controller.create(
      { headers: { authorization: "Bearer plt_mcp_valid" } } as any,
      res,
      { externalUserId: "person", organizationId: "org_1", idempotencyKey: "key_1" },
    );

    expect(res.statusCode).toBe(201);
    expect(erasure.requestErasure).toHaveBeenCalledWith({
      externalUserId: "person",
      organizationId: "org_1",
      idempotencyKey: "key_1",
      legalHoldPolicyId: null,
      // The credential is no longer thrown away after the org check: an
      // irreversible deletion has to name who asked for it.
      actor: {
        credentialId: "credential_1",
        userId: "user_1",
        environmentId: "env_1",
        projectId: "proj_1",
      },
    });
  });

  it("resumes from the persisted plan when the retry omits the subject id", async () => {
    // The whole point of the resume plan: an operation whose Redis pass timed
    // out overnight can be re-driven without the identifier the system
    // deliberately refuses to keep.
    credentials.verify.mockResolvedValue(adminCredential);
    erasure.resumeErasure.mockResolvedValue({ operationId: "op_1", status: "partial_failure" });
    const res = response();

    await controller.retry(
      { headers: { authorization: "Bearer plt_mcp_valid" } } as any,
      res,
      "op_1",
      {},
    );

    expect(erasure.retryErasureById).not.toHaveBeenCalled();
    expect(erasure.resumeErasure).toHaveBeenCalledWith("op_1", expect.objectContaining({
      credentialId: "credential_1",
    }));
    expect(res.statusCode).toBe(200);
  });

  it("takes the wider path when the retry does supply the subject id", async () => {
    credentials.verify.mockResolvedValue(adminCredential);
    erasure.retryErasureById.mockResolvedValue({ operationId: "op_1", status: "completed" });
    const res = response();

    await controller.retry(
      { headers: { authorization: "Bearer plt_mcp_valid" } } as any,
      res,
      "op_1",
      { externalUserId: "person" },
    );

    expect(erasure.resumeErasure).not.toHaveBeenCalled();
    expect(erasure.retryErasureById).toHaveBeenCalledWith("op_1", "person", expect.any(Object));
  });

  it("drains only the calling organization's queue", async () => {
    credentials.verify.mockResolvedValue(adminCredential);
    erasure.resumeDueErasures.mockResolvedValue([
      { operationId: "op_1", status: "partial_failure", attempts: 2 },
    ]);
    const res = response();

    await controller.resumeDue(
      { headers: { authorization: "Bearer plt_mcp_valid" } } as any,
      res,
      { limit: 5 },
    );

    expect(erasure.resumeDueErasures).toHaveBeenCalledWith({
      organizationId: "org_1",
      limit: 5,
      actor: expect.objectContaining({ credentialId: "credential_1" }),
    });
    expect(res.body).toMatchObject({ resumed: 1 });
  });

  it("does not disclose an erasure operation across organizations", async () => {
    credentials.verify.mockResolvedValue(adminCredential);
    erasure.operationBelongsToOrganization.mockResolvedValue(false);
    const res = response();

    await controller.get(
      { headers: { authorization: "Bearer plt_mcp_valid" } } as any,
      res,
      "op_other_org",
    );

    expect(res.statusCode).toBe(401);
    expect(erasure.getErasure).not.toHaveBeenCalled();
  });
});
