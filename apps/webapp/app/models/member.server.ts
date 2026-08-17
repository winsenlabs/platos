import { hashSecret, OrganizationRole } from "@platos/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { platosAuth, requestRateLimitIdentifier } from "~/services/platosAuth.server";

export class MemberLimitReachedError extends Error {
  constructor(public readonly limit: number) {
    super(`Organization has reached the member limit of ${limit}.`);
    this.name = "MemberLimitReachedError";
  }
}

type MemberCapacityClient = Pick<typeof prisma, "organizationMembership" | "organizationInvitation">;

export async function assertOrgMemberCapacity(
  organizationId: string,
  invitesAdded: number,
  prismaClient: MemberCapacityClient = prisma
) {
  const limit = env.PLATOS_MAX_PROJECT_MEMBERS;
  const now = new Date();
  const [memberCount, inviteCount] = await Promise.all([
    prismaClient.organizationMembership.count({
      where: { organizationId, deactivatedAt: null },
    }),
    prismaClient.organizationInvitation.count({
      where: {
        organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    }),
  ]);
  if (memberCount + inviteCount + invitesAdded > limit) throw new MemberLimitReachedError(limit);
}

async function requireOrganizationAdmin(organizationId: string, userId: string) {
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (
    !membership ||
    membership.deactivatedAt ||
    ![OrganizationRole.OWNER, OrganizationRole.ADMIN].includes(membership.role)
  ) {
    throw new Response("Forbidden", { status: 403 });
  }
  return membership;
}

export async function getTeamMembersAndInvites({ userId, organizationId }: { userId: string; organizationId: string }) {
  await requireOrganizationAdmin(organizationId, userId);
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      memberships: {
        where: { deactivatedAt: null },
        select: {
          id: true,
          role: true,
          user: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        },
      },
      invitations: {
        where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
          expiresAt: true,
          inviter: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        },
      },
    },
  });
  return organization
    ? { members: organization.memberships, invites: organization.invitations }
    : null;
}

export async function removeTeamMember({ userId, organizationId, memberId }: { userId: string; organizationId: string; memberId: string }) {
  const actorMembership = await requireOrganizationAdmin(organizationId, userId);
  const membership = await prisma.organizationMembership.findFirst({
    where: { id: memberId, organizationId, deactivatedAt: null },
    include: { organization: true, user: true },
  });
  if (!membership) throw new Response("Member not found", { status: 404 });
  if (membership.role === OrganizationRole.OWNER && actorMembership.role !== OrganizationRole.OWNER) {
    throw new Response("Only an owner can remove another owner", { status: 403 });
  }
  await platosAuth.removeMembership(membership.id);
  return membership;
}

export async function changeTeamMemberRole({
  userId,
  organizationId,
  memberId,
  role,
}: {
  userId: string;
  organizationId: string;
  memberId: string;
  role: OrganizationRole;
}) {
  const actorMembership = await requireOrganizationAdmin(organizationId, userId);
  const membership = await prisma.organizationMembership.findFirst({
    where: { id: memberId, organizationId, deactivatedAt: null },
    include: { user: true },
  });
  if (!membership) throw new Response("Member not found", { status: 404 });
  if (
    (membership.role === OrganizationRole.OWNER || role === OrganizationRole.OWNER) &&
    actorMembership.role !== OrganizationRole.OWNER
  ) {
    throw new Response("Only an owner can change owner roles", { status: 403 });
  }
  await platosAuth.changeMembershipRole(membership.id, role);
  return { ...membership, role };
}

export async function inviteMembers({ organizationId, emails, userId }: { organizationId: string; emails: string[]; userId: string }) {
  await requireOrganizationAdmin(organizationId, userId);
  const dedupedEmails = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
  await assertOrgMemberCapacity(organizationId, dedupedEmails.length);
  const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return Promise.all(
    dedupedEmails.map(async (email) => {
      const issued = await platosAuth.issueInvitation({
        organizationId,
        inviterId: userId,
        email,
        role: OrganizationRole.MEMBER,
      });
      return { ...issued, email, organization, inviter };
    })
  );
}

export async function getInviteFromToken({ token }: { token: string }) {
  return prisma.organizationInvitation.findUnique({
    where: { tokenHash: hashSecret(token) },
    include: { organization: true, inviter: true },
  });
}

export async function getUsersInvites({ email }: { email: string }) {
  return prisma.organizationInvitation.findMany({
    where: {
      email: email.trim().toLowerCase(),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      organization: { archivedAt: null },
    },
    include: { organization: true, inviter: true },
  });
}

export async function acceptInvite({ user, token, request }: { user: { id: string; email: string }; token: string; request: Request }) {
  const result = await platosAuth.acceptInvitation({
    token,
    userId: user.id,
    email: user.email,
    rateLimitIdentifier: requestRateLimitIdentifier(request, "invite-accept"),
  });
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: result.organizationId },
  });
  return { organization };
}

export async function declineInvite({ user, inviteId }: { user: { id: string; email: string }; inviteId: string }) {
  const invitation = await prisma.organizationInvitation.findFirst({
    where: { id: inviteId, email: user.email.trim().toLowerCase(), acceptedAt: null, revokedAt: null },
    include: { organization: true },
  });
  if (!invitation) throw new Response("Invitation not found", { status: 404 });
  await prisma.organizationInvitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
  });
  const remainingInvites = await getUsersInvites({ email: user.email });
  return { remainingInvites, organization: invitation.organization };
}

export async function resendInvite({ inviteId, userId }: { inviteId: string; userId: string }) {
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { id: inviteId },
    include: { organization: true },
  });
  if (!invitation) throw new Response("Invitation not found", { status: 404 });
  await requireOrganizationAdmin(invitation.organizationId, userId);
  const issued = await platosAuth.issueInvitation({
    organizationId: invitation.organizationId,
    inviterId: userId,
    email: invitation.email,
    role: invitation.role,
  });
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { ...issued, email: invitation.email, organization: invitation.organization, inviter };
}

export async function revokeInvite({ userId, organizationId, inviteId }: { userId: string; organizationId: string; inviteId: string }) {
  await requireOrganizationAdmin(organizationId, userId);
  const invitation = await prisma.organizationInvitation.findFirst({
    where: { id: inviteId, organizationId, acceptedAt: null, revokedAt: null },
    include: { organization: true },
  });
  if (!invitation) throw new Response("Invitation not found", { status: 404 });
  await prisma.organizationInvitation.update({
    where: { id: invitation.id },
    data: { revokedAt: new Date() },
  });
  return { email: invitation.email, organization: invitation.organization };
}
