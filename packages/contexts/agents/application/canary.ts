// Use cases: the canary split, and picking the version that answers a turn.
//
// SETTING A CANARY MINTS NO VERSION. The configuration did not change; which of
// two existing configurations answers a share of turns did. Minting one here
// would put an entry in the history saying nothing about what an operator
// edited, and would immediately become the new active version — quietly
// cancelling the very split it was recording.
//
// THE CANARY VERSION MUST BELONG TO THIS AGENT. Checked explicitly rather than
// left to the foreign key, because the foreign key only says the version exists:
// a version id belonging to a DIFFERENT agent in the same project satisfies it
// and would put one agent's configuration in front of another agent's users.
//
// SELECTION IS THE ONE RUNTIME PATH IN THIS CONTEXT AND IT TAKES ITS RANDOMNESS
// AS AN ARGUMENT. `domain/binding.ts` states why. Here the consequence is that
// `selectVersion` is a use case with no hidden entropy: given a binding, a draw
// and a thread, it returns the same version every time — which is what makes the
// hold, the fallback and the boundary percentages testable rather than
// statistical.

import { err, ok, type Result } from "@platos/kernel";

import {
  admitCanary,
  applyCanary,
  chooseVersion,
  promoteCanary as promoteOnBinding,
  versionNotFound,
  type AgentId,
  type AgentVersionId,
  type VersionChoice,
} from "../domain/index.js";
import { verifyOperator } from "./authorization.js";
import type { AgentsDependencies } from "./dependencies.js";
import type { BoundAgent } from "./ports/index.js";
import { requireBound } from "./read-agents.js";
import { releaseHolds } from "./version-writer.js";

export interface SetCanaryCommand {
  readonly authorization: unknown;
  readonly agentId: AgentId;
  readonly canaryVersionId: AgentVersionId | null;
  readonly canaryPercent: number;
}

export interface PromoteCanaryCommand {
  readonly authorization: unknown;
  readonly agentId: AgentId;
}

export interface SelectVersionQuery {
  readonly authorization: unknown;
  readonly agentId: AgentId;
  /**
   * The conversation this turn belongs to, or null for a one-off.
   *
   * Null is not "no stickiness needed" — it is "there is nothing to be sticky
   * about", and the source takes the ACTIVE version in that case rather than
   * drawing. A one-off request is not a sample of the canary population.
   */
  readonly threadId: string | null;
  /** A draw in `[0, 1)`. The composition root supplies it; nothing here draws. */
  readonly draw: number;
}

export async function setCanary(
  dependencies: AgentsDependencies,
  command: SetCanaryCommand,
): Promise<Result<BoundAgent>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);

  const admitted = admitCanary(command);
  if (admitted.canaryVersionId !== null) {
    const version = await dependencies.repository.findVersion(command.agentId, admitted.canaryVersionId);
    if (!version.ok) return err(version.error);
    if (version.value === null) return err(versionNotFound(command.agentId, admitted.canaryVersionId));
  }

  const now = dependencies.clock.now();
  const moved = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.updateBinding(applyCanary(bound.value.binding, admitted, now), transaction),
  );
  if (!moved.ok) return err(moved.error);
  await releaseHolds(dependencies, scope, command.agentId);
  const canaryVersion =
    admitted.canaryVersionId === null
      ? null
      : await dependencies.repository.findVersion(command.agentId, admitted.canaryVersionId);
  return ok({
    ...bound.value,
    binding: moved.value,
    canaryVersion: canaryVersion === null || !canaryVersion.ok ? null : canaryVersion.value,
  });
}

export async function promoteCanary(
  dependencies: AgentsDependencies,
  command: PromoteCanaryCommand,
): Promise<Result<BoundAgent>> {
  const granted = verifyOperator(dependencies, command.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const bound = await requireBound(dependencies, scope, command.agentId);
  if (!bound.ok) return err(bound.error);
  const promoted = promoteCanaryBinding(bound.value, dependencies.clock.now());
  if (!promoted.ok) return err(promoted.error);

  const moved = await dependencies.unitOfWork.run((transaction) =>
    dependencies.repository.updateBinding(promoted.value.binding, transaction),
  );
  if (!moved.ok) return err(moved.error);
  await releaseHolds(dependencies, scope, command.agentId);
  return ok({
    ...bound.value,
    binding: moved.value,
    activeVersion: promoted.value.activeVersion,
    canaryVersion: null,
  });
}

function promoteCanaryBinding(
  bound: BoundAgent,
  now: Date,
): Result<{ readonly binding: BoundAgent["binding"]; readonly activeVersion: BoundAgent["activeVersion"] }> {
  const promoted = promoteOnBinding(bound.binding, now);
  if (!promoted.ok) return err(promoted.error);
  // The canary version becomes the active one. When the binding named a canary
  // the store could not load, `canaryVersion` is null and the ACTIVE version
  // stays what it was — a promotion that moved the pointer but has no
  // configuration behind it is a broken binding, and reporting the old version
  // is the honest answer until the next read reloads it.
  return ok({ binding: promoted.value, activeVersion: bound.canaryVersion ?? bound.activeVersion });
}

/**
 * Which version answers this turn, and why.
 *
 * The hold is read before the split and written after it, so the first turn on a
 * thread decides and every later turn follows — including the turn that lost a
 * race to write the hold, which follows the winner rather than serving what it
 * drew.
 */
export async function selectVersion(
  dependencies: AgentsDependencies,
  query: SelectVersionQuery,
): Promise<Result<VersionChoice>> {
  const granted = verifyOperator(dependencies, query.authorization);
  if (!granted.ok) return err(granted.error);
  const scope = granted.value.scope;

  const bound = await requireBound(dependencies, scope, query.agentId);
  if (!bound.ok) return err(bound.error);
  const loadable = loadableIn(bound.value);

  if (query.threadId === null) {
    // A one-off request is NOT a sample of the canary population. The source
    // takes the active version outright rather than drawing, so the split is
    // removed from the binding rather than drawn against — which keeps the
    // "active version could not be loaded" refusal on this path too.
    return chooseVersion(
      { ...bound.value.binding, canaryVersionId: null, canaryPercent: 0 },
      { lockedVersionId: null, draw: 0, loadable },
    );
  }

  const key = { scope, agentId: query.agentId, threadId: query.threadId };
  const held = await dependencies.versionLock.read(key);
  if (!held.ok) return err(held.error);

  const chosen = chooseVersion(bound.value.binding, {
    lockedVersionId: held.value,
    draw: query.draw,
    loadable,
  });
  if (!chosen.ok || chosen.value.bucket === "locked") return chosen;

  const winner = await dependencies.versionLock.hold(key, chosen.value.versionId);
  if (!winner.ok) return err(winner.error);
  if (winner.value === chosen.value.versionId) return chosen;
  return ok({ versionId: winner.value, bucket: "locked" });
}

/**
 * A version id is loadable when the binding actually carries the row.
 *
 * `BoundAgent` holds both versions the binding names, so this needs no further
 * read — and a canary the store could not load arrives here as `null`, which is
 * exactly the case `chooseVersion` falls back on.
 */
function loadableIn(bound: BoundAgent): (versionId: AgentVersionId) => boolean {
  const known = new Set<string>([bound.activeVersion.agentVersionId]);
  if (bound.canaryVersion !== null) known.add(bound.canaryVersion.agentVersionId);
  return (versionId) => known.has(versionId);
}
