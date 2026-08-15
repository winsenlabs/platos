import { Injectable, Inject, Logger } from "@nestjs/common";
import { createDecipheriv } from "crypto";
import { PRISMA_TOKEN } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { env } from "../shared/env";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export function decodeScopedEnvEncryptionKey(raw: string): Buffer {
  if (raw.length === 64 && /^[0-9a-f]{64}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  const legacy = Buffer.from(raw, "utf8");
  if (legacy.length === 32) return legacy;
  throw new Error("ENCRYPTION_KEY must be 64 hex chars or an existing 32-byte UTF-8 key");
}

/**
 * Reads env vars that the webapp UI stores in the trigger.dev `SecretStore`
 * Postgres table (AES-256-GCM encrypted). Key format matches what the webapp
 * writes:
 *
 *   environmentvariable:{projectId}:{environmentId}:{VAR_NAME}
 *
 * The encryption key is shared between webapp + agent via the `ENCRYPTION_KEY`
 * docker-compose env var. New values are 64 hex characters; exact historical
 * 32-byte UTF-8 values retain their original bytes for backwards compatibility.
 *
 * This is the bridge that makes "link API key in dashboard → agent uses it"
 * actually work. Before this, the agent read `process.env` which never got
 * the scoped env-var values, so every LLM call returned 401.
 */
@Injectable()
export class ScopedEnvService {
  private readonly logger = new Logger(ScopedEnvService.name);
  // MCPF-W6 followup — must be a Buffer because Node's createDecipheriv
  // requires a 32-byte key.
  private readonly key: Buffer | null;
  // EOBD.39 — cache only positive lookups. Negative results (missing var)
  // are not cached because the UI writes a key and then expects the agent
  // to pick it up immediately; a 30s "not found" window caused users to
  // see "OPENAI_API_KEY not configured" for the first half-minute after
  // linking a key.
  private cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly TTL_MS = 30_000;

  constructor(@Inject(PRISMA_TOKEN) private readonly prisma: any) {
    const raw = env.ENCRYPTION_KEY;
    if (!raw) {
      this.logger.warn(
        "ENCRYPTION_KEY not set — scoped env-var resolution will always return undefined. Set it in docker-compose to match the webapp."
      );
      this.key = null;
    } else {
      try {
        this.key = decodeScopedEnvEncryptionKey(raw);
      } catch (err: any) {
        this.logger.error(
          `ENCRYPTION_KEY invalid format (${
            err?.message ?? String(err)
          }) — scoped env-var resolution disabled. Must be 64 hex chars or an existing 32-byte UTF-8 key.`
        );
        this.key = null;
      }
    }
  }

  /**
   * EOBD.39 — cache key must be the full 3-axis scope. Two orgs that
   * share projectId + environmentId (legal pre-Theme-A) would otherwise
   * collide. organizationId is now part of the key.
   */
  private cacheKeyFor(scope: ScopeTuple, name: string): string {
    return `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:${name}`;
  }

  /**
   * Resolve a single var by name for a scope. Returns undefined if the var
   * isn't set in that env OR we couldn't decrypt it.
   */
  async get(scope: ScopeTuple, name: string): Promise<string | undefined> {
    const cacheKey = this.cacheKeyFor(scope, name);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached && cached.expiresAt <= now) this.cache.delete(cacheKey);

    const value = await this.fetchFresh(scope, name);
    if (value !== undefined) {
      this.cache.set(cacheKey, { value, expiresAt: now + this.TTL_MS });
    }
    return value;
  }

  /**
   * EOBD.39 — invalidate a single (scope, name) pair. Called by the webapp
   * after a SecretStore write so the agent picks up new keys within one
   * request cycle. If `name` is omitted, purges all entries for the scope.
   */
  invalidate(scope: ScopeTuple, name?: string): void {
    if (name) {
      this.cache.delete(this.cacheKeyFor(scope, name));
      return;
    }
    const prefix = `${scope.organizationId}:${scope.projectId}:${scope.environmentId}:`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) this.cache.delete(k);
    }
  }

  /**
   * MCPF-W3 — provider key health check. For an `envVarName` already
   * registered in `PlatosProviderKey`, attempt to resolve + decrypt the
   * underlying SecretStore row and report exists/decryptable in a single
   * call. NEVER returns the plaintext value — only the boolean tristate so
   * the operator can tell `key not set` vs `key set but undecryptable`
   * (the typical symptom of a webapp/agent ENCRYPTION_KEY mismatch).
   */
  async test(
    scope: ScopeTuple,
    envVarName: string
  ): Promise<{ ok: boolean; exists: boolean; decryptable: boolean; error?: string }> {
    if (!envVarName || typeof envVarName !== "string") {
      return { ok: false, exists: false, decryptable: false, error: "envVarName_required" };
    }
    if (!this.key) {
      // No encryption key in the agent container — every read returns
      // undefined, which would falsely report "missing" rather than the
      // real "agent can't decrypt anything" condition.
      return {
        ok: false,
        exists: false,
        decryptable: false,
        error: "agent_encryption_key_not_set",
      };
    }
    const storeKey = `environmentvariable:${scope.projectId}:${scope.environmentId}:${envVarName}`;
    let row: any;
    try {
      row = await this.prisma.secretStore.findUnique({ where: { key: storeKey } });
    } catch (err: any) {
      return {
        ok: false,
        exists: false,
        decryptable: false,
        error: `secretstore_lookup_failed: ${err?.message ?? String(err)}`,
      };
    }
    if (!row) return { ok: false, exists: false, decryptable: false };
    // Bypass the cache so the operator's "test" reflects current state.
    const value = await this.fetchFresh(scope, envVarName);
    if (value === undefined) {
      // Row exists but couldn't decrypt — almost always an
      // ENCRYPTION_KEY mismatch between webapp + agent containers.
      return {
        ok: false,
        exists: true,
        decryptable: false,
        error: "decryption_failed_likely_encryption_key_mismatch",
      };
    }
    return { ok: true, exists: true, decryptable: true };
  }

  /** `true` iff all of the listed vars are set in this scope. */
  async allSet(scope: ScopeTuple, names: string[]): Promise<boolean> {
    for (const name of names) {
      const v = await this.get(scope, name);
      if (!v) return false;
    }
    return true;
  }

  /** Per-var set-ness map — used by the providers UI. */
  async setMap(scope: ScopeTuple, names: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const name of names) out[name] = !!(await this.get(scope, name));
    return out;
  }

  /**
   * PIFSP-14 — Resolve the API key for a provider, respecting per-agent key
   * pinning via `PlatosProviderKey`.
   *
   * Resolution order:
   *   1. If `preferredKeyId` is supplied, look up the PlatosProviderKey row
   *      and use its `envVarName` to fetch from SecretStore.
   *   2. If no pinned key (or lookup failed), find the isDefault=true row for
   *      (scope, provider) and use that envVarName.
   *   3. Fall back to the legacy convention (e.g. "ANTHROPIC_API_KEY").
   *   4. Fall back to process.env[legacyEnvVar].
   *
   * Bumps `lastUsedAt` on the resolved key row (fire-and-forget).
   */
  async getProviderApiKey(
    scope: ScopeTuple,
    provider: string,
    legacyEnvVar: string,
    preferredKeyId?: string | null
  ): Promise<string | undefined> {
    // Step 1 — pinned key
    if (preferredKeyId) {
      const pinned = await this.prisma.platosProviderKey.findFirst({
        where: {
          id: preferredKeyId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
        },
        select: { id: true, envVarName: true },
      });
      if (pinned) {
        const val = await this.get(scope, pinned.envVarName);
        if (val) {
          this.bumpLastUsedAt(pinned.id);
          return val;
        }
      }
    }

    // Step 2 — scope default key
    const defaultKey = await this.prisma.platosProviderKey.findFirst({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        provider,
        isDefault: true,
      },
      select: { id: true, envVarName: true },
    });
    if (defaultKey) {
      const val = await this.get(scope, defaultKey.envVarName);
      if (val) {
        this.bumpLastUsedAt(defaultKey.id);
        return val;
      }
    }

    // Step 3 — legacy single-key convention
    const fromStore = await this.get(scope, legacyEnvVar);
    if (fromStore) return fromStore;

    // Step 4 — process.env fallback (admin-seeded defaults)
    return process.env[legacyEnvVar];
  }

  private bumpLastUsedAt(id: string): void {
    this.prisma.platosProviderKey
      .update({
        where: { id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => {});
  }

  private async fetchFresh(scope: ScopeTuple, name: string): Promise<string | undefined> {
    if (!this.key) return undefined;

    const storeKey = `environmentvariable:${scope.projectId}:${scope.environmentId}:${name}`;
    const row = await this.prisma.secretStore.findUnique({ where: { key: storeKey } });
    if (!row) return undefined;

    // version "1" = plaintext (legacy), version "2" = encrypted { nonce, ciphertext, tag }
    const stored = row.value as unknown;
    if (row.version === "1") {
      if (stored && typeof stored === "object" && "secret" in (stored as any)) {
        return String((stored as any).secret);
      }
      return undefined;
    }

    if (!stored || typeof stored !== "object") return undefined;
    const { nonce, ciphertext, tag } = stored as {
      nonce?: string;
      ciphertext?: string;
      tag?: string;
    };
    if (!nonce || !ciphertext || !tag) return undefined;

    try {
      const plain = this.decrypt(nonce, ciphertext, tag);
      const parsed = safeJsonParse(plain);
      if (parsed && typeof parsed === "object" && "secret" in (parsed as any)) {
        return String((parsed as any).secret);
      }
      return undefined;
    } catch (err: any) {
      this.logger.warn(`Failed to decrypt ${storeKey}: ${err?.message}`);
      return undefined;
    }
  }

  private decrypt(nonce: string, ciphertext: string, tag: string): string {
    if (!this.key) throw new Error("encryption_key_not_set");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(nonce, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    let out = decipher.update(ciphertext, "hex", "utf8");
    out += decipher.final("utf8");
    return out;
  }
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
