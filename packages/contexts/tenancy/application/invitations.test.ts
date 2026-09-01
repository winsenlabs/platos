import { describe, expect, it } from "vitest";

import {
  activeInvitationsFor,
  normalizeEmail,
  OrganizationRole,
  userId,
} from "../domain/index.js";
import { createAcceptInvitation, createIssueInvitation } from "./invitations.js";
import { createTenancyFixture, seedTree } from "./testing/tenant-fixture.js";

const ADA = userId("ada");
const INVITER = userId("inviter");
const EMAIL = "Ada@Example.com";

function scenario() {
  const fixture = createTenancyFixture();
  const tree = seedTree(fixture.store);
  fixture.operators.add({
    userId: ADA,
    email: normalizeEmail(EMAIL),
    disabledAt: null,
  });
  return {
    fixture,
    tree,
    issue: createIssueInvitation(fixture.dependencies),
    accept: createAcceptInvitation(fixture.dependencies),
  };
}

describe("issueInvitation", () => {
  it("mints one invitation, normalizes the address, and takes the advisory slot lock", async () => {
    const { fixture, tree, issue } = scenario();
    const result = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.ADMIN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.supersededCount).toBe(0);
    expect(result.value.expiresAt).toEqual(new Date("2026-01-08T00:00:00.000Z"));

    const stored = fixture.store.invitations;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.email).toBe("ada@example.com");
    expect(stored[0]?.role).toBe(OrganizationRole.ADMIN);
    // The raw token is returned to the caller and stored nowhere.
    expect(stored[0]?.tokenDigest).not.toBe(result.value.token);
    expect([...fixture.locks.invitationSlots]).toEqual([
      `organization-invitation:${tree.organization.id}:ada@example.com`,
    ]);
    expect(fixture.unitOfWork.transactionCount()).toBe(1);
  });

  // THE ONE-ACTIVE-PER-EMAIL INVARIANT, end to end.
  it("supersedes the outstanding invitation instead of adding a second live one", async () => {
    const { fixture, tree, issue } = scenario();
    const first = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    const second = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      // A differently cased address is the SAME address; normalization is what
      // makes the partial unique index and the domain agree.
      email: "  ADA@EXAMPLE.COM ",
      role: OrganizationRole.ADMIN,
    });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.value.supersededCount).toBe(1);

    expect(fixture.store.invitations).toHaveLength(2);
    const live = activeInvitationsFor(
      fixture.store.invitations,
      tree.organization.id,
      normalizeEmail(EMAIL),
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(second.value.invitationId);
    expect(second.value.token).not.toBe(first.value.token);
  });

  it("keeps invitations to different addresses live side by side", async () => {
    const { fixture, tree, issue } = scenario();
    await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    const other = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: "grace@example.com",
      role: OrganizationRole.MEMBER,
    });
    expect(other.ok).toBe(true);
    if (!other.ok) throw new Error("unreachable");
    expect(other.value.supersededCount).toBe(0);
    expect(fixture.store.invitations.filter((row) => row.revokedAt === null)).toHaveLength(2);
  });
});

describe("acceptInvitation", () => {
  it("consumes the invitation and creates the membership", async () => {
    const { fixture, tree, issue, accept } = scenario();
    const issued = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.ADMIN,
    });
    if (!issued.ok) throw new Error("unreachable");

    const result = await accept({ token: issued.value.token, userId: ADA, email: EMAIL });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.role).toBe(OrganizationRole.ADMIN);
    expect(result.value.membership.deactivatedAt).toBeNull();
    expect(fixture.store.invitations[0]?.acceptedByUserId).toBe(ADA);
  });

  it("reactivates a previously deactivated membership rather than duplicating it", async () => {
    const { fixture, tree, issue, accept } = scenario();
    const issued = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    if (!issued.ok) throw new Error("unreachable");
    await accept({ token: issued.value.token, userId: ADA, email: EMAIL });

    // Remove them, then invite again.
    const [membership] = fixture.store.organizationMemberships;
    if (membership === undefined) throw new Error("expected a membership");
    fixture.store.organizationMemberships = [
      { ...membership, deactivatedAt: new Date("2026-02-02T00:00:00.000Z") },
    ];
    const reissued = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.ADMIN,
    });
    if (!reissued.ok) throw new Error("unreachable");
    const result = await accept({ token: reissued.value.token, userId: ADA, email: EMAIL });
    expect(result.ok).toBe(true);
    expect(fixture.store.organizationMemberships).toHaveLength(1);
    expect(fixture.store.organizationMemberships[0]?.id).toBe(membership.id);
    expect(fixture.store.organizationMemberships[0]?.deactivatedAt).toBeNull();
    expect(fixture.store.organizationMemberships[0]?.role).toBe(OrganizationRole.ADMIN);
  });

  it("refuses a token that was superseded by a re-invite", async () => {
    const { tree, issue, accept } = scenario();
    const first = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    if (!first.ok) throw new Error("unreachable");
    const result = await accept({ token: first.value.token, userId: ADA, email: EMAIL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_INVITATION_INVALID");
  });

  it("refuses a second acceptance of the same token", async () => {
    const { tree, issue, accept } = scenario();
    const issued = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    if (!issued.ok) throw new Error("unreachable");
    await accept({ token: issued.value.token, userId: ADA, email: EMAIL });
    const again = await accept({ token: issued.value.token, userId: ADA, email: EMAIL });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error("unreachable");
    expect(again.error.code).toBe("TENANCY_INVITATION_CONSUMED");
  });

  it("refuses an expired invitation", async () => {
    const { fixture, tree, issue, accept } = scenario();
    const issued = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    if (!issued.ok) throw new Error("unreachable");
    fixture.clock.advance(8 * 24 * 60 * 60 * 1000);
    const result = await accept({ token: issued.value.token, userId: ADA, email: EMAIL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_INVITATION_INVALID");
  });

  it("refuses a disabled account, and creates no membership", async () => {
    const { fixture, tree, issue, accept } = scenario();
    fixture.operators.add({
      userId: ADA,
      email: normalizeEmail(EMAIL),
      disabledAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    const issued = await issue({
      organizationId: tree.organization.id,
      inviterId: INVITER,
      email: EMAIL,
      role: OrganizationRole.MEMBER,
    });
    if (!issued.ok) throw new Error("unreachable");
    const result = await accept({ token: issued.value.token, userId: ADA, email: EMAIL });
    expect(result.ok).toBe(false);
    expect(fixture.store.organizationMemberships).toHaveLength(0);
  });

  it("refuses an unknown token", async () => {
    const { accept } = scenario();
    const result = await accept({ token: "plt_inv_nope", userId: ADA, email: EMAIL });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TENANCY_INVITATION_INVALID");
  });
});
