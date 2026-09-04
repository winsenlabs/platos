// Use cases: read memories.
//
// Four shapes, and they exist separately because they have different ceilings
// and different orderings, not because they were convenient:
//
//   describeMemory   one row, by id, inside the caller's agent scope.
//   listMemories     an unpaged read for a caller that will consume all of it.
//   pageMemories     the operator surface. Offset paging, capped at 100 rows and
//                    100,000 rows deep, because past that an offset scan costs
//                    more than the page is worth.
//   exportMemories   KEYSET paging by id. An export walks a whole subject, and
//                    an offset scan over one would re-read the whole prefix per
//                    page; a keyset resumes exactly where it stopped.
//
// THE VISIBILITY DEFAULT IS THE ONE THAT NARROWS. A caller that names no
// visibilities gets agent-visible rows only (`RUNTIME_RECALL_FILTER`). A
// transport that forgot to forward the field therefore under-reports rather than
// disclosing hidden and private rows, which is the direction a bug should fail
// in.
//
// ARCHIVE STATE IS EXPLICIT-OR-DERIVED, NEVER GUESSED. `archiveState` wins; the
// legacy `includeArchived` boolean is consulted only when it is absent; the
// default is `active`. That is the source's precedence and it matters because
// the two fields disagree in exactly one case — `includeArchived: true` with
// `archiveState: "archived"` — where the explicit field is the one a caller
// chose deliberately.
//
// NOTHING HERE EXCLUDES A RETRIEVAL-AUGMENTED OR A QUARANTINED ROW. An operator
// administering a subject's memories has to be able to see the rows that were
// withdrawn, or they cannot find out why recall stopped returning something.
// Only the paths that feed a TURN exclude them, and those are in `recall.ts`.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitPage,
  memoryNotFound,
  requireVisibilityFilter,
  type AgentId,
  type EndUserId,
  type Memory,
  type MemoryArchiveState,
  type MemoryId,
  type MemoryKind,
  type MemorySource,
  type MemoryVisibility,
} from "../domain/index.js";
import { authorizeRead } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import type { MemoryExportPage, MemoryFilter, MemoryPage } from "./ports/index.js";

/** Everything a read of this context takes, before any of it is admitted. */
export interface ReadMemoriesQuery {
  readonly authorization: unknown;
  /** Required under an operator grant; a runtime grant names its own subject. */
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly requestedAgentIds: readonly AgentId[];
  readonly kind: MemoryKind | null;
  readonly source: MemorySource | null;
  readonly visibilityIn: readonly MemoryVisibility[] | undefined;
  readonly archiveState: MemoryArchiveState | null;
  /** The legacy boolean. Only consulted when `archiveState` is absent. */
  readonly includeArchived: boolean | null;
}

export interface PageMemoriesQuery extends ReadMemoriesQuery {
  readonly limit: number | null;
  readonly offset: number | null;
}

export interface DescribeMemoryQuery {
  readonly authorization: unknown;
  readonly endUserId: EndUserId | null;
  readonly actingAgentId: AgentId | null;
  readonly memoryId: MemoryId;
}

export interface ExportMemoriesQuery extends ReadMemoriesQuery {
  readonly afterId: MemoryId | null;
  readonly limit: number | null;
}

export async function describeMemory(
  dependencies: MemoryDependencies,
  query: DescribeMemoryQuery,
): Promise<Result<Memory>> {
  const scope = await authorizeRead(dependencies, { ...query, requestedAgentIds: [] });
  if (!scope.ok) return err(scope.error);
  const found = await dependencies.repository.findMemory(
    scope.value.subject,
    scope.value.agentIds,
    query.memoryId,
  );
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(memoryNotFound(query.memoryId));
  return ok(found.value);
}

export async function listMemories(
  dependencies: MemoryDependencies,
  query: PageMemoriesQuery,
): Promise<Result<readonly Memory[]>> {
  const prepared = await prepare(dependencies, query);
  if (!prepared.ok) return err(prepared.error);
  const bounds = pageBounds(dependencies, query);
  return dependencies.repository.listMemories(prepared.value, bounds.limit, bounds.offset);
}

export async function pageMemories(
  dependencies: MemoryDependencies,
  query: PageMemoriesQuery,
): Promise<Result<MemoryPage>> {
  const prepared = await prepare(dependencies, query);
  if (!prepared.ok) return err(prepared.error);
  const bounds = pageBounds(dependencies, query);
  return dependencies.repository.pageMemories(prepared.value, bounds.limit, bounds.offset);
}

export async function exportMemories(
  dependencies: MemoryDependencies,
  query: ExportMemoriesQuery,
): Promise<Result<MemoryExportPage>> {
  const prepared = await prepare(dependencies, query);
  if (!prepared.ok) return err(prepared.error);
  const bounds = admitPage(
    query.limit ?? dependencies.policy.page.exportMaxLimit,
    0,
    dependencies.policy.page.exportMaxLimit,
    dependencies.policy.page.maxOffset,
  );
  return dependencies.repository.listExportPage(prepared.value, query.afterId, bounds.limit);
}

/**
 * Resolve the archive state a query means.
 *
 * Exported because more than one surface applies the same precedence, and two
 * copies of a three-way default is how two surfaces eventually disagree.
 */
export function resolveArchiveState(
  archiveState: MemoryArchiveState | null,
  includeArchived: boolean | null,
): MemoryArchiveState {
  if (archiveState !== null) return archiveState;
  return includeArchived === true ? "all" : "active";
}

function pageBounds(
  dependencies: MemoryDependencies,
  query: PageMemoriesQuery,
): { readonly limit: number; readonly offset: number } {
  return admitPage(
    query.limit ?? dependencies.policy.page.defaultLimit,
    query.offset ?? 0,
    dependencies.policy.page.maxLimit,
    dependencies.policy.page.maxOffset,
  );
}

async function prepare(
  dependencies: MemoryDependencies,
  query: ReadMemoriesQuery,
): Promise<Result<MemoryFilter>> {
  const visibilities = requireVisibilityFilter(query.visibilityIn);
  if (!visibilities.ok) return err(visibilities.error);
  const scope = await authorizeRead(dependencies, query);
  if (!scope.ok) return err(scope.error);
  return ok({
    subject: scope.value.subject,
    agentIds: scope.value.agentIds,
    kind: query.kind,
    source: query.source,
    visibilities: visibilities.value.visibilities,
    archiveState: resolveArchiveState(query.archiveState, query.includeArchived),
    excludeRag: false,
    excludeQuarantined: false,
  });
}
