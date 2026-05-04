import { Injectable, Inject } from "@nestjs/common";
import { createCipheriv, randomBytes } from "node:crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { env } from "../shared/env";
import type { RequestScope } from "../auth/scope.guard";
import { ScopedEnvService } from "../providers/scoped-env.service";

type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

const FRIENDLY_ID_ALPHABET = "123456789abcdefghijkmnopqrstuvwxyz";

/**
 * Mirror of `generateFriendlyId("envvar")` (`@platos/core/v3/isomorphic`).
 * Produces `envvar_<21-char nanoid>` so MCP-written EnvironmentVariable
 * rows match the format the webapp UI uses for keying friendly IDs.
 */
function envvarFriendlyId(): string {
  const buf = randomBytes(21);
  let id = "";
  for (let i = 0; i < 21; i++) {
    id += FRIENDLY_ID_ALPHABET[(buf[i] ?? 0) % FRIENDLY_ID_ALPHABET.length];
  }
  return `envvar_${id}`;
}

/**
 * Theme MCPF-W6 — RuntimeEnvironment + secret management service.
 *
 * Wraps `RuntimeEnvironment` (trigger.dev's per-project env model) +
 * `SecretStore` (the AES-256-GCM-encrypted key/value table that backs
 * scoped env vars). Used by the MCP `environments.*` tools.
 *
 * Three architectural rules baked in:
 *   1. **Cross-tenant scope filtering** — every read scopes by
 *      `(organizationId, projectId)`. Caller must be a member of the
 *      org via OrgMember.
 *   2. **Owner-gated mutations** — create/delete env + secret writes
 *      require `OrgMember.role = ADMIN`.
 *   3. **Secrets never leak through MCP** — `listSecrets` returns NAMES
 *      ONLY. Audit logs record names but never values. `setSecret`
 *      reuses the webapp `encryptSecret` AES-256-GCM format so existing
 *      SecretStore rows remain decryptable by either side.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

interface EncryptedValue {
  nonce: string;
  ciphertext: string;
  tag: string;
}

function encryptValue(plaintext: string): EncryptedValue {
  const raw = env.ENCRYPTION_KEY;
  if (!raw) throw new Error("encryption_key_not_set");
  let key: Buffer;
  if (raw.length === 64 && /^[0-9a-f]{64}$/i.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else if (Buffer.from(raw, "utf8").length === 32) {
    key = Buffer.from(raw, "utf8");
  } else {
    throw new Error("encryption_key_invalid_length");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return {
    nonce: nonce.toString("hex"),
    ciphertext: encrypted,
    tag,
  };
}

const ALPHABET = "123456789abcdefghijkmnopqrstuvwxyz";

function randomAlphaNumId(length: number): string {
  const buf = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[(buf[i] ?? 0) % ALPHABET.length];
  }
  return out;
}

function shortcode(): string {
  return randomAlphaNumId(12);
}

@Injectable()
export class EnvironmentService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly scopedEnv: ScopedEnvService,
  ) {}

  /**
   * List runtime environments visible inside the caller's project scope.
   * Caller must be a member of the org. Soft-archived envs are filtered
   * out by default.
   */
  async list(scope: ScopeTuple, userId: string | null) {
    await this.requireMember(scope.organizationId, userId);
    const envs = await this.prisma.runtimeEnvironment.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        archivedAt: null,
      },
      orderBy: [{ type: "asc" }, { slug: "asc" }],
      select: {
        id: true,
        slug: true,
        type: true,
        shortcode: true,
        branchName: true,
        paused: true,
        createdAt: true,
        updatedAt: true,
        archivedAt: true,
        orgMemberId: true,
      },
    });
    return envs;
  }

  /**
   * Create a new RuntimeEnvironment in the caller's project. Owner-gated.
   * Validates slug format. Mints fresh apiKey + pkApiKey (Trigger.dev
   * convention) so the env is immediately addressable.
   *
   * Note: this is a power-user surface. Most operators should use the
   * webapp UI which also wires up the dev sentinel + member binding.
   * This MCP tool exists for scripted environment provisioning.
   */
  async create(
    scope: ScopeTuple,
    userId: string | null,
    opts: {
      slug: string;
      type?: "PRODUCTION" | "STAGING" | "DEVELOPMENT" | "PREVIEW";
    },
  ) {
    await this.requireAdmin(scope.organizationId, userId);
    const slug = String(opts.slug || "").trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new Error("slug_invalid");
    // Resolve the caller's OrgMember row so we can bind dev/preview
    // envs to a specific member (matches webapp createEnvironment).
    const member = await this.prisma.orgMember.findFirst({
      where: { organizationId: scope.organizationId, userId: userId ?? "__none__" },
      select: { id: true },
    });
    const type = opts.type ?? "DEVELOPMENT";
    // apiKey + pkApiKey are unique across all envs in the system.
    const apiKey = `tr_${type === "PRODUCTION" ? "prd" : type === "STAGING" ? "stg" : "dev"}_${randomAlphaNumId(20)}`;
    const pkApiKey = `pk_${type === "PRODUCTION" ? "prd" : type === "STAGING" ? "stg" : "dev"}_${randomAlphaNumId(20)}`;
    try {
      const created = await this.prisma.runtimeEnvironment.create({
        data: {
          slug,
          apiKey,
          pkApiKey,
          shortcode: shortcode(),
          type,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          orgMemberId: member?.id ?? null,
        },
        select: {
          id: true,
          slug: true,
          type: true,
          shortcode: true,
          createdAt: true,
        },
      });
      return created;
    } catch (err: any) {
      // Unique constraint on (projectId, slug, orgMemberId).
      if (String(err?.code) === "P2002") throw new Error("slug_taken");
      throw err;
    }
  }

  /**
   * Delete (archive) a RuntimeEnvironment. Owner-gated. Refuses when
   * any PlatosAgent or PlatosAgentThread references the env (would
   * break running agents). Soft-deletes by setting `archivedAt = now()`
   * — same semantic the webapp uses.
   */
  async deleteEnvironment(
    scope: ScopeTuple,
    userId: string | null,
    opts: { environmentId: string },
  ) {
    await this.requireAdmin(scope.organizationId, userId);
    const target = await this.prisma.runtimeEnvironment.findFirst({
      where: {
        id: opts.environmentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      },
      select: { id: true, archivedAt: true, type: true },
    });
    if (!target) throw new Error("not_found");
    if (target.archivedAt) return { archived: false, alreadyArchived: true };
    if (target.type === "PRODUCTION") throw new Error("production_env_protected");
    // Block when agents reference the env.
    const [agentCount, threadCount] = await Promise.all([
      this.prisma.platosAgent.count({
        where: { environmentId: opts.environmentId, isActive: true },
      }),
      this.prisma.platosAgentThread.count({
        where: { environmentId: opts.environmentId, status: { not: "archived" } },
      }),
    ]);
    if (agentCount > 0) throw new Error(`env_in_use_by_agents:${agentCount}`);
    if (threadCount > 0) throw new Error(`env_in_use_by_threads:${threadCount}`);
    await this.prisma.runtimeEnvironment.update({
      where: { id: target.id },
      data: { archivedAt: new Date() },
    });
    return { archived: true };
  }

  /**
   * List secret NAMES only (NEVER values) for the caller's scope.
   * Backs `environments.list_secrets`.
   *
   * MCPF-W6 followup — query through `EnvironmentVariable` +
   * `EnvironmentVariableValue` (the webapp UI's source of truth) instead
   * of the raw `SecretStore` table, so MCP-written secrets and UI-written
   * secrets show up consistently. Falls back to `SecretStore` for any
   * orphan rows (e.g. legacy entries written before this followup).
   */
  async listSecrets(scope: ScopeTuple, userId: string | null) {
    await this.requireMember(scope.organizationId, userId);

    // 1) Canonical: EnvironmentVariable join (matches the dashboard list).
    const variables = await this.prisma.environmentVariable.findMany({
      where: {
        project: { id: scope.projectId, organizationId: scope.organizationId },
        values: { some: { environmentId: scope.environmentId } },
      },
      select: {
        key: true,
        createdAt: true,
        updatedAt: true,
        values: {
          where: { environmentId: scope.environmentId },
          select: { isSecret: true, version: true, updatedAt: true },
        },
      },
      orderBy: { key: "asc" },
    });

    const seen = new Set<string>();
    const out: Array<{
      name: string;
      version: string;
      createdAt: Date;
      updatedAt: Date;
      isSecret: boolean;
    }> = [];
    for (const v of variables as Array<{
      key: string;
      createdAt: Date;
      updatedAt: Date;
      values: Array<{ isSecret: boolean; version: number; updatedAt: Date }>;
    }>) {
      const value = v.values[0];
      if (!value) continue;
      seen.add(v.key);
      out.push({
        name: v.key,
        version: String(value.version),
        createdAt: v.createdAt,
        updatedAt: value.updatedAt ?? v.updatedAt,
        isSecret: !!value.isSecret,
      });
    }

    // 2) Fallback: legacy SecretStore-only rows (no EnvironmentVariable
    //    twin). Pre-followup MCP `setSecret` calls landed here, plus any
    //    out-of-band CLI writes. Surface them so operators can see + delete
    //    them via MCP, even though the UI won't list them until rewritten.
    const prefix = `environmentvariable:${scope.projectId}:${scope.environmentId}:`;
    const rows = await this.prisma.secretStore.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true, version: true, createdAt: true, updatedAt: true },
      orderBy: { key: "asc" },
    });
    for (const r of rows as Array<{
      key: string;
      version: string;
      createdAt: Date;
      updatedAt: Date;
    }>) {
      const name = r.key.slice(prefix.length);
      if (seen.has(name)) continue;
      out.push({
        name,
        version: r.version,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        isSecret: true,
      });
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Set / update a secret. Owner-gated. The plaintext is encrypted
   * with the webapp-shared `ENCRYPTION_KEY` so the existing scoped-env
   * resolver picks it up instantly.
   *
   * This method NEVER returns the value. The MCP tool wrapper audits
   * the NAME only.
   *
   * MCPF-W6 followup — also writes the `EnvironmentVariable` +
   * `SecretReference` + `EnvironmentVariableValue` triple that the webapp
   * UI lists from. Without this triple, MCP-set secrets are usable by
   * the agent (which only reads SecretStore) but invisible in the
   * dashboard. Mirrors the webapp's
   * `EnvironmentVariablesRepository.create` transactional pattern.
   */
  async setSecret(
    scope: ScopeTuple,
    userId: string | null,
    opts: { name: string; value: string },
  ): Promise<{ ok: true; name: string }> {
    await this.requireAdmin(scope.organizationId, userId);
    const name = (opts.name || "").trim();
    if (!name || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      throw new Error("name_invalid");
    }
    if (typeof opts.value !== "string" || opts.value.length === 0) {
      throw new Error("value_required");
    }
    if (opts.value.length > 8192) {
      throw new Error("value_too_long");
    }
    // Match webapp `setSecret` shape: { secret: string } as the
    // JSON payload, then AES-256-GCM encrypt with shared key.
    const encrypted = encryptValue(JSON.stringify({ secret: opts.value }));
    const storeKey = `environmentvariable:${scope.projectId}:${scope.environmentId}:${name}`;

    // Single transaction so the SecretStore row + EnvironmentVariable
    // join rows are always in sync. If any branch throws, no half-state.
    await this.prisma.$transaction(async (tx: any) => {
      // 1) SecretStore — the actual ciphertext the agent decrypts on read.
      await tx.secretStore.upsert({
        where: { key: storeKey },
        create: { key: storeKey, value: encrypted, version: "2" },
        update: { value: encrypted, version: "2" },
      });

      // 2) SecretReference — the dashboard's join target. Webapp uses
      //    `provider: "DATABASE"` for SecretStore-backed values.
      const secretReference = await tx.secretReference.upsert({
        where: { key: storeKey },
        create: { key: storeKey, provider: "DATABASE" },
        update: {},
      });

      // 3) EnvironmentVariable — keyed by (projectId, key). Friendly ID
      //    follows the webapp's `envvar_<nanoid>` convention.
      const envVar = await tx.environmentVariable.upsert({
        where: { projectId_key: { projectId: scope.projectId, key: name } },
        create: {
          key: name,
          friendlyId: envvarFriendlyId(),
          project: { connect: { id: scope.projectId } },
        },
        update: {},
      });

      // 4) EnvironmentVariableValue — per-environment join row. Bumps
      //    `version` on update so the UI shows the value rotated.
      const existing = await tx.environmentVariableValue.findFirst({
        where: { variableId: envVar.id, environmentId: scope.environmentId },
        select: { id: true, version: true },
      });
      if (existing) {
        await tx.environmentVariableValue.update({
          where: { id: existing.id },
          data: {
            valueReferenceId: secretReference.id,
            version: { increment: 1 },
            isSecret: true,
          },
        });
      } else {
        await tx.environmentVariableValue.create({
          data: {
            variableId: envVar.id,
            environmentId: scope.environmentId,
            valueReferenceId: secretReference.id,
            version: 1,
            isSecret: true,
          },
        });
      }
    });

    // Invalidate the agent's in-memory ScopedEnvService cache so the
    // new value is read on the next provider call (otherwise the
    // 30-second TTL would delay propagation).
    this.scopedEnv.invalidate(scope, name);
    return { ok: true, name };
  }

  /**
   * Delete a secret. Owner-gated. Idempotent — already-missing rows
   * return `{ deleted: false }` instead of throwing.
   *
   * MCPF-W6 followup — also cascades through the
   * `EnvironmentVariableValue` → `SecretReference` → `EnvironmentVariable`
   * join chain so the UI no longer shows the deleted secret. Mirrors the
   * webapp's `deleteValue` (drops the per-env row first, the variable
   * itself only when this was its last value).
   */
  async deleteSecret(
    scope: ScopeTuple,
    userId: string | null,
    opts: { name: string },
  ): Promise<{ deleted: boolean; name: string }> {
    await this.requireAdmin(scope.organizationId, userId);
    const name = (opts.name || "").trim();
    if (!name || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      throw new Error("name_invalid");
    }
    const storeKey = `environmentvariable:${scope.projectId}:${scope.environmentId}:${name}`;

    let anyDeleted = false;
    await this.prisma.$transaction(async (tx: any) => {
      // 1) Drop the SecretStore ciphertext row.
      const ssResult = await tx.secretStore.deleteMany({ where: { key: storeKey } });
      if (ssResult.count > 0) anyDeleted = true;

      // 2) Find the EnvironmentVariable + per-env value within the scope.
      const envVar = await tx.environmentVariable.findFirst({
        where: {
          key: name,
          project: { id: scope.projectId, organizationId: scope.organizationId },
        },
        select: {
          id: true,
          values: {
            select: { id: true, environmentId: true, valueReferenceId: true },
          },
        },
      });
      if (!envVar) return;

      const value = envVar.values.find(
        (v: { environmentId: string }) => v.environmentId === scope.environmentId,
      );
      if (value) {
        anyDeleted = true;
        // Drop the per-env value first.
        await tx.environmentVariableValue.delete({ where: { id: value.id } });
        // Drop the SecretReference (no other env should be sharing it
        // since `key` is the scope-specific store key).
        if (value.valueReferenceId) {
          await tx.secretReference.deleteMany({
            where: { id: value.valueReferenceId },
          });
        }
      }

      // 3) If this was the last value across any env, drop the
      //    EnvironmentVariable row too. Matches the webapp's "delete
      //    last value also drops the variable" semantic so the
      //    dashboard doesn't show an orphan no-value row.
      const remaining = await tx.environmentVariableValue.count({
        where: { variableId: envVar.id },
      });
      if (remaining === 0) {
        await tx.environmentVariable.delete({ where: { id: envVar.id } });
      }
    });

    // Invalidate the cache regardless — even if the row didn't exist
    // here, the cache layer might be holding a stale positive lookup.
    this.scopedEnv.invalidate(scope, name);
    return { deleted: anyDeleted, name };
  }

  // ── Authz helpers ─────────────────────────────────────────────────

  private async requireMember(orgId: string, userId: string | null): Promise<void> {
    if (!userId) throw new Error("access_denied");
    const m = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, userId },
      select: { id: true },
    });
    if (!m) throw new Error("access_denied");
  }

  private async requireAdmin(orgId: string, userId: string | null): Promise<void> {
    if (!userId) throw new Error("access_denied");
    const m = await this.prisma.orgMember.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: true },
    });
    if (!m) throw new Error("access_denied");
    if (m.role !== "ADMIN") throw new Error("access_denied");
  }
}
