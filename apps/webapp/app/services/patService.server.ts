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
 * This service is distinct from `personalAccessToken.server.ts`
 * (legacy `tr_pat_` tokens for the engine / CLI management surface) and
 * from the `PlatosMCPToken` family (MCP-only, per-scope, minted against
 * the agent service in `/apps/agent`).
 */

import { prisma } from "~/db.server";
import crypto from "node:crypto";

export const PAT_TOKEN_PREFIX = "plt_pat_";

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

export type MintPATInput = {
  userId: string;
  name: string;
  role?: PATRole;
  orgId?: string | null;
  projectId?: string | null;
  envId?: string | null;
  /** Lifetime in seconds. 0 or undefined → no expiry. */
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

/**
 * Mint a new PAT. The raw `token` string in the return value is the only
 * time the plaintext is available — the database stores only sha256(raw).
 */
export async function mintPAT(input: MintPATInput): Promise<MintPATResult> {
  const role: PATRole = input.role ?? "write";
  const raw = generateRawToken();
  const tokenHash = hashToken(raw);

  const ttl = input.ttlSeconds && input.ttlSeconds > 0 ? input.ttlSeconds : 0;
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

  const row = await prisma.platosPAT.create({
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

  // Fire-and-forget lastUsedAt bump. If this fails we still auth — the
  // PAT is valid, we just lose the audit bump this one call.
  prisma.platosPAT
    .update({
      where: { id: row.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {
      /* best-effort */
    });

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
export async function revokePAT(
  id: string,
  userId: string,
): Promise<{ ok: boolean }> {
  const res = await prisma.platosPAT.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { ok: res.count > 0 };
}
