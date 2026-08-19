import { describe, expect, it, vi } from "vitest";
import type { OperatorAuthorization } from "@platos/tenancy-database";
import {
  applyLegacyImpersonation,
  canonicalUserId,
  normalizeBridgeEmail,
  resolveDashboardIdentity,
} from "../app/services/dashboardIdentity.server";

const AUTHORIZATION: OperatorAuthorization = {
  sessionId: "6be52196-613e-4c2c-9fd6-246a254ff491",
  actorUserId: "47bda732-e958-4098-8769-d103d2f2ee82",
  effectiveUserId: "47bda732-e958-4098-8769-d103d2f2ee82",
  email: " Operator+tag@Example.COM ",
  expiresAt: new Date("2026-08-20T00:00:00.000Z"),
  mfaVerifiedAt: null,
  impersonation: null,
};

function dependencies(params?: {
  authorization?: OperatorAuthorization | Error;
  matches?: Array<{ id: string; email: string }>;
}) {
  const authorization = params?.authorization ?? AUTHORIZATION;
  return {
    authorizer: {
      authorizeOperatorSession: vi.fn(async () => {
        if (authorization instanceof Error) throw authorization;
        return authorization;
      }),
    },
    legacyIdentityReader: {
      findByNormalizedEmail: vi.fn(async () => params?.matches ?? []),
    },
    canonicalMfaReader: {
      findEnabledAt: vi.fn(async () => null),
    },
    canonicalIdentityReader: {
      findEmail: vi.fn(async () => null),
    },
  };
}

describe("dashboard clean-session identity bridge", () => {
  it("normalizes with trim and case folding only", () => {
    expect(normalizeBridgeEmail(" Operator+tag@Example.COM ")).toBe(
      "operator+tag@example.com"
    );
    expect(normalizeBridgeEmail("first.last@gmail.com")).toBe("first.last@gmail.com");
  });

  it("fails closed without a session", async () => {
    const deps = dependencies();
    await expect(resolveDashboardIdentity({ token: null, ...deps })).resolves.toBeNull();
    expect(deps.authorizer.authorizeOperatorSession).not.toHaveBeenCalled();
  });

  it("fails closed for a bad clean session", async () => {
    const deps = dependencies({ authorization: new Error("bad session") });
    await expect(resolveDashboardIdentity({ token: "bad", ...deps })).resolves.toBeNull();
    expect(deps.legacyIdentityReader.findByNormalizedEmail).not.toHaveBeenCalled();
  });

  it("returns separately branded canonical and legacy IDs for one exact normalized match", async () => {
    const deps = dependencies({
      matches: [{ id: "clz8legacycuid", email: "operator+tag@example.com" }],
    });
    await expect(resolveDashboardIdentity({ token: "valid", ...deps })).resolves.toMatchObject({
      canonicalActorUserId: canonicalUserId(AUTHORIZATION.actorUserId),
      canonicalEffectiveUserId: canonicalUserId(AUTHORIZATION.effectiveUserId),
      canonicalUserId: canonicalUserId(AUTHORIZATION.effectiveUserId),
      legacyActorUserId: "clz8legacycuid",
      legacyEffectiveUserId: "clz8legacycuid",
      legacyUserId: "clz8legacycuid",
      email: AUTHORIZATION.email,
      isImpersonating: false,
    });
    expect(deps.legacyIdentityReader.findByNormalizedEmail).toHaveBeenCalledWith(
      "operator+tag@example.com"
    );
  });

  it("fails closed when a legacy principal does not belong to the clean session email", async () => {
    const deps = dependencies({
      matches: [{ id: "wrong-legacy-cuid", email: "someone-else@example.com" }],
    });
    await expect(resolveDashboardIdentity({ token: "valid", ...deps })).resolves.toBeNull();
    expect(deps.canonicalMfaReader.findEnabledAt).not.toHaveBeenCalled();
  });

  it.each([
    ["zero legacy matches", []],
    [
      "ambiguous legacy matches",
      [
        { id: "legacy-one", email: "operator+tag@example.com" },
        { id: "legacy-two", email: "OPERATOR+TAG@example.com" },
      ],
    ],
  ])("fails closed for %s", async (_name, matches) => {
    const deps = dependencies({ matches });
    await expect(resolveDashboardIdentity({ token: "valid", ...deps })).resolves.toBeNull();
    expect(deps.canonicalMfaReader.findEnabledAt).not.toHaveBeenCalled();
  });

  it("keeps canonical actor/effective and bridged legacy actor/effective identities separate", async () => {
    const authorization: OperatorAuthorization = {
      ...AUTHORIZATION,
      actorUserId: "canonical-actor",
      effectiveUserId: "canonical-effective",
      email: "target@example.com",
      impersonation: {
        active: true,
        actorUserId: "canonical-actor",
        targetUserId: "canonical-effective",
      },
    };
    const deps = dependencies({ authorization });
    deps.canonicalIdentityReader.findEmail.mockResolvedValue("admin@example.com");
    deps.legacyIdentityReader.findByNormalizedEmail.mockImplementation(async (email) =>
      email === "admin@example.com"
        ? [{ id: "legacy-admin", email }]
        : [{ id: "legacy-target", email }]
    );

    await expect(resolveDashboardIdentity({ token: "valid", ...deps })).resolves.toMatchObject({
      canonicalActorUserId: "canonical-actor",
      canonicalEffectiveUserId: "canonical-effective",
      legacyActorUserId: "legacy-admin",
      legacyEffectiveUserId: "legacy-target",
      isImpersonating: true,
    });
  });

  it("layers legacy impersonation over legacy IDs without changing canonical authorization", async () => {
    const deps = dependencies({
      matches: [{ id: "legacy-admin", email: "operator+tag@example.com" }],
    });
    const identity = await resolveDashboardIdentity({ token: "valid", ...deps });
    expect(identity).not.toBeNull();

    const impersonated = applyLegacyImpersonation({
      identity: identity!,
      legacyTargetUserId: "legacy-target",
      legacyActorIsAdmin: true,
      legacyTargetExists: true,
    });
    expect(impersonated).toMatchObject({
      canonicalActorUserId: AUTHORIZATION.actorUserId,
      canonicalEffectiveUserId: AUTHORIZATION.effectiveUserId,
      legacyActorUserId: "legacy-admin",
      legacyEffectiveUserId: "legacy-target",
      isImpersonating: true,
    });
    expect(impersonated.authorization).toBe(identity!.authorization);
  });
});
