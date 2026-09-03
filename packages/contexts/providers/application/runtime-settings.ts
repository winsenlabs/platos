// Reading the per-environment settings that refine a route.
//
// A provider's root and its region are stored the same way its API key is —
// as environment-owned credentials — so reading one is a MATERIAL read and needs
// the runtime tier. That is why this file takes a runtime grant and not an
// operator one.
//
// THE THREE-WAY DISTINCTION IS THE POINT, and it is the defect the source
// records having fixed. A configuration lookup has three outcomes, not two:
//
//   absent            no credential of that name for this provider. NOT an
//                     error — the caller uses the provider's default.
//   present, readable the configured value.
//   present, unreadable  a credential exists and could not be decrypted. This
//                     IS an error, and collapsing it into "absent" made a
//                     correctly-configured provider silently fall back to a
//                     default root, which then failed somewhere else entirely.
//
// THE PROVIDER IS PART OF THE LOOKUP, NOT A CHECK AFTERWARDS. An environment can
// legitimately hold several credentials under one name — a provider's own and an
// operator's same-named environment variable both exist on a migrated
// installation. Fetching "any credential with this name" and then refusing on a
// provider mismatch made an unrelated variable poison provider resolution. The
// filter includes the provider from the start.

import { err, ok, type Result } from "@platos/kernel";

import {
  configurationUnavailable,
  NO_RUNTIME_SETTINGS,
  type CredentialName,
  type ProviderManifest,
  type ProviderRuntimeSettings,
} from "../domain/index.js";
import type { SecretsRuntimeGrant } from "./authorization.js";
import type { ProvidersDependencies } from "./dependencies.js";

async function readConfiguration(
  dependencies: ProvidersDependencies,
  grant: SecretsRuntimeGrant,
  manifest: ProviderManifest,
  name: CredentialName | null,
): Promise<Result<string | null>> {
  if (name === null) return ok(null);

  const listed = await dependencies.secrets.listCredentials(grant);
  if (!listed.ok) {
    return err(
      configurationUnavailable("credential lookup failed while reading provider configuration", {
        provider: manifest.id,
        name,
      }),
    );
  }
  const held = listed.value.find(
    (credential) => credential.name === name && credential.provider === manifest.id,
  );
  if (held === undefined) return ok(null);

  const material = await dependencies.secrets.readSecret({
    authorization: grant,
    credentialId: held.id,
    provider: manifest.id,
  });
  if (!material.ok) {
    return err(
      configurationUnavailable("provider configuration was found but could not be read", {
        provider: manifest.id,
        name,
      }),
    );
  }
  return ok(material.value.reveal());
}

/** The root and region this environment configures for a provider. */
export async function runtimeSettingsFor(
  dependencies: ProvidersDependencies,
  grant: SecretsRuntimeGrant,
  manifest: ProviderManifest,
): Promise<Result<ProviderRuntimeSettings>> {
  if (manifest.baseUrlCredential === null && manifest.locationCredential === null) {
    return ok(NO_RUNTIME_SETTINGS);
  }
  const baseUrl = await readConfiguration(dependencies, grant, manifest, manifest.baseUrlCredential);
  if (!baseUrl.ok) return err(baseUrl.error);
  const location = await readConfiguration(dependencies, grant, manifest, manifest.locationCredential);
  if (!location.ok) return err(location.error);
  return ok({ baseUrl: baseUrl.value, location: location.value });
}
