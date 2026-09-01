import { describe, expect, it } from "vitest";

import {
  checkProjectMembershipIntegrity,
  countActiveOwners,
  deactivateMembership,
  isActiveMembership,
  reactivateMembership,
  withOrganizationRole,
} from "./membership.js";
import {
  anOrganization,
  anOrganizationMembership,
  aProject,
  aProjectMembership,
  organizationId,
  userId,
} from "./record-builders.js";
import { OrganizationRole, ProjectRole } from "./roles.js";

const NOW = new Date("2026-03-03T00:00:00.000Z");

describe("organization membership", () => {
  it("deactivates rather than deletes, and reactivates the same row", () => {
    const organization = anOrganization("acme");
    const membership = anOrganizationMembership("m1", organization.id, userId("u1"));
    const removed = deactivateMembership(membership, NOW);
    expect(isActiveMembership(removed)).toBe(false);
    expect(removed.deactivatedAt).toEqual(NOW);

    const restored = reactivateMembership(removed, OrganizationRole.ADMIN, NOW);
    expect(restored.id).toBe(membership.id);
    expect(isActiveMembership(restored)).toBe(true);
    expect(restored.role).toBe(OrganizationRole.ADMIN);
  });

  it("is unchanged when the role it already holds is written again", () => {
    const membership = anOrganizationMembership("m1", organizationId("acme"), userId("u1"), {
      role: OrganizationRole.OWNER,
    });
    expect(withOrganizationRole(membership, OrganizationRole.OWNER, NOW)).toBe(membership);
  });

  it("counts only active owners of the named organization", () => {
    const acme = organizationId("acme");
    const other = organizationId("other");
    const memberships = [
      anOrganizationMembership("m1", acme, userId("u1"), { role: OrganizationRole.OWNER }),
      anOrganizationMembership("m2", acme, userId("u2"), {
        role: OrganizationRole.OWNER,
        deactivatedAt: NOW,
      }),
      anOrganizationMembership("m3", acme, userId("u3"), { role: OrganizationRole.ADMIN }),
      anOrganizationMembership("m4", other, userId("u4"), { role: OrganizationRole.OWNER }),
    ];
    expect(countActiveOwners(memberships, acme, OrganizationRole.OWNER)).toBe(1);
  });
});

describe("project membership cross-tenant integrity key", () => {
  const acme = anOrganization("acme");
  const rival = anOrganization("rival");
  const acmeProject = aProject("app", acme.id);
  const acmeMembership = anOrganizationMembership("m-acme", acme.id, userId("u1"));
  const rivalMembership = anOrganizationMembership("m-rival", rival.id, userId("u1"));

  it("accepts a row whose integrity key agrees with both parents", () => {
    const membership = aProjectMembership("pm1", acmeProject, acmeMembership, {
      role: ProjectRole.EDITOR,
    });
    const checked = checkProjectMembershipIntegrity(membership, acmeProject, acmeMembership);
    expect(checked.ok).toBe(true);
  });

  // NEGATIVE CONTROL: the DB-enforced invariant, restated. Both composite
  // foreign keys derive AND verify `organizationId`, so a row linking one
  // organization's project to another organization's membership cannot exist.
  it("rejects a row whose organizationId disagrees with its project", () => {
    const forged = aProjectMembership("pm2", acmeProject, acmeMembership, {
      organizationId: rival.id,
    });
    const checked = checkProjectMembershipIntegrity(forged, acmeProject, acmeMembership);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.code).toBe("TENANCY_CROSS_TENANT_MEMBERSHIP");
    expect(checked.error.category).toBe("precondition_failed");
  });

  it("rejects a row that points at a membership in a different organization", () => {
    // The integrity key agrees with the PROJECT here, so a check that only
    // consulted one parent would pass this. The membership is a stranger's.
    const forged = aProjectMembership("pm3", acmeProject, rivalMembership, {
      organizationId: acmeProject.organizationId,
    });
    const checked = checkProjectMembershipIntegrity(forged, acmeProject, rivalMembership);
    expect(checked.ok).toBe(false);
  });

  it("rejects a row whose projectId is not the project it was checked against", () => {
    const otherProject = aProject("other-app", acme.id);
    const forged = aProjectMembership("pm4", otherProject, acmeMembership);
    const checked = checkProjectMembershipIntegrity(forged, acmeProject, acmeMembership);
    expect(checked.ok).toBe(false);
  });
});
