import {
  AuthorizationScopeKind,
  TokenFamily,
  TokenLifecycleAction,
  TokenLifecycleOutcome,
} from "@platos/database";
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
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      mintedByUserId: true,
      tier: true,
      expiresAt: true,
      revokedAt: true,
      environment: {
        select: {
          id: true,
          project: { select: { id: true, organizationId: true } },
        },
      },
    },
  });
  if (
    !row ||
    !constantTimeHexEqual(row.tokenHash, tokenHash) ||
    row.tier !== "admin" ||
    row.environment.project.organizationId !== organizationId
  ) {
    return null;
  }
  if (row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return null;

  const recorded = await prisma.$transaction(async (tx) => {
    const updated = await tx.mcpToken.updateMany({
      where: {
        id: row.id,
        tier: "admin",
        environment: { project: { organizationId } },
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { lastUsedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await tx.tokenLifecycleAudit.create({
      data: {
        family: TokenFamily.MCP_TOKEN,
        mcpTokenId: row.id,
        scopeKind: AuthorizationScopeKind.ENVIRONMENT,
        environmentId: row.environment.id,
        actorUserId: row.mintedByUserId,
        action: TokenLifecycleAction.USE,
        outcome: TokenLifecycleOutcome.SUCCESS,
      },
    });
    return true;
  });
  if (!recorded) return null;

  return {
    id: row.id,
    organizationId: row.environment.project.organizationId,
    actorUserId: row.mintedByUserId,
  };
}
