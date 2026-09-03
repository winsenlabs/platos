// `ProviderKey` — an environment's named link from a provider to a credential.
//
// A ProviderKey holds NO SECRET. It is metadata: which provider, what an
// operator called it, which credential in this environment's vault backs it, and
// whether it is the one to use when nothing else is specified. The material
// lives behind `secrets`, and this row is the only thing that says which piece
// of material is this provider's.
//
// That separation is why an environment can hold several keys for one provider —
// a production key, a staging key, a key belonging to one customer — and pin an
// individual agent version to one of them without ever moving the secret.
//
// TWO CONSTRAINTS ARE THE STORE'S AND ARE MODELLED HERE SO A CALLER MEETS THEM
// BEFORE IT WRITES:
//
//   [environmentId, provider, label]  is unique — a label names one key.
//   at most one key per [environment, provider] carries `isDefault` — enforced
//   in the store by a partial unique index, and reached here by demoting the
//   incumbent inside the same transaction as the promotion.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { providerKeyMetadataInvalid } from "./errors.js";
import {
  asProvidersIdentifier,
  type ActorId,
  type CredentialId,
  type CredentialName,
  type ProviderId,
  type ProviderKeyId,
} from "./identifiers.js";

/** Ceiling on an operator-supplied label. */
export const MAX_PROVIDER_KEY_LABEL_LENGTH = 200;

/** Ceiling on a bare credential reference name. */
export const MAX_CREDENTIAL_NAME_LENGTH = 200;

/**
 * Ceiling on the secret an operator pastes when registering a key directly.
 *
 * Sixteen kibibytes, which is the source's limit. It is generous because one
 * legitimate credential is a whole service-account document rather than a token,
 * and it exists because an unbounded body is an unbounded envelope.
 */
export const MAX_PROVIDER_SECRET_LENGTH = 16_384;

export interface ProviderKey {
  readonly providerKeyId: ProviderKeyId;
  readonly environmentId: EnvironmentId;
  readonly credentialId: CredentialId;
  readonly provider: ProviderId;
  readonly label: string;
  /** The bare name of the credential in this environment's vault. */
  readonly credentialName: CredentialName;
  readonly isDefault: boolean;
  readonly createdBy: ActorId;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an operator supplies to link a provider to an existing credential. */
export interface ProviderKeyIntake {
  readonly provider: string;
  readonly label: string;
  readonly credentialName: string;
  readonly isDefault: boolean;
}

export interface AdmittedProviderKey {
  readonly provider: ProviderId;
  readonly label: string;
  readonly credentialName: CredentialName;
  readonly isDefault: boolean;
}

function required(value: string, field: string, maximum: number): Result<string> {
  const trimmed = value.trim();
  if (trimmed === "") {
    return err(
      providerKeyMetadataInvalid(`${field} is required`, [
        { field, code: "required", message: `${field} is required` },
      ]),
    );
  }
  if (trimmed.length > maximum) {
    return err(
      providerKeyMetadataInvalid(`${field} must be at most ${maximum} characters`, [
        { field, code: "too_long", message: `${field} must be at most ${maximum} characters` },
      ]),
    );
  }
  return ok(trimmed);
}

/**
 * Admit an intake.
 *
 * Every field is trimmed before it is judged, because the control surface trims
 * before it validates and an untrimmed label would otherwise pass here and fail
 * the store's uniqueness check against its own trimmed twin.
 */
export function admitProviderKey(intake: ProviderKeyIntake): Result<AdmittedProviderKey> {
  const provider = required(intake.provider, "provider", MAX_CREDENTIAL_NAME_LENGTH);
  if (!provider.ok) return err(provider.error);
  const label = required(intake.label, "label", MAX_PROVIDER_KEY_LABEL_LENGTH);
  if (!label.ok) return err(label.error);
  const credentialName = required(intake.credentialName, "credentialName", MAX_CREDENTIAL_NAME_LENGTH);
  if (!credentialName.ok) return err(credentialName.error);
  return ok({
    provider: asProvidersIdentifier<ProviderId>(provider.value),
    label: label.value,
    credentialName: asProvidersIdentifier<CredentialName>(credentialName.value),
    isDefault: intake.isDefault,
  });
}

/** Admit pasted secret material. Its VALUE is never inspected or logged. */
export function admitProviderSecret(plaintext: unknown): Result<string> {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    return err(
      providerKeyMetadataInvalid("secret is required", [
        { field: "secret", code: "required", message: "secret is required" },
      ]),
    );
  }
  if (plaintext.length > MAX_PROVIDER_SECRET_LENGTH) {
    return err(
      providerKeyMetadataInvalid(`secret must be at most ${MAX_PROVIDER_SECRET_LENGTH} characters`, [
        { field: "secret", code: "too_long", message: "secret is too long" },
      ]),
    );
  }
  return ok(plaintext);
}

/**
 * The listing order, transcribed exactly: provider, then defaults first, then
 * oldest first, then by id.
 *
 * The final id comparison is what makes the order TOTAL. Two keys created in the
 * same millisecond would otherwise come back in whatever order the store felt
 * like, and a paged listing whose order is not total silently drops and repeats
 * rows across pages.
 */
export function byListingOrder(left: ProviderKey, right: ProviderKey): number {
  if (left.provider !== right.provider) return left.provider < right.provider ? -1 : 1;
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  const byAge = left.createdAt.getTime() - right.createdAt.getTime();
  if (byAge !== 0) return byAge;
  if (left.providerKeyId === right.providerKeyId) return 0;
  return left.providerKeyId < right.providerKeyId ? -1 : 1;
}

/** The keys that must lose `isDefault` for `promoted` to become the default. */
export function defaultsToDemote(
  keys: readonly ProviderKey[],
  promoted: ProviderKey,
): readonly ProviderKey[] {
  return keys.filter(
    (key) =>
      key.isDefault &&
      key.providerKeyId !== promoted.providerKeyId &&
      key.environmentId === promoted.environmentId &&
      key.provider === promoted.provider,
  );
}

export function findDefault(keys: readonly ProviderKey[], provider: ProviderId): ProviderKey | null {
  return keys.find((key) => key.provider === provider && key.isDefault) ?? null;
}

/** True when a key already carries the label another key wants. */
export function labelIsTaken(
  keys: readonly ProviderKey[],
  environmentId: EnvironmentId,
  provider: ProviderId,
  label: string,
  excluding: ProviderKeyId | null = null,
): boolean {
  return keys.some(
    (key) =>
      key.environmentId === environmentId &&
      key.provider === provider &&
      key.label === label &&
      key.providerKeyId !== excluding,
  );
}

/** What changed on a key, as an operator supplied it. */
export interface ProviderKeyPatch {
  readonly label?: string;
  readonly isDefault?: boolean;
}

export interface AdmittedProviderKeyPatch {
  readonly label: string | null;
  readonly isDefault: boolean | null;
}

export function admitProviderKeyPatch(patch: ProviderKeyPatch): Result<AdmittedProviderKeyPatch> {
  if (patch.label === undefined) {
    return ok({ label: null, isDefault: patch.isDefault ?? null });
  }
  const label = required(patch.label, "label", MAX_PROVIDER_KEY_LABEL_LENGTH);
  if (!label.ok) return err(label.error);
  return ok({ label: label.value, isDefault: patch.isDefault ?? null });
}

export function applyPatch(key: ProviderKey, patch: AdmittedProviderKeyPatch, now: Date): ProviderKey {
  return {
    ...key,
    label: patch.label ?? key.label,
    isDefault: patch.isDefault ?? key.isDefault,
    updatedAt: now,
  };
}

export function demote(key: ProviderKey, now: Date): ProviderKey {
  return { ...key, isDefault: false, updatedAt: now };
}

export function relink(
  key: ProviderKey,
  credentialId: CredentialId,
  credentialName: CredentialName,
  label: string | null,
  now: Date,
): ProviderKey {
  return { ...key, credentialId, credentialName, label: label ?? key.label, updatedAt: now };
}

export function markUsed(key: ProviderKey, at: Date): ProviderKey {
  return { ...key, lastUsedAt: at };
}
