import crypto from "node:crypto";
import { prisma } from "~/db.server";

const PREFIX = "plt_mcp_";

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export type AdminControlPlaneCredential = {
  id: string;
  organizationId: string;
  actorUserId: string;
};

/**
 * Verify an admin-tier control-plane credential and persist its use audit.
 * Static deployment secrets are intentionally not accepted.
 */
export async function verifyAdminControlPlaneCredential(
  request: Request,
  organizationId: string
): Promise<AdminControlPlaneCredential | null> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const raw = authorization.slice("Bearer ".length).trim();
  if (!raw.startsWith(PREFIX)) return null;

  const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");
  const row = await prisma.platosMCPToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
      mintedByUserId: true,
      tier: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (
    !row ||
    !constantTimeHexEqual(row.tokenHash, tokenHash) ||
    row.tier !== "admin" ||
    row.organizationId !== organizationId
  ) {
    return null;
  }
  if (row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return null;

  const recorded = await prisma.$transaction(async (tx) => {
    const updated = await tx.platosMCPToken.updateMany({
      where: {
        id: row.id,
        tier: "admin",
        organizationId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { lastUsedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await tx.platosCredentialAudit.create({
      data: {
        family: "control_plane",
        credentialId: row.id,
        action: "use",
        organizationId: row.organizationId,
        projectId: row.projectId,
        environmentId: row.environmentId,
        actorUserId: row.mintedByUserId,
      },
    });
    return true;
  });
  if (!recorded) return null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    actorUserId: row.mintedByUserId,
  };
}
