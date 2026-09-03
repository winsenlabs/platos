// EnvironmentVariable — the fourth row this context is sole writer of.
//
// It lives here rather than in `tenancy` for one reason: a SECRET variable has no
// value of its own. Its value is a Credential of kind SECRET_REFERENCE, and the
// only code allowed to seal or open that Credential is this context. Splitting the
// two would have put half of a secret's lifecycle outside the encryption boundary.
//
// THE INVARIANT: `value` is populated for PLAIN and is NULL for SECRET. There is
// no third state. A SECRET row carries a `credentialId` and nothing readable, so a
// dump of this table leaks configuration and never material.

import { err, ok } from "@platos/kernel";
import type { EnvironmentId, Result } from "@platos/kernel";

import type { CredentialId, EnvironmentVariableId } from "./ids.js";
import {
  environmentVariableKeyInvalid,
  environmentVariableValueRequired,
  environmentVariableValueTooLong,
} from "./errors.js";

export const ENVIRONMENT_VARIABLE_KINDS = ["PLAIN", "SECRET"] as const;

export type EnvironmentVariableKind = (typeof ENVIRONMENT_VARIABLE_KINDS)[number];

/** Unchanged from the extraction source: shouting snake case, at most 64 characters. */
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

export const ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH = 8192;

export interface EnvironmentVariable {
  readonly id: EnvironmentVariableId;
  readonly environmentId: EnvironmentId;
  /** Unique with environmentId in the canonical store. */
  readonly key: string;
  readonly kind: EnvironmentVariableKind;
  /** Present only for PLAIN. Always null for SECRET. */
  readonly value: string | null;
  /** Present only for SECRET. The Credential holding the sealed material. */
  readonly credentialId: CredentialId | null;
  /** Bumped on every write, so a stale reader can tell it is stale. */
  readonly version: number;
  readonly lastUpdatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A validated key. Branding it stops an unvalidated string reaching a write. */
export type EnvironmentVariableKey = string & { readonly __environmentVariableKey?: true };

export function environmentVariableKey(input: string): Result<EnvironmentVariableKey> {
  const key = typeof input === "string" ? input.trim() : "";
  return KEY_PATTERN.test(key) ? ok(key) : err(environmentVariableKeyInvalid());
}

export function environmentVariableValue(input: string): Result<string> {
  if (typeof input !== "string" || input.length === 0) {
    return err(environmentVariableValueRequired());
  }
  if (input.length > ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH) {
    return err(environmentVariableValueTooLong(ENVIRONMENT_VARIABLE_VALUE_MAX_LENGTH));
  }
  return ok(input);
}

/**
 * The read model for one variable.
 *
 * A PLAIN variable reads back its value. A SECRET variable reads back
 * `hasSecret` and NOTHING else — no value, no ciphertext, no credential material.
 * Reading the material itself is a separate, runtime-tier-only operation.
 */
export interface EnvironmentVariableMetadata {
  readonly id: EnvironmentVariableId;
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly kind: EnvironmentVariableKind;
  readonly value: string | null;
  readonly hasSecret: boolean;
  readonly version: number;
  readonly lastUpdatedBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The exact key set of the projection above, so a leak by field addition fails a test. */
export const ENVIRONMENT_VARIABLE_METADATA_FIELDS = [
  "id",
  "environmentId",
  "key",
  "kind",
  "value",
  "hasSecret",
  "version",
  "lastUpdatedBy",
  "createdAt",
  "updatedAt",
] as const;

export function toEnvironmentVariableMetadata(
  variable: EnvironmentVariable,
): EnvironmentVariableMetadata {
  const isSecret = variable.kind === "SECRET";
  return Object.freeze({
    id: variable.id,
    environmentId: variable.environmentId,
    key: variable.key,
    kind: variable.kind,
    value: isSecret ? null : (variable.value ?? ""),
    hasSecret: isSecret && variable.credentialId !== null,
    version: variable.version,
    lastUpdatedBy: variable.lastUpdatedBy,
    createdAt: variable.createdAt,
    updatedAt: variable.updatedAt,
  });
}
