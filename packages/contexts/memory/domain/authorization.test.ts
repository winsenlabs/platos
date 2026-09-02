import {
  asIdentifier,
  environmentScope,
  type EnvironmentId,
  type OrganizationId,
  type ProjectId,
} from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  authorizeMemoryRuntime,
  isMemoryRuntimeAuthorization,
  isMintedMemoryAuthorization,
  requireRuntimeAuthorization,
  runtimeScope,
  verifyRuntimeScope,
} from "./authorization.js";
import type { ActorId, AgentId, EndUserId } from "./identifiers.js";

const ANCESTRY = {
  organizationId: asIdentifier<OrganizationId>("org-1"),
  projectId: asIdentifier<ProjectId>("proj-1"),
  environmentId: asIdentifier<EnvironmentId>("env-1"),
};
const SCOPE = environmentScope(ANCESTRY.organizationId, ANCESTRY.projectId, ANCESTRY.environmentId);

function grant(overrides: Partial<Parameters<typeof authorizeMemoryRuntime>[0]> = {}) {
  return authorizeMemoryRuntime({
    ancestry: ANCESTRY,
    endUserId: asIdentifier<EndUserId>("user-1"),
    actingAgentId: asIdentifier<AgentId>("agent-1"),
    actorId: asIdentifier<ActorId>("actor-1"),
    ...overrides,
  });
}

describe("unforgeability", () => {
  it("a minted grant is recognised", () => {
    const minted = grant();
    expect(isMintedMemoryAuthorization(minted)).toBe(true);
    expect(isMemoryRuntimeAuthorization(minted)).toBe(true);
  });

  it("a STRUCTURALLY IDENTICAL literal is refused", () => {
    const literal = {
      ...ANCESTRY,
      principalType: "runtime",
      endUserId: "user-1",
      actingAgentId: "agent-1",
      actorId: "actor-1",
    };
    expect(isMemoryRuntimeAuthorization(literal)).toBe(false);
  });

  it("a SPREAD COPY of a real grant is refused — identity, not shape", () => {
    const copied = { ...grant() };
    expect(isMemoryRuntimeAuthorization(copied)).toBe(false);
  });

  it("a JSON round trip is refused", () => {
    const wired: unknown = JSON.parse(JSON.stringify(grant()));
    expect(isMemoryRuntimeAuthorization(wired)).toBe(false);
  });

  it("null, a string and a number are refused", () => {
    for (const value of [null, undefined, "grant", 7, []]) {
      expect(isMemoryRuntimeAuthorization(value)).toBe(false);
    }
  });

  it("a minted grant is FROZEN, so it cannot be re-pointed after the fact", () => {
    const minted = grant();
    expect(Object.isFrozen(minted)).toBe(true);
  });
});

describe("requireRuntimeAuthorization", () => {
  it("passes a minted grant through", () => {
    const required = requireRuntimeAuthorization(grant());
    expect(required.ok).toBe(true);
  });

  it("refuses anything else with a scope-mismatch code", () => {
    const required = requireRuntimeAuthorization({});
    expect(required.ok).toBe(false);
    if (required.ok) throw new Error("unreachable");
    expect(required.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });
});

describe("the grant names its subject", () => {
  it("carries the end user and the acting agent inside the checked value", () => {
    const minted = grant();
    expect(minted.endUserId).toBe("user-1");
    expect(minted.actingAgentId).toBe("agent-1");
  });

  it("permits a null acting agent — a sweep runs for the environment", () => {
    expect(grant({ actingAgentId: null }).actingAgentId).toBeNull();
  });
});

describe("verifyRuntimeScope", () => {
  it("accepts the scope the grant was minted for", () => {
    expect(verifyRuntimeScope(grant(), SCOPE).ok).toBe(true);
  });

  it("compares the WHOLE ancestry, not the leaf alone", () => {
    const reparented = environmentScope(
      asIdentifier<OrganizationId>("org-2"),
      ANCESTRY.projectId,
      ANCESTRY.environmentId,
    );
    const verified = verifyRuntimeScope(grant(), reparented);
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("unreachable");
    expect(verified.error.code).toBe("MEMORY_SCOPE_MISMATCH");
  });

  it("refuses a different project with the same environment id", () => {
    const moved = environmentScope(
      ANCESTRY.organizationId,
      asIdentifier<ProjectId>("proj-2"),
      ANCESTRY.environmentId,
    );
    expect(verifyRuntimeScope(grant(), moved).ok).toBe(false);
  });

  it("refuses a different environment", () => {
    const other = environmentScope(
      ANCESTRY.organizationId,
      ANCESTRY.projectId,
      asIdentifier<EnvironmentId>("env-2"),
    );
    expect(verifyRuntimeScope(grant(), other).ok).toBe(false);
  });

  it("resolves the grant back to a kernel scope", () => {
    expect(runtimeScope(grant())).toEqual(SCOPE);
  });
});
