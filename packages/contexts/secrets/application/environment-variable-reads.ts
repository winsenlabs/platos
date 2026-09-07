// Reading environment variables.
//
// The return type is a discriminated union rather than the extraction source's
// `string | SecretMaterial`. Under the union a caller must NAME which case it is
// handling, so "log the value" cannot compile against a secret by accident; under
// the bare union it type-checks and leaks.
//
// Listing is metadata-only and available to any minted grant. Reading a SECRET
// variable is a secret read: it goes through the same runtime-tier-only,
// active-envelope-only, always-audited path as any other credential read.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { requireMetadataAccess, requireSecretRead } from "../domain/access-rules.js";
import { isMintedAuthorization } from "../domain/authorization.js";
import type { EnvironmentAuthorization } from "../domain/authorization.js";
import {
  environmentVariableKey,
  toEnvironmentVariableMetadata,
} from "../domain/environment-variable.js";
import type { EnvironmentVariableMetadata } from "../domain/environment-variable.js";
import { environmentVariableUnavailable } from "../domain/errors.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import type { SecretsDependencies } from "./dependencies.js";
import { readSecret, recordDeniedRead } from "./read-secret.js";

/**
 * WIN-259 — a denied environment-variable read is a denied SECRET read.
 *
 * The tier check here happens BEFORE the variable is resolved, so this path
 * would otherwise deny and record nothing while the `readSecret` beneath it —
 * which now writes a DENIED row — is never reached. The variable is resolved
 * anyway, purely to learn which credential the caller was reaching for, and the
 * evidence is written against that credential. A PLAIN variable resolves to no
 * credential, so nothing is recorded: the schema has no row shape for it, which
 * is the same measured limit `recordDeniedRead` states.
 */
async function recordDeniedVariableRead(
  deps: SecretsDependencies,
  authorization: EnvironmentAuthorization,
  key: string,
): Promise<void> {
  // The minted check is repeated here rather than left to `recordDeniedRead`,
  // because the lookup below is keyed on `environmentId` — and on a forged
  // literal that field is whatever the forger typed, so deferring the check
  // would spend a store read on an address the caller chose.
  if (!isMintedAuthorization(authorization)) return;
  const found = await deps.variables.findByKey(authorization.environmentId, key);
  if (!found.ok || found.value === null) return;
  const credentialId = found.value.credentialId;
  if (credentialId === null) return;
  await recordDeniedRead(deps, { authorization, credentialId, kind: "SECRET_REFERENCE" });
}

/** A read value, with its kind attached so a caller cannot confuse the two. */
export type EnvironmentVariableValue =
  | { readonly kind: "PLAIN"; readonly value: string }
  | { readonly kind: "SECRET"; readonly material: SecretMaterial };

export interface ReadEnvironmentVariableQuery {
  readonly authorization: EnvironmentAuthorization;
  readonly key: string;
}

export async function readEnvironmentVariable(
  deps: SecretsDependencies,
  query: ReadEnvironmentVariableQuery,
): Promise<Result<EnvironmentVariableValue>> {
  const granted = requireSecretRead(query.authorization);
  if (!granted.ok) {
    const probed = environmentVariableKey(query.key);
    if (probed.ok) await recordDeniedVariableRead(deps, query.authorization, probed.value);
    return err(granted.error);
  }
  const key = environmentVariableKey(query.key);
  if (!key.ok) return err(key.error);

  const found = await deps.variables.findByKey(granted.value.environmentId, key.value);
  if (!found.ok) return err(found.error);
  const variable = found.value;
  if (variable === null) return err(environmentVariableUnavailable("variable_not_found"));

  if (variable.kind === "PLAIN") {
    if (variable.value === null) return err(environmentVariableUnavailable("plain_value_missing"));
    return ok({ kind: "PLAIN", value: variable.value });
  }
  if (variable.credentialId === null) {
    return err(environmentVariableUnavailable("secret_reference_missing"));
  }

  const material = await readSecret(deps, {
    authorization: granted.value,
    credentialId: variable.credentialId,
    kind: "SECRET_REFERENCE",
  });
  return material.ok ? ok({ kind: "SECRET", material: material.value }) : err(material.error);
}

export async function listEnvironmentVariables(
  deps: SecretsDependencies,
  authorization: EnvironmentAuthorization,
): Promise<Result<readonly EnvironmentVariableMetadata[]>> {
  const granted = requireMetadataAccess(authorization);
  if (!granted.ok) return err(granted.error);

  const rows = await deps.variables.list(granted.value.environmentId);
  if (!rows.ok) return err(rows.error);
  return ok(rows.value.map(toEnvironmentVariableMetadata));
}
