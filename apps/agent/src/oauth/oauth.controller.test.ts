import { HttpException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthController } from "./oauth.controller";

vi.mock("../shared/url-validator", () => ({
  validatePublicUrl: vi.fn(async (raw: string) => ({ ok: true, url: new URL(raw) })),
  describeUrlValidationError: vi.fn(() => "blocked"),
}));

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
    entities: [
      {
        id: "entity_1",
        displayName: "Acme",
        mcpConfig: { enabled: true, redirectUriAllowlist: [] },
      },
    ],
  },
};

function harness() {
  const tx = {
    credential: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    mcpOidcSession: {
      upsert: vi.fn().mockResolvedValue({ id: "oidc_session_1" }),
    },
  };
  const prisma = {
    entity: { findFirst: vi.fn().mockResolvedValue(entity) },
    environment: {
      findFirst: vi.fn().mockResolvedValue(environment),
      findUnique: vi.fn().mockResolvedValue({
        id: "env_1",
        archivedAt: null,
        project: {
          id: "project_1",
          archivedAt: null,
          organizationId: "org_1",
          organization: { archivedAt: null },
        },
      }),
    },
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
  };
  const oauth = {
    findClient: vi.fn().mockResolvedValue({
      entityPk: "entity_1",
      registeredByUserId: "operator_1",
      redirectUris: ["https://client.example/callback"],
    }),
    effectiveScopes: vi.fn().mockResolvedValue(["mcp:tools"]),
    createConsentTransaction: vi.fn().mockResolvedValue("plt_octx_opaque.signature"),
    inspectConsentTransaction: vi.fn(),
    consumeConsentTransaction: vi.fn(),
    issueAuthCode: vi.fn().mockResolvedValue({ code: "plt_oauth_code" }),
  };
  const secretStore = {
    createInTransaction: vi.fn().mockResolvedValue({ id: "credential_1" }),
    rotateInTransaction: vi.fn(),
  };
  return {
    prisma,
    tx,
    oauth,
    secretStore,
    controller: new OAuthController(oauth as any, prisma as any, secretStore as any),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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
      })
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
      "env_1"
    );

    const consent = new URL(res.redirect.mock.calls[0]![1]);
    expect(res.redirect).toHaveBeenCalledWith(302, expect.any(String));
    expect(consent.searchParams.get("transaction")).toBe("plt_octx_opaque.signature");
    expect([...consent.searchParams.keys()]).toEqual(["transaction"]);
  });

  it("uses one canonical array descriptor through combined-mode OIDC redirect and callback", async () => {
    const h = harness();
    const identityProviders = [
      { type: "saml", metadataUrl: "https://saml.example/metadata" },
      {
        type: "oauth2_pkce",
        authorizationUrl: "https://identity.example/authorize",
        tokenUrl: "https://identity.example/token",
        userInfoUrl: "https://identity.example/userinfo",
        clientId: "entity-client",
        clientSecret: "entity-client-secret",
        scopes: ["openid", "email"],
      },
    ];
    h.prisma.environment.findFirst.mockResolvedValue({
      ...environment,
      project: {
        ...environment.project,
        entities: [
          {
            ...environment.project.entities[0],
            mcpConfig: {
              enabled: true,
              identityMode: "bearer+oidc+anonymous",
              identityProviders,
            },
          },
        ],
      },
    });
    const consent = {
      entityId: "entity_1",
      entity: { externalId: "acme" },
      environmentId: "env_1",
      client: { clientId: "client_1" },
      redirectUri: "https://client.example/callback",
      state: "client_state",
      codeChallenge: "client_challenge",
      scopes: ["mcp:tools"],
    };
    h.oauth.inspectConsentTransaction.mockResolvedValue(consent);
    h.oauth.consumeConsentTransaction.mockResolvedValue(consent);
    const redirectRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    };

    await h.controller.entityOidcRedirect(
      "acme",
      {} as any,
      redirectRes as any,
      "consent_transaction_1"
    );

    const providerRedirect = new URL(redirectRes.redirect.mock.calls[0]![1]);
    expect(providerRedirect.origin + providerRedirect.pathname).toBe(
      "https://identity.example/authorize"
    );
    expect(providerRedirect.searchParams.get("client_id")).toBe("entity-client");
    expect(providerRedirect.searchParams.get("scope")).toBe("openid email");
    expect(providerRedirect.searchParams.get("code_challenge_method")).toBe("S256");
    const signedState = providerRedirect.searchParams.get("state");
    expect(signedState).toBeTruthy();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          access_token: "provider_access_token",
          refresh_token: "provider_refresh_token",
          expires_in: 3600,
          // Deliberately unsigned and contradictory: identity must come from
          // the authenticated userinfo response, never this token's payload.
          id_token: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
            '{"sub":"forged"}'
          ).toString("base64url")}.signature`,
        }),
        text: vi.fn(),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          sub: "user_1",
          email: "user@example.com",
          email_verified: true,
          name: "Test User",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const callbackRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
      redirect: vi.fn(),
    };

    await h.controller.entityOidcCallback(
      "acme",
      callbackRes as any,
      "entity_authorization_code",
      signedState!,
      undefined
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://identity.example/token",
      expect.objectContaining({ method: "POST" })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://identity.example/userinfo",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer provider_access_token" }),
      })
    );
    const tokenRequest = new URLSearchParams(fetchMock.mock.calls[0]![1].body);
    expect(tokenRequest.get("client_id")).toBe("entity-client");
    expect(tokenRequest.get("client_secret")).toBe("entity-client-secret");
    expect(tokenRequest.get("code_verifier")).toBeTruthy();
    expect(tokenRequest.get("redirect_uri")).toContain("/oauth/entity/acme/oidc-callback");
    expect(h.secretStore.createInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ plaintext: expect.stringContaining("provider_access_token") })
    );
    expect(h.tx.mcpOidcSession.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          environmentId_entityId_provider_externalSubject: expect.objectContaining({
            externalSubject: "user_1",
          }),
        }),
        create: expect.objectContaining({
          environmentId: "env_1",
          provider: "oauth2_pkce",
          emailVerified: true,
        }),
      })
    );
    expect(h.oauth.issueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeTuple: {
          organizationId: "org_1",
          projectId: "project_1",
          environmentId: "env_1",
        },
        mcpIdentity: { kind: "oidc", sessionId: "oidc_session_1" },
      })
    );
    expect(callbackRes.redirect).toHaveBeenCalledWith(
      302,
      "https://client.example/callback?code=plt_oauth_code&state=client_state"
    );
  });

  it("rejects legacy object-root and malformed canonical OIDC descriptors", async () => {
    const h = harness();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), redirect: vi.fn() };
    h.oauth.inspectConsentTransaction.mockResolvedValue({
      entityId: "entity_1",
      entity: { externalId: "acme" },
      environmentId: "env_1",
      client: { clientId: "client_1" },
    });
    h.prisma.environment.findFirst.mockResolvedValue({
      ...environment,
      project: {
        ...environment.project,
        entities: [
          {
            ...environment.project.entities[0],
            mcpConfig: {
              enabled: true,
              identityMode: "bearer+oidc",
              identityProviders: {
                type: "oauth2_pkce",
                authorizationUrl: "https://identity.example/authorize",
                tokenUrl: "https://identity.example/token",
                clientId: "legacy-client",
              },
            },
          },
        ],
      },
    });

    await h.controller.entityOidcRedirect("acme", {} as any, res as any, "transaction_1");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "oidc_not_configured" })
    );
    expect(res.redirect).not.toHaveBeenCalled();

    h.prisma.environment.findFirst.mockResolvedValue({
      ...environment,
      project: {
        ...environment.project,
        entities: [
          {
            ...environment.project.entities[0],
            mcpConfig: {
              enabled: true,
              identityMode: "bearer+oidc",
              identityProviders: [
                {
                  type: "oidc",
                  authorizationUrl: "https://identity.example/authorize",
                  tokenUrl: "https://identity.example/token",
                },
              ],
            },
          },
        ],
      },
    });
    res.status.mockClear();
    res.json.mockClear();

    await h.controller.entityOidcRedirect("acme", {} as any, res as any, "transaction_1");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "oidc_not_configured" })
    );
    expect(res.redirect).not.toHaveBeenCalled();
  });
});
