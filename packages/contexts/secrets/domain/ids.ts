// Identifiers and ordinal value objects owned by `secrets`.
//
// The kernel already brands the tenancy identifiers this context is keyed by
// (EnvironmentId, OrganizationId, ProjectId). The four rows this context is
// SOLE WRITER of (ADR M0.3 §1 row 3 — Credential, CredentialSecretVersion,
// CredentialAudit, EnvironmentVariable) need their own brands for the same
// reason the kernel gives: a plain `string` lets a credentialId reach a
// parameter expecting a secretVersionId, and the encryption boundary binds BOTH
// into the additional authenticated data of every envelope. A substitution there
// is not a typo, it is a decryption failure or, worse, an envelope accepted in
// the wrong place.
//
// `secretRevision` and `rootKeyVersion` are branded NUMBERS for the same reason.
// The canonical store types both as `Int` and the unique key
// `[credentialId, secretRevision, rootKeyVersion]` orders them adjacently, so
// swapping the two arguments of a call is otherwise silent and type-correct.

import { err, ok } from "@platos/kernel";
import type { Branded, Result } from "@platos/kernel";

import { invalidKeyRing, invalidSecretMaterial } from "./errors.js";

/** Credential.id — `@default(uuid()) @db.Uuid`. */
export type CredentialId = Branded<string, "CredentialId">;

/** CredentialSecretVersion.id. */
export type SecretVersionId = Branded<string, "SecretVersionId">;

/** CredentialAudit.id. */
export type CredentialAuditId = Branded<string, "CredentialAuditId">;

/** EnvironmentVariable.id. */
export type EnvironmentVariableId = Branded<string, "EnvironmentVariableId">;

/**
 * Whoever acted. Deliberately NOT the kernel `PrincipalId`: an audit row records
 * `actorId` plus an `effectiveUserId` that differ under impersonation, and
 * `secrets` may not import identity-access (ADR M0.3 §1 row 3 — its allow-list is
 * `kernel` alone), so it names the actor without adopting identity's model of one.
 */
export type ActorId = Branded<string, "ActorId">;

/** CredentialSecretVersion.secretRevision — monotonic, per credential, from 1. */
export type SecretRevision = Branded<number, "SecretRevision">;

/** CredentialSecretVersion.rootKeyVersion — which root key sealed this envelope. */
export type RootKeyVersion = Branded<number, "RootKeyVersion">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is an
 * assertion and not validation: adapters reading a row and transports parsing a
 * request are the only callers that should reach for it.
 */
export function asSecretsIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** The first revision of any credential. Rotation counts up from here. */
export const FIRST_SECRET_REVISION = 1;

export function secretRevision(value: number): Result<SecretRevision> {
  if (!positiveInteger(value)) {
    return err(invalidSecretMaterial("secret_revision_not_a_positive_integer"));
  }
  return ok(value as SecretRevision);
}

export function nextSecretRevision(current: SecretRevision): Result<SecretRevision> {
  return secretRevision(current + 1);
}

export function rootKeyVersion(value: number): Result<RootKeyVersion> {
  if (!positiveInteger(value)) {
    return err(invalidKeyRing("root_key_version_not_a_positive_integer"));
  }
  return ok(value as RootKeyVersion);
}
