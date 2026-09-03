import { asIdentifier } from "@platos/kernel";
import type { EnvironmentId, OrganizationId, ProjectId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  requireMetadataAccess,
  requireRootKeyOperations,
  requireSameEnvironment,
  requireSecretMutation,
  requireSecretRead,
} from "./access-rules.js";
import {
  authorizeEnvironmentOperator,
  authorizeEnvironmentRuntime,
  authorizeEnvironmentService,
  authorizeRootKeyOperations,
  auditActor,
  isMintedAuthorization,
} from "./authorization.js";
import type { EnvironmentAuthorization, EnvironmentOperatorAuthorization } from "./authorization.js";
import { asSecretsIdentifier } from "./ids.js";
import type { ActorId } from "./ids.js";

const ancestry = {
  organizationId: asIdentifier<OrganizationId>("org-1"),
  projectId: asIdentifier<ProjectId>("proj-1"),
  environmentId: asIdentifier<EnvironmentId>("env-1"),
};
const actor = asSecretsIdentifier<ActorId>("user-1");

const operator = authorizeEnvironmentOperator({
  ancestry,
  access: "secret:mutate",
  actorUserId: actor,
  effectiveUserId: asSecretsIdentifier<ActorId>("impersonated-1"),
});
const readOnlyOperator = authorizeEnvironmentOperator({
  ancestry,
  access: "metadata",
  actorUserId: actor,
  effectiveUserId: actor,
});
const runtime = authorizeEnvironmentRuntime({ ancestry, actorId: asSecretsIdentifier<ActorId>("rt-1") });
const service = authorizeEnvironmentService({ ancestry, actorId: asSecretsIdentifier<ActorId>("svc-1") });
const rootKeyOperator = authorizeRootKeyOperations({ actorId: asSecretsIdentifier<ActorId>("ops-1") });

describe("an authorization cannot be forged", () => {
  it("rejects a structurally identical object literal", () => {
    const forged = {
      organizationId: ancestry.organizationId,
      projectId: ancestry.projectId,
      environmentId: ancestry.environmentId,
      principalType: "operator",
      tier: "OPERATOR",
      access: "secret:mutate",
      actorUserId: actor,
      effectiveUserId: actor,
    } as unknown as EnvironmentOperatorAuthorization;

    expect(isMintedAuthorization(forged)).toBe(false);
    const denied = requireSecretMutation(forged);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("CREDENTIAL_FORBIDDEN");
      expect(denied.error.details).toMatchObject({ reason: "authorization_not_minted" });
    }
  });

  it("rejects a SPREAD COPY of a genuine grant, which a symbol brand would have let through", () => {
    const copied = { ...operator } as EnvironmentOperatorAuthorization;
    expect(copied.access).toBe("secret:mutate");
    expect(isMintedAuthorization(copied)).toBe(false);
    expect(requireSecretMutation(copied).ok).toBe(false);
  });

  it("rejects anything that arrived as data", () => {
    const parsed = JSON.parse(JSON.stringify(operator)) as EnvironmentOperatorAuthorization;
    expect(isMintedAuthorization(parsed)).toBe(false);
    expect(isMintedAuthorization(null)).toBe(false);
    expect(isMintedAuthorization("operator")).toBe(false);
  });

  it("accepts and freezes what it minted", () => {
    expect(isMintedAuthorization(operator)).toBe(true);
    expect(Object.isFrozen(operator)).toBe(true);
  });
});

describe("the four access rules", () => {
  it("lets any minted environment grant read metadata", () => {
    for (const grant of [operator, readOnlyOperator, runtime, service] as EnvironmentAuthorization[]) {
      expect(requireMetadataAccess(grant).ok).toBe(true);
    }
  });

  it("denies a WRITE to a read-only operator grant", () => {
    const denied = requireSecretMutation(readOnlyOperator);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.details).toMatchObject({ reason: "mutation_requires_write_access" });
    }
  });

  it("allows a write to an operator holding secret:mutate and a service holding secret:write", () => {
    expect(requireSecretMutation(operator).ok).toBe(true);
    expect(requireSecretMutation(service).ok).toBe(true);
  });

  it("denies a runtime grant the ability to write", () => {
    expect(requireSecretMutation(runtime).ok).toBe(false);
  });

  it("restricts reading secret material to the runtime tier", () => {
    expect(requireSecretRead(runtime).ok).toBe(true);
    for (const grant of [operator, readOnlyOperator, service] as EnvironmentAuthorization[]) {
      const denied = requireSecretRead(grant);
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.error.details).toMatchObject({ reason: "read_requires_runtime_tier" });
      }
    }
  });

  it("restricts root key operations to the installation-global grant", () => {
    expect(requireRootKeyOperations(rootKeyOperator).ok).toBe(true);
    const forged = { principalType: "operations", installationScope: "global", actorId: actor };
    expect(requireRootKeyOperations(forged as never).ok).toBe(false);
  });

  it("denies a grant addressing another environment", () => {
    expect(requireSameEnvironment(operator, ancestry.environmentId).ok).toBe(true);
    const crossed = requireSameEnvironment(operator, asIdentifier<EnvironmentId>("env-2"));
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) expect(crossed.error.details).toMatchObject({ reason: "environment_mismatch" });
  });
});

describe("the audit actor never loses who really acted", () => {
  it("keeps the acting user and the effective user apart under impersonation", () => {
    expect(auditActor(operator)).toEqual({ actorId: actor, effectiveUserId: "impersonated-1" });
  });

  it("reports no effective user for machine principals", () => {
    expect(auditActor(runtime)).toEqual({ actorId: "rt-1", effectiveUserId: null });
    expect(auditActor(service)).toEqual({ actorId: "svc-1", effectiveUserId: null });
  });
});
