import { type Prisma, prisma } from "~/db.server";
import { env } from "~/env.server";
import { createEnvironment } from "./organization.server";
import { customAlphabet } from "nanoid";

const tokenValueLength = 40;
const tokenGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", tokenValueLength);

/**
 * OSS launch: hard cap on org members + pending invites. Override via
 * `PLATOS_MAX_PROJECT_MEMBERS` (defaults to 2 to mirror the hosted demo).
 * Self-hosters set a large value to effectively disable. Throws when the
 * cap is reached so callers can surface the error in the UI.
 */
export class MemberLimitReachedError extends Error {
  constructor(public readonly limit: number) {
    super(
      `Org has reached the OSS member limit of ${limit}. Set PLATOS_MAX_PROJECT_MEMBERS in the webapp environment to raise the cap.`
    );
    this.name = "MemberLimitReachedError";
  }
}

type MemberCapacityClient = Pick<typeof prisma, "orgMember" | "orgMemberInvite">;

export async function assertOrgMemberCapacity(
  organizationId: string,
  invitesAdded: number,
  prismaClient: MemberCapacityClient = prisma
): Promise<void> {
  const limit = env.PLATOS_MAX_PROJECT_MEMBERS;
  const [memberCount, inviteCount] = await Promise.all([
    prismaClient.orgMember.count({ where: { organizationId } }),
    prismaClient.orgMemberInvite.count({ where: { organizationId } }),
  ]);
  if (memberCount + inviteCount + invitesAdded > limit) {
    throw new MemberLimitReachedError(limit);
  }
}

export async function getTeamMembersAndInvites({
  userId,
  organizationId,
}: {
  userId: string;
  organizationId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { id: organizationId, members: { some: { userId } } },
    select: {
      members: {
        select: {
          id: true,
          role: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
      invites: {
        select: {
          id: true,
          email: true,
          updatedAt: true,
          inviter: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      },
    },
  });

  if (!org) {
    return null;
  }

  return { members: org.members, invites: org.invites };
}

export async function removeTeamMember({
  userId,
  slug,
  memberId,
}: {
  userId: string;
  slug: string;
  memberId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  return prisma.orgMember.delete({
    where: {
      id: memberId,
    },
    include: {
      organization: true,
      user: true,
    },
  });
}

export async function inviteMembers({
  slug,
  emails,
  userId,
}: {
  slug: string;
  emails: string[];
  userId: string;
}) {
  const org = await prisma.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  const dedupedEmails = [...new Set(emails)];

  // OSS member-cap enforcement (PLATOS_MAX_PROJECT_MEMBERS, default 2).
  // Throws MemberLimitReachedError if active members + pending invites
  // + this batch would exceed the cap. The route surfaces the message.
  await assertOrgMemberCapacity(org.id, dedupedEmails.length);

  const invites = dedupedEmails.map(
    (email) =>
      ({
        email,
        token: tokenGenerator(),
        organizationId: org.id,
        inviterId: userId,
        role: "MEMBER",
      } satisfies Prisma.OrgMemberInviteCreateManyInput)
  );

  await prisma.orgMemberInvite.createMany({
    data: invites,
  });

  return await prisma.orgMemberInvite.findMany({
    where: {
      organizationId: org.id,
      inviterId: userId,
      email: {
        in: emails,
      },
    },
    include: {
      organization: true,
      inviter: true,
    },
  });
}

export async function getInviteFromToken({ token }: { token: string }) {
  return await prisma.orgMemberInvite.findFirst({
    where: {
      token,
    },
    include: {
      organization: true,
      inviter: true,
    },
  });
}

export async function getUsersInvites({ email }: { email: string }) {
  return await prisma.orgMemberInvite.findMany({
    where: {
      email,
      organization: {
        deletedAt: null,
      },
    },
    include: {
      organization: true,
      inviter: true,
    },
  });
}

export async function acceptInvite({
  user,
  inviteId,
}: {
  user: { id: string; email: string };
  inviteId: string;
}) {
  return await prisma.$transaction(async (tx) => {
    // 1. Delete the invite and get the invite details
    const invite = await tx.orgMemberInvite.delete({
      where: {
        id: inviteId,
        email: user.email,
      },
      include: {
        organization: {
          include: {
            projects: true,
          },
        },
      },
    });

    // 2. Join the organization
    const member = await tx.orgMember.create({
      data: {
        organizationId: invite.organizationId,
        userId: user.id,
        role: invite.role,
      },
    });

    // 3. Create an environment for each project
    for (const project of invite.organization.projects) {
      await createEnvironment({
        organization: invite.organization,
        project,
        type: "DEVELOPMENT",
        isBranchableEnvironment: false,
        member,
        prismaClient: tx,
      });
    }

    // 4. Check for other invites
    const remainingInvites = await tx.orgMemberInvite.findMany({
      where: {
        email: user.email,
      },
    });

    return { remainingInvites, organization: invite.organization };
  });
}

export async function declineInvite({
  user,
  inviteId,
}: {
  user: { id: string; email: string };
  inviteId: string;
}) {
  return await prisma.$transaction(async (tx) => {
    //1. delete invite
    const declinedInvite = await prisma.orgMemberInvite.delete({
      where: {
        id: inviteId,
        email: user.email,
      },
      include: {
        organization: true,
      },
    });

    //2. check for other invites
    const remainingInvites = await prisma.orgMemberInvite.findMany({
      where: {
        email: user.email,
      },
    });

    return { remainingInvites, organization: declinedInvite.organization };
  });
}

export async function resendInvite({ inviteId, userId }: { inviteId: string; userId: string }) {
  return await prisma.orgMemberInvite.update({
    where: {
      id: inviteId,
      inviterId: userId,
    },
    data: {
      updatedAt: new Date(),
    },
    include: {
      inviter: true,
      organization: true,
    },
  });
}

export async function revokeInvite({
  userId,
  orgSlug,
  inviteId,
}: {
  userId: string;
  orgSlug: string;
  inviteId: string;
}) {
  const invite = await prisma.orgMemberInvite.findFirst({
    where: {
      id: inviteId,
      organization: {
        slug: orgSlug,
        members: {
          some: {
            userId,
          },
        },
      },
    },
    select: {
      id: true,
      email: true,
      organization: true,
    },
  });

  if (!invite) {
    throw new Error("Invite not found");
  }

  await prisma.orgMemberInvite.delete({
    where: {
      id: invite.id,
    },
  });

  return { email: invite.email, organization: invite.organization };
}
