import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  PROVIDER_KEY_SAFE_SELECT,
  PlatosSecretStore,
  SecretMaterial,
  authorizeEnvironmentRuntime,
  type EnvironmentRuntimeAuthorization,
  type PrismaClient,
} from "@platos/tenancy-database";
import type { RequestScope } from "../auth/scope.guard";
import { unwrapEntitySecretMaterial } from "../shared/entity-secret";
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
  private readonly logger = new Logger(ScopedEnvService.name);

  constructor(
    @Inject(PRISMA_TOKEN) private readonly prisma: PrismaClient,
    @Inject(PLATOS_SECRET_STORE_TOKEN) private readonly secretStore: PlatosSecretStore,
  ) {}

  /**
   * Raise a provider runtime error with the reason on the record.
   *
   * "Provider configuration is unavailable for this environment." is returned
   * to callers deliberately — it must not leak credential, database or crypto
   * detail. But it is raised from six different places, and with none of them
   * logged an operator cannot tell a missing ProviderKey from a failed
   * authorize from a decrypt error. The safe message still goes to the client;
   * the reason goes to the server log.
   *
   * Never pass secret material, only identifiers already visible in config.
   */
  private failProvider(
    code: "provider_configuration_unavailable" | "provider_credential_unavailable",
    reason: string,
    context: { provider?: string; name?: string; environmentId?: string },
  ): never {
    const where = [
      context.provider ? `provider=${context.provider}` : null,
      context.name ? `name=${context.name}` : null,
      context.environmentId ? `env=${context.environmentId}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    this.logger.warn(`${code}: ${reason} (${where})`);
    throw new ProviderRuntimeError(code);
  }

  /** Resolve one same-Environment credential by its bare reference name. */
  async get(scope: ScopeTuple, name: string): Promise<string | undefined> {
    if (!name || typeof name !== "string") return undefined;
    try {
      const authorization = await this.authorize(scope);
      const variable = await this.prisma.environmentVariable.findFirst({
        where: { environmentId: authorization.environmentId, key: name },
        select: { kind: true, value: true, credentialId: true },
      });
      if (!variable) return undefined;
      if (variable.kind === "PLAIN") return variable.value ?? undefined;
      if (!variable.credentialId) return undefined;
      const material = await this.secretStore.readForRuntime({
        authorization,
        credentialId: variable.credentialId,
        kind: "SECRET_REFERENCE",
      });
      return material.reveal();
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve an entity's ENTITY_SECRET — the key its outbound tool calls are
   * signed with.
   *
   * `get()` above reads `EnvironmentVariable`. An entity's service secret is
   * NOT an environment variable: it is a `Credential` of kind ENTITY_SECRET
   * keyed by the entity's `externalId`. Resolving one through `get()`
   * therefore always missed, and every signed outbound call to a wire entity
   * failed with "signing credential is unavailable" — while tool-sync stayed
   * connected, because that path authenticates by hash instead.
   *
   * Unwraps migration envelopes for the same reason AuthService does: the
   * stored plaintext may be `{"secret":…}` / `{"serviceSecret":…}` rather than
   * the bare key, and signing with the envelope produces a wrong signature.
   */
  async getEntitySecret(
    scope: ScopeTuple,
    entityExternalId: string,
  ): Promise<string | undefined> {
    if (!entityExternalId || typeof entityExternalId !== "string") return undefined;
    try {
      const authorization = await this.authorize(scope);
      const material = await this.secretStore.readForRuntime({
        authorization,
        name: entityExternalId,
        kind: "ENTITY_SECRET",
      } as never);
      const revealed = material.reveal();
      return revealed ? unwrapEntitySecretMaterial(revealed) : undefined;
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
    } catch (err: any) {
      this.failProvider(
        "provider_configuration_unavailable",
        `environment authorization failed while reading configuration (${err?.message ?? err})`,
        { provider, name, environmentId: scope.environmentId },
      );
    }

    let credential: { id: string; provider: string | null } | null;
    try {
      // Match on provider in the QUERY, not after the fact. An Environment can
      // legitimately hold several credentials under one name — a provider-owned
      // SERVICE_CREDENTIAL for `OPENAI_API_KEY` and an operator's environment
      // variable of the same name both exist on a migrated deployment. Fetching
      // "any credential with this name" and then throwing on a provider
      // mismatch made an unrelated same-named variable poison provider
      // resolution: the runtime reported "Provider configuration is
      // unavailable" for a provider that was correctly configured.
      credential = await this.prisma.credential.findFirst({
        where: {
          environmentId: authorization.environmentId,
          name,
          provider,
        },
        select: { id: true, provider: true },
      });
    } catch (err: any) {
      this.failProvider(
        "provider_configuration_unavailable",
        `credential lookup failed (${err?.message ?? err})`,
        { provider, name, environmentId: authorization.environmentId },
      );
    }
    // Absent provider configuration is not an error — callers treat undefined
    // as "not configured" and fall back to the provider's default.
    if (!credential) return undefined;

    try {
      const material = await this.secretStore.readForRuntime({
        authorization,
        credentialId: credential.id,
        provider,
      });
      return material.reveal();
    } catch (err: any) {
      this.failProvider(
        "provider_configuration_unavailable",
        `credential ${credential.id} found but could not be decrypted (${err?.message ?? err})`,
        { provider, name, environmentId: authorization.environmentId },
      );
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
    } catch (err: any) {
      this.failProvider(
        "provider_configuration_unavailable",
        `environment authorization failed (${err?.message ?? err}) — the scope's organization/project may not own this environment`,
        { provider, environmentId: scope.environmentId },
      );
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
        if (!key) {
          this.failProvider(
            "provider_configuration_unavailable",
            `no ProviderKey with the pinned id ${preferredKeyId} for this provider in this environment`,
            { provider, environmentId: authorization.environmentId },
          );
        }
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

    if (!key) {
      // Not an error: callers treat undefined as "no key configured" and
      // resolveModel reports it. Logged because on a migrated deployment this
      // is the difference between "BYOK was never registered" and a bug.
      this.logger.warn(
        `no default ProviderKey for provider=${provider} env=${authorization.environmentId} — register one (BYOK) or pin providerKeyId on the model route`,
      );
      return undefined;
    }
    try {
      return await this.readProviderKey(authorization, key.id, key.credentialId, provider);
    } catch (err: any) {
      this.failProvider(
        "provider_credential_unavailable",
        `ProviderKey ${key.id} resolved but its credential could not be read (${err?.message ?? err})`,
        { provider, environmentId: authorization.environmentId },
      );
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
