// Integration events tenancy publishes.
//
// Appended through the kernel `OutboxWriter` inside the same unit of work that
// wrote the state they describe (ADR M0.3 §3), so there is no instant in which
// a membership is demoted and the event saying so does not exist. `eventing`
// routes them and `observability` projects them; neither imports this context's
// domain, which is why every payload below is flat, self-describing JSON.
//
// The names are dotted, lower-case, and prefixed with the owning context, per
// the kernel `DomainEvent` envelope. Renaming one is a breaking change.
//
// PAYLOADS ARE `type`, NOT `interface`, on purpose: a type alias gains an
// implicit index signature and therefore satisfies the kernel's `JsonValue`
// constraint, while an interface does not.

import type { DomainEventDraft } from "@platos/kernel";

export const TENANCY_EVENT_NAMES = {
  organizationArchived: "tenancy.organization.archived",
  projectArchived: "tenancy.project.archived",
  environmentArchived: "tenancy.environment.archived",
  membershipRoleChanged: "tenancy.membership.role-changed",
  membershipDeactivated: "tenancy.membership.deactivated",
  invitationIssued: "tenancy.invitation.issued",
  invitationAccepted: "tenancy.invitation.accepted",
  projectMemberAdded: "tenancy.project-membership.added",
  accessKeyGenerationAdvanced: "tenancy.environment.access-key-generation-advanced",
} as const;

export type TenancyEventName = (typeof TENANCY_EVENT_NAMES)[keyof typeof TENANCY_EVENT_NAMES];

export type TenantArchivedPayload = {
  readonly level: "organization" | "project" | "environment";
  readonly tenantId: string;
  readonly archivedAt: string;
};

export type MembershipRoleChangedPayload = {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly previousRole: string;
  readonly role: string;
  /** How many operator sessions the change ended. */
  readonly revokedSessionCount: number;
};

export type MembershipDeactivatedPayload = {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly deactivatedAt: string;
  readonly revokedSessionCount: number;
};

export type InvitationIssuedPayload = {
  readonly organizationId: string;
  readonly invitationId: string;
  /**
   * The invited address. Present because a notification cannot be routed
   * without it; the TOKEN is never in an event, only ever in the response to
   * the call that minted it.
   */
  readonly email: string;
  readonly role: string;
  readonly expiresAt: string;
  readonly supersededCount: number;
};

export type InvitationAcceptedPayload = {
  readonly organizationId: string;
  readonly invitationId: string;
  readonly userId: string;
  readonly role: string;
};

export type ProjectMemberAddedPayload = {
  readonly organizationId: string;
  readonly projectId: string;
  readonly projectMembershipId: string;
  readonly organizationMembershipId: string;
  readonly role: string;
};

export type AccessKeyGenerationAdvancedPayload = {
  readonly environmentId: string;
  readonly generation: number;
};

export type TenancyEventDraft =
  | DomainEventDraft<TenantArchivedPayload>
  | DomainEventDraft<MembershipRoleChangedPayload>
  | DomainEventDraft<MembershipDeactivatedPayload>
  | DomainEventDraft<InvitationIssuedPayload>
  | DomainEventDraft<InvitationAcceptedPayload>
  | DomainEventDraft<ProjectMemberAddedPayload>
  | DomainEventDraft<AccessKeyGenerationAdvancedPayload>;
