// Use cases: read and restore version history.
//
// ROLLBACK WRITES FORWARD. It does not move the binding onto the old version; it
// reads that version's snapshot, writes it as a NEW version, and moves the
// binding onto that. So the history is append-only — an operator can see that a
// rollback happened, and can roll back the rollback — and the version an agent
// is serving is always the newest one, which is the invariant the canary split
// and the thread holds both rely on.
//
// AND IT CARRIES THE LOADOUT OF THE VERSION BEING RESTORED, NOT OF THE ONE BEING
// REPLACED. This is the one place `writeVersion`'s default is wrong: restoring a
// configuration from before a skill was added must restore the loadout from
// before it was added too, or the operator gets an old prompt with a new toolset
// and nothing says so. The loadout is therefore read from the TARGET and passed
// explicitly.
//
// PRUNING RETURNS A PLAN AND DELETES NOTHING. See `domain/version.ts` for why
// that half-step is the honest one.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitNote,
  carryForward,
  planPrune,
  rollbackNote,
  versionNotFound,
  windowFor,
  type ActorId,
  type AgentId,
  type AgentVersion,
  type AgentVersionId,
  type PrunePlan,
  type PruneRequest,
} from "../domain/index.js";
import { asAgentsIdentifier } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { AgentVersionPage, BoundAgent } from "./ports/index.js";
import { requireBound } from "./read-agents.js";
import { releaseHolds, writeVersion } from "./version-writer.js";

export interface VersionHistoryQuery {
  readonly authorization: unknown;
  readonly agentId: AgentId;
}

export interface PageVersionsQuery extends VersionHistoryQuery {
  readonly cursor?: string | null;
  readonly take?: number;
  readonly offset?: number;
}

export interface DescribeVersionQuery extends VersionHistoryQuery {
  readonly versionId: AgentVersionId;
}

export interface RollbackCommand extends DescribeVersionQuery {
  readonly restoredBy: string;
}

export interface PruneVersionsQuery extends VersionHistoryQuery, PruneRequest {}

/** A version with the two facts only its binding can supply. */
export interface VersionInHistory {
  readonly version: AgentVersion;
  readonly isCurrent: boolean;
  readonly isCanary: boolean;
}

export interface VersionHistoryPage {
  readonly items: readonly VersionInHistory[];
  readonly total: number;
  readonly nextCursor: string | null;
  readonly offset: number;
  readonly limit: number;
}

function inHistory(version: AgentVersion, bound: BoundAgent): VersionInHistory {
  return {
    version,
    isCurrent: bound.binding.activeVersionId === version.agentVersionId,
    isCanary: bound.binding.canaryVersionId === version.agentVersionId,
  };
}

export async function pageVersions(
  dependencies: AgentsDependencies,
  query: PageVersionsQuery,
): Promise<Result<VersionHistoryPage>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);

  const window = windowFor(query, dependencies.policy.versions);
  const page: Result<AgentVersionPage> = await dependencies.repository.pageVersions(query.agentId, window);
  if (!page.ok) return err(page.error);
  return ok({
    items: page.value.items.map((version) => inHistory(version, bound.value)),
    total: page.value.total,
    nextCursor: page.value.nextCursor,
    offset: window.offset,
    limit: window.take,
  });
}

export async function describeVersion(
  dependencies: AgentsDependencies,
  query: DescribeVersionQuery,
): Promise<Result<VersionInHistory>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);
  const found = await dependencies.repository.findVersion(query.agentId, query.versionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(versionNotFound(query.agentId, query.versionId));
  return ok(inHistory(found.value, bound.value));
}

export async function rollbackToVersion(
  dependencies: AgentsDependencies,
  command: RollbackCommand,
): Promise<Result<BoundAgent>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);
  const found = await dependencies.repository.findVersion(command.agentId, command.versionId);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(versionNotFound(command.agentId, command.versionId));
  const target = found.value;

  const note = admitNote(rollbackNote(target.versionNumber));
  if (!note.ok) return err(note.error);
  const restored = await dependencies.repository.listLoadout(target.agentVersionId);
  if (!restored.ok) return err(restored.error);

  const written = await runResult(dependencies.unitOfWork, (transaction) =>
    writeVersion(
      dependencies,
      {
        bound: bound.value,
        snapshot: target.snapshot,
        createdBy: asAgentsIdentifier<ActorId>(command.restoredBy),
        note: note.value,
        loadout: carryForward(restored.value),
        toolDefaultPolicy: target.toolDefaultPolicy,
      },
      transaction,
    ),
  );
  if (!written.ok) return err(written.error);
  await releaseHolds(dependencies, scope, command.agentId);
  return ok(written.value.bound);
}

export async function planVersionPrune(
  dependencies: AgentsDependencies,
  query: PruneVersionsQuery,
): Promise<Result<PrunePlan>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);
  const versions = await dependencies.repository.listVersions(query.agentId);
  if (!versions.ok) return err(versions.error);
  return ok(
    planPrune(
      versions.value,
      {
        activeVersionId: bound.value.binding.activeVersionId,
        canaryVersionId: bound.value.binding.canaryVersionId,
      },
      query,
      dependencies.policy.versions,
      dependencies.clock.now(),
    ),
  );
}
