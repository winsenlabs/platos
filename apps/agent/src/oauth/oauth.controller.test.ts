import { HttpException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { OAuthController } from "./oauth.controller";

const entity = {
  id: "entity_1",
  projectId: "project_1",
  displayName: "Acme",
  mcpConfig: { enabled: true, redirectUriAllowlist: [] },
  project: {
    organizationId: "org_1",
    environments: [{ id: "env_1", slug: "prod" }],
  },
};

const environment = {
  id: "env_1",
  project: {
    id: "project_1",
    organizationId: "org_1",
    entities: [{
      id: "entity_1",
      displayName: "Acme",
      mcpConfig: { enabled: true, redirectUriAllowlist: [] },
    }],
  },
};

function harness() {
  const prisma = {
    entity: { findFirst: vi.fn().mockResolvedValue(entity) },
    environment: { findFirst: vi.fn().mockResolvedValue(environment) },
  };
  const oauth = {
    findClient: vi.fn().mockResolvedValue({
      entityPk: "entity_1",
      redirectUris: ["https://client.example/callback"],
    }),
    effectiveScopes: vi.fn().mockResolvedValue(["mcp:tools"]),
    createConsentTransaction: vi.fn().mockResolvedValue("plt_octx_opaque.signature"),
  };
  return {
    prisma,
    oauth,
    controller: new OAuthController(oauth as any, prisma as any, {} as any),
  };
}

describe("OAuthController entity environment contract", () => {
  it("fails closed when discovery omits an ambiguous environment", async () => {
    const h = harness();
    const error = await h.controller.entityMetadata("acme", undefined).catch((caught) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(404);
  });

  it("publishes one canonical environment on every entity OAuth endpoint", async () => {
    const h = harness();
    const metadata = await h.controller.entityMetadata("acme", "env_1");

    expect(metadata).toMatchObject({
      authorization_endpoint: expect.stringContaining("/authorize?environmentId=env_1"),
      token_endpoint: expect.stringContaining("/token?environmentId=env_1"),
      revocation_endpoint: expect.stringContaining("/revoke?environmentId=env_1"),
      registration_endpoint: expect.stringContaining("/register?environmentId=env_1"),
    });
    expect(h.prisma.environment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "env_1", archivedAt: null }),
      }),
    );
  });

  it("propagates the canonical environment into consent", async () => {
    const h = harness();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), redirect: vi.fn() };

    await h.controller.entityAuthorize(
      "acme",
      {} as any,
      res as any,
      "code",
      "client_1",
      "https://client.example/callback",
      "mcp:tools",
      "state_1",
      "challenge_1",
      "S256",
      "env_1",
    );

    const consent = new URL(res.redirect.mock.calls[0]![1]);
    expect(res.redirect).toHaveBeenCalledWith(302, expect.any(String));
    expect(consent.searchParams.get("transaction")).toBe("plt_octx_opaque.signature");
    expect([...consent.searchParams.keys()]).toEqual(["transaction"]);
  });
});
