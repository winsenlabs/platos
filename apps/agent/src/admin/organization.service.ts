import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { OrganizationRole } from "@platos/tenancy-database";
import {
  type ControlDatabaseClient,
  PRISMA_TOKEN,
} from "../shared/database.provider";
import { env } from "../shared/env";

const DEFAULT_OSS_MEMBER_LIMIT = 2;
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrgRecord {
  id: string;
  slug: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  companySize: string | null;
  memberRole: "ADMIN" | "MEMBER" | null;
}

export interface OrgMemberRecord {
  id: string;
  userId: string;
  role: "ADMIN" | "MEMBER";
  user: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  };
  createdAt: Date;
}

function publicRole(role: OrganizationRole): "ADMIN" | "MEMBER" {
  return role === "MEMBER" ? "MEMBER" : "ADMIN";
}

@Injectable()
export class OrganizationService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: ControlDatabaseClient,
  ) {}

  async listForUser(userId: string): Promise<OrgRecord[]> {
    if (!userId) return [];
    const memberships = await this.prisma.organizationMembership.findMany({
      where: {
        userId,
        deactivatedAt: null,
        organization: { archivedAt: null },
      },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            slug: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            archivedAt: true,
          },
        },
      },
      orderBy: { organization: { name: "asc" } },
    });
    return memberships.map(({ organization, role }) => ({
      id: organization.id,
      slug: organization.slug,
      title: organization.name,
      createdAt: organization.createdAt,
      updatedAt: organization.updatedAt,
      deletedAt: organization.archivedAt,
      companySize: null,
      memberRole: publicRole(role),
    }));
  }

  async getForUser(orgId: string, userId: string): Promise<OrgRecord | null> {
    if (!userId) return null;
    const membership = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: orgId, userId, deactivatedAt: null },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            slug: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            archivedAt: true,
          },
        },
      },
    });
    if (!membership || membership.organization.archivedAt) return null;
    return {
      id: membership.organization.id,
      slug: membership.organization.slug,
      title: membership.organization.name,
      createdAt: membership.organization.createdAt,
      updatedAt: membership.organization.updatedAt,
      deletedAt: membership.organization.archivedAt,
      companySize: null,
      memberRole: publicRole(membership.role),
    };
  }

  async update(
    orgId: string,
    userId: string,
    patch: { title?: string },
  ): Promise<OrgRecord> {
    await this.requireAdmin(orgId, userId);
    if (patch.title === undefined) {
      const current = await this.getForUser(orgId, userId);
      if (!current) throw new Error("not_found");
      return current;
    }
    const name = patch.title.trim();
    if (!name || name.length > 200) throw new Error("title_invalid");
    await this.prisma.organization.update({
      where: { id: orgId },
      data: { name },
    });
    const updated = await this.getForUser(orgId, userId);
    if (!updated) throw new Error("not_found");
    return updated;
  }

  async listMembers(
    orgId: string,
    userId: string,
  ): Promise<OrgMemberRecord[] | null> {
    const member = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: orgId, userId, deactivatedAt: null },
      select: { id: true },
    });
    if (!member) return null;
    const members = await this.prisma.organizationMembership.findMany({
      where: { organizationId: orgId, deactivatedAt: null },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: {
          select: { id: true, displayName: true, email: true },
        },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
    return members.map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      role: publicRole(membership.role),
      user: {
        id: membership.user.id,
        name: membership.user.displayName,
        email: membership.user.email,
        avatarUrl: null,
      },
      createdAt: membership.createdAt,
    }));
  }

  async addMemberInvite(
    orgId: string,
    userId: string,
    opts: { email: string; role?: "ADMIN" | "MEMBER" },
  ): Promise<{ id: string; email: string; role: "ADMIN" | "MEMBER" }> {
    await this.requireAdmin(orgId, userId);
    const email = opts.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("email_invalid");
    }
    const existing = await this.prisma.organizationMembership.findFirst({
      where: {
        organizationId: orgId,
        deactivatedAt: null,
        user: { email },
      },
      select: { id: true },
    });
    if (existing) throw new Error("already_member");
    const now = new Date();
    const existingInvite = await this.prisma.organizationInvitation.findFirst({
      where: {
        organizationId: orgId,
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (existingInvite) throw new Error("invite_already_pending");

    const memberLimit =
      env.PLATOS_MAX_PROJECT_MEMBERS ?? DEFAULT_OSS_MEMBER_LIMIT;
    const [memberCount, inviteCount] = await Promise.all([
      this.prisma.organizationMembership.count({
        where: { organizationId: orgId, deactivatedAt: null },
      }),
      this.prisma.organizationInvitation.count({
        where: {
          organizationId: orgId,
          acceptedAt: null,
          revokedAt: null,
          expiresAt: { gt: now },
        },
      }),
    ]);
    if (memberCount + inviteCount >= memberLimit) {
      const err = new Error(`member_limit_reached:${memberLimit}`);
      (err as Error & { limit: number }).limit = memberLimit;
      throw err;
    }

    const rawToken = `plt_inv_${randomBytes(32).toString("base64url")}`;
    const invite = await this.prisma.organizationInvitation.create({
      data: {
        organizationId: orgId,
        email,
        role: opts.role ?? "MEMBER",
        inviterId: userId,
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
        expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
      },
      select: { id: true, email: true, role: true },
    });
    return { ...invite, role: publicRole(invite.role) };
  }

  async removeMember(
    orgId: string,
    userId: string,
    opts: { memberId: string },
  ): Promise<{ removed: boolean }> {
    await this.requireAdmin(orgId, userId);
    const target = await this.prisma.organizationMembership.findFirst({
      where: {
        id: opts.memberId,
        organizationId: orgId,
        deactivatedAt: null,
      },
      select: { id: true, role: true },
    });
    if (!target) throw new Error("not_found");
    if (target.role === "OWNER") throw new Error("last_admin_protected");
    if (target.role === "ADMIN") await this.requireAnotherAdministrator(orgId);
    await this.prisma.organizationMembership.delete({
      where: { id: target.id },
    });
    return { removed: true };
  }

  async setMemberRole(
    orgId: string,
    userId: string,
    opts: { memberId: string; role: "ADMIN" | "MEMBER" },
  ): Promise<{ id: string; role: "ADMIN" | "MEMBER" }> {
    await this.requireAdmin(orgId, userId);
    const target = await this.prisma.organizationMembership.findFirst({
      where: {
        id: opts.memberId,
        organizationId: orgId,
        deactivatedAt: null,
      },
      select: { id: true, role: true },
    });
    if (!target) throw new Error("not_found");
    if (target.role === "OWNER") {
      if (opts.role === "MEMBER") throw new Error("last_admin_protected");
      return { id: target.id, role: "ADMIN" };
    }
    if (target.role === opts.role) return { id: target.id, role: opts.role };
    if (target.role === "ADMIN" && opts.role === "MEMBER") {
      await this.requireAnotherAdministrator(orgId);
    }
    const updated = await this.prisma.organizationMembership.update({
      where: { id: target.id },
      data: { role: opts.role },
      select: { id: true, role: true },
    });
    return { id: updated.id, role: publicRole(updated.role) };
  }

  private async requireAdmin(orgId: string, userId: string): Promise<void> {
    if (!userId) throw new Error("access_denied");
    const membership = await this.prisma.organizationMembership.findFirst({
      where: { organizationId: orgId, userId, deactivatedAt: null },
      select: { role: true },
    });
    if (!membership || membership.role === "MEMBER") {
      throw new Error("access_denied");
    }
  }

  private async requireAnotherAdministrator(orgId: string): Promise<void> {
    const adminCount = await this.prisma.organizationMembership.count({
      where: {
        organizationId: orgId,
        deactivatedAt: null,
        role: { in: ["OWNER", "ADMIN"] },
      },
    });
    if (adminCount <= 1) throw new Error("last_admin_protected");
  }
}
