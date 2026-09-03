// The write path every save in this context goes through.
//
// Four things happen together or not at all, and the reason they are one
// function rather than four lines repeated in five use cases is that every one
// of those five got it wrong at least once in the running system:
//
//   1. Mint the next version number from what the store actually holds.
//   2. Insert the new immutable version.
//   3. CARRY THE LOADOUT FORWARD. `AgentSkill` belongs to a version, so a new
//      version starts empty; a save that skips this strips every skill from a
//      live agent and shows the operator a diff of the one field they edited.
//   4. Move the binding onto the new version, and release the thread holds so
//      new conversations pick it up.
//
// AND ONE THING DOES NOT HAPPEN HERE, DELIBERATELY. The running system also
// copies `AgentToolPolicy` rows forward inside this same block. ADR M0.3 §1 row
// 7 makes `tools` the sole writer of that table, so this context cannot do it
// and does not. What it does instead is REPORT the hand-off: every write returns
// the previous and the new version id, and the contract publishes them, so
// `tools` can carry its own rows across the same seam. Doing the copy here would
// be a sole-writer violation that the §5.2 lint would catch in the adapter and
// that nothing would catch in a design.

import { err, ok, type EnvironmentScope, type Result, type TransactionScope } from "@platos/kernel";

import {
  activateVersion,
  asAgentsIdentifier,
  carryForward,
  nextVersionNumber,
  type ActorId,
  type AgentId,
  type AgentVersion,
  type AgentVersionId,
  type AgentVersionSnapshot,
  type SkillAssignment,
  type ToolDefaultPolicy,
} from "../domain/index.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { BoundAgent } from "./ports/index.js";

/** What a caller learns from a save that minted a version. */
export interface VersionWritten {
  readonly bound: BoundAgent;
  readonly previousVersionId: AgentVersionId;
  readonly version: AgentVersion;
  readonly loadout: readonly SkillAssignment[];
}

export interface WriteVersionRequest {
  readonly bound: BoundAgent;
  readonly snapshot: AgentVersionSnapshot;
  readonly createdBy: ActorId;
  readonly note: string | null;
  /**
   * The loadout the new version carries. Absent means "whatever the version
   * being replaced carried", which is the correct default for every save that is
   * not itself a loadout change.
   */
  readonly loadout?: readonly SkillAssignment[];
  /** Inherited from the version being replaced unless a caller overrides it. */
  readonly toolDefaultPolicy?: ToolDefaultPolicy;
}

/**
 * Write one new version and move the binding onto it.
 *
 * Runs inside the caller's transaction rather than opening its own, so a use
 * case that also renames the Agent row commits both together or neither.
 */
export async function writeVersion(
  dependencies: AgentsDependencies,
  request: WriteVersionRequest,
  transaction: TransactionScope,
): Promise<Result<VersionWritten>> {
  const { bound } = request;
  const previousVersionId = bound.activeVersion.agentVersionId;

  const observed = await dependencies.repository.observedVersionNumbers(bound.agent.agentId, transaction);
  if (!observed.ok) return err(observed.error);

  const carried =
    request.loadout === undefined
      ? await inheritedLoadout(dependencies, previousVersionId)
      : ok(request.loadout);
  if (!carried.ok) return err(carried.error);
  const loadout = carried.value;

  const now = dependencies.clock.now();
  const version: AgentVersion = {
    agentVersionId: asAgentsIdentifier<AgentVersionId>(dependencies.ids.uuid()),
    agentId: bound.agent.agentId,
    versionNumber: nextVersionNumber(observed.value),
    toolDefaultPolicy: request.toolDefaultPolicy ?? bound.activeVersion.toolDefaultPolicy,
    note: request.note,
    createdBy: request.createdBy,
    createdAt: now,
    snapshot: request.snapshot,
  };

  const inserted = await dependencies.repository.insertVersion(version, transaction);
  if (!inserted.ok) return err(inserted.error);

  const written = await dependencies.repository.replaceLoadout(
    inserted.value.agentVersionId,
    loadout,
    transaction,
  );
  if (!written.ok) return err(written.error);

  const moved = await dependencies.repository.updateBinding(
    activateVersion(bound.binding, inserted.value.agentVersionId, now),
    transaction,
  );
  if (!moved.ok) return err(moved.error);

  return ok({
    bound: { ...bound, binding: moved.value, activeVersion: inserted.value },
    previousVersionId,
    version: inserted.value,
    loadout,
  });
}

async function inheritedLoadout(
  dependencies: AgentsDependencies,
  versionId: AgentVersionId,
): Promise<Result<readonly SkillAssignment[]>> {
  const held = await dependencies.repository.listLoadout(versionId);
  if (!held.ok) return err(held.error);
  return ok(carryForward(held.value));
}

/**
 * Release every thread hold for one agent.
 *
 * Called AFTER the transaction commits, never inside it. A hold released inside
 * a transaction that then rolls back would have sent live conversations onto a
 * version that no longer exists — the failure is silent and the recovery is a
 * restart, so the ordering is stated here rather than left to each call site.
 *
 * A failure to release is not a failure to save. The holds are short lived; the
 * version is written. Turning a lapsed cache into a failed save would be the
 * more damaging of the two outcomes.
 */
export async function releaseHolds(
  dependencies: AgentsDependencies,
  scope: EnvironmentScope,
  agentId: AgentId,
): Promise<void> {
  await dependencies.versionLock.releaseAll(scope, agentId);
}
