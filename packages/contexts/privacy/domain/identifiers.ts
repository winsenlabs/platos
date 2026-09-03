// Identifiers owned by the `privacy` context (ADR M0.3 §1, context 18).
//
// The kernel brands the tenancy tree; these brand the two rows this context is
// sole writer of, plus the three opaque strings that are NOT primary keys and
// are the easiest to mix up: an idempotency key supplied by a caller, a salted
// subject digest, and a salted alias digest. All three are plain `String`
// columns on `ErasureOperation` / `ErasureTombstone`, and all three are the kind
// of value that silently substitutes for a raw handle when it is typed as
// `string` — which in this context is the difference between a content-free
// audit record and a durable copy of the identifier the operation destroyed.

import type { Branded } from "@platos/kernel";

/** `ErasureOperation.id` — uuid. */
export type ErasureOperationId = Branded<string, "ErasureOperationId">;

/** `ErasureTombstone.id` — uuid. */
export type ErasureTombstoneId = Branded<string, "ErasureTombstoneId">;

/**
 * `ErasureOperation.idempotencyKey` — supplied by the caller, unique within one
 * organization. Never derived here: it is the caller's handle on its own retry,
 * and minting one on their behalf would make two requests look like one.
 */
export type IdempotencyKey = Branded<string, "IdempotencyKey">;

/**
 * `ErasureOperation.subjectKeyHash` — the salted, organization-scoped digest of
 * the subject's external id.
 *
 * Branded because this is the ONLY form of the subject that may be written down.
 * A `string` parameter here would accept the raw handle, and the whole point of
 * the receipt is that it documents a person's destruction without recording who
 * they were.
 */
export type SubjectKeyHash = Branded<string, "SubjectKeyHash">;

/** `ErasureTombstone.aliasHash` — the same primitive, per alias. */
export type AliasHash = Branded<string, "AliasHash">;

/**
 * `ErasureOperation.leaseToken` — held for the duration of one destructive pass
 * so two passes cannot overlap.
 */
export type LeaseToken = Branded<string, "LeaseToken">;

// Rows this context references but never writes. They are branded here because
// `privacy` must not import another context's domain to name them (ADR M0.3 §2),
// and this context handles both an operator id and an end-user id in the same
// call — the substitution the subject graph exists to prevent.
export type PrincipalRef = Branded<string, "PrincipalRef">;
