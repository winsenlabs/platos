/**
 * Theme K.9 — Platos PAT (Personal Access Token) service.
 *
 * Developer-facing long-lived tokens for authenticating non-interactive
 * callers (CI, scripts, integrators) against the full Platos webapp REST
 * API. A PAT authenticates AS the minting user — treat the raw value like
 * a session cookie.
 *
 * Token format: `plt_pat_` + 32 random bytes (base64url). We persist only
 * sha256(raw); the plaintext is returned to the caller exactly once at
 * mint time and is never recoverable afterwards.
 *
 * This service is distinct from the `PlatosMCPToken` family (MCP-only,
 * per-scope, minted against
 * the agent service in `/apps/agent`).
 */

import { prisma } from "~/db.server";
import crypto from "node:crypto";

export const PAT_TOKEN_PREFIX = "plt_pat_";
const DEFAULT_TTL_SECONDS = 90 * 24 * 3600;

/** True if `s` looks like a Platos PAT (prefix check only — does not verify). */
export function isPlatosPAT(s: string): boolean {
  return typeof s === "string" && s.startsWith(PAT_TOKEN_PREFIX);
}

/**
 * Returns sha256(raw) as hex. Used as the storage key + lookup key. We
 * never store raw tokens, and we compare only hashes to avoid timing
 * oracles against plaintext.
 */
function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Generates `plt_pat_` + 32 random bytes in base64url. */
function generateRawToken(): string {
  return `${PAT_TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
}

/** Constant-time compare of two hex-encoded sha256 digests. */
function constantTimeHexEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

export type PATRole = "admin" | "write" | "read";
export type PATCapability = PATRole;

const PAT_ROLE_RANK: Record<PATRole, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

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
  /** Raw plaintext token. Shown to the caller ONCE at mint. */
  token: string;
  name: string;
  role: PATRole;
  organizationId: string | null;
  projectId: string | null;
  environmentId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
};

async function validateMintScope(tx: any, input: MintPATInput, role: PATRole): Promise<void> {
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
    if (role === "admin") {
      throw new Error("An admin PAT requires an organization scope");
    }
    return;
  }

  const membership = await tx.orgMember.findFirst({
    where: { userId: input.userId, organizationId },
    select: { role: true },
  });
  if (!membership) throw new Error("PAT scope is outside the user's organization access");
  if (role === "admin" && membership.role !== "ADMIN") {
    throw new Error("An admin PAT requires organization admin access");
  }

  if (projectId) {
    const project = await tx.project.findFirst({
      where: { id: projectId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new Error("PAT project scope does not belong to the organization");
  }

  if (environmentId) {
    const environment = await tx.runtimeEnvironment.findFirst({
      where: { id: environmentId, projectId: projectId!, organizationId },
      select: { id: true },
    });
    if (!environment) throw new Error("PAT environment scope does not belong to the project");
  }
}

/**
 * Mint a new PAT. The raw `token` string in the return value is the only
 * time the plaintext is available — the database stores only sha256(raw).
 */
export async function mintPAT(input: MintPATInput): Promise<MintPATResult> {
  const role: PATRole = input.role ?? "write";
  if (!(role in PAT_ROLE_RANK)) throw new Error("Invalid PAT role");
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);

  const ttl = input.ttlSeconds === undefined ? DEFAULT_TTL_SECONDS : input.ttlSeconds;
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

  const row = await prisma.$transaction(async (tx) => {
    await validateMintScope(tx, input, role);
    const created = await tx.platosPAT.create({
      data: {
        tokenHash,
        name: input.name,
        userId: input.userId,
        organizationId: input.orgId ?? null,
        projectId: input.projectId ?? null,
        environmentId: input.envId ?? null,
        role,
        expiresAt,
      },
      select: {
        id: true,
        name: true,
        role: true,
        organizationId: true,
        projectId: true,
        environmentId: true,
        expiresAt: true,
        createdAt: true,
      },
    });
    await tx.platosCredentialAudit.create({
      data: {
        family: "user_api",
        credentialId: created.id,
        action: "mint",
        organizationId: input.orgId ?? null,
        projectId: input.projectId ?? null,
        environmentId: input.envId ?? null,
        actorUserId: input.userId,
      },
    });
    return created;
  });

  return {
    id: row.id,
    token: raw,
    name: row.name,
    role: row.role as PATRole,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
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

/** A pin at a narrower level cannot authorize a broader target. */
export function patAllowsScope(pat: VerifiedPAT, target: PATScope): boolean {
  if (pat.organizationId && pat.organizationId !== target.organizationId) return false;
  if (pat.projectId && pat.projectId !== target.projectId) return false;
  if (pat.environmentId && pat.environmentId !== target.environmentId) return false;
  return true;
}

/**
 * Verify a raw PAT string. Returns the stored metadata (never the raw
 * token) or `null` if the token is unknown, revoked, or expired.
 *
 * Bumps `lastUsedAt` on success. Callers must treat a non-null return as
 * equivalent to a logged-in session for `userId`.
 */
export async function verifyPAT(rawToken: string): Promise<VerifiedPAT | null> {
  if (!isPlatosPAT(rawToken)) return null;

  const tokenHash = hashToken(rawToken);

  const row = await prisma.platosPAT.findFirst({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      userId: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
      role: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!row) return null;
  // Belt-and-braces constant-time compare — defends against any future
  // change that relaxes the findFirst equality (e.g. range lookup).
  if (!constantTimeHexEqual(row.tokenHash, tokenHash)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  // A successful credential use must leave evidence. Fail authentication if
  // the atomic last-used + audit write cannot be persisted.
  const recorded = await prisma.$transaction(async (tx) => {
    const updated = await tx.platosPAT.updateMany({
      where: {
        id: row.id,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      data: { lastUsedAt: new Date() },
    });
    if (updated.count !== 1) return false;
    await tx.platosCredentialAudit.create({
      data: {
        family: "user_api",
        credentialId: row.id,
        action: "use",
        organizationId: row.organizationId,
        projectId: row.projectId,
        environmentId: row.environmentId,
        actorUserId: row.userId,
      },
    });
    return true;
  });
  if (!recorded) return null;

  return {
    id: row.id,
    userId: row.userId,
    organizationId: row.organizationId,
    projectId: row.projectId,
    environmentId: row.environmentId,
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

/** List the user's PATs (hash excluded, active + revoked both visible). */
export async function listPATs(userId: string): Promise<PATListRow[]> {
  const rows = await prisma.platosPAT.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      role: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
      expiresAt: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role as PATRole,
    organizationId: r.organizationId,
    projectId: r.projectId,
    environmentId: r.environmentId,
    expiresAt: r.expiresAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
  }));
}

/**
 * Revoke a PAT by id. Only the owning user can revoke — other users'
 * ids silently no-op (the updateMany returns count=0 and we surface that
 * as `ok: false`).
 */
export async function revokePAT(id: string, userId: string): Promise<{ ok: boolean }> {
  const existing = await prisma.platosPAT.findFirst({
    where: { id, userId },
    select: {
      id: true,
      revokedAt: true,
      organizationId: true,
      projectId: true,
      environmentId: true,
    },
  });
  if (!existing) return { ok: false };
  if (existing.revokedAt) return { ok: true };
  await prisma.$transaction(async (tx) => {
    const updated = await tx.platosPAT.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (updated.count === 0) return;
    await tx.platosCredentialAudit.create({
      data: {
        family: "user_api",
        credentialId: id,
        action: "revoke",
        organizationId: existing.organizationId,
        projectId: existing.projectId,
        environmentId: existing.environmentId,
        actorUserId: userId,
      },
    });
  });
  return { ok: true };
}

export type PATAuthenticationResult = VerifiedPAT;

/** Authenticate a webapp API request with a retained `plt_pat_` token. */
export async function authenticateApiRequestWithPAT(
  request: Request,
  requiredCapability: PATCapability = patCapabilityForMethod(request.method)
): Promise<PATAuthenticationResult | undefined> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return;
  const verified = await verifyPAT(authorization.slice("Bearer ".length).trim());
  return verified && patHasCapability(verified.role, requiredCapability) ? verified : undefined;
}
