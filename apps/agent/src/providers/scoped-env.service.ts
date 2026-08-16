import { Inject, Injectable } from "@nestjs/common";
import {
  PROVIDER_KEY_SAFE_SELECT,
  PlatosSecretStore,
  SecretMaterial,
  authorizeEnvironmentRuntime,
  type EnvironmentRuntimeAuthorization,
  type PrismaClient,
} from "@platos/tenancy-database";
import type { RequestScope } from "../auth/scope.guard";
import { ProviderRuntimeError } from "./provider-runtime.error";
import {
  PLATOS_SECRET_STORE_TOKEN,
  PRISMA_TOKEN,
} from "../shared/database.provider";

export type ScopeTuple = Pick<
  RequestScope,
  "organizationId" | "projectId" | "environmentId"
> & { agentId?: string | null };

/**
 * Resolves Environment-owned credentials through the clean-schema secret store.
 * Scoped reads never consult deployment environment variables and plaintext is
 * never cached. Every successful read therefore uses the active revision and
 * shares its transaction with the store's immutable READ audit.
 */
@Injectable()
export class ScopedEnvService {
  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(PLATOS_SECRET_STORE_TOKEN) private readonly secretStore: PlatosSecretStore,
  ) {}

  /** Resolve one same-Environment credential by its bare reference name. */
  async get(scope: ScopeTuple, name: string): Promise<string | undefined> {
    if (!name || typeof name !== "string") return undefined;
    try {
      const authorization = await this.authorize(scope);
      const material = await this.secretStore.readForRuntime({
        authorization,
        name,
      });
      return material.reveal();
    } catch {
      return undefined;
    }
  }

  /** Resolve a provider-owned credential name without allowing a provider mismatch. */
  async getForProvider(
    scope: ScopeTuple,
    name: string,
    provider: string,
  ): Promise<string | undefined> {
    if (!name || typeof name !== "string" || !provider) return undefined;
    try {
      const authorization = await this.authorize(scope);
      const material = await this.secretStore.readForRuntime({
        authorization,
        name,
        provider,
      });
      return material.reveal();
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve optional provider runtime configuration without making a configured
   * row's lookup/decrypt failure indistinguishable from an absent row.
   */
  async getProviderConfiguration(
    scope: ScopeTuple,
    name: string,
    provider: string,
  ): Promise<string | undefined> {
    if (!name || typeof name !== "string" || !provider) return undefined;
    let authorization: EnvironmentRuntimeAuthorization;
    try {
      authorization = await this.authorize(scope);
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }

    let credential: { id: string; provider: string | null } | null;
    try {
      credential = await this.prisma.credential.findFirst({
        where: {
          environmentId: authorization.environmentId,
          name,
        },
        select: { id: true, provider: true },
      });
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
    if (!credential) return undefined;
    if (credential.provider !== provider) {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }

    try {
      const material = await this.secretStore.readForRuntime({
        authorization,
        credentialId: credential.id,
        provider,
      });
      return material.reveal();
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }
  }

  /**
   * Retained as a compatibility hook for existing callers. There is no
   * plaintext cache to invalidate; post-commit reads always load the active
   * credential revision.
   */
  invalidate(_scope: ScopeTuple, _name?: string): void {}

  /** Probe a bare credential reference without returning plaintext. */
  async test(
    scope: ScopeTuple,
    name: string,
  ): Promise<{ ok: boolean; exists: boolean; decryptable: boolean; error?: string }> {
    if (!name || typeof name !== "string") {
      return { ok: false, exists: false, decryptable: false, error: "envVarName_required" };
    }
    const value = await this.get(scope, name);
    if (value === undefined) {
      return {
        ok: false,
        exists: false,
        decryptable: false,
        error: "credential_unavailable",
      };
    }
    return { ok: true, exists: true, decryptable: true };
  }

  /** `true` iff all listed same-Environment credentials are available. */
  async allSet(scope: ScopeTuple, names: string[]): Promise<boolean> {
    for (const name of names) {
      if (!(await this.get(scope, name))) return false;
    }
    return true;
  }

  /** Safe per-reference readiness map used by provider metadata surfaces. */
  async setMap(scope: ScopeTuple, names: string[]): Promise<Record<string, boolean>> {
    const entries = await Promise.all(names.map(async (name) => [name, !!(await this.get(scope, name))] as const));
    return Object.fromEntries(entries);
  }

  /** Provider-constrained readiness map for provider control/runtime paths. */
  async setMapForProvider(
    scope: ScopeTuple,
    names: string[],
    provider: string,
  ): Promise<Record<string, boolean>> {
    const out = Object.fromEntries(names.map((name) => [name, false]));
    try {
      const authorization = await this.authorize(scope);
      const credentials = await this.prisma.credential.findMany({
        where: {
          environmentId: authorization.environmentId,
          provider,
          name: { in: names },
          revokedAt: null,
          activeSecretVersionId: { not: null },
        },
        select: { name: true },
      });
      for (const credential of credentials) out[credential.name] = true;
    } catch {
      // Fail closed without widening to deployment configuration.
    }
    return out;
  }

  /**
   * Resolve a provider key by an optional pinned ProviderKey, then the provider
   * default. A supplied but invalid, cross-scope, or wrong-provider pin fails
   * closed, and an absent default never widens to a conventional name.
   */
  async getProviderApiKey(
    scope: ScopeTuple,
    provider: string,
    legacyEnvVar: string,
    preferredKeyId?: string | null,
  ): Promise<string | undefined> {
    void legacyEnvVar;
    let authorization: EnvironmentRuntimeAuthorization;
    try {
      authorization = await this.authorize(scope);
    } catch {
      throw new ProviderRuntimeError("provider_configuration_unavailable");
    }

    let key: { id: string; credentialId: string } | null;
    try {
      if (preferredKeyId) {
        key = await this.prisma.providerKey.findFirst({
          where: {
            id: preferredKeyId,
            environmentId: authorization.environmentId,
            provider,
          },
          select: PROVIDER_KEY_SAFE_SELECT,
        });
        if (!key) throw new ProviderRuntimeError("provider_configuration_unavailable");
      } else {
        key = await this.prisma.providerKey.findFirst({
          where: {
            environmentId: authorization.environmentId,
            provider,
            isDefault: true,
          },
          select: PROVIDER_KEY_SAFE_SELECT,
        });
      }
    } catch (error) {
      throw error instanceof ProviderRuntimeError
        ? error
        : new ProviderRuntimeError("provider_configuration_unavailable");
    }

    if (!key) return undefined;
    try {
      return await this.readProviderKey(authorization, key.id, key.credentialId, provider);
    } catch {
      throw new ProviderRuntimeError("provider_credential_unavailable");
    }
  }

  /** Metadata-only readiness check for a linked provider credential. */
  async hasProviderCredential(scope: ScopeTuple, provider: string): Promise<boolean> {
    try {
      const authorization = await this.authorize(scope);
      const key = await this.prisma.providerKey.findFirst({
        where: {
          environmentId: authorization.environmentId,
          provider,
          credential: {
            provider,
            revokedAt: null,
            activeSecretVersionId: { not: null },
          },
        },
        select: { id: true },
      });
      return !!key;
    } catch {
      return false;
    }
  }

  private async authorize(scope: ScopeTuple): Promise<EnvironmentRuntimeAuthorization> {
    const authorization = await authorizeEnvironmentRuntime(this.prisma, {
      actorId: scope.agentId || "platos-agent",
      environmentId: scope.environmentId,
    });
    if (
      authorization.organizationId !== scope.organizationId ||
      authorization.projectId !== scope.projectId
    ) {
      throw new Error("credential_unavailable");
    }
    return authorization;
  }

  private async readProviderKey(
    authorization: EnvironmentRuntimeAuthorization,
    providerKeyId: string,
    credentialId: string,
    provider: string,
  ): Promise<string> {
    const material: SecretMaterial = await this.secretStore.readForRuntime({
      authorization,
      credentialId,
      provider,
    });
    await this.prisma.providerKey.update({
      where: { id: providerKeyId },
      data: { lastUsedAt: new Date() },
    });
    return material.reveal();
  }
}
