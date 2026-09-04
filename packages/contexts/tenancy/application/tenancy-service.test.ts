// The published `TenancyContract`, exercised through the same in-memory
// dependencies. A contract nothing implements is a wish; this proves the one
// fifteen other contexts depend on is inhabitable and behaves.

import { resolvePath } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  anEntity,
  anOrganizationMembership,
  entityId,
  environmentId,
  isEnvironmentOperatorAuthorization,
  normalizeEmail,
  OrganizationRole,
  projectId,
  ProjectRole,
  userId,
} from "../domain/index.js";
import type { TenancyContract } from "../contracts/index.js";
import { createTenancyService } from "./tenancy-service.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

const OWNER = userId("owner");

function scenario() {
  const fixture = createTenancyFixture();
  const tree = seedTree(fixture.store);
  fixture.store.organizationMemberships.push(
    anOrganizationMembership("m-owner", tree.organization.id, OWNER, {
      role: OrganizationRole.OWNER,
    }),
  );
  fixture.store.entities.push(anEntity("crm", tree.project.id));
  const contract: TenancyContract = createTenancyService(fixture.dependencies);
  return { fixture, tree, contract };
}

describe("TenancyContract", () => {
  it("names itself", () => {
    expect(scenario().contract.name).toBe("tenancy");
  });

  it("resolves the scope every other context is keyed by", async () => {
    const { tree, contract } = scenario();
    const resolved = await contract.resolveEnvironmentScope(tree.environment.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.archived).toBeNull();
    expect(resolvePath(resolved.value.scope)).toBe("org/acme/proj/acme-app/env/acme-prod");
  });

  it("reports which level is archived rather than pretending the scope is fine", async () => {
    const { fixture, tree, contract } = scenario();
    fixture.store.projects = [{ ...tree.project, archivedAt: new Date("2026-02-02T00:00:00Z") }];
    const resolved = await contract.resolveEnvironmentScope(tree.environment.id);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.value.archived).toBe("project");
  });

  it("refuses to resolve an environment that does not exist", async () => {
    const { contract } = scenario();
    const resolved = await contract.resolveEnvironmentScope(environmentId("nope"));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.error.code).toBe("TENANCY_NOT_FOUND");
  });

  it("describes the whole tenant chain", async () => {
    const { tree, contract } = scenario();
    const described = await contract.describeTenant(tree.environment.id);
    if (!described.ok) throw new Error("unreachable");
    expect(described.value.organization.id).toBe(tree.organization.id);
    expect(described.value.project.id).toBe(tree.project.id);
    expect(described.value.environment.id).toBe(tree.environment.id);
  });

  it("issues and re-verifies an authorization, and rejects a forgery", async () => {
    const { tree, contract } = scenario();
    const authorized = await contract.authorizeEnvironmentOperator({
      environmentId: tree.environment.id,
      operator: { actorUserId: OWNER, effectiveUserId: OWNER },
      access: "secret:mutate",
    });
    expect(authorized.ok).toBe(true);
    if (!authorized.ok) throw new Error("unreachable");
    expect(contract.verifyAuthorization(authorized.value).ok).toBe(true);
    expect(isEnvironmentOperatorAuthorization(authorized.value)).toBe(true);

    const forged = contract.verifyAuthorization({ ...authorized.value });
    expect(forged.ok).toBe(false);
    if (forged.ok) throw new Error("unreachable");
    expect(forged.error.code).toBe("TENANCY_AUTHORIZATION_FORGED");
  });

  it("delegates containment to the kernel predicate", () => {
    const { tree, contract } = scenario();
    const environment = {
      level: "environment",
      organizationId: tree.organization.id,
      projectId: tree.project.id,
      environmentId: tree.environment.id,
    } as const;
    expect(
      contract.scopeContains({ level: "organization", organizationId: tree.organization.id }, environment),
    ).toBe(true);
    expect(contract.scopeContains(environment, { level: "organization", organizationId: tree.organization.id })).toBe(
      false,
    );
  });

  // `Entity` hangs off `Project`, so this is the only shape the lookup takes.
  it("lists a project's entities and refuses an unknown project", async () => {
    const { tree, contract } = scenario();
    const listed = await contract.listProjectEntities(tree.project.id);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.map((entity) => entity.externalId)).toEqual(["crm"]);
    expect((await contract.listProjectEntities(projectId("nope"))).ok).toBe(false);
    expect((await contract.findEntity(entityId("crm"))).ok).toBe(true);
    expect((await contract.findEntity(entityId("nope"))).ok).toBe(false);
  });

  it("finds an organization membership and reports its absence as not-found", async () => {
    const { tree, contract } = scenario();
    const found = await contract.findOrganizationMembership(tree.organization.id, OWNER);
    if (!found.ok) throw new Error("unreachable");
    expect(found.value.role).toBe(OrganizationRole.OWNER);
    expect((await contract.findOrganizationMembership(tree.organization.id, userId("nobody"))).ok).toBe(
      false,
    );
  });

  it("CREATES AN ORGANIZATION AND ITS OWNER through the contract", async () => {
    const { fixture, contract } = scenario();
    fixture.operators.add({
      userId: OWNER,
      email: normalizeEmail("owner@example.com"),
      disabledAt: null,
    });
    const created = await contract.createOrganization({
      name: "Globex",
      slug: "globex",
      founderUserId: OWNER,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.founderMembership.role).toBe(OrganizationRole.OWNER);

    // The new organization is immediately administrable, which is the whole
    // point of the founding membership: the owner can be found through the
    // contract's own read.
    const found = await contract.findOrganizationMembership(created.value.organization.id, OWNER);
    expect(found.ok).toBe(true);
  });

  it("CREATES A PROJECT, ITS FIRST ENVIRONMENT AND AN ADMIN MEMBERSHIP through the contract", async () => {
    const { tree, contract } = scenario();
    const created = await contract.createProject({
      organizationId: tree.organization.id,
      actorUserId: OWNER,
      name: "Checkout",
      slug: "checkout",
      environmentName: "Production",
      environmentSlug: "production",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.value.membership.role).toBe(ProjectRole.ADMIN);

    // The environment the create returned resolves as a scope, so the project
    // is reachable the moment it exists rather than after a second call. The
    // path is built from IDS, not slugs — that is what every other context is
    // keyed by — so it is asserted against the ids the create minted.
    const resolved = await contract.resolveEnvironmentScope(created.value.environment.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolvePath(resolved.value.scope)).toBe(
      `org/${tree.organization.id}/proj/${created.value.project.id}/env/${created.value.environment.id}`,
    );
  });

  it("refuses a creation the caller is not entitled to, through the contract", async () => {
    const { tree, contract } = scenario();
    const refusal = await contract.createProject({
      organizationId: tree.organization.id,
      actorUserId: userId("stranger"),
      name: "Checkout",
      slug: "checkout",
      environmentName: "Production",
      environmentSlug: "production",
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) throw new Error("unreachable");
    expect(refusal.error.code).toBe("TENANCY_PROJECT_CREATE_FORBIDDEN");
  });

  it("advances the access-key generation through the contract", async () => {
    const { tree, contract } = scenario();
    const advanced = await contract.revokeAccessKeyGeneration({
      environmentId: tree.environment.id,
    });
    if (!advanced.ok) throw new Error("unreachable");
    expect(advanced.value).toBe(1);
  });
});
