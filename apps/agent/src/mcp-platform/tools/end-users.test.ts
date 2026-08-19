import { describe, expect, it, vi } from "vitest";
import type { RequestScope } from "../../auth/scope.guard";
import { buildEndUserToolHandlers } from "./end-users";

const scope: RequestScope = {
  organizationId: "org-a",
  projectId: "project-a",
  environmentId: "env-a",
  userId: "operator-a",
  principal: "operator",
};

const presence = {
  OR: [
    { threads: { some: { environmentId: "env-a" } } },
    { memories: { some: { environmentId: "env-a" } } },
    { messageAttachments: { some: { environmentId: "env-a" } } },
    { toolCallAudits: { some: { environmentId: "env-a" } } },
    { safetyEvents: { some: { environmentId: "env-a" } } },
  ],
};

function tool(name: string, prisma: any) {
  const handlers = buildEndUserToolHandlers({
    prisma,
    toolAudit: { record: vi.fn().mockResolvedValue(undefined) } as any,
  });
  return handlers.find((candidate) => candidate.name === name)!;
}

describe("end_users Environment authority", () => {
  it("requires current-Environment presence for reads by canonical id", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const handler = tool("end_users.get", { endUser: { findFirst } });

    await expect(
      handler.execute({ platosEndUserId: "end-user-a" }, scope, {} as any),
    ).resolves.toEqual({ error: "not_found", platosEndUserId: "end-user-a" });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: "end-user-a",
        organizationId: "org-a",
        ...presence,
      },
    });
  });

  it("does not manufacture a verified manual identity", async () => {
    const findFirst = vi.fn();
    const handler = tool("end_users.link_identity", {
      endUser: { findFirst },
    });

    await expect(
      handler.execute(
        {
          platosEndUserId: "end-user-a",
          channel: "email",
          handle: "person@example.com",
          verified: true,
        },
        scope,
        {} as any,
      ),
    ).resolves.toEqual({
      error: "trusted_claim_required",
      message: "Manual MCP identities cannot manufacture a verified claim.",
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("requires a verified runtime claim already present in the Environment", async () => {
    const claimFindFirst = vi.fn().mockResolvedValue(null);
    const handler = tool("end_users.bind_external_id", {
      endUserIdentity: { findFirst: claimFindFirst },
    });

    await expect(
      handler.execute(
        { channel: "email", handle: "person@example.com", externalId: "customer-a" },
        scope,
        {} as any,
      ),
    ).resolves.toEqual({
      error: "trusted_claim_required",
      message: "A verified runtime identity in the current Environment is required.",
    });
    expect(claimFindFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        issuer: "channel:email",
        channel: "email",
        subject: "person@example.com",
        disabledAt: null,
        verifiedAt: { not: null },
        endUser: {
          organizationId: "org-a",
          ...presence,
        },
      },
    });
  });

  it("only confirms an external tuple previously verified by runtime persistence", async () => {
    const claim = {
      id: "identity-email",
      endUserId: "end-user-a",
      verifiedAt: new Date(),
    };
    const findFirst = vi.fn().mockResolvedValue(claim);
    const findUnique = vi.fn().mockResolvedValue({
      id: "identity-external",
      endUserId: "end-user-a",
      verifiedAt: new Date(),
    });
    const create = vi.fn();
    const update = vi.fn();
    const handler = tool("end_users.bind_external_id", {
      endUserIdentity: { findFirst, findUnique, create, update },
    });

    await expect(
      handler.execute(
        { channel: "email", handle: "person@example.com", externalId: "customer-a" },
        scope,
        {} as any,
      ),
    ).resolves.toEqual({
      ok: true,
      platosEndUserId: "end-user-a",
      externalId: "customer-a",
      created: false,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_issuer_channel_subject: {
          organizationId: "org-a",
          issuer: "platos:external",
          channel: "external",
          subject: "customer-a",
        },
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("unlinks only a manual identity belonging to an Environment-present person", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const handler = tool("end_users.unlink_identity", {
      endUserIdentity: { findFirst },
    });

    await handler.execute(
      { channel: "email", handle: "person@example.com" },
      scope,
      {} as any,
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        issuer: "platos:mcp-manual",
        channel: "email",
        subject: "person@example.com",
        disabledAt: null,
        endUser: {
          organizationId: "org-a",
          ...presence,
        },
      },
    });
   });
 });
