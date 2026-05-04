import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { env } from "../shared/env";

// OSS launch member cap — mirrors the webapp default. Self-hosters set
// PLATOS_MAX_PROJECT_MEMBERS in the agent + webapp environments to raise.
const DEFAULT_OSS_MEMBER_LIMIT = 2;

/**
 * Theme MCPF-W6 — Organization + member management service.
 *
 * Wraps `Organization` + `OrgMember` + `OrgMemberInvite` with strict
 * membership-gated reads + owner-gated writes. Used exclusively by the
 * MCP `org.*` tools.
 *
 * Authorization model:
 *   - Read paths require the caller to be a member of the org.
 *   - Mutating paths (add/remove member, role change, org update)
 *     require the caller to be `ADMIN` (the role enum has only
 *     ADMIN | MEMBER — see `OrgMemberRole` in schema.prisma:265).
 *   - Last-admin protection: removeMember + setMemberRole refuse to
 *     leave an org with zero ADMIN members.
 *
 * NEVER returns a list of orgs the caller doesn't belong to. The only
 * orgs surfaced are those reachable via `OrgMember.userId === userId`.
 */
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

@Injectable()
export class OrganizationService {
  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  /**
   * List organizations the caller is a member of. Soft-deleted orgs
   * (`deletedAt != null`) are filtered out. Returns the caller's own
   * role on each row so the UI / MCP client can hide owner-gated
   * actions for members.
   */
  async listForUser(userId: string): Promise<OrgRecord[]> {
    if (!userId) return [];
    const memberships = await this.prisma.orgMember.findMany({
      where: { userId, organization: { deletedAt: null } },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            slug: true,
            title: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
            companySize: true,
          },
        },
      },
      orderBy: { organization: { title: "asc" } },
    });
    return memberships.map((m: any) => ({
      ...m.organization,
      memberRole: m.role,
    }));
  }

  /**
   * Fetch a single org. Verifies membership; returns null when the
   * caller is not a member (cross-tenant probes get a clean 404).
   */
  async getForUser(orgId: string, userId: string): Promise<OrgRecord | null> {
    if (!userId) return null;
    const membership = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, userId },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            slug: true,
            title: true,
            createdAt: true,
            updatedAt: true,
            deletedAt: true,
            companySize: true,
          },
        },
      },
    });
    if (!membership) return null;
    if (membership.organization.deletedAt) return null;
    return { ...membership.organization, memberRole: membership.role };
  }

  /**
   * Update org name (`title`). Requires ADMIN role. Returns the
   * patched row. Throws on access denied / not_found.
   */
  async update(
    orgId: string,
    userId: string,
    patch: { title?: string },
  ): Promise<OrgRecord> {
    await this.requireAdmin(orgId, userId);
    const data: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      const trimmed = patch.title.trim();
      if (!trimmed || trimmed.length > 200) {
        throw new Error("title_invalid");
      }
      data["title"] = trimmed;
    }
    if (Object.keys(data).length === 0) {
      // No-op patch — return the current row.
      const current = await this.getForUser(orgId, userId);
      if (!current) throw new Error("not_found");
      return current;
    }
    const updated = await this.prisma.organization.update({
      where: { id: orgId },
      data,
      select: {
        id: true,
        slug: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        companySize: true,
      },
    });
    const membership = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: true },
    });
    return { ...updated, memberRole: membership?.role ?? null };
  }

  /**
   * List members of an org the caller belongs to. Membership-gated;
   * non-members get an empty list (the calling tool layer translates
   * to a not_found error).
   */
  async listMembers(orgId: string, userId: string): Promise<OrgMemberRecord[] | null> {
    const member = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, userId },
      select: { id: true },
    });
    if (!member) return null;
    const members = await this.prisma.orgMember.findMany({
      where: { organizationId: orgId },
      select: {
        id: true,
        userId: true,
        role: true,
        createdAt: true,
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });
    return members as OrgMemberRecord[];
  }

  /**
   * Add a member by email. Owner-gated. Always lands as a pending
   * `OrgMemberInvite` — joining requires the invitee to accept (the
   * webapp's accept-invite flow). Returns the invite row.
   */
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
    // Refuse if user is already a member.
    const existing = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, user: { email } },
      select: { id: true },
    });
    if (existing) throw new Error("already_member");
    // Refuse if invite already pending.
    const existingInvite = await this.prisma.orgMemberInvite.findFirst({
      where: { organizationId: orgId, email },
      select: { id: true },
    });
    if (existingInvite) throw new Error("invite_already_pending");
    // OSS launch member cap — refuse if active members + pending invites
    // already at the limit. Same cap is enforced in the webapp's
    // `inviteMembers` so REST + MCP `org.add_member` + webapp invites
    // can never collectively exceed PLATOS_MAX_PROJECT_MEMBERS.
    const memberLimit = env.PLATOS_MAX_PROJECT_MEMBERS ?? DEFAULT_OSS_MEMBER_LIMIT;
    const [memberCount, inviteCount] = await Promise.all([
      this.prisma.orgMember.count({ where: { organizationId: orgId } }),
      this.prisma.orgMemberInvite.count({ where: { organizationId: orgId } }),
    ]);
    if (memberCount + inviteCount >= memberLimit) {
      const err = new Error(`member_limit_reached:${memberLimit}`);
      (err as Error & { limit: number }).limit = memberLimit;
      throw err;
    }
    // Mint token using cuid (matches schema default).
    const invite = await this.prisma.orgMemberInvite.create({
      data: {
        organizationId: orgId,
        email,
        role: opts.role ?? "MEMBER",
        inviterId: userId,
      },
      select: { id: true, email: true, role: true },
    });
    return invite;
  }

  /**
   * Remove a member. Owner-gated. Refuses if the target is the last
   * ADMIN. Allows self-removal of MEMBER role (caller leaving org).
   */
  async removeMember(
    orgId: string,
    userId: string,
    opts: { memberId: string },
  ): Promise<{ removed: boolean }> {
    await this.requireAdmin(orgId, userId);
    const target = await this.prisma.orgMember.findFirst({
      where: { id: opts.memberId, organizationId: orgId },
      select: { id: true, role: true, userId: true },
    });
    if (!target) throw new Error("not_found");
    if (target.role === "ADMIN") {
      const adminCount = await this.prisma.orgMember.count({
        where: { organizationId: orgId, role: "ADMIN" },
      });
      if (adminCount <= 1) throw new Error("last_admin_protected");
    }
    await this.prisma.orgMember.delete({ where: { id: target.id } });
    return { removed: true };
  }

  /**
   * Change a member's role. Owner-gated. Refuses to demote the last
   * ADMIN. Caller cannot demote themselves if they would become the
   * sole MEMBER (i.e. zero admins remain).
   */
  async setMemberRole(
    orgId: string,
    userId: string,
    opts: { memberId: string; role: "ADMIN" | "MEMBER" },
  ): Promise<{ id: string; role: "ADMIN" | "MEMBER" }> {
    await this.requireAdmin(orgId, userId);
    const target = await this.prisma.orgMember.findFirst({
      where: { id: opts.memberId, organizationId: orgId },
      select: { id: true, role: true, userId: true },
    });
    if (!target) throw new Error("not_found");
    if (target.role === opts.role) return { id: target.id, role: target.role };
    if (target.role === "ADMIN" && opts.role === "MEMBER") {
      const adminCount = await this.prisma.orgMember.count({
        where: { organizationId: orgId, role: "ADMIN" },
      });
      if (adminCount <= 1) throw new Error("last_admin_protected");
    }
    const updated = await this.prisma.orgMember.update({
      where: { id: target.id },
      data: { role: opts.role },
      select: { id: true, role: true },
    });
    return updated;
  }

  /** Owner-only gate. Throws "access_denied" when caller isn't ADMIN. */
  private async requireAdmin(orgId: string, userId: string): Promise<void> {
    if (!userId) throw new Error("access_denied");
    const membership = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: true },
    });
    if (!membership) throw new Error("access_denied");
    if (membership.role !== "ADMIN") throw new Error("access_denied");
  }
}
