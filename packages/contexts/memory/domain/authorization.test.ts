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
  runtimeScope,
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

describe("runtimeScope", () => {
  it("resolves the grant back to a kernel scope", () => {
    expect(runtimeScope(grant())).toEqual(SCOPE);
  });
});
