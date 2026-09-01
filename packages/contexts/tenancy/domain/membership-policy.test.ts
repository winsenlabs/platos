import { describe, expect, it } from "vitest";

import {
  decideMembershipDeactivation,
  decideMembershipRoleChange,
  mayChangeOwnership,
  wouldStrandOrganization,
  type MembershipRoleChangeInput,
} from "./membership-policy.js";
import { anOrganizationMembership, organizationId, userId } from "./record-builders.js";
import { OrganizationRole } from "./roles.js";

const NOW = new Date("2026-04-04T00:00:00.000Z");
const ACME = organizationId("acme");

const owner = anOrganizationMembership("m-owner", ACME, userId("owner"), {
  role: OrganizationRole.OWNER,
});
const secondOwner = anOrganizationMembership("m-owner-2", ACME, userId("owner2"), {
  role: OrganizationRole.OWNER,
});
const admin = anOrganizationMembership("m-admin", ACME, userId("admin"), {
  role: OrganizationRole.ADMIN,
});
const member = anOrganizationMembership("m-member", ACME, userId("member"), {
  role: OrganizationRole.MEMBER,
});

function input(overrides: Partial<MembershipRoleChangeInput> = {}): MembershipRoleChangeInput {
  return {
    organizationLocked: true,
    actor: owner,
    target: member,
    nextRole: OrganizationRole.ADMIN,
    activeOwnerCount: 1,
    at: NOW,
    ...overrides,
  };
}

describe("who may change what", () => {
  it("lets an OWNER grant and revoke OWNER", () => {
    expect(mayChangeOwnership(OrganizationRole.OWNER, OrganizationRole.MEMBER, OrganizationRole.OWNER)).toBe(true);
    expect(mayChangeOwnership(OrganizationRole.OWNER, OrganizationRole.OWNER, OrganizationRole.ADMIN)).toBe(true);
  });

  // NEGATIVE CONTROL: an ADMIN cannot grant OWNER.
  it("refuses an ADMIN granting OWNER", () => {
    expect(mayChangeOwnership(OrganizationRole.ADMIN, OrganizationRole.MEMBER, OrganizationRole.OWNER)).toBe(false);
    const decision = decideMembershipRoleChange(
      input({ actor: admin, target: member, nextRole: OrganizationRole.OWNER }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_MEMBERSHIP_FORBIDDEN");
  });

  // The other half of the same gate: without it an ADMIN could demote every
  // OWNER and end up holding the highest remaining role.
  it("refuses an ADMIN demoting an existing OWNER", () => {
    expect(mayChangeOwnership(OrganizationRole.ADMIN, OrganizationRole.OWNER, OrganizationRole.MEMBER)).toBe(false);
    const decision = decideMembershipRoleChange(
      input({ actor: admin, target: owner, nextRole: OrganizationRole.MEMBER, activeOwnerCount: 2 }),
    );
    expect(decision.ok).toBe(false);
  });

  it("refuses a MEMBER acting at all", () => {
    const decision = decideMembershipRoleChange(input({ actor: member, target: admin }));
    expect(decision.ok).toBe(false);
  });

  it("refuses when the organization row could not be locked", () => {
    const decision = decideMembershipRoleChange(input({ organizationLocked: false }));
    expect(decision.ok).toBe(false);
  });

  it("refuses when the target membership is already deactivated", () => {
    const decision = decideMembershipRoleChange(
      input({ target: { ...member, deactivatedAt: NOW } }),
    );
    expect(decision.ok).toBe(false);
  });

  it("refuses when the ACTOR's membership is deactivated", () => {
    const decision = decideMembershipRoleChange(
      input({ actor: { ...owner, deactivatedAt: NOW } }),
    );
    expect(decision.ok).toBe(false);
  });
});

describe("the last-owner invariant", () => {
  it("recognises only a demotion away from the sole active OWNER", () => {
    expect(wouldStrandOrganization(OrganizationRole.OWNER, OrganizationRole.MEMBER, 1)).toBe(true);
    expect(wouldStrandOrganization(OrganizationRole.OWNER, OrganizationRole.MEMBER, 2)).toBe(false);
    expect(wouldStrandOrganization(OrganizationRole.OWNER, OrganizationRole.OWNER, 1)).toBe(false);
    expect(wouldStrandOrganization(OrganizationRole.ADMIN, OrganizationRole.MEMBER, 1)).toBe(false);
  });

  // NEGATIVE CONTROL: removing the last owner is rejected (409 owner_invariant).
  it("refuses demoting the last active OWNER", () => {
    const decision = decideMembershipRoleChange(
      input({ actor: owner, target: owner, nextRole: OrganizationRole.ADMIN, activeOwnerCount: 1 }),
    );
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_LAST_OWNER");
    expect(decision.error.category).toBe("conflict");
  });

  it("allows demoting an OWNER while another active OWNER remains", () => {
    const decision = decideMembershipRoleChange(
      input({ actor: owner, target: secondOwner, nextRole: OrganizationRole.ADMIN, activeOwnerCount: 2 }),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value.kind).toBe("changed");
  });

  // Gate 4 before gate 5: re-asserting OWNER on the only owner is a no-op and
  // must NOT trip the invariant.
  it("treats re-asserting the sole owner's own role as a no-op", () => {
    const decision = decideMembershipRoleChange(
      input({ actor: owner, target: owner, nextRole: OrganizationRole.OWNER, activeOwnerCount: 1 }),
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value.kind).toBe("unchanged");
  });

  it("refuses deactivating the last active OWNER too", () => {
    const decision = decideMembershipDeactivation({
      organizationLocked: true,
      actor: owner,
      target: owner,
      activeOwnerCount: 1,
      at: NOW,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_LAST_OWNER");
  });
});

describe("what a successful change carries", () => {
  it("orders the affected user's sessions revoked, impersonations included", () => {
    const decision = decideMembershipRoleChange(
      input({ actor: owner, target: member, nextRole: OrganizationRole.ADMIN }),
    );
    if (!decision.ok) throw new Error("unreachable");
    if (decision.value.kind !== "changed") throw new Error("expected a change");
    expect(decision.value.membership.role).toBe(OrganizationRole.ADMIN);
    expect(decision.value.membership.updatedAt).toEqual(NOW);
    expect(decision.value.revocation.userId).toBe(member.userId);
    expect(decision.value.revocation.cause).toBe("membership-role-changed");
    expect(decision.value.revocation.includeImpersonatedSessions).toBe(true);
  });

  it("refuses an ADMIN removing an OWNER", () => {
    const decision = decideMembershipDeactivation({
      organizationLocked: true,
      actor: admin,
      target: owner,
      activeOwnerCount: 2,
      at: NOW,
    });
    expect(decision.ok).toBe(false);
  });
});
