import { Injectable, Inject } from "@nestjs/common";
import { CredentialKind } from "@platos/tenancy-database";
import { PRISMA_TOKEN, environmentScopeWhere } from "../shared/database.provider";
import type { RequestScope } from "../auth/scope.guard";
import { SecretsService } from "../auth/secrets.service";
import { ProviderRuntimeError } from "./provider-runtime.error";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

/** Kept for configuration-domain validation tests; provider reads use SecretsService. */
export function decodeScopedEnvEncryptionKey(raw: string): Buffer {
  if (raw.length === 64 && /^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const legacy = Buffer.from(raw, "utf8");
  if (legacy.length === 32) return legacy;
  throw new Error("ENCRYPTION_KEY must be 64 hex chars or an existing 32-byte UTF-8 key");
}

export function credentialReference(id: string): string {
  return `credential://${id}`;
}

function parseCredentialReference(reference: string | null | undefined):
  | { id: string }
  | { name: string }
  | null {
  if (!reference) return null;
  if (reference.startsWith("credential://")) {
    const id = reference.slice("credential://".length).trim();
    return id ? { id } : null;
  }
  // `secret://<bare-name>` is the current clean-schema compatibility contract.
  if (reference.startsWith("secret://")) {
    const name = reference.slice("secret://".length).trim();
    return name ? { name } : null;
  }
  return null;
}

/**
 * Resolves Environment-owned Credential rows. ProviderKey stores only a safe
 * reference; plaintext is decrypted at the final provider constructor boundary.
 */
@Injectable()
export class ScopedEnvService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: any,
    private readonly secrets: SecretsService,
  ) {}

  invalidate(_scope: ScopeTuple, _name?: string): void {
    // Plaintext is intentionally never cached.
  }

  async findCredentialMetadata(
    scope: ScopeTuple,
    name: string,
    provider?: string,
  ): Promise<{ id: string; name: string; provider: string | null } | null> {
    if (!name || typeof name !== "string") return null;
    try {
      return await this.prisma.credential.findFirst({
        where: {
          ...environmentScopeWhere(scope),
          name,
          kind: { in: [CredentialKind.SECRET_REFERENCE, CredentialKind.SERVICE_CREDENTIAL] },
          revokedAt: null,
          ...(provider ? { provider } : {}),
        },
        select: { id: true, name: true, provider: true },
      });
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
  }

  async get(scope: ScopeTuple, name: string): Promise<string | undefined> {
    let credential: { encryptedReference: string | null } | null;
    try {
      credential = await this.prisma.credential.findFirst({
        where: {
          ...environmentScopeWhere(scope),
          name,
          kind: { in: [CredentialKind.SECRET_REFERENCE, CredentialKind.SERVICE_CREDENTIAL] },
          revokedAt: null,
        },
        select: { encryptedReference: true },
      });
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
    if (!credential?.encryptedReference) return undefined;
    return this.decrypt(credential.encryptedReference);
  }

  async test(
    scope: ScopeTuple,
    name: string,
  ): Promise<{ ok: boolean; exists: boolean; decryptable: boolean; error?: string }> {
    if (!name || typeof name !== "string") {
      return { ok: false, exists: false, decryptable: false, error: "credential_name_required" };
    }
    let credential: { encryptedReference: string | null } | null;
    try {
      credential = await this.prisma.credential.findFirst({
        where: {
          ...environmentScopeWhere(scope),
          name,
          kind: { in: [CredentialKind.SECRET_REFERENCE, CredentialKind.SERVICE_CREDENTIAL] },
          revokedAt: null,
        },
        select: { encryptedReference: true },
      });
    } catch {
      return { ok: false, exists: false, decryptable: false, error: "credential_lookup_failed" };
    }
    if (!credential) return { ok: false, exists: false, decryptable: false };
    if (!credential.encryptedReference) {
      return { ok: false, exists: true, decryptable: false, error: "credential_reference_missing" };
    }
    try {
      const value = this.secrets.decrypt(credential.encryptedReference);
      return value.length > 0
        ? { ok: true, exists: true, decryptable: true }
        : { ok: false, exists: true, decryptable: false, error: "credential_empty" };
    } catch {
      return { ok: false, exists: true, decryptable: false, error: "credential_decryption_failed" };
    }
  }

  async allSet(scope: ScopeTuple, names: string[]): Promise<boolean> {
    const values = await this.setMap(scope, names);
    return names.every((name) => values[name] === true);
  }

  async setMap(scope: ScopeTuple, names: string[]): Promise<Record<string, boolean>> {
    const entries = await Promise.all(names.map(async (name) => [name, !!(await this.get(scope, name))] as const));
    return Object.fromEntries(entries);
  }

  /**
   * Resolve an explicitly configured ProviderKey. A pinned key never falls
   * through to a default, and an absent default never falls through to a
   * conventional name or deployment environment variable.
   */
  async getProviderApiKey(
    scope: ScopeTuple,
    provider: string,
    legacyEnvVar: string,
    preferredKeyId?: string | null,
  ): Promise<string> {
    void legacyEnvVar;
    const resolved = await this.resolveProviderCredential(scope, provider, preferredKeyId);
    if (!resolved) throw new ProviderRuntimeError("provider_configuration_unavailable");

    try {
      await this.prisma.$transaction([
        this.prisma.providerKey.update({
          where: { id: resolved.providerKeyId },
          data: { lastUsedAt: new Date() },
        }),
        this.prisma.credential.update({
          where: { id: resolved.credentialId },
          data: { lastUsedAt: new Date() },
        }),
      ]);
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
    return resolved.value;
  }

  async hasProviderCredential(
    scope: ScopeTuple,
    provider: string,
    preferredKeyId?: string | null,
  ): Promise<boolean> {
    return (await this.resolveProviderCredential(scope, provider, preferredKeyId)) !== null;
  }

  private async resolveProviderCredential(
    scope: ScopeTuple,
    provider: string,
    preferredKeyId?: string | null,
  ): Promise<{ providerKeyId: string; credentialId: string; value: string } | null> {
    let providerKey: {
      id: string;
      provider: string;
      environmentKeyName: string;
      encryptedReference: string | null;
    } | null;
    try {
      providerKey = await this.prisma.providerKey.findFirst({
        where: {
          ...environmentScopeWhere(scope),
          provider,
          ...(preferredKeyId ? { id: preferredKeyId } : { isDefault: true }),
        },
        select: {
          id: true,
          provider: true,
          environmentKeyName: true,
          encryptedReference: true,
        },
        ...(!preferredKeyId ? { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } : {}),
      });
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
    if (!providerKey) return null;

    const reference = parseCredentialReference(providerKey.encryptedReference);
    if (!reference) return null;

    let credential: { id: string; encryptedReference: string | null } | null;
    try {
      credential = await this.prisma.credential.findFirst({
        where: {
          ...environmentScopeWhere(scope),
          ...reference,
          name: providerKey.environmentKeyName,
          provider,
          kind: { in: [CredentialKind.SECRET_REFERENCE, CredentialKind.SERVICE_CREDENTIAL] },
          revokedAt: null,
        },
        select: { id: true, encryptedReference: true },
      });
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
    if (!credential?.encryptedReference) return null;

    const value = this.decrypt(credential.encryptedReference);
    if (!value) throw new ProviderRuntimeError("provider_credential_unavailable");
    return { providerKeyId: providerKey.id, credentialId: credential.id, value };
  }

  private decrypt(reference: string): string {
    try {
      return this.secrets.decrypt(reference);
    } catch {
      throw new ProviderRuntimeError("provider_credential_unavailable");
    }
  }
}
