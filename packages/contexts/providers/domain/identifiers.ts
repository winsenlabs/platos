// Identifiers owned by the `providers` context (ADR M0.3 §1, context 4).
//
// The kernel brands the tenancy tree; these brand the four rows this context is
// SOLE WRITER of — ProviderKey, EnvironmentProvider, Model, ModelPrice — plus
// the three opaque strings that are not primary keys and are the easiest to
// substitute for one another: a provider id, a model key, and a bare credential
// reference name. All three are plain `String` columns in the baseline schema,
// all three read as ordinary prose in a log line, and swapping any two of them
// is silent when they are typed `string`.
//
// `CredentialId` is branded here rather than imported. A context's `domain/`
// may import only its own domain and `@platos/kernel` (ADR M0.3 §2), so it
// cannot name another context's type. The brand is deliberately spelled with
// the SAME tag `secrets` uses, so the two are one type: an id that crossed the
// contract boundary from `secrets` reaches a repository method here without a
// cast, and a `ProviderKeyId` still cannot.

import type { Branded } from "@platos/kernel";

/** `ProviderKey.id` — uuid. */
export type ProviderKeyId = Branded<string, "ProviderKeyId">;

/** `EnvironmentProvider.id` — uuid. */
export type EnvironmentProviderId = Branded<string, "EnvironmentProviderId">;

/** `Model.id` — uuid. */
export type ModelId = Branded<string, "ModelId">;

/** `ModelPrice.id` — uuid. */
export type ModelPriceId = Branded<string, "ModelPriceId">;

/**
 * `Credential.id`. Referenced constantly here and NEVER written: ADR M0.3 §1
 * row 3 makes `secrets` its sole writer, and this context composes that
 * context's `createCredential`/`rotateCredential` with its own ProviderKey
 * write (the hand-off recorded in `secrets/domain/credential.ts`).
 */
export type CredentialId = Branded<string, "CredentialId">;

/**
 * The stable provider identifier — `anthropic`, `openai`, `google-vertex`.
 *
 * One value appears in four places that must agree: `ProviderKey.provider`,
 * `EnvironmentProvider.providerId`, `Model.provider`, and the segment before
 * the colon in a `<provider>:<model>` model string. Branding it is what stops a
 * model name reaching a parameter that means a provider.
 */
export type ProviderId = Branded<string, "ProviderId">;

/**
 * `Model.key` — the catalogue's unique name for one model. It is NOT a row id
 * and it is NOT the `<provider>:<model>` string a caller writes: several
 * lookup keys can resolve to one `Model.key` (see `domain/model-key.ts`).
 */
export type ModelKey = Branded<string, "ModelKey">;

/**
 * `ProviderKey.environmentKeyName` — the BARE reference name of the credential
 * this key points at (`ANTHROPIC_API_KEY`). It is a name in the environment's
 * own credential namespace, never a process variable and never secret material.
 */
export type CredentialName = Branded<string, "CredentialName">;

/**
 * Whoever acted. Deliberately not the kernel `PrincipalId`, for the reason
 * `secrets` gives: `ProviderKey.createdBy` is a plain `String` column recording
 * authorship, and `providers` may not import identity-access (ADR M0.3 §1 row 4
 * allows `tenancy`, `secrets`, `kernel`), so it names the actor without
 * adopting identity's model of one.
 */
export type ActorId = Branded<string, "ActorId">;

/**
 * Tag an already-provenanced string. Like the kernel's `asIdentifier`, this is
 * an assertion and not validation: adapters reading a row, and transports
 * parsing a request, are the only callers that should reach for it.
 */
export function asProvidersIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
