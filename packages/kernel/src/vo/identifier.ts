// Branded identifier types.
//
// Every canonical row in the baseline schema is keyed by an opaque string
// (uuid, or a prefixed token id). Modelling them all as `string` is what lets a
// projectId reach a parameter expecting an organizationId — the exact shape of
// the cross-tenant defects this programme must make impossible. Branding costs
// nothing at runtime (the brand is a phantom type; `declare` emits no JavaScript)
// and makes that substitution a compile error.
//
// ADR M0.3 §4: pure value objects, no runtime dependency, no I/O.

declare const brand: unique symbol;

/** A primitive carrying a compile-time-only tag that prevents substitution. */
export type Branded<Primitive, Tag extends string> = Primitive & {
  readonly [brand]: Tag;
};

/** RFC 4122 version 4 UUID — the baseline primary-key format. */
export type Uuid = Branded<string, "Uuid">;

/** Lexicographically sortable, monotonic identifier (ADR M0.3 §4 IdGenerator). */
export type Ulid = Branded<string, "Ulid">;

// The tenancy tree (ADR M0.3 §1, context 2). Entity is the tree's leaf and is
// structural, not channel-specific (§7 decision 6).
export type OrganizationId = Branded<string, "OrganizationId">;
export type ProjectId = Branded<string, "ProjectId">;
export type EnvironmentId = Branded<string, "EnvironmentId">;
export type EntityId = Branded<string, "EntityId">;

/** The acting principal, whoever it is (operator, end user, access key, agent). */
export type PrincipalId = Branded<string, "PrincipalId">;

/** One inbound request, carried through every layer for correlation. */
export type RequestId = Branded<string, "RequestId">;

/** One transactional boundary. Opaque: it never carries a vendor handle. */
export type TransactionId = Branded<string, "TransactionId">;

/** One appended domain event. */
export type EventId = Branded<string, "EventId">;

/**
 * Tag an untrusted string as an identifier.
 *
 * This is a compile-time assertion, not validation: the caller is asserting it
 * has already established the value's provenance. Adapters parsing a row, and
 * transports parsing a request, are the only places that should reach for it.
 */
export function asIdentifier<Id extends Branded<string, string>>(value: string): Id {
  return value as Id;
}
