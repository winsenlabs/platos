// The one guard the three `governance` READ SEAMS share, and the three refusals
// it produces.
//
// WHAT IT GUARDS. `Organization.id`, `Project.id` and `Environment.id` are all
// `@db.Uuid` and every one of these reads narrows by all three. A scope carrying
// a string that is not a uuid does NOT return no rows: the driver refuses the
// whole statement with "Error creating UUID, invalid character", the same
// failure `agents-guards.ts` found on the agent search and answered the same
// way. `EnvironmentScope`'s identifiers are BRANDS over `string` —
// `asIdentifier("")` compiles — so the values reaching here are whatever built
// the grant, unvalidated.
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
 * That shape, as a predicate — the ONE definition the three seams and the five
 * canonical stores share.
 *
 * WIN-303. `governance-scope.ts` has to check the members of an ORGANIZATION and
 * a PROJECT scope, which `narrowableScope` below cannot express because it takes
 * the whole environment triple. It imports this rather than carrying a third
 * copy of the expression: unlike `agents-guards.ts`, that file guards the SAME
 * three columns for the SAME owner as this one, so neither reason the paragraph
 * above gives for a second copy applies between them.
 */
export function isNarrowableIdentifier(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/**
 * The WHOLE tenant triple this read may narrow by, or `null` when it is not
 * usable.
 *
 * ALL THREE, NOT THE ENVIRONMENT ALONE, AND THAT IS THE ORACLE'S SHAPE RATHER
 * THAN A PREFERENCE. `apps/agent/src/evals/rating.service.ts` — byte-identical
 * to `origin/main` — resolves a rating's turn through `threadScopeWhere`, which
 * is `{ environmentId, environment: { project: { id: projectId,
 * organizationId } } }`, and its own comment says why: "a guessed turn id in
 * another scope returns null and we throw". The monitoring service's four
 * denominator reads narrow the same way.
 *
 * `Environment.id` is a globally unique uuid, so the environment alone
 * determines the project and the organization and the extra clauses look
 * redundant. THEY ARE NOT, and the case they catch is the one worth having: a
 * grant assembled with a REAL environment and SOMEBODY ELSE'S project or
 * organization. That scope is not a typo — it is a scope that has been
 * tampered with, or built by a bug in whatever resolved the grant — and with
 * the environment clause alone this reader would serve it. The oracle refuses
 * it, so these do.
 *
 * THE FIVE CANONICAL STORES BESIDE THESE NOW DO TOO, AND THIS PARAGRAPH USED TO
 * SAY THEY DID NOT. WIN-267 G2 reported the divergence rather than repairing it
 * — `scopedWhere` was `{ environmentId }` and nothing more, so `SafetyLedger`,
 * `RatingsRepository`, `CriteriaRepository`, `EvalsRepository` and
 * `GoldenSetsRepository` accepted a mismatched triple where these three refused
 * it. WIN-303 closed it. The five resolve their whole scope through
 * `governance-scope.ts` before any statement, and refuse a forged ancestry under
 * a code of each store's own.
 *
 * THE TWO ANSWERS STILL DIFFER, AND THE DIFFERENCE IS DELIBERATE. These three
 * fold the triple into the `where` and answer ABSENCE for a mismatched one,
 * because absence is already what they answer for another tenant's row and
 * `read-seams.ts` requires a probe and a typo to be indistinguishable. The five
 * stores REFUSE instead, in a statement of their own, because absence there
 * would make a broken grant indistinguishable from a criterion that does not
 * exist — see `governance-scope.ts`, which carries the argument in full.
 *
 * `null` is the signal to REFUSE with the calling seam's own constructor. It is
 * never a licence to read wider: no caller in this package treats `null` as
 * "match everything", and the three that use it return before any statement.
 */
export interface NarrowedScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

export function narrowableScope(scope: EnvironmentScope): NarrowedScope | null {
  const organizationId: unknown = scope.organizationId;
  const projectId: unknown = scope.projectId;
  const environmentId: unknown = scope.environmentId;
  if (typeof organizationId !== "string" || !UUID_SHAPE.test(organizationId)) return null;
  if (typeof projectId !== "string" || !UUID_SHAPE.test(projectId)) return null;
  if (typeof environmentId !== "string" || !UUID_SHAPE.test(environmentId)) return null;
  return { organizationId, projectId, environmentId };
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
