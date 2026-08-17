import { env } from "~/env.server";
import { getTeamMembersAndInvites } from "~/models/member.server";

export class TeamPresenter {
  async call({ userId, organizationId }: { userId: string; organizationId: string }) {
    const result = await getTeamMembersAndInvites({ userId, organizationId });
    if (!result) return;
    return {
      ...result,
      limits: {
        used: result.members.length + result.invites.length,
        limit: env.PLATOS_MAX_PROJECT_MEMBERS,
      },
      canPurchaseSeats: false,
      extraSeats: 0,
      seatPricing: null,
      maxSeatQuota: 0,
      planSeatLimit: env.PLATOS_MAX_PROJECT_MEMBERS,
    };
  }
}
