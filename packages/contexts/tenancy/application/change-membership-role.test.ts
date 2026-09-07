import { describe, expect, it } from "vitest";

import {
  anOrganizationMembership,
  membershipId,
  OrganizationRole,
  userId,
} from "../domain/index.js";
import {
  createChangeMembershipRole,
  createDeactivateMembership,
} from "./change-membership-role.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

/**
 * A FIXED instant, because a fixture that says `new Date()` is a fixture whose
 * value depends on when the suite runs. `scripts/arch/ambient-time.mjs` rule T2
 * refuses the ambient form here as it does in the code under test: the whole
 * reason `Clock` is a port is that an instant is an input.
 */
const ARCHIVED_AT = new Date("2026-01-01T00:00:00.000Z");


const OWNER = userId("owner");
const SECOND_OWNER = userId("owner-2");
const ADMIN = userId("admin");
const MEMBER = userId("member");

function scenario(options: { readonly twoOwners?: boolean } = {}) {
  const fixture = createTenancyFixture();
  const tree = seedTree(fixture.store);
  const organization = tree.organization.id;
  fixture.store.organizationMemberships.push(
    anOrganizationMembership("m-owner", organization, OWNER, { role: OrganizationRole.OWNER }),
    anOrganizationMembership("m-admin", organization, ADMIN, { role: OrganizationRole.ADMIN }),
    anOrganizationMembership("m-member", organization, MEMBER, { role: OrganizationRole.MEMBER }),
  );
  if (options.twoOwners === true) {
    fixture.store.organizationMemberships.push(
      anOrganizationMembership("m-owner-2", organization, SECOND_OWNER, {
        role: OrganizationRole.OWNER,
      }),
    );
  }
  fixture.sessionRevoker.seed(MEMBER, 3);
  fixture.sessionRevoker.seed(OWNER, 2);
  return { fixture, organization, tree };
}

describe("changeMembershipRole", () => {
  it("promotes a MEMBER, revokes their sessions, and does both under the lock", async () => {
    const { fixture, organization } = scenario();
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-member"),
      actorUserId: OWNER,
      role: OrganizationRole.ADMIN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toEqual({ changed: true, revokedSessionCount: 3 });

    const stored = fixture.store.organizationMemberships.find((row) => row.id === "m-member");
    expect(stored?.role).toBe(OrganizationRole.ADMIN);
    // The organization row was locked FOR UPDATE before anything was read.
    expect([...fixture.locks.organizationLocks]).toEqual([organization]);
    // The write and the revocation shared ONE transaction.
    expect(fixture.unitOfWork.transactionCount()).toBe(1);
    expect(fixture.sessionRevoker.orders).toHaveLength(1);
    expect(fixture.sessionRevoker.liveSessions(MEMBER)).toBe(0);
  });

  // NEGATIVE CONTROL: an ADMIN cannot grant OWNER.
  it("refuses an ADMIN granting OWNER, and writes nothing", async () => {
    const { fixture, organization } = scenario();
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-member"),
      actorUserId: ADMIN,
      role: OrganizationRole.OWNER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_MEMBERSHIP_FORBIDDEN");
    expect(
      fixture.store.organizationMemberships.find((row) => row.id === "m-member")?.role,
    ).toBe(OrganizationRole.MEMBER);
    expect(fixture.sessionRevoker.orders).toHaveLength(0);
  });

  it("refuses an ADMIN demoting an OWNER", async () => {
    const { fixture, organization } = scenario({ twoOwners: true });
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-owner"),
      actorUserId: ADMIN,
      role: OrganizationRole.MEMBER,
    });
    expect(result.ok).toBe(false);
  });

  // NEGATIVE CONTROL: removing (demoting) the last owner is rejected.
  it("refuses demoting the last active OWNER with the owner invariant", async () => {
    const { fixture, organization } = scenario();
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-owner"),
      actorUserId: OWNER,
      role: OrganizationRole.ADMIN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_LAST_OWNER");
    expect(result.error.category).toBe("conflict");
    expect(fixture.sessionRevoker.liveSessions(OWNER)).toBe(2);
  });

  it("allows demoting an OWNER once a second active OWNER exists", async () => {
    const { fixture, organization } = scenario({ twoOwners: true });
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-owner"),
      actorUserId: SECOND_OWNER,
      role: OrganizationRole.ADMIN,
    });
    expect(result.ok).toBe(true);
  });

  it("is a no-op when the target already holds the role, and revokes nothing", async () => {
    const { fixture, organization } = scenario();
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-owner"),
      actorUserId: OWNER,
      role: OrganizationRole.OWNER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toEqual({ changed: false, revokedSessionCount: 0 });
    expect(fixture.sessionRevoker.orders).toHaveLength(0);
  });

  it("refuses when the organization is archived, because the lock fails", async () => {
    const { fixture, organization, tree } = scenario();
    fixture.store.organizations = [{ ...tree.organization, archivedAt: ARCHIVED_AT }];
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: organization,
      membershipId: membershipId("m-member"),
      actorUserId: OWNER,
      role: OrganizationRole.ADMIN,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a membership id belonging to a different organization", async () => {
    const { fixture } = scenario();
    const rival = seedTree(fixture.store, "rival");
    const change = createChangeMembershipRole(fixture.dependencies);
    const result = await change({
      organizationId: rival.organization.id,
      membershipId: membershipId("m-member"),
      actorUserId: OWNER,
      role: OrganizationRole.ADMIN,
    });
    expect(result.ok).toBe(false);
  });
});

describe("deactivateMembership", () => {
  it("deactivates a MEMBER and ends their sessions in the same transaction", async () => {
    const { fixture, organization } = scenario();
    const deactivate = createDeactivateMembership(fixture.dependencies);
    const result = await deactivate({
      organizationId: organization,
      membershipId: membershipId("m-member"),
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.revokedSessionCount).toBe(3);
    expect(
      fixture.store.organizationMemberships.find((row) => row.id === "m-member")?.deactivatedAt,
    ).not.toBeNull();
    expect(fixture.unitOfWork.transactionCount()).toBe(1);
  });

  // Only an OWNER may remove an OWNER. With a single owner in the organization
  // the last-owner branch is unreachable through this use case — the only OWNER
  // who could act is the target, and self-removal is refused first — so both
  // guards are exercised here and the invariant itself is pinned at the domain
  // level in membership-policy.test.ts.
  it("refuses an ADMIN removing an OWNER", async () => {
    const { fixture, organization } = scenario({ twoOwners: true });
    const deactivate = createDeactivateMembership(fixture.dependencies);
    const result = await deactivate({
      organizationId: organization,
      membershipId: membershipId("m-owner"),
      actorUserId: ADMIN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ reason: "owner-removal-requires-owner" });
  });

  it("lets one OWNER remove another while an active OWNER remains", async () => {
    const { fixture, organization } = scenario({ twoOwners: true });
    const deactivate = createDeactivateMembership(fixture.dependencies);
    const result = await deactivate({
      organizationId: organization,
      membershipId: membershipId("m-owner-2"),
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(true);
  });

  it("refuses self-removal", async () => {
    const { fixture, organization } = scenario({ twoOwners: true });
    const deactivate = createDeactivateMembership(fixture.dependencies);
    const result = await deactivate({
      organizationId: organization,
      membershipId: membershipId("m-owner"),
      actorUserId: OWNER,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.details).toEqual({ reason: "self-removal" });
  });
});
