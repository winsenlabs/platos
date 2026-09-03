import { describe, expect, it } from "vitest";

import {
  anOrganizationMembership,
  membershipId,
  OrganizationRole,
  ProjectRole,
  userId,
} from "../domain/index.js";
import { createAddProjectMember } from "./add-project-member.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

const OWNER = userId("owner");
const MEMBER = userId("member");

function scenario() {
  const fixture = createTenancyFixture();
  const acme = seedTree(fixture.store, "acme");
  const rival = seedTree(fixture.store, "rival");
  fixture.store.organizationMemberships.push(
    anOrganizationMembership("m-owner", acme.organization.id, OWNER, {
      role: OrganizationRole.OWNER,
    }),
    anOrganizationMembership("m-member", acme.organization.id, MEMBER, {
      role: OrganizationRole.MEMBER,
    }),
    anOrganizationMembership("m-rival", rival.organization.id, MEMBER, {
      role: OrganizationRole.MEMBER,
    }),
  );
  return { fixture, acme, rival, add: createAddProjectMember(fixture.dependencies) };
}

describe("addProjectMember", () => {
  it("grants a project role and derives the integrity key from the project", async () => {
    const { fixture, acme, add } = scenario();
    const result = await add({
      projectId: acme.project.id,
      organizationMembershipId: membershipId("m-member"),
      organizationId: acme.organization.id,
      role: ProjectRole.EDITOR,
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.organizationId).toBe(acme.organization.id);
    expect(result.value.role).toBe(ProjectRole.EDITOR);
    expect(fixture.store.projectMemberships).toHaveLength(1);
  });

  // NEGATIVE CONTROL: a ProjectMembership whose organizationId disagrees with
  // its project is rejected. In Postgres the two composite foreign keys make
  // this row impossible; in memory there are no foreign keys, which is exactly
  // why the domain restates the invariant.
  it("rejects a membership whose organizationId disagrees with its project", async () => {
    const { fixture, acme, rival, add } = scenario();
    const result = await add({
      // A project in acme...
      projectId: acme.project.id,
      // ...a membership in rival...
      organizationMembershipId: membershipId("m-rival"),
      // ...and rival's organization id as the integrity key.
      organizationId: rival.organization.id,
      role: ProjectRole.ADMIN,
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_CROSS_TENANT_MEMBERSHIP");
    expect(result.error.details).toEqual({
      projectOrganizationId: acme.organization.id,
      membershipOrganizationId: rival.organization.id,
      declaredOrganizationId: rival.organization.id,
    });
    expect(fixture.store.projectMemberships).toHaveLength(0);
  });

  it("rejects a declared organizationId that matches neither parent", async () => {
    const { fixture, acme, rival, add } = scenario();
    const result = await add({
      projectId: acme.project.id,
      organizationMembershipId: membershipId("m-member"),
      organizationId: rival.organization.id,
      role: ProjectRole.ADMIN,
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(false);
    expect(fixture.store.projectMemberships).toHaveLength(0);
  });

  it("checks the actor against the PROJECT's organization, not the declared one", async () => {
    const { rival, acme, add } = scenario();
    // OWNER is an owner of acme and nothing in rival, so granting on rival's
    // project is refused even though the command names rival correctly.
    const result = await add({
      projectId: rival.project.id,
      organizationMembershipId: membershipId("m-rival"),
      organizationId: rival.organization.id,
      role: ProjectRole.VIEWER,
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ reason: "actor-not-organization-admin" });
    expect(acme.project.organizationId).not.toBe(rival.project.organizationId);
  });

  it("refuses a plain MEMBER acting", async () => {
    const { acme, add } = scenario();
    const result = await add({
      projectId: acme.project.id,
      organizationMembershipId: membershipId("m-member"),
      organizationId: acme.organization.id,
      role: ProjectRole.VIEWER,
      actorUserId: MEMBER,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an organization membership that does not exist", async () => {
    const { acme, add } = scenario();
    const result = await add({
      projectId: acme.project.id,
      organizationMembershipId: membershipId("no-such-membership"),
      organizationId: acme.organization.id,
      role: ProjectRole.VIEWER,
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ reason: "target-not-active" });
  });
});
