// The four access decisions this context makes, and nothing else.
//
// Split out of domain/authorization.ts so the value objects and the rules that
// judge them stay separately readable, and so each rule is one small named
// function a negative control can aim at.
//
// Every rule begins with the same runtime identity check. That ordering matters:
// a forged literal must be rejected BEFORE its `access` field is consulted, or
// the shape check becomes the security boundary and the brand becomes decoration.

import { err, ok } from "@platos/kernel";
import type { EnvironmentId, Result } from "@platos/kernel";

import { isMintedAuthorization } from "./authorization.js";
import type {
  EnvironmentAuthorization,
  EnvironmentRuntimeAuthorization,
  RootKeyOperationsAuthorization,
  SecretMutationAuthorization,
} from "./authorization.js";
import { credentialForbidden } from "./errors.js";

function requireMinted<Grant>(authorization: Grant): Result<Grant> {
  return isMintedAuthorization(authorization)
    ? ok(authorization)
    : err(credentialForbidden("authorization_not_minted"));
}

/** Reading metadata: any authenticated environment grant will do. */
export function requireMetadataAccess(
  authorization: EnvironmentAuthorization,
): Result<EnvironmentAuthorization> {
  return requireMinted(authorization);
}

/**
 * Reading secret MATERIAL: the runtime tier only.
 *
 * An operator grant is deliberately not accepted, however privileged. Operators
 * administer the vault; they do not read out of it. That is the property that
 * keeps a compromised console session from being a bulk exfiltration.
 */
export function requireSecretRead(
  authorization: EnvironmentAuthorization,
): Result<EnvironmentRuntimeAuthorization> {
  const minted = requireMinted(authorization);
  if (!minted.ok) return err(minted.error);
  if (authorization.principalType !== "runtime" || authorization.access !== "secret:read") {
    return err(credentialForbidden("read_requires_runtime_tier"));
  }
  return ok(authorization);
}

/**
 * Writing secret material: an operator holding `secret:mutate`, or a service
 * holding `secret:write`. An operator holding only `metadata` is denied — this is
 * the read-only-grant denial the extraction source's `requireMutation` performs.
 */
export function requireSecretMutation(
  authorization: EnvironmentAuthorization,
): Result<SecretMutationAuthorization> {
  const minted = requireMinted(authorization);
  if (!minted.ok) return err(minted.error);
  const operatorMayMutate =
    authorization.principalType === "operator" && authorization.access === "secret:mutate";
  const serviceMayWrite =
    authorization.principalType === "service" && authorization.access === "secret:write";
  if (!operatorMayMutate && !serviceMayWrite) {
    return err(credentialForbidden("mutation_requires_write_access"));
  }
  return ok(authorization);
}

/** Root key operations: the installation-global grant, and only that. */
export function requireRootKeyOperations(
  authorization: RootKeyOperationsAuthorization,
): Result<RootKeyOperationsAuthorization> {
  const minted = requireMinted(authorization);
  if (!minted.ok) return err(minted.error);
  if (authorization.principalType !== "operations" || authorization.installationScope !== "global") {
    return err(credentialForbidden("root_key_operations_require_global_scope"));
  }
  return ok(authorization);
}

/**
 * Cross-environment denial. A grant pinned to environment A may never address a
 * row in environment B, however the row was found.
 */
export function requireSameEnvironment(
  authorization: EnvironmentAuthorization,
  environmentId: EnvironmentId,
): Result<EnvironmentId> {
  return authorization.environmentId === environmentId
    ? ok(environmentId)
    : err(credentialForbidden("environment_mismatch"));
}
