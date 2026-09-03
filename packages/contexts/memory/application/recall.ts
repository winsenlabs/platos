// Use cases: recall — the runtime read a turn actually makes.
//
// This is the hot path, and it is separate from `read-memories.ts` for reasons
// that are about behaviour rather than about tidiness:
//
//   IT TAKES THE RUNTIME GRANT, NOT AN OPERATOR ONE. A turn holds a
//   `MemoryRuntimeAuthorization` naming ONE subject
//   (`domain/authorization.ts`), so a mis-wired turn cannot recall a different
//   person's history — the subject is inside the value that is checked, not a
//   parameter beside it.
//
//   IT EXCLUDES THREE CLASSES OF ROW THAT AN OPERATOR LISTING INCLUDES.
//   Archived rows were put away; quarantined rows were withdrawn by feedback;
//   retrieval-augmented rows are ingested documents rather than things the
//   subject said. All three are visible to an operator and none belongs in a
//   turn.
//
//   IT RANKS, WHICH A LISTING DOES NOT. The store returns an overfetched
//   candidate window ordered by distance; `rankRecall` reorders it by the
//   blended score and cuts it to the page. Doing that inside the store would
//   make confidence unable to promote anything, because the rows it would have
//   promoted were never fetched.
//
// THE ACCESS STAMP IS BEST-EFFORT AND SAYS SO. `lastAccessedAt` orders a
// listing; it is not truth about the memory. A failure to write it is reported
// on the result rather than failing the recall, because a turn that could not
// update an ordering column has still recalled correctly.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitRecall,
  clusterPeers,
  rankRecall,
  requireVisibilityFilter,
  type AgentId,
  type Memory,
  type MemoryKind,
  type MemoryVisibility,
  type RankedRecall,
} from "../domain/index.js";
import { resolveReadScope, runtimeEnvironment, verifyRuntime } from "./authorization.js";
import type { MemoryDependencies } from "./dependencies.js";
import { embedQuery } from "./embedding.js";
import type { MemoryFilter } from "./ports/index.js";

export interface RecallQuery {
  /** A `MemoryRuntimeAuthorization`. The subject travels inside it. */
  readonly authorization: unknown;
  readonly query: string;
  readonly kind: MemoryKind | null;
  /** Named agents. Empty means "the acting agent", per `domain/scope.ts`. */
  readonly requestedAgentIds: readonly AgentId[];
  readonly limit: number | null;
  readonly minScore: number | null;
  readonly visibilityIn: readonly MemoryVisibility[] | undefined;
}

/** One recalled memory and both of its scores. */
export interface RecalledMemory {
  readonly memory: Memory;
  /** Raw cosine similarity. What `minScore` was applied to. */
  readonly score: number;
  /** 80% similarity, 20% confidence. What the page was ordered by. */
  readonly rankingScore: number;
}

export interface RecallReport {
  readonly memories: readonly RecalledMemory[];
  /** How many candidates the store returned before ranking and cutting. */
  readonly candidatesConsidered: number;
  /** False when the access stamp could not be written. Never fails the recall. */
  readonly accessStamped: boolean;
}

export async function recall(
  dependencies: MemoryDependencies,
  query: RecallQuery,
): Promise<Result<RecallReport>> {
  const granted = verifyRuntime(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);

  const bounds = admitRecall(query.query, query.limit ?? undefined, query.minScore ?? undefined);
  if (!bounds.ok) return err(bounds.error);

  const visibilities = requireVisibilityFilter(query.visibilityIn);
  if (!visibilities.ok) return err(visibilities.error);

  const environment = runtimeEnvironment(granted.value);
  const scope = await resolveReadScope(
    dependencies,
    {
      environment,
      endUserId: granted.value.endUserId,
      actingAgentId: granted.value.actingAgentId,
    },
    query.requestedAgentIds,
  );
  if (!scope.ok) return err(scope.error);

  const embedding = await embedQuery(dependencies, query.query.trim());
  if (!embedding.ok) return err(embedding.error);

  const filter: MemoryFilter = {
    subject: scope.value.subject,
    agentIds: scope.value.agentIds,
    kind: query.kind,
    source: null,
    visibilities: visibilities.value.visibilities,
    archiveState: "active",
    excludeRag: true,
    excludeQuarantined: true,
  };
  const matches = await dependencies.repository.searchMemories({
    filter,
    embedding: embedding.value,
    candidateLimit: bounds.value.candidateLimit,
  });
  if (!matches.ok) return err(matches.error);

  const byId = new Map(matches.value.map((match) => [match.memory.memoryId, match.memory] as const));
  const ranked = rankRecall(
    matches.value.map((match) => ({
      memoryId: match.memory.memoryId,
      score: match.score,
      confidence: match.memory.confidence.confidence,
    })),
    bounds.value.limit,
    bounds.value.minScore,
  );

  const memories = collect(ranked, byId);
  const stamped = await stampAccess(dependencies, environment, memories);
  return ok({
    memories,
    candidatesConsidered: matches.value.length,
    accessStamped: stamped,
  });
}

/**
 * Recall across the acting agent's whole cluster.
 *
 * The peer set is derived from the acting agent's OWN binding, never from ids a
 * caller supplied: an agent naming a cluster it is not in would otherwise read
 * that cluster's memories. When the acting agent has no cluster this is exactly
 * a single-agent recall, which is the source's behaviour and is what keeps a
 * caller from having to ask "am I in a cluster?" before choosing a method.
 */
export async function recallAcrossCluster(
  dependencies: MemoryDependencies,
  query: Omit<RecallQuery, "requestedAgentIds">,
): Promise<Result<RecallReport>> {
  const granted = verifyRuntime(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const environment = runtimeEnvironment(granted.value);

  const bindings = await dependencies.repository.listAgentBindings(environment);
  if (!bindings.ok) return err(bindings.error);

  const acting = bindings.value.find((binding) => binding.agentId === granted.value.actingAgentId);
  const peers = acting === undefined ? [] : clusterPeers(bindings.value, acting);
  return recall(dependencies, {
    ...query,
    requestedAgentIds: peers.map((binding) => binding.agentId),
  });
}

function collect(
  ranked: readonly RankedRecall[],
  byId: ReadonlyMap<string, Memory>,
): readonly RecalledMemory[] {
  const collected: RecalledMemory[] = [];
  for (const entry of ranked) {
    const memory = byId.get(entry.memoryId);
    if (memory === undefined) continue;
    collected.push({ memory, score: entry.score, rankingScore: entry.rankingScore });
  }
  return Object.freeze(collected);
}

async function stampAccess(
  dependencies: MemoryDependencies,
  environment: Parameters<MemoryDependencies["repository"]["touchAccessed"]>[0],
  memories: readonly RecalledMemory[],
): Promise<boolean> {
  if (memories.length === 0) return true;
  const stamped = await dependencies.repository.touchAccessed(
    environment,
    memories.map((recalled) => recalled.memory.memoryId),
    dependencies.clock.now(),
  );
  return stamped.ok;
}
