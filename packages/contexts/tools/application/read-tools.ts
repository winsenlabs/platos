// Use cases: read the dispatch matrix, and search it.
//
// `findTools` IS THE ONE A MODEL CALLS, and it is why this context holds a
// ranking function at all. A scope can expose hundreds of tools and a turn's
// prompt has room for fifteen; the alternative to ranking is truncation, and
// truncating alphabetically means a model in an environment with a large tool
// set can never reach anything after the letter C.
//
// THE INDEX IS BUILT PER QUERY, FROM THE CALLABLE SET.
//
// The source keeps a long-lived `BM25Index` beside a `scopedToolCache`, and
// most of `ToolRegistryService` is the machinery keeping the two in step: a
// revision counter, an eviction that can be prepared and applied, a Redis
// subscription that refreshes policies, and three separate paths that discard
// and rebuild the index. Every one of those exists because the index outlives
// the data it indexes.
//
// Here it does not. `buildIndex` takes the callable exposures and returns a
// frozen value, so the index cannot disagree with the matrix, cannot be stale,
// cannot be evicted wrongly and needs no revision counter. What that costs is
// tokenising the callable set on each search; what it buys is that the four
// invalidation paths, the concurrency guard around them and the class of bug
// they exist to manage all cease to be reachable. An adapter that decides the
// re-tokenisation is too expensive can memoise against the exposure set it was
// built from — a cache with a key, rather than a cache with a protocol.

import { err, ok, type EntityId, type Result } from "@platos/kernel";

import {
  asToolsIdentifier,
  buildIndex,
  searchDocument,
  searchIndex,
  selectExposures,
  type AgentId,
  type ExposureId,
  type ExternalEntityId,
  type ToolExposure,
} from "../domain/index.js";
import { requireAccess, verifyOperator } from "./authorization.js";
import type { ToolsDependencies } from "./dependencies.js";
import type { ExposurePage } from "./ports/index.js";

export interface ReadToolsQuery {
  readonly authorization: unknown;
  /** Empty means no entity filter. See `domain/exposure.ts` on why. */
  readonly externalEntityIds?: readonly ExternalEntityId[];
  readonly agentId?: AgentId | null;
  /** Default true: only enabled AND dispatchable exposures. */
  readonly callableOnly?: boolean;
}

export interface PageToolsQuery extends ReadToolsQuery {
  readonly limit: number;
  readonly offset: number;
  readonly entityId?: EntityId | null;
  readonly search?: string | null;
}

export interface FindToolsQuery extends ReadToolsQuery {
  readonly query: string;
  readonly limit?: number;
}

export async function listTools(
  dependencies: ToolsDependencies,
  query: ReadToolsQuery,
): Promise<Result<readonly ToolExposure[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.repository.listExposures(granted.value.scope);
  if (!listed.ok) return err(listed.error);
  return ok(selectExposures(listed.value, query));
}

export async function pageTools(
  dependencies: ToolsDependencies,
  query: PageToolsQuery,
): Promise<Result<ExposurePage>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const search = query.search?.trim();
  return dependencies.repository.pageExposures(granted.value.scope, {
    limit: Math.min(Math.max(Math.trunc(query.limit), 1), dependencies.policy.acl.maximumPageSize),
    offset: Math.max(Math.trunc(query.offset), 0),
    entityId: query.entityId ?? null,
    // An empty search is NOT a search. Passing `""` down would make every
    // adapter decide privately whether that means "everything" or "nothing".
    search: search === undefined || search === "" ? null : search,
  });
}

/**
 * Rank the callable tools against a natural-language query.
 *
 * THE FILTER RUNS BEFORE THE INDEX IS BUILT, NOT AFTER THE SEARCH. Indexing
 * everything and filtering the hits would let a tool this agent may not see
 * influence the document frequencies — and therefore the RANKING — of the tools
 * it may. That is a small, real information leak across an agent boundary, and
 * it is also just wrong: the scores would describe a corpus the caller cannot
 * reach.
 *
 * ONE INDEX ENTRY PER `Tool` ROW, NOT PER EXPOSURE. Two entities exposing the
 * same tool version share one document — `buildIndex` takes the first and drops
 * the rest — so a tool does not outrank its rivals by being popular. The hit is
 * mapped back to the FIRST exposure in matrix order, and routing is what
 * chooses between the others.
 */
export async function findTools(
  dependencies: ToolsDependencies,
  query: FindToolsQuery,
): Promise<Result<readonly ToolExposure[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const listed = await dependencies.repository.listExposures(granted.value.scope);
  if (!listed.ok) return err(listed.error);

  const discovery = dependencies.policy.discovery;
  const callable = selectExposures(listed.value, { ...query, callableOnly: true });
  if (callable.length === 0) return ok([]);

  const byToolId = new Map<string, ToolExposure>();
  for (const exposure of callable) {
    if (!byToolId.has(exposure.toolId)) byToolId.set(exposure.toolId, exposure);
  }

  const index = buildIndex(
    [...byToolId.values()].map((exposure) => ({
      id: exposure.toolId,
      text: searchDocument({
        name: exposure.toolName,
        description: exposure.description,
        paramSchema: exposure.paramSchema,
      }),
    })),
    discovery,
  );

  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? discovery.defaultSearchLimit), 1),
    discovery.maximumSearchLimit,
  );
  const hits = searchIndex(index, query.query, limit);
  return ok(hits.map((hit) => byToolId.get(hit.id)).filter((entry): entry is ToolExposure => entry !== undefined));
}

/**
 * Switch one exposure on or off.
 *
 * Addressed by `ExposureId`, not by name: a name can belong to several
 * exposures in one environment, and "switch off the tool called search" would
 * silently pick one of them.
 */
export interface SetToolEnabledCommand {
  readonly authorization: unknown;
  readonly exposureId: string;
  readonly enabled: boolean;
}

/** A transport hands this context a bare string; the brand starts here. */
function asExposureId(value: string): ExposureId {
  return asToolsIdentifier<ExposureId>(value);
}

export async function setToolEnabled(
  dependencies: ToolsDependencies,
  command: SetToolEnabledCommand,
): Promise<Result<ToolExposure>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const permitted = requireAccess(granted.value, "secret:mutate");
  if (!permitted.ok) return err(permitted.error);
  return dependencies.repository.setExposureEnabled(
    granted.value.scope,
    asExposureId(command.exposureId),
    command.enabled,
  );
}
