import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { EmailAddress, OrganizationInvitationId, TokenDigest } from "./identifiers.js";
import { normalizeEmail } from "./identifiers.js";
import {
  activeInvitationsFor,
  confirmInvitationConsumed,
  decideInvitationAcceptance,
  isInvitationExpired,
  isInvitationLive,
  planInvitationIssue,
  revokeInvitation,
  type OrganizationInvitationRecord,
} from "./invitation.js";
import { organizationId, userId } from "./record-builders.js";
import { OrganizationRole } from "./roles.js";

const ACME = organizationId("acme");
const NOW = new Date("2026-06-06T00:00:00.000Z");
const LATER = new Date("2026-06-13T00:00:00.000Z");
const EMAIL = normalizeEmail("Ada@Example.COM");

function anInvitation(
  id: string,
  overrides: Partial<OrganizationInvitationRecord> = {},
): OrganizationInvitationRecord {
  return {
    id: asIdentifier<OrganizationInvitationId>(id),
    organizationId: ACME,
    inviterId: userId("inviter"),
    acceptedByUserId: null,
    email: EMAIL,
    role: OrganizationRole.MEMBER,
    tokenDigest: asIdentifier<TokenDigest>(`digest-${id}`),
    expiresAt: LATER,
    acceptedAt: null,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("email normalization", () => {
  it("trims and lower-cases, so the partial unique index and the domain agree", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
    expect(normalizeEmail("ada@example.com")).toBe(EMAIL);
  });
});

describe("the one-active-per-email invariant", () => {
  it("counts only live invitations for the same organization and address", () => {
    const other = asIdentifier<EmailAddress>("grace@example.com");
    const invitations = [
      anInvitation("i1"),
      anInvitation("i2", { acceptedAt: NOW }),
      anInvitation("i3", { revokedAt: NOW }),
      anInvitation("i4", { email: other }),
      anInvitation("i5", { organizationId: organizationId("rival") }),
    ];
    const active = activeInvitationsFor(invitations, ACME, EMAIL);
    expect(active.map((invitation) => invitation.id)).toEqual(["i1"]);
  });

  // Issuing SUPERSEDES rather than adding: creating first and revoking second
  // would breach the partial unique index for the length of the transaction.
  it("revokes every outstanding invitation to the address before issuing", () => {
    const existing = [anInvitation("old-1"), anInvitation("old-2")];
    const issued = anInvitation("new", { tokenDigest: asIdentifier<TokenDigest>("digest-new") });
    const plan = planInvitationIssue(existing, issued, NOW);
    expect(plan.superseded).toHaveLength(2);
    for (const superseded of plan.superseded) expect(superseded.revokedAt).toEqual(NOW);
    expect(plan.issued.id).toBe("new");
    // After the plan is applied, exactly one live invitation remains.
    const after = [...plan.superseded, plan.issued];
    expect(activeInvitationsFor(after, ACME, EMAIL)).toHaveLength(1);
  });

  it("leaves an already-revoked invitation alone", () => {
    const revoked = anInvitation("i1", { revokedAt: NOW });
    expect(revokeInvitation(revoked, LATER)).toBe(revoked);
  });
});

describe("acceptance", () => {
  const account = { userId: userId("ada"), email: EMAIL };

  it("accepts a live invitation whose address matches both proofs", () => {
    const decision = decideInvitationAcceptance({
      invitation: anInvitation("i1"),
      userId: account.userId,
      claimedEmail: "ADA@example.com",
      accountEmail: account.email,
      now: NOW,
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value.invitation.acceptedAt).toEqual(NOW);
    expect(decision.value.invitation.acceptedByUserId).toBe(account.userId);
    expect(decision.value.role).toBe(OrganizationRole.MEMBER);
  });

  it("refuses a missing, revoked or expired invitation with one indistinguishable error", () => {
    const cases: (OrganizationInvitationRecord | null)[] = [
      null,
      anInvitation("i1", { revokedAt: NOW }),
      anInvitation("i1", { expiresAt: NOW }),
    ];
    for (const invitation of cases) {
      const decision = decideInvitationAcceptance({
        invitation,
        userId: account.userId,
        claimedEmail: "ada@example.com",
        accountEmail: account.email,
        now: NOW,
      });
      expect(decision.ok).toBe(false);
      if (decision.ok) throw new Error("unreachable");
      expect(decision.error.code).toBe("TENANCY_INVITATION_INVALID");
    }
  });

  it("refuses an already-accepted invitation as a conflict, not as invalid", () => {
    const decision = decideInvitationAcceptance({
      invitation: anInvitation("i1", { acceptedAt: NOW }),
      userId: account.userId,
      claimedEmail: "ada@example.com",
      accountEmail: account.email,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_INVITATION_CONSUMED");
    expect(decision.error.category).toBe("conflict");
  });

  it("refuses when the proved address is not the invited one", () => {
    const decision = decideInvitationAcceptance({
      invitation: anInvitation("i1"),
      userId: account.userId,
      claimedEmail: "grace@example.com",
      accountEmail: account.email,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_INVITATION_EMAIL_MISMATCH");
  });

  // Both addresses are checked: proving control of an address is not the same
  // as being the account the membership would be attached to.
  it("refuses when the ACCOUNT's address is not the invited one", () => {
    const decision = decideInvitationAcceptance({
      invitation: anInvitation("i1"),
      userId: account.userId,
      claimedEmail: "ada@example.com",
      accountEmail: asIdentifier<EmailAddress>("someone.else@example.com"),
      now: NOW,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("TENANCY_INVITATION_EMAIL_MISMATCH");
  });

  it("refuses when identity-access has no such account", () => {
    const decision = decideInvitationAcceptance({
      invitation: anInvitation("i1"),
      userId: account.userId,
      claimedEmail: "ada@example.com",
      accountEmail: null,
      now: NOW,
    });
    expect(decision.ok).toBe(false);
  });
});

describe("the compare-and-set consumption", () => {
  it("accepts exactly one affected row and refuses anything else", () => {
    expect(confirmInvitationConsumed(1).ok).toBe(true);
    const none = confirmInvitationConsumed(0);
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error("unreachable");
    expect(none.error.code).toBe("TENANCY_INVITATION_CONSUMED");
  });
});

describe("liveness and expiry are separate questions", () => {
  it("treats an unexpired, unconsumed invitation as live", () => {
    const invitation = anInvitation("i1");
    expect(isInvitationLive(invitation)).toBe(true);
    expect(isInvitationExpired(invitation, NOW)).toBe(false);
    // Expiry is inclusive of the boundary, as the oracle's `<=` is.
    expect(isInvitationExpired(invitation, LATER)).toBe(true);
    expect(isInvitationLive({ ...invitation, expiresAt: NOW })).toBe(true);
  });
});
