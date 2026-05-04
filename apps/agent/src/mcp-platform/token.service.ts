import { Inject, Injectable, Logger } from "@nestjs/common";
import * as crypto from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";

/**
 * Theme K.1 — PlatosMCPToken mint / verify / revoke.
 *
 * Opaque random 32-byte bearers, prefixed `plt_mcp_`. Stored only as
 * sha256(raw) server-side — raw is returned to the caller once at
 * mint and never persisted. Verification is a constant-time lookup +
 * expiry + revocation check + `lastUsedAt` bump.
 *
 * Tokens are pinned to exactly one `(org, project, env)` tuple at
 * mint time (enforced by the minting caller) and carry an allowlist
 * of tool-name patterns.
 */

/**
 * Theme K.18 — token tier.
 *   - "scope" (default): pinned to exactly one (org, project, env).
 *   - "admin":           cross-scope within the minting org; every
 *                        non-block tool call auto-escalates to
 *                        require_approval via the permission gateway.
 *
 * Admin-tier mints are gated server-side — only org ADMIN members may
 * mint them. See PlatosMCPTokenService.mint().
 */
export type PlatosMCPTokenTier = "scope" | "admin";

export interface MintTokenInput {
  scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">;
  name: string;
  permissions: string[];
  /** Default 90 days. Pass 0 or negative for an admin "never expires" token. */
  ttlSeconds?: number;
  /** Theme K.18. Defaults to "scope". Admin-tier requires org ADMIN role. */
  tier?: PlatosMCPTokenTier;
}

export interface MintedToken {
  id: string;
  token: string;         // raw — show once, never again
  name: string;
  permissions: string[];
  tier: PlatosMCPTokenTier;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface VerifiedToken {
  id: string;
  scope: {
    organizationId: string;
    projectId: string;
    environmentId: string;
  };
  permissions: string[];
  mintedByUserId: string;
  expiresAt: Date | null;
  /**
   * K.18 — tier on the verified token. Always present; defaults to
   * "scope" when the DB column is absent (pre-migration environments)
   * so the agent never fails to boot on a stale schema.
   */
  tier: PlatosMCPTokenTier;
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 3600;
const TOKEN_PREFIX = "plt_mcp_";

/**
 * Theme K.18 — thrown when a non-admin user attempts to mint an
 * admin-tier token. The controller maps this to HTTP 403 without
 * leaking the role check detail.
 */
export class AdminMintForbiddenError extends Error {
  constructor(userId: string, organizationId: string) {
    super(
      `user ${userId} is not an ADMIN of organization ${organizationId} — admin-tier MCP tokens are reserved for org admins`,
    );
    this.name = "AdminMintForbiddenError";
  }
}

function normalizeTier(raw: unknown): PlatosMCPTokenTier {
  return raw === "admin" ? "admin" : "scope";
}

@Injectable()
export class PlatosMCPTokenService {
  private readonly logger = new Logger(PlatosMCPTokenService.name);

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {}

  private hashToken(raw: string): string {
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  /**
   * Generate a new token. Returns the raw value ONCE — after this
   * function returns, only sha256(raw) is in the DB.
   */
  async mint(input: MintTokenInput): Promise<MintedToken> {
    if (!input.name || input.name.length < 1 || input.name.length > 80) {
      throw new Error("token name must be 1–80 chars");
    }
    if (!Array.isArray(input.permissions) || input.permissions.length === 0) {
      throw new Error("permissions must be a non-empty array");
    }

    const tier: PlatosMCPTokenTier = normalizeTier(input.tier);

    // K.18 — admin-tier gate. Server-side check against OrgMember.role ==
    // ADMIN (OrgMemberRole enum has ADMIN | MEMBER — no "owner"). The UI
    // may also hide the tier=admin control, but this check is the
    // authoritative enforcement point.
    if (tier === "admin") {
      const membership = await this.prisma.orgMember.findFirst({
        where: {
          organizationId: input.scope.organizationId,
          userId: input.scope.userId,
        },
        select: { role: true },
      });
      if (!membership || membership.role !== "ADMIN") {
        throw new AdminMintForbiddenError(
          input.scope.userId,
          input.scope.organizationId,
        );
      }
    }

    const raw = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    const tokenHash = this.hashToken(raw);

    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

    // K.18 fail-safe — when the DB schema pre-dates this migration the
    // `tier` column doesn't exist, so sending it as a field would 500.
    // We attempt the write with `tier` and fall back on schema errors.
    let row: {
      id: string;
      name: string;
      permissions: string[];
      expiresAt: Date | null;
      createdAt: Date;
      tier?: string | null;
    };
    try {
      row = await this.prisma.platosMCPToken.create({
        data: {
          organizationId: input.scope.organizationId,
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          mintedByUserId: input.scope.userId,
          name: input.name,
          tokenHash,
          permissions: input.permissions,
          tier,
          expiresAt,
        },
        select: {
          id: true,
          name: true,
          permissions: true,
          tier: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    } catch (err: any) {
      // PrismaClientValidationError for an unknown field means the
      // column isn't migrated yet. In that case fall back to the legacy
      // shape — admin mints are impossible pre-migration.
      const msg = String(err?.message ?? "");
      if (tier === "admin") throw err;
      if (/Unknown arg|Unknown argument|Unknown field|tier/.test(msg)) {
        this.logger.warn(
          "PlatosMCPToken.tier column absent; minting without tier (pre-migration).",
        );
        row = await this.prisma.platosMCPToken.create({
          data: {
            organizationId: input.scope.organizationId,
            projectId: input.scope.projectId,
            environmentId: input.scope.environmentId,
            mintedByUserId: input.scope.userId,
            name: input.name,
            tokenHash,
            permissions: input.permissions,
            expiresAt,
          },
          select: {
            id: true,
            name: true,
            permissions: true,
            expiresAt: true,
            createdAt: true,
          },
        });
      } else {
        throw err;
      }
    }

    return {
      id: row.id,
      name: row.name,
      permissions: row.permissions,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      tier: normalizeTier(row.tier),
      token: raw,
    };
  }

  /**
   * Verify a raw bearer. Returns the pinned scope + permissions when
   * valid, null otherwise. Bumps `lastUsedAt` on success (fire-and-forget).
   */
  async verify(raw: string | undefined | null): Promise<VerifiedToken | null> {
    if (!raw || typeof raw !== "string" || !raw.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const tokenHash = this.hashToken(raw);
    // K.18 fail-safe — request `tier`, but tolerate a schema without
    // the column by falling back to the legacy select. This lets a
    // freshly-rebuilt agent boot against an un-migrated DB.
    let row:
      | {
          id: string;
          organizationId: string;
          projectId: string;
          environmentId: string;
          permissions: string[];
          mintedByUserId: string;
          expiresAt: Date | null;
          revokedAt: Date | null;
          tier?: string | null;
        }
      | null;
    try {
      row = await this.prisma.platosMCPToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          organizationId: true,
          projectId: true,
          environmentId: true,
          permissions: true,
          mintedByUserId: true,
          tier: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (/Unknown arg|Unknown argument|Unknown field|tier/.test(msg)) {
        this.logger.warn(
          "PlatosMCPToken.tier column absent; verifying without tier (pre-migration).",
        );
        row = await this.prisma.platosMCPToken.findUnique({
          where: { tokenHash },
          select: {
            id: true,
            organizationId: true,
            projectId: true,
            environmentId: true,
            permissions: true,
            mintedByUserId: true,
            expiresAt: true,
            revokedAt: true,
          },
        });
      } else {
        throw err;
      }
    }
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;

    // Fire-and-forget lastUsedAt bump; failure never fails verification.
    this.prisma.platosMCPToken
      .update({
        where: { tokenHash },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);

    return {
      id: row.id,
      scope: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        environmentId: row.environmentId,
      },
      permissions: row.permissions,
      mintedByUserId: row.mintedByUserId,
      expiresAt: row.expiresAt,
      tier: normalizeTier(row.tier),
    };
  }

  /**
   * List tokens for a scope. The raw token is NEVER returned — only
   * metadata. `tokenHash` is also elided because it's a security-
   * sensitive value that could feed brute-force attacks.
   */
  async list(
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId">,
  ): Promise<
    Array<{
      id: string;
      name: string;
      permissions: string[];
      tier: PlatosMCPTokenTier;
      mintedByUserId: string;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
    }>
  > {
    // K.18 fail-safe — select `tier` but fall back when absent.
    let rows: Array<{
      id: string;
      name: string;
      permissions: string[];
      tier?: string | null;
      mintedByUserId: string;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      revokedAt: Date | null;
      createdAt: Date;
    }>;
    try {
      rows = await this.prisma.platosMCPToken.findMany({
        where: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          permissions: true,
          tier: true,
          mintedByUserId: true,
          expiresAt: true,
          lastUsedAt: true,
          revokedAt: true,
          createdAt: true,
        },
      });
    } catch (err: any) {
      const msg = String(err?.message ?? "");
      if (/Unknown arg|Unknown argument|Unknown field|tier/.test(msg)) {
        rows = await this.prisma.platosMCPToken.findMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            permissions: true,
            mintedByUserId: true,
            expiresAt: true,
            lastUsedAt: true,
            revokedAt: true,
            createdAt: true,
          },
        });
      } else {
        throw err;
      }
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      permissions: r.permissions,
      tier: normalizeTier(r.tier),
      mintedByUserId: r.mintedByUserId,
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Revoke a token. Idempotent — re-revoking leaves revokedAt stamped
   * at the first call. Scope-gated: a token from scope A can't be
   * revoked by a caller in scope B.
   */
  async revoke(
    id: string,
    scope: Pick<RequestScope, "organizationId" | "projectId" | "environmentId" | "userId">,
  ): Promise<boolean> {
    const existing = await this.prisma.platosMCPToken.findFirst({
      where: {
        id,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
      select: { id: true, revokedAt: true },
    });
    if (!existing) return false;
    if (existing.revokedAt) return true;
    await this.prisma.platosMCPToken.update({
      where: { id },
      data: { revokedAt: new Date(), revokedBy: scope.userId },
    });
    return true;
  }

  /** Check whether the token's permissions allow the given toolName. */
  static allows(permissions: string[], toolName: string): boolean {
    for (const pattern of permissions) {
      if (pattern === "*") return true;
      if (pattern === toolName) return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -2);
        if (toolName.startsWith(`${prefix}.`) || toolName === prefix) return true;
      }
    }
    return false;
  }
}
