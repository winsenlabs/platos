// Use case: update an agent.
//
// A save does up to three independent things, and which ones it does is decided
// separately for each:
//
//   the AGENT ROW moves when the name, description or active flag changed;
//   the BINDING moves when the cluster changed;
//   a NEW VERSION is minted only when the CONFIGURATION changed.
//
// Deciding them together — "something changed, so write everything" — is what
// fills a version history with entries that say nothing. Deciding them
// separately is why renaming an agent does not mint a version, and why editing a
// prompt does.
//
// THE CHANGE TEST IS A COMPARISON OF TWO CANONICAL SNAPSHOTS. Both sides go
// through `buildSnapshot`, so a request that omitted a field and a stored row
// that has its default compare equal. `snapshotsDiffer` then compares them
// structurally rather than by serialization order; `domain/snapshot.ts` records
// why that is a deliberate divergence from the source's `JSON.stringify`
// comparison and what it costs.
//
// PARTIAL PATCHES MERGE, THEY DO NOT REPLACE. `toolsBlockConfig` and
// `subAgentConfig` are shallow-merged over the stored value, because a surface
// that owns one tab of a settings page sends one tab's worth of keys. A
// replacing write there is the bug the merge exists for, and it is the same bug
// as the tool-mode coercion in `domain/tools-config.ts` one layer down.

import { err, ok, type EnvironmentScope, type Result } from "@platos/kernel";

import {
  admitAgentPatch,
  admitNote,
  admitRoutes,
  applyAgentPatch,
  assignCluster,
  buildSnapshot,
  clusterNotFound,
  mergeJsonConfig,
  modelFromRoutes,
  normalizeToolsBlockConfig,
  readPromptBlocks,
  serializePromptBlocks,
  snapshotsDiffer,
  touchesAgentRow,
  type ActorId,
  type AgentCluster,
  type AgentClusterId,
  type AgentId,
  type AgentVersionSnapshot,
  type RouteIntake,
  type SubAgentConfig,
} from "../domain/index.js";
import { asAgentsIdentifier } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import { snapshotSourceFrom, type AgentConfigurationIntake } from "./configuration.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { BoundAgent } from "./ports/index.js";
import { requireBound } from "./read-agents.js";
import { releaseHolds, writeVersion } from "./version-writer.js";

export interface UpdateAgentCommand extends AgentConfigurationIntake {
  readonly authorization: unknown;
  readonly agentId: AgentId;
  readonly updatedBy: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly isActive?: boolean;
  /** Absent leaves membership alone; `null` removes the agent from its cluster. */
  readonly clusterId?: string | null;
  readonly modelRoutes?: readonly RouteIntake[] | null;
  readonly versionNote?: string | null;
}

/** What a save actually did. Three independent facts, reported separately. */
export interface AgentUpdated {
  readonly bound: BoundAgent;
  readonly renamed: boolean;
  readonly reclustered: boolean;
  /** Null when the configuration did not change and no version was minted. */
  readonly previousVersionId: string | null;
}

export async function updateAgent(
  dependencies: AgentsDependencies,
  command: UpdateAgentCommand,
): Promise<Result<AgentUpdated>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const existing = await requireBound(dependencies, scope, command.agentId);
  if (!existing.ok) return err(existing.error);

  const patch = admitAgentPatch({
    ...(command.name === undefined ? {} : { name: command.name }),
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.isActive === undefined ? {} : { isActive: command.isActive }),
  });
  if (!patch.ok) return err(patch.error);
  const note = admitNote(command.versionNote);
  if (!note.ok) return err(note.error);

  const next = nextSnapshot(dependencies, existing.value, command);
  if (!next.ok) return err(next.error);

  const cluster = await resolveCluster(dependencies, scope, command.clusterId);
  if (!cluster.ok) return err(cluster.error);

  const now = dependencies.clock.now();
  const changed = snapshotsDiffer(existing.value.activeVersion.snapshot, next.value);
  const renames = touchesAgentRow(patch.value);

  const written = await dependencies.unitOfWork.run(async (transaction) => {
    let bound = existing.value;
    if (renames) {
      const agent = await dependencies.repository.updateAgent(
        applyAgentPatch(bound.agent, patch.value, now),
        transaction,
      );
      if (!agent.ok) return err(agent.error);
      bound = { ...bound, agent: agent.value };
    }
    if (cluster.value !== undefined) {
      const assigned = cluster.value;
      const binding = await dependencies.repository.updateBinding(
        assignCluster(bound.binding, assigned === null ? null : assigned.clusterId, now),
        transaction,
      );
      if (!binding.ok) return err(binding.error);
      bound = { ...bound, binding: binding.value, cluster: assigned };
    }
    if (!changed) {
      return ok<AgentUpdated>({
        bound,
        renamed: renames,
        reclustered: cluster.value !== undefined,
        previousVersionId: null,
      });
    }
    const minted = await writeVersion(
      dependencies,
      {
        bound,
        snapshot: next.value,
        createdBy: asAgentsIdentifier<ActorId>(command.updatedBy),
        note: note.value,
      },
      transaction,
    );
    if (!minted.ok) return err(minted.error);
    return ok<AgentUpdated>({
      bound: minted.value.bound,
      renamed: renames,
      reclustered: cluster.value !== undefined,
      previousVersionId: minted.value.previousVersionId,
    });
  });

  if (written.ok && changed) await releaseHolds(dependencies, scope, command.agentId);
  return written;
}

/**
 * The snapshot a save lands on.
 *
 * Exported because rollback, the tool flip and the feature-flag path all need
 * "the current configuration with these fields changed" and each computing it
 * privately is how the running system ended up with three slightly different
 * merges.
 */
export function nextSnapshot(
  dependencies: AgentsDependencies,
  bound: BoundAgent,
  command: UpdateAgentCommand,
): Result<AgentVersionSnapshot> {
  const current = bound.activeVersion.snapshot;

  const routes = command.modelRoutes === undefined
    ? { ok: true as const, value: current.modelRoutes }
    : command.modelRoutes === null
      ? { ok: true as const, value: null }
      : admitRoutes(command.modelRoutes);
  if (!routes.ok) return err(routes.error);

  let model = command.model ?? current.model;
  // A save that supplied routes but no model syncs the model to the default
  // route, exactly as the create path does. A save that supplied both keeps the
  // model it was given.
  if (command.model === undefined && Array.isArray(command.modelRoutes) && routes.value !== null) {
    model = modelFromRoutes(routes.value) ?? model;
  }

  let toolsBlockConfig: unknown = current.toolsBlockConfig;
  if (command.toolsBlockConfig !== undefined) {
    toolsBlockConfig = mergeJsonConfig(
      current.toolsBlockConfig,
      normalizeToolsBlockConfig(command.toolsBlockConfig),
    );
  }
  if (command.toolMode !== undefined) {
    toolsBlockConfig = mergeJsonConfig(toolsBlockConfig, { mode: command.toolMode });
  }

  const subAgentConfig: SubAgentConfig | null =
    command.subAgentConfig === undefined
      ? current.subAgentConfig
      : (mergeJsonConfig(current.subAgentConfig, command.subAgentConfig) as SubAgentConfig | null);

  return ok(
    buildSnapshot(
      snapshotSourceFrom(
        { ...current, ...command, subAgentConfig },
        {
          model,
          modelRoutes: routes.value,
          systemPrompt: resolveSystemPrompt(current.systemPrompt, command),
          toolsBlockConfig,
        },
      ),
      dependencies.policy.defaults,
    ),
  );
}

/**
 * The system prompt a save lands on.
 *
 * An explicit prompt wins, including an explicit empty one — clearing the prompt
 * has to be possible. Blocks re-derive it only when the request carried blocks
 * and no prompt, which is what keeps the block editor and the raw editor from
 * overwriting each other on alternate saves.
 */
function resolveSystemPrompt(current: string | null, command: UpdateAgentCommand): string | null {
  if (command.systemPrompt !== undefined) return command.systemPrompt;
  const blocks = readPromptBlocks(command.promptBlocks);
  if (blocks === null || blocks.length === 0) return current;
  const serialized = serializePromptBlocks(blocks);
  return serialized === "" ? current : serialized;
}

/**
 * Resolve a requested cluster.
 *
 * Three answers, and the middle one is why this returns `undefined` rather than
 * `null` for "unchanged": absent leaves membership alone, `null` removes it, and
 * an id must resolve INSIDE the granted environment or the save is refused. A
 * cluster id from another environment is a cross-tenant write with a plausible
 * cover story, so it fails here rather than at the foreign key.
 */
async function resolveCluster(
  dependencies: AgentsDependencies,
  scope: EnvironmentScope,
  clusterId: string | null | undefined,
): Promise<Result<AgentCluster | null | undefined>> {
  if (clusterId === undefined) return ok(undefined);
  if (clusterId === null || clusterId === "") return ok(null);
  const id = asAgentsIdentifier<AgentClusterId>(clusterId);
  const found = await dependencies.repository.findCluster(scope, id);
  if (!found.ok) return err(found.error);
  if (found.value === null) return err(clusterNotFound(id));
  return ok(found.value);
}
