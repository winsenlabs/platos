// Use cases: a version's skill loadout.
//
// EVERY LOADOUT CHANGE MINTS A VERSION, AND THAT IS THE POINT. `AgentSkill`
// hangs off an immutable `AgentVersion`, so there is no such thing as "the same
// version with one more skill". The running system edits the loadout of the live
// version in place, which means an agent's behaviour changes without its version
// number moving, without a history entry, and without a rollback target — an
// operator who enabled a skill and broke a workflow has nothing to roll back to.
//
// So a change here computes the WHOLE next loadout with `applyLoadoutChange` and
// hands it to `writeVersion` alongside the unchanged configuration. The
// configuration is byte-identical, so the only thing the diff shows is the
// skill — which is exactly what the operator did.
//
// THAT IS A DELIBERATE DIVERGENCE FROM THE SOURCE AND IT IS THE MOST CONSEQUENTIAL
// ONE IN THIS PACKAGE. It costs a version row per skill toggle. It buys the
// invariant every other rule here relies on: the loadout a version carries is
// the loadout it was written with, so `carryForward` is the only way a loadout
// ever moves, and a live version's skills cannot change under a thread that is
// mid-conversation with it.
//
// READS DO NOT RESOLVE THE SKILL. A loadout entry names an `EnvironmentSkill` by
// id and `skills` owns that row; describing it needs that context's contract,
// which was still a generated placeholder when this context was made real. So
// the read returns ids and assignment state, and says so — see
// `dependencies.ts`, which now holds a real `skills` behind a one-method port
// and still does not call it. Widening this read is a change to what every
// caller receives, so it waits for a decision rather than arriving with a merge.

import { err, ok, runResult, type Result } from "@platos/kernel";

import {
  admitNote,
  applyLoadoutChange,
  assignmentOf,
  type ActorId,
  type AgentId,
  type EnvironmentSkillId,
  type JsonObject,
  type LoadoutChange,
  type SkillAssignment,
} from "../domain/index.js";
import { asAgentsIdentifier } from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { BoundAgent } from "./ports/index.js";
import { requireBound } from "./read-agents.js";
import { releaseHolds, writeVersion } from "./version-writer.js";

export interface ReadLoadoutQuery {
  readonly authorization: unknown;
  readonly agentId: AgentId;
}

export interface ChangeLoadoutCommand extends ReadLoadoutQuery {
  readonly environmentSkillId: EnvironmentSkillId;
  readonly changedBy: string;
  readonly config?: JsonObject;
}

/** What a loadout change did, including the version it minted. */
export interface LoadoutChanged {
  readonly bound: BoundAgent;
  readonly previousVersionId: string;
  readonly loadout: readonly SkillAssignment[];
}

/** The note a loadout change writes, so the history says which skill moved. */
export function loadoutNote(change: LoadoutChange): string {
  const verb = change.kind === "enable" ? "Enable" : change.kind === "disable" ? "Disable" : "Remove";
  return `${verb} Agent Skill ${change.environmentSkillId}`;
}

export async function readLoadout(
  dependencies: AgentsDependencies,
  query: ReadLoadoutQuery,
): Promise<Result<readonly SkillAssignment[]>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const bound = await requireBound(dependencies, granted.value.scope, query.agentId);
  if (!bound.ok) return err(bound.error);
  const held = await dependencies.repository.listLoadout(bound.value.activeVersion.agentVersionId);
  if (!held.ok) return err(held.error);
  return ok(held.value.map(assignmentOf));
}

export async function enableSkill(
  dependencies: AgentsDependencies,
  command: ChangeLoadoutCommand,
): Promise<Result<LoadoutChanged>> {
  return changeLoadout(dependencies, command, {
    kind: "enable",
    environmentSkillId: command.environmentSkillId,
    ...(command.config === undefined ? {} : { config: command.config }),
  });
}

export async function disableSkill(
  dependencies: AgentsDependencies,
  command: ChangeLoadoutCommand,
): Promise<Result<LoadoutChanged>> {
  return changeLoadout(dependencies, command, {
    kind: "disable",
    environmentSkillId: command.environmentSkillId,
  });
}

export async function removeSkill(
  dependencies: AgentsDependencies,
  command: ChangeLoadoutCommand,
): Promise<Result<LoadoutChanged>> {
  return changeLoadout(dependencies, command, {
    kind: "remove",
    environmentSkillId: command.environmentSkillId,
  });
}

async function changeLoadout(
  dependencies: AgentsDependencies,
  command: ChangeLoadoutCommand,
  change: LoadoutChange,
): Promise<Result<LoadoutChanged>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);
  const held = await dependencies.repository.listLoadout(bound.value.activeVersion.agentVersionId);
  if (!held.ok) return err(held.error);

  const next = applyLoadoutChange(
    held.value.map(assignmentOf),
    change,
    bound.value.activeVersion.agentVersionId,
  );
  if (!next.ok) return err(next.error);
  const note = admitNote(loadoutNote(change));
  if (!note.ok) return err(note.error);

  const written = await runResult(dependencies.unitOfWork, (transaction) =>
    writeVersion(
      dependencies,
      {
        bound: bound.value,
        // The configuration is carried across UNCHANGED. A loadout change is
        // not a configuration change, and re-deriving the snapshot here would
        // let a policy default that moved since the last save ride along
        // silently on a skill toggle.
        snapshot: bound.value.activeVersion.snapshot,
        createdBy: asAgentsIdentifier<ActorId>(command.changedBy),
        note: note.value,
        loadout: next.value,
      },
      transaction,
    ),
  );
  if (!written.ok) return err(written.error);
  await releaseHolds(dependencies, scope, command.agentId);
  return ok({
    bound: written.value.bound,
    previousVersionId: written.value.previousVersionId,
    loadout: written.value.loadout,
  });
}
