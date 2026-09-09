// WIN-303 — the tenant triple, RESOLVED against the tree before any of the five
// canonical stores sends a statement.
//
// *** THE DEFECT THIS FILE CLOSES. *** `governance-rows.ts`' `scopedWhere` was
// `{ environmentId }` and nothing else, so `SafetyLedger`, `RatingsRepository`,
// `CriteriaRepository`, `EvalsRepository` and `GoldenSetsRepository` checked ONE
// member of a three-member scope. A caller presenting a legitimate environment
// beside SOMEBODY ELSE'S project or organization was served: every read, every
// update and every delete matched, because the two clauses that would have
// disagreed were never in the statement.
//
// `Environment.id` is a globally unique uuid, so the environment determines the
// project and the organization and the other two members look redundant. THEY
// ARE NOT, and the case they catch is the one worth having: a scope assembled
// with a real environment and a foreign ancestry is not a typo. It is a scope
// that has been tampered with, or built by a bug in whatever resolved the grant.
// `apps/agent/src/evals/rating.service.ts` — byte-identical to `origin/main` —
// refuses it, and so do the three read seams this context added last tranche
// (`governance-seam-guards.ts` carries that citation in full).
//
// ---------------------------------------------------------------------------
// WHY ONE STATEMENT AND NOT THREE CLAUSES ON EVERY READ.
//
// The obvious repair is to widen `scopedWhere` to
// `{ environmentId, environment: { project: { id, organizationId } } }` — the
// shape the read seams use — and send nothing extra. It is one statement fewer
// and it is the WRONG shape here, for the reason `tools-scope.ts` already gives
// about the same database: a filter answers a tampered scope with an EMPTY SET,
// and this context has already spent absence on concealment. `errors.ts` says it
// outright — a criterion in another environment and a criterion that does not
// exist answer identically "because telling them apart is exactly the probe" —
// so a store that also answered absence for a forged ancestry would be reporting
// a broken grant as a clean miss, for ever, with nothing anywhere to notice.
//
// So the ancestry is resolved ONCE, in its own statement, and a scope that does
// not join up is REFUSED under a code of the store's own. `scopedWhere` and
// `tenantWhere` stay as they are, narrowing by identifiers this file has already
// proven coherent, and there is exactly ONE mechanism enforcing the triple —
// which is what makes it falsifiable. A second copy in the `where` clause could
// never be turned red by any test, because this guard would refuse first: a
// guard nothing can falsify is the same as no guard at all.
//
// ---------------------------------------------------------------------------
// FIVE CODES, THREE REASONS.
//
// The CODE says which store refused, so a resolver dropped from one of the five
// cannot hide behind the other four. The REASON says which of three facts it
// was, and the three are genuinely different operational events:
//
//   `unnarrowable_identifiers` — a member of the scope is not uuid-shaped. NO
//   STATEMENT IS SENT, and that is the point rather than an optimisation: every
//   id below is bound to a `@db.Uuid` column, a malformed one makes the driver
//   refuse the whole statement with "Error creating UUID, invalid character",
//   and on PostgreSQL a refused statement ABORTS THE ENCLOSING TRANSACTION.
//   Four of this context's five ports take the caller's `TransactionScope`, so a
//   scope check that raised would leave the caller unable to write anything
//   else. Same finding, same answer, as `governance-guards.ts` and
//   `governance-seam-guards.ts`.
//
//   `unknown_environment` / `unknown_project` — the leaf resolves to no row. An
//   environment deleted since the grant was minted looks like this.
//
//   `foreign_ancestry` — the leaf EXISTS, under a project or an organization
//   other than the one the scope claims. This is the tampered triple, and it is
//   the only one of the three that a store narrowing by the leaf alone served.
//
// AN ORGANIZATION SCOPE SENDS NO STATEMENT EITHER, AND THAT IS NOT AN OMISSION.
// It names ONE identifier, so it asserts no relation and there is nothing for
// the tree to contradict; the erasure paths that take one already narrow through
// `Environment` and `Project` from that organization, so a non-existent
// organization reaches no row. A statement that could only ever answer "yes"
// would be a cost with no refusal behind it — and it would break the pin
// `governance-statements.integration.test.ts` takes at an organization scope,
// which exists to catch a widening read of the tenant tree.
//
// THE SQL IS A STATIC TAGGED TEMPLATE WITH ONE INTERPOLATED VALUE, so
// `scripts/arch/sole-writer.mjs` can attribute it: it names two tables, both
// `tenancy`'s, and reads them — which §1 permits, since the cutting rule
// restricts WRITES.

import type {
  DomainError,
  EnvironmentScope,
  Result,
  TenantScope,
} from "@platos/context-governance/application/ports/index.js";
import { err, ok, resolvePath } from "@platos/context-governance/application/ports/index.js";

import { refuse } from "./governance-refusal.js";
import { isNarrowableIdentifier, narrowableScope } from "./governance-seam-guards.js";
import type { TenancyTransactions } from "./transaction.js";

/** A scope member is not the shape a `@db.Uuid` column accepts. No statement sent. */
export const GOVERNANCE_SCOPE_UNNARROWABLE = "unnarrowable_identifiers";

/** The scope names an environment that is in no row of the tree. */
export const GOVERNANCE_SCOPE_UNKNOWN_ENVIRONMENT = "unknown_environment";

/** The scope names a project that is in no row of the tree. */
export const GOVERNANCE_SCOPE_UNKNOWN_PROJECT = "unknown_project";

/** The leaf exists, under a different parent than the scope claims. THE TAMPER. */
export const GOVERNANCE_SCOPE_FOREIGN_ANCESTRY = "foreign_ancestry";

/**
 * One store's own refusal constructor.
 *
 * Passed in rather than switched on inside, so the five codes are chosen at the
 * five call sites and a store that forgot to pass its own would not compile.
 */
export type GovernanceScopeRefusal = (reason: string) => DomainError;

/** One row: the environment's parent, and its parent's parent. */
interface ResolvedEnvironment {
  readonly projectId: string;
  readonly organizationId: string;
}

/** One row: the project's parent. */
interface ResolvedProject {
  readonly organizationId: string;
}

/**
 * The reason string a refusal carries.
 *
 * The FACT leads, then the operation, then the scope path. An operator greps for
 * `foreign_ancestry` across every store; the path is what tells them which grant
 * produced it, and `resolvePath` is the kernel's own canonical spelling of a
 * scope rather than a fourth local one.
 */
function reasonFor(fact: string, operation: string, scope: TenantScope): string {
  return `${fact}: ${operation}: ${resolvePath(scope)}`;
}

/**
 * Resolve a scope against the tenant tree, or refuse under the store's own code.
 *
 * ZERO STATEMENTS for an organization scope and for a scope whose identifiers
 * are not uuid-shaped; ONE for a project or an environment scope. Never more:
 * the environment case reaches its organization through a JOIN rather than
 * through a second read, because the client loads a relation as its own query
 * and this sits on the front of every method of five ports.
 */
export async function requireGovernanceScope(
  transactions: TenancyTransactions,
  scope: TenantScope,
  refusal: GovernanceScopeRefusal,
  operation: string,
): Promise<Result<true>> {
  if (scope.level === "organization") {
    // Nothing asserted, nothing to contradict. See the header.
    return isNarrowableIdentifier(scope.organizationId)
      ? ok(true)
      : err(refusal(reasonFor(GOVERNANCE_SCOPE_UNNARROWABLE, operation, scope)));
  }

  if (scope.level === "project") {
    if (!isNarrowableIdentifier(scope.organizationId) || !isNarrowableIdentifier(scope.projectId)) {
      return err(refusal(reasonFor(GOVERNANCE_SCOPE_UNNARROWABLE, operation, scope)));
    }
    const rows = await transactions.reader().$queryRaw<readonly ResolvedProject[]>`
      SELECT project."organizationId" AS "organizationId"
        FROM "public"."Project" project
       WHERE project."id" = ${scope.projectId}::uuid`;
    const resolved = rows[0];
    if (resolved === undefined) {
      return err(refusal(reasonFor(GOVERNANCE_SCOPE_UNKNOWN_PROJECT, operation, scope)));
    }
    if (resolved.organizationId !== scope.organizationId) {
      return err(refusal(reasonFor(GOVERNANCE_SCOPE_FOREIGN_ANCESTRY, operation, scope)));
    }
    return ok(true);
  }

  // `narrowableScope` is the READ SEAMS' guard, imported rather than copied:
  // same context, same three columns, same RFC 4122 fact. The seams' header
  // explains why it does NOT import `agents-guards.ts`' copy — different tables,
  // different owners — and neither reason applies between these two.
  const narrowed = narrowableScope(scope as EnvironmentScope);
  if (narrowed === null) {
    return err(refusal(reasonFor(GOVERNANCE_SCOPE_UNNARROWABLE, operation, scope)));
  }
  const rows = await transactions.reader().$queryRaw<readonly ResolvedEnvironment[]>`
    SELECT environment."projectId" AS "projectId", project."organizationId" AS "organizationId"
      FROM "public"."Environment" environment
      JOIN "public"."Project" project ON project."id" = environment."projectId"
     WHERE environment."id" = ${narrowed.environmentId}::uuid`;
  const resolved = rows[0];
  if (resolved === undefined) {
    return err(refusal(reasonFor(GOVERNANCE_SCOPE_UNKNOWN_ENVIRONMENT, operation, scope)));
  }
  // BOTH halves, and the organization one is the half a mutation removes without
  // any other suite noticing: an environment under the right project is under
  // the right organization in every fixture that seeds one chain. The tampered
  // triple `governance-isolation.integration.test.ts` builds is the case that
  // separates them.
  if (resolved.projectId !== narrowed.projectId || resolved.organizationId !== narrowed.organizationId) {
    return err(refusal(reasonFor(GOVERNANCE_SCOPE_FOREIGN_ANCESTRY, operation, scope)));
  }
  return ok(true);
}

/**
 * Resolve the scope, then run one store method — the single entry point the five
 * stores use in place of a bare `refuse`.
 *
 * THE RESOLVE RUNS INSIDE `refuse`, unlike `tools-scope.ts`' `inScope` where it
 * runs outside. The ports say "every method returns `Result`; a rejected promise
 * is a defect, not an outcome", and the resolve sends a statement — so a genuine
 * infrastructure fault during it would otherwise reject the promise this method
 * promised never to reject. Inside, it is folded into
 * `GOVERNANCE_LEDGER_UNAVAILABLE`, which is what a table being down actually is,
 * while a `TransactionScopeError` still rethrows for the reason
 * `governance-refusal.ts` gives.
 */
export async function inGovernanceScope<Value>(
  transactions: TenancyTransactions,
  scope: TenantScope,
  refusal: GovernanceScopeRefusal,
  operation: string,
  work: () => Promise<Result<Value>>,
): Promise<Result<Value>> {
  return refuse(async () => {
    const resolved = await requireGovernanceScope(transactions, scope, refusal, operation);
    if (!resolved.ok) return err(resolved.error);
    return work();
  }, operation);
}
