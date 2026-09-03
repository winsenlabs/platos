// Use cases: read agents.
//
// EVERY READ IS THROUGH THE BINDING, AND THAT IS THE WHOLE ACCESS RULE. An
// `Agent` row belongs to a project and is therefore visible, in principle, to
// every environment in it; an agent is PRESENT in an environment only where a
// binding exists. So "list this environment's agents" is "list this
// environment's bindings", and an agent bound in staging is simply not there
// when production asks. There is no separate visibility flag to get wrong.
//
// A LOOKUP BY SLUG IS NOT A LOOKUP BY ID WITH EXTRA STEPS. `@@unique([projectId,
// slug])` makes a slug unique per project, so two environments in one project
// resolve the same slug to the same agent — and each still sees it only if it is
// bound there. That is why the slug read goes through the same binding filter
// rather than resolving the agent first and checking the binding afterwards: the
// second shape leaks the existence of agents this environment cannot see.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  asAgentsIdentifier,
  agentNotBound,
  byListingOrder,
  type AgentId,
  type Slug,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { BoundAgent, BoundAgentPage } from "./ports/index.js";

export interface ReadAgentsQuery {
  readonly authorization: unknown;
}

export interface DescribeAgentQuery extends ReadAgentsQuery {
  readonly agentId: AgentId;
}

export interface DescribeAgentBySlugQuery extends ReadAgentsQuery {
  readonly slug: string;
}

export interface PageAgentsQuery extends ReadAgentsQuery {
  readonly limit: number;
  readonly offset: number;
  readonly search?: string | null;
  /** `active`, `paused`, or absent for both. The surface's own vocabulary. */
  readonly status?: "active" | "paused" | null;
}

export async function listAgents(
  dependencies: AgentsDependencies,
  query: ReadAgentsQuery,
): Promise<Result<readonly BoundAgent[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.repository.listBoundAgents(granted.value.scope);
  if (!listed.ok) return err(listed.error);
  // Sorted here as well as in the store. The store's order is the one that makes
  // paging correct; repeating it here makes an unpaged listing independent of
  // whether a particular adapter honoured it.
  return ok([...listed.value].sort((left, right) => byListingOrder(left.agent, right.agent)));
}

export async function pageAgents(
  dependencies: AgentsDependencies,
  query: PageAgentsQuery,
): Promise<Result<BoundAgentPage>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const search = query.search?.trim();
  return dependencies.repository.pageBoundAgents(granted.value.scope, {
    limit: Math.min(Math.max(Math.trunc(query.limit), 1), dependencies.policy.maxPageSize),
    offset: Math.max(Math.trunc(query.offset), 0),
    // An empty search is NOT a search. Passing `""` down would make every
    // adapter decide privately whether that means "everything" or "nothing".
    search: search === undefined || search === "" ? null : search,
    active: statusFilter(query.status),
  });
}

/** `active` and `paused` are the surface's words for one boolean column. */
function statusFilter(status: "active" | "paused" | null | undefined): boolean | null {
  if (status === "active") return true;
  if (status === "paused") return false;
  return null;
}

export async function describeAgent(
  dependencies: AgentsDependencies,
  query: DescribeAgentQuery,
): Promise<Result<BoundAgent>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  return requireBound(dependencies, granted.value.scope, query.agentId);
}

export async function describeAgentBySlug(
  dependencies: AgentsDependencies,
  query: DescribeAgentBySlugQuery,
): Promise<Result<BoundAgent>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const slug = asAgentsIdentifier<Slug>(query.slug.trim());
  const found = await dependencies.repository.findBoundAgentBySlug(granted.value.scope, slug);
  if (!found.ok) return err(found.error);
  if (found.value === null) {
    return err(agentNotBound(slug, granted.value.scope.environmentId));
  }
  return ok(found.value);
}

/**
 * The read every write path starts with.
 *
 * Exported because five use cases need exactly this — resolve the agent inside
 * the granted environment, or refuse — and a second implementation of it would
 * be a second chance to forget the environment filter.
 */
export async function requireBound(
  dependencies: AgentsDependencies,
  scope: EnvironmentScope,
  agentId: AgentId,
): Promise<Result<BoundAgent>> {
  const found = await dependencies.repository.findBoundAgent(scope, agentId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(agentNotBound(agentId, scope.environmentId));
  return ok(found.value);
}
