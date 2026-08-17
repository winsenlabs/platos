import type { PrismaClient, User } from "@platos/database";
import { prisma } from "~/db.server";

export class NewOrganizationPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call({ userId }: { userId: User["id"] }) {
    const count = await this.#prismaClient.organizationMembership.count({
      where: { userId, deactivatedAt: null, organization: { archivedAt: null } },
    });
    return { hasOrganizations: count > 0 };
  }
}
