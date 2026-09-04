// The two rows ADR M0.3 §1 row 17 assigns to `eventing` that this context does
// NOT model, and the evidence for not modelling them.
//
// ADR M0.3 §1 row 17 reads:
//
//     SOLE WRITER of: NotificationRule, PlatformNotification,
//                     PlatformNotificationInteraction
//
// One of those three is real. The ADR is frozen and is not edited in place
// (§ header: "a future architectural change is recorded in a new, superseding
// ADR"), so the disagreement is recorded here rather than resolved by pretending
// either side said something else.
//
// WHAT THE TREE SAYS. Both absent rows live in
// `internal-packages/database/prisma/schema.prisma`, not in the canonical
// `internal-packages/tenancy-database/prisma/schema.prisma`. That is not a
// neutral fact: ADR §1 row 11 and §7 decision 10 give the ENTIRE former schema
// to `packages/adapters/durable-runtime` behind the `DurableRuntime` port —
// "no domain context touches `internal-packages/database`". So the ADR assigns
// the same two rows to two different owners on two different lines. A context
// that modelled them would be claiming write-ownership of rows another line of
// the same ADR encapsulates wholesale.
//
// `scripts/arch/table-ownership.mjs` already reaches this conclusion
// independently: both names appear in its `UNOWNED_ADR_ROWS` map as "legacy
// schema only; not a canonical tenancy row", and the sole-writer gate passes
// because of it. This file is the same finding stated where the domain can see
// it, so the two cannot drift apart silently.
//
// WHAT THE CODE SAYS. Neither row has a writer anywhere in the repository. The
// only source reference to either name is
// `apps/agent/src/privacy/subject-graph.ts`, which lists both in
// `OPERATOR_USERID_TABLES` — the set whose `userId` "is an OPERATOR, not the
// subject", explicitly excluded from the erasure sweep. They are admin-authored
// product announcements with per-operator read receipts, which is a different
// capability from environment-scoped event routing and shares no column with it.
//
// CONSEQUENCE, and it is the point of this file: `eventing` is sole writer of
// exactly ONE row. `eventing-erasure-target.ts` therefore plans one model, and
// `legacy-rows.test.ts` fails if that ever silently becomes two or zero.

/**
 * The rows ADR §1 row 17 names that are not canonical, each with where it
 * actually lives. Kept as data, not prose, so a test can assert on it.
 */
export const UNMODELLED_ADR_ROWS = Object.freeze({
  PlatformNotification: "legacy schema only; not a canonical tenancy row",
  PlatformNotificationInteraction: "legacy schema only; not a canonical tenancy row",
} as const);

export type UnmodelledAdrRow = keyof typeof UNMODELLED_ADR_ROWS;

/** The schema those rows are in, and which context owns it wholesale. */
export const LEGACY_SCHEMA_PATH = "internal-packages/database/prisma/schema.prisma";
export const LEGACY_SCHEMA_OWNER = "packages/adapters/durable-runtime";

/** The canonical schema, and the single row from it that `eventing` writes. */
export const CANONICAL_SCHEMA_PATH = "internal-packages/tenancy-database/prisma/schema.prisma";
export const NOTIFICATION_RULE_MODEL = "NotificationRule";

/**
 * Every canonical model this context is sole writer of. Exactly one, and the
 * erasure target is built from this list rather than from a second literal.
 */
export const OWNED_CANONICAL_MODELS = Object.freeze([NOTIFICATION_RULE_MODEL] as const);

export function isUnmodelledAdrRow(model: string): model is UnmodelledAdrRow {
  return Object.prototype.hasOwnProperty.call(UNMODELLED_ADR_ROWS, model);
}
