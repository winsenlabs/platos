// The façade's suite is a REFUSAL suite.
//
// The use cases underneath already have their own negative controls. What can
// only be proven here is that the façade does not soften them: that every denial
// still arrives as a failure with the code the domain minted, and that a caller
// holding an `IdentityAccessContract` cannot reach a view for a session, a
// credential or a budget it is not entitled to. A projection layer is exactly
// where a refusal quietly becomes an empty success.
//
// It also pins what the views must NOT carry. A DTO that leaked `tokenHash` or
// `parentSessionId` would hand every consumer the material this context exists
// to hold, and no type error would follow, because the extra keys are structural.

import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  ENVIRONMENT,
  HOUR_MS,
  MINUTE_MS,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  PROJECT_ID,
  SIBLING_ENVIRONMENT,
  T0,
  aBearerCredential,
  aGlobalBearerCredential,
  anOperatorSession,
  anOperatorUser,
  aTotpCredential,
  at,
  email,
  sessionId,
  tokenHash,
  userId,
} from "../domain/testing.js";
import { DEFAULT_POLICIES } from "../domain/index.js";
import { createIdentityAccessService } from "./identity-access-service.js";
import { testPorts, type TestPorts } from "./testing.js";
import { asIdentifier, environmentScope, projectScope, type PrincipalId } from "@platos/kernel";

const SESSION_TOKEN = "plt_os_raw-session-token";
const BEARER_TOKEN = "plt_mcp_raw-token";

/** A session store holding exactly one live session for `SESSION_TOKEN`. */
function withSession(overrides: Parameters<typeof anOperatorSession>[0] = {}): TestPorts {
  const ports = testPorts();
  const session = anOperatorSession({ tokenHash: ports.hasher.hash(SESSION_TOKEN), ...overrides });
  ports.repository.state.sessions.set(session.sessionId, session);
  ports.repository.state.users.set(userId(), anOperatorUser());
  return ports;
}

/**
 * A credential store keyed the way the schema is: one row per (table, hash).
 *
 * The real store has a unique index on `tokenHash` WITHIN each credential table,
 * which is why the key here is `kind:hash` and not the hash alone. A double that
 * keyed on the hash by itself would let two rows in different tables collide and
 * would certify a lookup this context does not actually perform.
 */
function withCredential(overrides: Parameters<typeof aBearerCredential>[0] = {}): TestPorts {
  const ports = testPorts();
  const credential = aBearerCredential({
    tokenHash: ports.hasher.hash(BEARER_TOKEN),
    ...overrides,
  });
  ports.repository.state.bearerCredentials.set(
    `${credential.kind}:${credential.tokenHash}`,
    credential,
  );
  return ports;
}

async function operatorRefusal(ports: TestPorts, presentedToken: string | null): Promise<string> {
  const result = await createIdentityAccessService(ports).authenticateOperator({ presentedToken });
  if (result.ok) throw new Error("expected the operator session to be refused");
  return result.error.code;
}

async function bearerRefusal(
  ports: TestPorts,
  request: Parameters<ReturnType<typeof createIdentityAccessService>["authenticateBearer"]>[0],
): Promise<string> {
  const result = await createIdentityAccessService(ports).authenticateBearer(request);
  if (result.ok) throw new Error("expected the credential to be refused");
  return result.error.code;
}

describe("the published contract is inhabited", () => {
  it("names itself, so a mis-wired composition root is visible at run time", () => {
    expect(createIdentityAccessService(testPorts()).name).toBe("identity-access");
  });
});

describe("authenticateOperator — refusals", () => {
  it("refuses when no token was presented", async () => {
    expect(await operatorRefusal(withSession(), null)).toBe("UNAUTHENTICATED");
  });

  it("refuses a token that matches no session", async () => {
    expect(await operatorRefusal(withSession(), "plt_os_not-a-real-token")).toBe("UNAUTHENTICATED");
  });

  it("REFUSES AN EXPIRED SESSION as SESSION_EXPIRED", async () => {
    const ports = withSession({ expiresAt: at(DAY_MS) });
    ports.clock.set(at(DAY_MS + MINUTE_MS));
    expect(await operatorRefusal(ports, SESSION_TOKEN)).toBe("SESSION_EXPIRED");
  });

  it("REFUSES A REVOKED SESSION as SESSION_REVOKED", async () => {
    expect(await operatorRefusal(withSession({ revokedAt: T0 }), SESSION_TOKEN)).toBe(
      "SESSION_REVOKED",
    );
  });

  it("REFUSES AN UNVERIFIED SECOND FACTOR as MFA_REQUIRED", async () => {
    const ports = withSession({ mfaVerifiedAt: null });
    ports.repository.state.totp.set(userId(), aTotpCredential());
    expect(await operatorRefusal(ports, SESSION_TOKEN)).toBe("MFA_REQUIRED");
  });

  it("refuses a disabled operator even with a live session", async () => {
    const ports = withSession();
    ports.repository.state.users.set(userId(), anOperatorUser({ disabledAt: T0 }));
    expect(await operatorRefusal(ports, SESSION_TOKEN)).toBe("UNAUTHENTICATED");
  });
});

describe("authenticateOperator — the projection", () => {
  it("returns the view a consumer is entitled to", async () => {
    const result = await createIdentityAccessService(withSession()).authenticateOperator({
      presentedToken: SESSION_TOKEN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionId).toBe(sessionId());
    expect(result.value.actorUserId).toBe(userId());
    expect(result.value.effectiveUserId).toBe(userId());
    expect(result.value.email).toBe(email());
    expect(result.value.impersonating).toBeNull();
  });

  it("carries EXACTLY the seven published keys and nothing else", async () => {
    // Asserted as an exact set, not as a list of absences. `not.toContain
    // ("tokenHash")` reads like a leak control and is not one: the domain
    // aggregate this projects from never carried a token hash, so no edit to
    // this file could have turned that assertion red. An exact set does go red
    // the moment the projection widens — by a spread, or by a field added to
    // the aggregate and copied across without a decision.
    const result = await createIdentityAccessService(withSession()).authenticateOperator({
      presentedToken: SESSION_TOKEN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      "actorUserId",
      "effectiveUserId",
      "email",
      "expiresAt",
      "impersonating",
      "mfaVerifiedAt",
      "sessionId",
    ]);
  });

  it("separates who is acting from whose permissions apply while impersonating", async () => {
    const ports = withSession({
      userId: userId("operator-1"),
      impersonatedUserId: userId("target-1"),
      parentSessionId: sessionId("parent-1"),
    });
    ports.repository.state.sessions.set(
      sessionId("parent-1"),
      anOperatorSession({
        sessionId: sessionId("parent-1"),
        tokenHash: tokenHash("parent-hash"),
        userId: userId("operator-1"),
      }),
    );
    ports.repository.state.users.set(
      userId("operator-1"),
      anOperatorUser({ userId: userId("operator-1"), platformOperator: true }),
    );
    ports.repository.state.users.set(
      userId("target-1"),
      anOperatorUser({ userId: userId("target-1"), email: email("target@example.com") }),
    );

    const result = await createIdentityAccessService(ports).authenticateOperator({
      presentedToken: SESSION_TOKEN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actorUserId).toBe(userId("operator-1"));
    expect(result.value.effectiveUserId).toBe(userId("target-1"));
    expect(result.value.impersonating).toEqual({ targetUserId: userId("target-1") });
  });

  it("REFUSES IMPERSONATION BY A NON-PLATFORM OPERATOR", async () => {
    const ports = withSession({
      userId: userId("operator-1"),
      impersonatedUserId: userId("target-1"),
    });
    ports.repository.state.users.set(
      userId("operator-1"),
      anOperatorUser({ userId: userId("operator-1"), platformOperator: false }),
    );
    ports.repository.state.users.set(
      userId("target-1"),
      anOperatorUser({ userId: userId("target-1") }),
    );
    expect(await operatorRefusal(ports, SESSION_TOKEN)).toBe("UNAUTHENTICATED");
  });
});

describe("authenticateBearer — cross-tenant denial", () => {
  it("DENIES A SIBLING ENVIRONMENT", async () => {
    expect(
      await bearerRefusal(withCredential(), {
        presentedToken: BEARER_TOKEN,
        requestedScope: SIBLING_ENVIRONMENT,
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("denies the parent project of its own environment", async () => {
    expect(
      await bearerRefusal(withCredential(), {
        presentedToken: BEARER_TOKEN,
        requestedScope: projectScope(ORGANIZATION_ID, PROJECT_ID),
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("DENIES ANOTHER ORGANIZATION ENTIRELY", async () => {
    expect(
      await bearerRefusal(withCredential(), {
        presentedToken: BEARER_TOKEN,
        requestedScope: environmentScope(OTHER_ORGANIZATION_ID, PROJECT_ID, ENVIRONMENT.environmentId),
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("lets a GLOBAL credential through, which is what makes the denial a decision", async () => {
    const ports = withCredential();
    const global = aGlobalBearerCredential({ tokenHash: ports.hasher.hash(BEARER_TOKEN) });
    ports.repository.state.bearerCredentials.set(`${global.kind}:${global.tokenHash}`, global);
    const result = await createIdentityAccessService(ports).authenticateBearer({
      presentedToken: BEARER_TOKEN,
      requestedScope: SIBLING_ENVIRONMENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scope).toEqual({ kind: "GLOBAL", tenant: null });
  });
});

describe("authenticateBearer — capability and lifecycle", () => {
  it("REFUSES A MISSING CAPABILITY with its own code, not the scope code", async () => {
    expect(
      await bearerRefusal(withCredential(), {
        presentedToken: BEARER_TOKEN,
        requestedScope: ENVIRONMENT,
        requiredPermission: "mcp:write",
      }),
    ).toBe("MISSING_PERMISSION");
  });

  it("answers the SCOPE denial when both gates would refuse", async () => {
    // Out of scope AND without the capability. The scope gate runs first, so a
    // caller cannot learn which capabilities a credential holds by asking about
    // a tenant it cannot reach. The two codes differ, so reversing the order
    // turns this red instead of leaving it green on a shared code.
    expect(
      await bearerRefusal(withCredential(), {
        presentedToken: BEARER_TOKEN,
        requestedScope: SIBLING_ENVIRONMENT,
        requiredPermission: "mcp:write",
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("REFUSES AN EXPIRED CREDENTIAL", async () => {
    expect(
      await bearerRefusal(withCredential({ expiresAt: at(-HOUR_MS) }), {
        presentedToken: BEARER_TOKEN,
        requestedScope: ENVIRONMENT,
      }),
    ).toBe("CREDENTIAL_EXPIRED");
  });

  it("REFUSES A REVOKED CREDENTIAL, and says revoked rather than expired", async () => {
    expect(
      await bearerRefusal(withCredential({ revokedAt: T0, expiresAt: at(-HOUR_MS) }), {
        presentedToken: BEARER_TOKEN,
        requestedScope: ENVIRONMENT,
      }),
    ).toBe("CREDENTIAL_REVOKED");
  });

  it("refuses an absent token and an unroutable prefix alike", async () => {
    expect(
      await bearerRefusal(withCredential(), { presentedToken: null, requestedScope: ENVIRONMENT }),
    ).toBe("UNAUTHENTICATED");
    expect(
      await bearerRefusal(withCredential(), {
        presentedToken: "not-a-registered-prefix",
        requestedScope: ENVIRONMENT,
      }),
    ).toBe("UNAUTHENTICATED");
  });

  it("projects the principal without the storage table it came from", async () => {
    // `kind` IS on the domain authorization, so dropping it is a real decision
    // this exact key set holds in place.
    const result = await createIdentityAccessService(withCredential()).authenticateBearer({
      presentedToken: BEARER_TOKEN,
      requestedScope: ENVIRONMENT,
      requiredPermission: "mcp:read",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tier).toBe("OPERATOR");
    expect(result.value.credentialId).toBe("mcp-token-1");
    expect(result.value.scope).toEqual({ kind: "ENVIRONMENT", tenant: ENVIRONMENT });
    expect(Object.keys(result.value).sort()).toEqual([
      "credentialId",
      "permissions",
      "principalId",
      "scope",
      "tier",
    ]);
  });
});

describe("consumeRateLimit", () => {
  const request = {
    action: "LOGIN",
    identifier: "operator@example.com",
    scope: ENVIRONMENT,
    principalId: asIdentifier<PrincipalId>("user-1"),
  } as const;

  it("allows a first request and reports what is left of the window", async () => {
    const result = await createIdentityAccessService(testPorts()).consumeRateLimit(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("allowed");
    expect(result.value.remaining).toBe(DEFAULT_POLICIES.LOGIN.requests - 1);
  });

  it("REFUSES THE REQUEST AFTER THE BUDGET IS SPENT, with the wait on the failure", async () => {
    const service = createIdentityAccessService(testPorts());
    for (let spent = 0; spent < DEFAULT_POLICIES.LOGIN.requests; spent += 1) {
      const allowed = await service.consumeRateLimit(request);
      expect(allowed.ok).toBe(true);
    }
    const refused = await service.consumeRateLimit(request);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("RATE_LIMITED");
    expect(refused.error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("shares one budget between two spellings of the same identifier", async () => {
    const service = createIdentityAccessService(testPorts());
    const first = await service.consumeRateLimit(request);
    const second = await service.consumeRateLimit({ ...request, identifier: " Operator@Example.COM " });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.remaining).toBe(DEFAULT_POLICIES.LOGIN.requests - 2);
  });

  it("reports a limiter outage as degraded rather than as a healthy allow", async () => {
    const ports = testPorts();
    ports.rateLimiter.breakLimiter();
    const result = await createIdentityAccessService(ports).consumeRateLimit(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outcome).toBe("degraded");
    expect(result.value.remaining).toBeNull();
    expect(ports.safety.observations.map((observation) => observation.rule)).toContain(
      "identity.rate_limit.degraded",
    );
  });
});
