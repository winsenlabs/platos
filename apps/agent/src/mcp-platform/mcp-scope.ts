// The tenant clause for the MCP platform's authorization surfaces, as a
// STATEMENT rather than as a comparison.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS FOR, MEASURED ON THE TREE IT REPLACES
//
// `RequestScope` is assembled in `apps/agent/src/auth/scope.guard.ts` from three
// SEPARATE request headers — `x-platos-organization-id`, `x-platos-project-id`
// and `x-platos-environment-id` — and nothing on that path asks whether the
// three name one chain. The only coherence check the guard performs is
// `validateOperatorAgentPin`, and it runs ONLY when `x-platos-agent-id` is also
// present. So a triple whose environment belongs to one tenant and whose
// organization belongs to another is REPRESENTABLE at every authorization
// surface downstream of that guard.
//
// `permission-gateway.service.ts` then read tier 2 as
//
//     prisma.organizationMcpPolicy.findMany({ where: { organizationId: scope.organizationId } })
//
// — the leaf's organization taken on trust from the header. Tier 3 in the same
// file re-derives the whole chain (`environment.projectId`,
// `environment.project.organizationId`, `agent.projectId`) and refuses when it
// does not join up, so the two tiers of one gate disagreed about whether the
// scope had to be true. And tier 3 only runs when there IS an agent: an MCP
// client or an operator calls with `agentId === null`, which is the common case
// on this surface, and then tier 2 was the ONLY tier that touched the database.
//
// THE FAILURE IS NOT "reads the wrong rows". It is that the wrong rows are
// USUALLY NONE: `findMany` for an organization with no MCP policy returns `[]`,
// `organizationOpinion([])` is `null`, and a null opinion is "this tier has no
// objection". So a forged organization id turned a tier that could only ever
// TIGHTEN into a tier that could be made to abstain. An empty result and a
// refusal were the same value, which is the distinction this module exists to
// mint.
//
// ---------------------------------------------------------------------------
// WHY IT IS SHAPED LIKE `packages/adapters/postgres-tenancy/src/tools-scope.ts`
//
// Because that is where this surface is going. ADR M0.3 §1 row 7 gives
// `OrganizationMcpPolicy`, `EntityToolPolicy`, `EntityMcpConfig` and
// `EnvironmentEntityTool` to the `tools` context, whose `ToolsRepository` port
// says every scoped method takes an `EnvironmentScope` and not an
// `environmentId` "so an adapter's `where` clause is built from the organization
// and project as well as the leaf". Its PostgreSQL adapter implements that as
// ONE JOIN on the front of every scoped read, with TWO distinct refusals —
// `out_of_scope` for a forged ancestry and `unknown_environment` for an
// environment that is not there.
//
// This module is that same statement, with the same two reasons, in the app that
// still holds the client. It is deliberately NOT a new invariant invented here:
// the destination behaviour already exists, is already conformance-tested
// against a real PostgreSQL in `tools-isolation.integration.test.ts`, and the
// day `apps/agent` can reach `toolsContract` this file is deleted rather than
// translated.
//
// WHY IT IS NOT A CALL TO THAT CONTRACT TODAY. `apps/agent` imports no
// `@platos/context-*` package, no `@platos/adapter-*` package and no
// `@platos/kernel` — measured, zero occurrences — and it could not: ADR M0.3
// §5.1 rule (j) `adapters-only-from-core` gives adapter imports to
// `apps/core-api` alone, and `scripts/arch/composition-root.mjs` narrows that
// further to the ONE file `apps/core-api/src/composition/adapter-bindings.ts`.
// A composed `ToolsContract` therefore cannot be constructed in this process,
// and `tools` is not composed in the one process that could construct it
// (`ToolDispatch` has no adapter directory — WIN-269's scope, not this one's).
//
// ---------------------------------------------------------------------------
// ONE STATEMENT, AND IT IS THE SAME ONE FOR EVERY METHOD
//
// Folding the ancestry into each read's own `where` would be one statement
// fewer, and would also make "this scope is a lie" indistinguishable from "this
// organization has no policy" on every read that returns a list — which is the
// exact defect above, re-created one layer down. The scoped methods below return
// a discriminated union, so the difference is expressible, and it is worth a
// statement to express it.

import type { ControlDatabaseClient } from "../shared/database.provider";

/** The (organization, project, environment) chain a caller CLAIMS. */
export interface ClaimedScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/** The scope names an environment that is not under the project it claims. */
export const MCP_SCOPE_FOREIGN = "out_of_scope";

/** The scope names an environment that does not exist at all. */
export const MCP_SCOPE_UNKNOWN = "unknown_environment";

export type ScopeRefusalReason = typeof MCP_SCOPE_FOREIGN | typeof MCP_SCOPE_UNKNOWN;

/**
 * A refusal, or a value. Never `null` standing in for both.
 *
 * The shape is the one the `tools` contract's methods return — `Result` in
 * kernel terms — spelled without importing the kernel, which this app may not
 * do. A caller that ignores the failure branch does not compile.
 */
export type Scoped<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: ScopeRefusalReason };

export function scopeRefused(reason: ScopeRefusalReason): Scoped<never> {
  return { ok: false, reason };
}

export function scopeAllowed<Value>(value: Value): Scoped<Value> {
  return { ok: true, value };
}

/** One row: the environment's parent, and its parent's parent. */
interface ResolvedAncestry {
  readonly projectId: string;
  readonly organizationId: string;
}

/**
 * Resolve a claimed scope against the tree, or refuse. ONE statement.
 *
 * THE PROJECT'S ORGANIZATION, NOT THE ENVIRONMENT'S. `Environment` has no
 * organization column — the chain is Environment -> Project -> Organization —
 * which is precisely why a method keyed on the leaf alone cannot notice a
 * re-parent, and why the join has to be written out.
 *
 * A RAW READ RATHER THAN `findUnique` WITH A RELATION SELECT, for the reason
 * `tools-scope.ts` gives and measures: the client loads a relation as a SECOND
 * round trip, and this sits on the front of every scoped method. The SQL is a
 * static tagged template with one interpolated VALUE, so it stays attributable
 * and names no table it does not read.
 *
 * THE CAST IS `::text`, NOT `::uuid`. `tools-scope.ts` can cast to uuid because
 * every id it sees has already been through a branded-identifier constructor.
 * Here the value arrives as a raw HTTP header, so a caller can trivially send
 * `x-platos-environment-id: not-a-uuid` — and a `::uuid` cast on that raises a
 * PostgreSQL `22P02` that surfaces as a 500 rather than as the 403 a forged
 * scope has earned. Comparing as text refuses it as `unknown_environment`,
 * which is what it is.
 */
export async function resolveClaimedScope(
  prisma: ControlDatabaseClient,
  scope: ClaimedScope,
): Promise<Scoped<ResolvedAncestry>> {
  const rows = await prisma.$queryRaw<readonly ResolvedAncestry[]>`
    SELECT environment."projectId" AS "projectId", project."organizationId" AS "organizationId"
    FROM "public"."Environment" environment
    JOIN "public"."Project" project ON project."id" = environment."projectId"
    WHERE environment."id"::text = ${scope.environmentId}`;
  const resolved = rows[0];
  if (resolved === undefined) return scopeRefused(MCP_SCOPE_UNKNOWN);
  if (resolved.projectId !== scope.projectId || resolved.organizationId !== scope.organizationId) {
    return scopeRefused(MCP_SCOPE_FOREIGN);
  }
  return scopeAllowed(resolved);
}
