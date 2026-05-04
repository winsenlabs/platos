import { Injectable, Inject } from "@nestjs/common";
import { PRISMA_TOKEN } from "../shared/database.provider";
import { PROVIDER_MANIFESTS, getManifest, type ProviderManifest } from "./manifests";
import { ScopedEnvService } from "./scoped-env.service";
import type { RequestScope } from "../auth/scope.guard";

export type ScopeTuple = Pick<RequestScope, "organizationId" | "projectId" | "environmentId">;

export interface ProviderState {
  /** Manifest id (e.g. "anthropic"). */
  id: string;
  displayName: string;
  description: string;
  /** All required env-vars + whether each is currently set in the agent container. */
  requiredEnv: Array<{ name: string; set: boolean }>;
  optionalEnv: string[];
  /** True when all `requiredEnv[].set === true`. */
  envReady: boolean;
  /** User-controlled toggle. Defaults to `envReady` when no PlatosProviderEnabled row exists. */
  enabled: boolean;
  /** Has the user explicitly opted-in via UI? */
  linked: boolean;
  linkedAt: string | null;
  /** Models exposed to the model picker when `enabled && envReady`. */
  models: string[];
}

/**
 * ProviderRegistryService — single source of truth for "which LLM providers
 * are available in this (org, project, env)".
 *
 * Source of provider definitions: code (see `providers/manifests/index.ts`).
 * Source of "is the env var set?": `process.env` (trigger.dev injects env
 * vars into the agent container at deploy time).
 * Source of user opt-in: `PlatosProviderEnabled` table (scoped per env).
 *
 * NOTE: The webapp has richer knowledge of the trigger.dev env-vars table —
 * it can show per-variable set/unset for any environment, not just the one
 * the agent container is running in. The webapp loader calls this service
 * for the `enabled` + `linked` state, and reads env-var presence itself.
 */
@Injectable()
export class ProviderRegistryService {
  private prisma: any;

  constructor(
    @Inject(PRISMA_TOKEN) prisma: any,
    private readonly scopedEnv: ScopedEnvService,
  ) {
    this.prisma = prisma;
  }

  /** All manifest-defined providers with current-scope state. */
  async list(scope: ScopeTuple): Promise<ProviderState[]> {
    const rows = await this.prisma.platosProviderEnabled.findMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
      },
    });
    const linkedById = new Map<string, { enabled: boolean; linkedAt: Date }>();
    for (const row of rows) {
      linkedById.set(row.providerId, { enabled: row.enabled, linkedAt: row.linkedAt });
    }

    return Promise.all(PROVIDER_MANIFESTS.map((m) => this.stateFor(scope, m, linkedById.get(m.id))));
  }

  async getOne(scope: ScopeTuple, providerId: string): Promise<ProviderState | undefined> {
    const manifest = getManifest(providerId);
    if (!manifest) return undefined;
    const row = await this.prisma.platosProviderEnabled.findUnique({
      where: {
        organizationId_projectId_environmentId_providerId: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          providerId,
        },
      },
    });
    return this.stateFor(scope, manifest, row ? { enabled: row.enabled, linkedAt: row.linkedAt } : undefined);
  }

  /** User clicked "Enable" on the providers page. */
  async link(scope: ScopeTuple, providerId: string): Promise<ProviderState> {
    const manifest = getManifest(providerId);
    if (!manifest) throw new Error(`Unknown providerId: ${providerId}`);

    await this.prisma.platosProviderEnabled.upsert({
      where: {
        organizationId_projectId_environmentId_providerId: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          providerId,
        },
      },
      create: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        providerId,
        enabled: true,
      },
      update: { enabled: true },
    });
    const state = await this.getOne(scope, providerId);
    return state!;
  }

  /** User clicked "Unlink". The row is deleted — next list() call treats it as unlinked. */
  async unlink(scope: ScopeTuple, providerId: string): Promise<void> {
    await this.prisma.platosProviderEnabled.deleteMany({
      where: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        providerId,
      },
    });
  }

  /** Toggle enabled flag for a linked provider. */
  async setEnabled(scope: ScopeTuple, providerId: string, enabled: boolean): Promise<ProviderState> {
    const manifest = getManifest(providerId);
    if (!manifest) throw new Error(`Unknown providerId: ${providerId}`);
    await this.prisma.platosProviderEnabled.upsert({
      where: {
        organizationId_projectId_environmentId_providerId: {
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          providerId,
        },
      },
      create: {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        providerId,
        enabled,
      },
      update: { enabled },
    });
    const state = await this.getOne(scope, providerId);
    return state!;
  }

  /**
   * Models picker source — returns provider groups that are BOTH enabled
   * (user opted-in) AND have all required env vars set in the container.
   *
   * This is what `/agents/new` and `/agents/:id` consume.
   */
  async availableModels(scope: ScopeTuple): Promise<Array<{ provider: string; displayName: string; models: string[] }>> {
    const states = await this.list(scope);
    return states
      .filter((s) => s.enabled && s.envReady)
      .map((s) => ({ provider: s.id, displayName: s.displayName, models: s.models }));
  }

  private async stateFor(
    scope: ScopeTuple,
    manifest: ProviderManifest,
    row?: { enabled: boolean; linkedAt: Date },
  ): Promise<ProviderState> {
    // Only check the trigger.dev SecretStore — process.env is never a valid
    // source for agent provider keys (those are admin/internal keys, not
    // user-linked keys).
    const setMap = await this.scopedEnv.setMap(scope, manifest.requiredEnv);
    const requiredEnv = manifest.requiredEnv.map((name) => ({
      name,
      set: !!setMap[name],
    }));
    let envReady = requiredEnv.every((e) => e.set);

    // PIFSP-14 — also consider ANY PlatosProviderKey for this provider.
    // The canonical env var (e.g. ANTHROPIC_API_KEY) is not required if the
    // user mapped a custom-named env var via the Providers UI. ANY registered
    // key with a non-empty SecretStore value makes the provider ready.
    if (!envReady) {
      try {
        const allKeys = await this.prisma.platosProviderKey.findMany({
          where: {
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            environmentId: scope.environmentId,
            provider: manifest.id,
          },
          select: { envVarName: true },
        });
        for (const k of allKeys) {
          const keyVal = await this.scopedEnv.get(scope, k.envVarName);
          if (keyVal) { envReady = true; break; }
        }
      } catch {
        // non-fatal
      }
    }

    // Setting the env-var IS linking — the explicit `PlatosProviderEnabled`
    // row used to be the only signal, but that produced the contradictory
    // "key set but provider not linked" UI. Now `linked` reflects whether
    // the provider has a usable credential in scope; the row only carries
    // the explicit enable/disable toggle for users who configure but
    // intentionally disable a provider.
    const linked = !!row || envReady;
    const enabled = row ? row.enabled : envReady;
    return {
      id: manifest.id,
      displayName: manifest.displayName,
      description: manifest.description,
      requiredEnv,
      optionalEnv: manifest.optionalEnv,
      envReady,
      enabled,
      linked,
      linkedAt: row ? row.linkedAt.toISOString() : null,
      models: manifest.models,
    };
  }
}
