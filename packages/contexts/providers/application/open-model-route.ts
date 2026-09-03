// Use case: resolve a model string into something a turn can call.
//
// The three steps the turn engine currently performs inline, in order, with
// every failure a value rather than an exception:
//
//   1. resolve the credential — the pinned key, else the environment default
//   2. read the per-environment settings that refine the route
//   3. build the routing plan, and bind it to the credential
//
// FAIL-LOUD, UNLIKE DISCOVERY. Every step refuses rather than degrading. A turn
// that cannot resolve a key must not run against a different one, and a turn
// that cannot build a plan must not be sent somewhere approximate. The metadata
// paths in this package fail soft precisely so that this one does not have to.
//
// NO KEY IS `PROVIDERS_CONFIGURATION_UNAVAILABLE`, not a null. `resolveProvider-
// Credential` reports "this environment has registered nothing" as an absence
// because a readiness surface needs to distinguish it; a turn cannot proceed
// either way, so here the absence becomes the refusal the caller must handle.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  configurationUnavailable,
  parseModelReference,
  planModelRoute,
  requireManifest,
  type ModelRoutePlan,
  type ProviderKey,
} from "../domain/index.js";
import type { SecretsRuntimeGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";
import type { ModelSession } from "./ports/index.js";
import { resolveProviderCredential } from "./resolve-provider-credential.js";
import { runtimeSettingsFor } from "./runtime-settings.js";

export interface OpenModelRouteCommand {
  readonly authorization: SecretsRuntimeGrant;
  readonly scope: EnvironmentScope;
  /** `<provider>:<model>`, or a bare model name routed to the default provider. */
  readonly model: string;
  /** An agent version's pinned key. Absent means "use the environment default". */
  readonly providerKeyId?: ProviderKey["providerKeyId"] | null;
}

export interface OpenedModelRoute {
  readonly session: ModelSession;
  readonly plan: ModelRoutePlan;
  /** Which key paid for it. The caller records this against the turn. */
  readonly providerKey: ProviderKey;
}

export async function openModelRoute(
  dependencies: ProvidersDependencies,
  command: OpenModelRouteCommand,
): Promise<Result<OpenedModelRoute>> {
  const reference = parseModelReference(command.model);
  if (!reference.ok) return err(reference.error);
  const manifest = requireManifest(dependencies.catalogue, reference.value.provider);
  if (!manifest.ok) {
    return err(
      configurationUnavailable("no manifest for the provider named by the model string", {
        provider: reference.value.provider,
        model: command.model,
      }),
    );
  }

  const resolved = await resolveProviderCredential(dependencies, {
    authorization: command.authorization,
    scope: command.scope,
    provider: reference.value.provider,
    providerKeyId: command.providerKeyId ?? null,
  });
  if (!resolved.ok) return err(resolved.error);
  if (resolved.value === null) {
    return err(
      configurationUnavailable("no default provider key is registered for this provider", {
        provider: reference.value.provider,
        environmentId: command.scope.environmentId,
        model: command.model,
      }),
    );
  }

  const settings = await runtimeSettingsFor(dependencies, command.authorization, manifest.value);
  if (!settings.ok) return err(settings.error);

  const plan = planModelRoute(dependencies.catalogue, command.model, settings.value);
  if (!plan.ok) return err(plan.error);

  const session = await dependencies.modelRouter.open({
    plan: plan.value,
    credential: resolved.value.credential,
  });
  if (!session.ok) return err(session.error);
  return ok({ session: session.value, plan: plan.value, providerKey: resolved.value.key });
}
