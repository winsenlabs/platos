// The one guard the three `governance` READ SEAMS share, and the three refusals
// it produces.
//
// WHAT IT GUARDS. `Environment.id` is `@db.Uuid` and every one of these reads
// narrows by it. A scope carrying a string that is not a uuid does NOT return
// no rows: the driver refuses the whole statement with "Error creating UUID,
// invalid character", the same failure `agents-guards.ts` found on the agent
// search and answered the same way. `EnvironmentScope`'s identifiers are BRANDS
// over `string` — `asIdentifier("")` compiles — so the value reaching here is
// whatever built the grant, unvalidated.
//
// WHY IT IS A REFUSAL AND NOT AN EMPTY ANSWER. `read-seams.ts` has already
// spent absence: `null` means "not in this environment", and the use cases turn
// it into `NOT_FOUND` precisely so a cross-tenant probe is indistinguishable
// from a typo. A reader that answered `null` or `[]` because it could not apply
// the narrowing would be reporting a defect as a clean miss — and for
// `ActivityReader` that is not even visible, because `risk-report.ts` renders
// the board anyway with every denominator substituted.
//
// WHY IT RUNS BEFORE THE STATEMENT. Two reasons, and only the second is about
// this file. The first is `governance-guards.ts`' reason for writes: these reads
// resolve through `transactions.reader()`, which inside a unit of work IS the
// caller's transaction, and a statement the driver refuses there can leave the
// caller unable to write anything else. The second is the code. A refusal raised
// by the driver is folded by `refuse()` into `GOVERNANCE_LEDGER_UNAVAILABLE` —
// ONE code for all three seams and for a genuine outage as well. Checking here
// is what keeps `GOVERNANCE_RATING_TARGET_UNREADABLE`,
// `GOVERNANCE_TRANSCRIPT_UNREADABLE` and `GOVERNANCE_ACTIVITY_UNREADABLE`
// distinct from each other and from an outage.
//
// THE ROW IDENTIFIERS ARE DELIBERATELY NOT GUARDED THE SAME WAY. A `turnId` or
// `threadId` that is not a uuid is a TYPO, and the port says a typo and another
// tenant's row must answer identically. So a malformed row id resolves to
// absence — `null`, or an empty turn list — and only the SCOPE, which no caller
// typed, refuses. `narrowableRowId` below is what lets the seams answer absence
// without sending a statement the driver would refuse.

import type { EnvironmentScope } from "@platos/context-governance/application/ports/index.js";

/**
 * The shape `@db.Uuid` accepts, checked BEFORE the value reaches a uuid column.
 *
 * A SECOND COPY of `agents-guards.ts`' pattern rather than an import of it, and
 * that is deliberate: that one is not exported from this package's entry point,
 * the two guard different tables for different owners, and a shared constant
 * would make one owner's change silently retune another's. The regular
 * expression is RFC 4122's textual form, which is the same fact both are joined
 * to.
 */
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

/**
 * The environment this read may narrow by, or `null` when there is none.
 *
 * `null` is the signal to REFUSE with the calling seam's own constructor. It is
 * never a licence to read wider: no caller in this package treats `null` as
 * "match everything", and the three that use it return before any statement.
 */
export function narrowableEnvironment(scope: EnvironmentScope): string | null {
  const environmentId: unknown = scope.environmentId;
  if (typeof environmentId !== "string") return null;
  return UUID_SHAPE.test(environmentId) ? environmentId : null;
}

/**
 * A row identifier a uuid column could hold, or `null` for a typo.
 *
 * `null` here means ABSENCE, not refusal — see the header. It exists so a
 * mistyped identifier costs no statement and, more to the point, so it cannot
 * raise a driver error that `refuse()` would report as an outage.
 */
export function narrowableRowId(rowId: string): string | null {
  return UUID_SHAPE.test(rowId) ? rowId : null;
}
