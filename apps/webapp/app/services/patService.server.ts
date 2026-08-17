/** Hash-only Platos personal access token lifecycle on the clean schema. */
import {
  AuthorizationScopeKind,
  TokenFamily,
  TokenLifecycleAction,
  TokenLifecycleOutcome,
  type Prisma,
} from "@platos/database";
import crypto from "node:crypto";
import { prisma } from "~/db.server";

export const PAT_TOKEN_PREFIX = "plt_pat_";
const DEFAULT_TTL_SECONDS = 90 * 24 * 3600;

export function isPlatosPAT(value: string): boolean {
  return typeof value === "string" && value.startsWith(PAT_TOKEN_PREFIX);
}

function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

function generateRawToken(): string {
  return `${PAT_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  } catch {
    return false;
  }
}

export type PATRole = "admin" | "write" | "read";
export type PATCapability = PATRole;

const PAT_ROLE_RANK: Record<PATRole, number> = { read: 1, write: 2, admin: 3 };

export function patHasCapability(role: PATRole, required: PATCapability): boolean {
  return PAT_ROLE_RANK[role] >= PAT_ROLE_RANK[required];
}

export function patCapabilityForMethod(method: string): PATCapability {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) ? "read" : "write";
}

export type MintPATInput = {
  userId: string;
  name: string;
  role?: PATRole;
  orgId?: string | null;
  projectId?: string | null;
  envId?: string | null;
  /** Lifetime in seconds. Defaults to 90 days; 0 explicitly means no expiry. */
  ttlSeconds?: number;
};

export type MintPATResult = {
  id: string;
  /** Raw plaintext token. Shown to the caller ONCE. */
  token: string;
  name: string;
  role: PATRole;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

function scopeKind(input: MintPATInput): AuthorizationScopeKind {
  if (input.envId) return AuthorizationScopeKind.ENVIRONMENT;
  if (input.projectId) return AuthorizationScopeKind.PROJECT;
  if (input.orgId) return AuthorizationScopeKind.ORGANIZATION;
  return AuthorizationScopeKind.GLOBAL;
}

function scopeColumns(input: MintPATInput) {
  const kind = scopeKind(input);
  return {
    scopeKind: kind,
    organizationId: kind === AuthorizationScopeKind.ORGANIZATION ? input.orgId ?? null : null,
    projectId: kind === AuthorizationScopeKind.PROJECT ? input.projectId ?? null : null,
    environmentId: kind === AuthorizationScopeKind.ENVIRONMENT ? input.envId ?? null : null,
  };
}

async function validateMintScope(
  tx: Prisma.TransactionClient,
  input: MintPATInput,
  role: PATRole
): Promise<void> {
  const organizationId = input.orgId ?? null;
  const projectId = input.projectId ?? null;
  const environmentId = input.envId ?? null;

  if (projectId && !organizationId) {
    throw new Error("PAT project scope requires an organization scope");
  }
  if (environmentId && (!organizationId || !projectId)) {
    throw new Error("PAT environment scope requires organization and project scopes");
  }
  if (!organizationId) {
    if (role === "admin") throw new Error("An admin PAT requires an organization scope");
    return;
  }

  const membership = await tx.organizationMembership.findFirst({
    where: { userId: input.userId, organizationId, deactivatedAt: null },
    select: { id: true, role: true },
  });
  if (!membership) throw new Error("PAT scope is outside the user's organization access");
  const organizationAdmin = membership.role === "OWNER" || membership.role === "ADMIN";
  if (role === "admin" && !organizationAdmin) {
    throw new Error("An admin PAT requires organization admin access");
  }

  if (projectId) {
    const project = await tx.project.findFirst({
      where: { id: projectId, organizationId, archivedAt: null },
      select: { id: true },
    });
    if (!project) throw new Error("PAT project scope does not belong to the organization");
    if (!organizationAdmin) {
      const projectMembership = await tx.projectMembership.findUnique({
        where: {
          projectId_organizationMembershipId: {
            projectId,
            organizationMembershipId: membership.id,
          },
        },
        select: { id: true },
      });
      if (!projectMembership) throw new Error("PAT project scope is outside the user's access");
    }
  }

  if (environmentId) {
    const environment = await tx.environment.findFirst({
      where: { id: environmentId, projectId: projectId!, archivedAt: null },
      select: { id: true },
    });
    if (!environment) throw new Error("PAT environment scope does not belong to the project");
  }
}

export async function mintPAT(input: MintPATInput): Promise<MintPATResult> {
  const role: PATRole = input.role ?? "write";
  if (!(role in PAT_ROLE_RANK)) throw new Error("Invalid PAT role");
  if (!input.name.trim()) throw new Error("PAT name is required");

  const raw = generateRawToken();
  const ttl = input.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : input.ttlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl < 0) throw new Error("Invalid PAT lifetime");
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;
  const persistedScope = scopeColumns(input);

  const row = await prisma.$transaction(async (tx) => {
    await validateMintScope(tx, input, role);
    const created = await tx.personalAccessToken.create({
      data: {
        userId: input.userId,
        ...persistedScope,
        tokenHash: hashToken(raw),
        name: input.name.trim(),
        role,
        expiresAt,
      },
      select: {
        id: true,
        name: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    await tx.tokenLifecycleAudit.create({
      data: {
        family: TokenFamily.PERSONAL_ACCESS_TOKEN,
        personalAccessTokenId: created.id,
        ...persistedScope,
        actorUserId: input.userId,
        action: TokenLifecycleAction.MINT,
        outcome: TokenLifecycleOutcome.SUCCESS,
      },
    });
    return created;
  });

  return {
    id: row.id,
    token: raw,
    name: row.name,
    role: row.role as PATRole,
    organizationId: input.orgId ?? null,
    projectId: input.projectId ?? null,
    environmentId: input.envId ?? null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export type VerifiedPAT = {
  id: string;
  userId: string;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  role: PATRole;
  expiresAt: Date | null;
};

export type PATScope = {
  organizationId?: string | null;
  projectId?: string | null;
  environmentId?: string | null;
};

export function patAllowsScope(pat: VerifiedPAT, target: PATScope): boolean {
  if (pat.organizationId && pat.organizationId !== target.organizationId) return false;
  if (pat.projectId && pat.projectId !== target.projectId) return false;
  if (pat.environmentId && pat.environmentId !== target.environmentId) return false;
  return true;
}

type PersistedPATScope = {
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  project: { id: string; organizationId: string } | null;
  environment: { id: string; project: { id: string; organizationId: string } } | null;
};

type CanonicalPATScope = {
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
};

function projectScope(row: PersistedPATScope): CanonicalPATScope {
  if (row.environment) {
    return {
      organizationId: row.environment.project.organizationId,
      projectId: row.environment.project.id,
      environmentId: row.environment.id,
    };
  }
  if (row.project) {
    return {
      organizationId: row.project.organizationId,
      projectId: row.project.id,
      environmentId: null,
    };
  }
  return { organizationId: row.organizationId, projectId: null, environmentId: null };
}

const PAT_SCOPE_SELECT = {
  organizationId: true,
  projectId: true,
  environmentId: true,
  project: { select: { id: true, organizationId: true } },
  environment: { select: { id: true, project: { select: { id: true, organizationId: true } } } },
} as const;

export async function verifyPAT(rawToken: string): Promise<VerifiedPAT | null> {
  if (!isPlatosPAT(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  const row = await prisma.personalAccessToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      userId: true,
      scopeKind: true,
      role: true,
      expiresAt: true,
      revokedAt: true,
      ...PAT_SCOPE_SELECT,
    },
  });
  if (!row || !constantTimeHexEqual(row.tokenHash, tokenHash) || row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  const recorded = await prisma.$transaction(async (tx) => {
    const updated = await tx.personalAccessToken.updateMany({
      where: {
        id: row.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { lastUsedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await tx.tokenLifecycleAudit.create({
      data: {
        family: TokenFamily.PERSONAL_ACCESS_TOKEN,
        personalAccessTokenId: row.id,
        scopeKind: row.scopeKind,
        organizationId: row.organizationId,
        projectId: row.projectId,
        environmentId: row.environmentId,
        actorUserId: row.userId,
        action: TokenLifecycleAction.USE,
        outcome: TokenLifecycleOutcome.SUCCESS,
      },
    });
    return true;
  });
  if (!recorded) return null;

  return {
    id: row.id,
    userId: row.userId,
    ...projectScope(row),
    role: row.role as PATRole,
    expiresAt: row.expiresAt,
  };
}

export type PATListRow = {
  id: string;
  name: string;
  role: PATRole;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export async function listPATs(userId: string): Promise<PATListRow[]> {
  const rows = await prisma.personalAccessToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      role: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
      ...PAT_SCOPE_SELECT,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role as PATRole,
    ...projectScope(row),
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  }));
}

export async function revokePAT(id: string, userId: string): Promise<{ ok: boolean }> {
  const existing = await prisma.personalAccessToken.findFirst({
    where: { id, userId },
    select: {
      id: true,
      revokedAt: true,
      scopeKind: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
    },
  });
  if (!existing) return { ok: false };
  if (existing.revokedAt) return { ok: true };

  await prisma.$transaction(async (tx) => {
    const updated = await tx.personalAccessToken.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count !== 1) return;
    await tx.tokenLifecycleAudit.create({
      data: {
        family: TokenFamily.PERSONAL_ACCESS_TOKEN,
        personalAccessTokenId: existing.id,
        scopeKind: existing.scopeKind,
        organizationId: existing.organizationId,
        projectId: existing.projectId,
        environmentId: existing.environmentId,
        actorUserId: userId,
        action: TokenLifecycleAction.REVOKE,
        outcome: TokenLifecycleOutcome.SUCCESS,
      },
    });
  });
  return { ok: true };
}

export type PATAuthenticationResult = VerifiedPAT;

export async function authenticateApiRequestWithPAT(
  request: Request,
  requiredCapability: PATCapability = patCapabilityForMethod(request.method)
): Promise<PATAuthenticationResult | undefined> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return;
  const verified = await verifyPAT(authorization.slice("Bearer ".length).trim());
  return verified && patHasCapability(verified.role, requiredCapability) ? verified : undefined;
}
