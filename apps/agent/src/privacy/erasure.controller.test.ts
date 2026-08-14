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
      discoverSubject: vi.fn(),
      inventory: vi.fn(),
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
    });
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
