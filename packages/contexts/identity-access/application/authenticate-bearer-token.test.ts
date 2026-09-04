import { describe, expect, it } from "vitest";

import { GLOBAL_SCOPE, tenantAuthorizationScope } from "../domain/index.js";
import {
  ENVIRONMENT,
  HOUR_MS,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  PROJECT_ID,
  SIBLING_ENVIRONMENT,
  T0,
  aBearerCredential,
  at,
} from "../domain/testing.js";
import { authenticateBearerToken } from "./authenticate-bearer-token.js";
import { testPorts, type TestPorts } from "./testing.js";
import { environmentScope, organizationScope, projectScope } from "@platos/kernel";

const RAW = "plt_mcp_raw-token";

function arrange(overrides: Parameters<typeof aBearerCredential>[0] = {}): TestPorts {
  const ports = testPorts();
  const credential = aBearerCredential({ tokenHash: ports.hasher.hash(RAW), ...overrides });
  ports.repository.state.bearerCredentials.set(
    `${credential.kind}:${credential.tokenHash}`,
    credential,
  );
  return ports;
}

async function refusalCode(
  ports: TestPorts,
  request: Parameters<typeof authenticateBearerToken>[1],
): Promise<string> {
  const result = await authenticateBearerToken(ports, request);
  if (result.ok) throw new Error("expected the credential to be refused");
  return result.error.code;
}

describe("authenticating a scoped bearer credential", () => {
  it("authorizes a live credential inside its own scope", async () => {
    const ports = arrange();
    const result = await authenticateBearerToken(ports, {
      presentedToken: RAW,
      requestedScope: ENVIRONMENT,
      requiredPermission: "mcp:read",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("mcp-token");
    expect(result.value.tier).toBe("OPERATOR");
  });

  it("stamps liveness only after a successful decision", async () => {
    const ports = arrange();
    await authenticateBearerToken(ports, { presentedToken: RAW, requestedScope: ENVIRONMENT });
    expect(
      ports.repository.state.bearerCredentials.get(`mcp-token:${ports.hasher.hash(RAW)}`)
        ?.lastUsedAt,
    ).toEqual(T0);
  });

  it("leaves no trace when the credential is refused", async () => {
    const ports = arrange({ revokedAt: T0 });
    await authenticateBearerToken(ports, { presentedToken: RAW, requestedScope: ENVIRONMENT });
    expect(
      ports.repository.state.bearerCredentials.get(`mcp-token:${ports.hasher.hash(RAW)}`)
        ?.lastUsedAt,
    ).toBeNull();
  });
});

describe("CROSS-SCOPE DENIAL", () => {
  it("DENIES A SIBLING ENVIRONMENT", async () => {
    expect(
      await refusalCode(arrange(), { presentedToken: RAW, requestedScope: SIBLING_ENVIRONMENT }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("denies the parent project and the parent organization", async () => {
    const ports = arrange();
    expect(
      await refusalCode(ports, {
        presentedToken: RAW,
        requestedScope: projectScope(ORGANIZATION_ID, PROJECT_ID),
      }),
    ).toBe("FORBIDDEN_SCOPE");
    expect(
      await refusalCode(ports, {
        presentedToken: RAW,
        requestedScope: organizationScope(ORGANIZATION_ID),
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("denies another organization entirely", async () => {
    expect(
      await refusalCode(arrange(), {
        presentedToken: RAW,
        requestedScope: environmentScope(
          OTHER_ORGANIZATION_ID,
          PROJECT_ID,
          ENVIRONMENT.environmentId,
        ),
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });

  it("lets a project-scoped credential reach its own environment", async () => {
    const ports = arrange({
      scope: tenantAuthorizationScope(projectScope(ORGANIZATION_ID, PROJECT_ID)),
    });
    const result = await authenticateBearerToken(ports, {
      presentedToken: RAW,
      requestedScope: ENVIRONMENT,
    });
    expect(result.ok).toBe(true);
  });

  it("lets a GLOBAL credential reach anywhere", async () => {
    const ports = arrange({ scope: GLOBAL_SCOPE });
    const result = await authenticateBearerToken(ports, {
      presentedToken: RAW,
      requestedScope: SIBLING_ENVIRONMENT,
    });
    expect(result.ok).toBe(true);
  });
});

describe("lifecycle negative controls", () => {
  it("REFUSES AN EXPIRED CREDENTIAL", async () => {
    const ports = arrange({ expiresAt: at(HOUR_MS) });
    ports.clock.set(at(HOUR_MS));
    expect(await refusalCode(ports, { presentedToken: RAW, requestedScope: ENVIRONMENT })).toBe(
      "CREDENTIAL_EXPIRED",
    );
  });

  it("REFUSES A REVOKED CREDENTIAL, and says revoked rather than expired", async () => {
    const ports = arrange({ revokedAt: T0, expiresAt: at(-HOUR_MS) });
    expect(await refusalCode(ports, { presentedToken: RAW, requestedScope: ENVIRONMENT })).toBe(
      "CREDENTIAL_REVOKED",
    );
  });

  it("refuses a credential that lacks the required permission", async () => {
    expect(
      await refusalCode(arrange(), {
        presentedToken: RAW,
        requestedScope: ENVIRONMENT,
        requiredPermission: "mcp:write",
      }),
    ).toBe("MISSING_PERMISSION");
  });

  it("checks the scope BEFORE the permission, so permissions cannot be probed", async () => {
    // Out of scope AND missing the permission: the answer must be the scope one,
    // identical to the answer for a credential that DOES carry the permission.
    // The two gates mint DIFFERENT codes, so reversing the order turns this red
    // rather than leaving it green on a shared `FORBIDDEN_SCOPE`.
    expect(
      await refusalCode(arrange(), {
        presentedToken: RAW,
        requestedScope: SIBLING_ENVIRONMENT,
        requiredPermission: "mcp:write",
      }),
    ).toBe("FORBIDDEN_SCOPE");
  });
});

describe("routing negative controls", () => {
  it("refuses an absent token", async () => {
    expect(await refusalCode(arrange(), { presentedToken: null, requestedScope: null })).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("refuses a prefix that routes to no bearer store", async () => {
    expect(
      await refusalCode(arrange(), { presentedToken: "plt_os_a-session", requestedScope: null }),
    ).toBe("UNAUTHENTICATED");
  });

  it("refuses an unprefixed string", async () => {
    expect(await refusalCode(arrange(), { presentedToken: "just-a-string", requestedScope: null })).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("refuses a well-formed prefix whose hash matches nothing", async () => {
    expect(
      await refusalCode(arrange(), { presentedToken: "plt_mcp_invented", requestedScope: null }),
    ).toBe("UNAUTHENTICATED");
  });

  it("refuses a kind this entry point does not accept", async () => {
    expect(
      await refusalCode(arrange(), {
        presentedToken: RAW,
        requestedScope: ENVIRONMENT,
        acceptedKinds: ["entity-bearer-token"],
      }),
    ).toBe("UNAUTHENTICATED");
  });
});
