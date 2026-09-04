// `AgentBinding` — which version of an agent an environment is serving, and the
// canary split.
//
// The binding is the only environment-scoped part of an agent. One row per
// `[environment, agent]`, holding the active version, an optional canary
// version, the percentage of turns the canary takes, and an optional cluster.
// Everything a turn needs to pick a version is on this one row, which is why
// version selection below is a pure function of it.
//
// SELECTION IS DETERMINISTIC GIVEN ITS DRAW. The running system calls a random
// generator inline, which makes "does 0% ever route to the canary?" a question
// nobody can answer without running it a thousand times. Here the draw is a
// PARAMETER in `[0, 1)`, so every boundary is a literal: 0% never routes to the
// canary whatever the draw, 100% always does, and a canary version of null never
// does at any percentage. That is the same rule; it is just now checkable.
//
// STICKINESS IS NOT MODELLED HERE. A thread that has already been answered by a
// version keeps that version, and the running system enforces that with a
// short-lived lock outside the transaction. A lock is I/O, so it belongs to a
// port; what belongs here is the ORDER — an existing lock wins over the split —
// and `chooseVersion` takes the locked version as an input so that order is
// stated once rather than re-derived at each call site.

import { err, ok, type EnvironmentId, type Result } from "@platos/kernel";

import { canaryAbsent, versionInvalid } from "./errors.js";
import type { AgentBindingId, AgentClusterId, AgentId, AgentVersionId } from "./identifiers.js";

export interface AgentBinding {
  readonly agentBindingId: AgentBindingId;
  readonly environmentId: EnvironmentId;
  readonly agentId: AgentId;
  readonly activeVersionId: AgentVersionId;
  readonly canaryVersionId: AgentVersionId | null;
  readonly clusterId: AgentClusterId | null;
  readonly canaryPercent: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Which side of the split answered, or why neither did. */
export type VersionBucket = "locked" | "canary" | "current";

export interface VersionChoice {
  readonly versionId: AgentVersionId;
  readonly bucket: VersionBucket;
}

/** The percentage bounds. Anything outside them is clamped, never refused. */
export const MIN_CANARY_PERCENT = 0;
export const MAX_CANARY_PERCENT = 100;

/**
 * Clamp a requested percentage into `[0, 100]` and drop its fraction.
 *
 * Transcribed exactly, including the truncation: a request for 12.9% is 12%, not
 * 13%. Rounding would move a canary's share on the first save an operator made
 * through a surface that emits floats.
 *
 * ONE INPUT IS HANDLED BEFORE THE CLAMP AND IT IS A FIX, NOT A TRANSCRIPTION.
 * `Math.max(0, Math.min(100, Math.floor(NaN)))` is `NaN`, so the source's own
 * expression writes `NaN` into the percentage column for any request that
 * arrived as one — and every later comparison against it is false, which reads
 * as a canary that silently never fires and cannot be dialled back. `NaN`
 * therefore lands on zero, the fail-closed answer. Infinities need no guard:
 * they clamp correctly on their own.
 */
export function clampCanaryPercent(requested: number): number {
  if (Number.isNaN(requested)) return MIN_CANARY_PERCENT;
  return Math.max(MIN_CANARY_PERCENT, Math.min(MAX_CANARY_PERCENT, Math.floor(requested)));
}

export interface CanaryIntake {
  readonly canaryVersionId: AgentVersionId | null;
  readonly canaryPercent: number;
}

export interface AdmittedCanary {
  readonly canaryVersionId: AgentVersionId | null;
  readonly canaryPercent: number;
}

/**
 * Admit a canary setting.
 *
 * ZERO PERCENT CLEARS THE VERSION. That is the source's rule and it is load
 * bearing: a binding left holding a canary version at 0% looks, in every
 * listing, like an agent with a canary — and an operator who dialled it to zero
 * to stop it would keep seeing it. Setting the percentage to zero is how you
 * cancel a canary, so cancelling it must also forget which version it was.
 */
export function admitCanary(intake: CanaryIntake): AdmittedCanary {
  const canaryPercent = clampCanaryPercent(intake.canaryPercent);
  return {
    canaryPercent,
    canaryVersionId: canaryPercent === MIN_CANARY_PERCENT ? null : intake.canaryVersionId,
  };
}

export function applyCanary(binding: AgentBinding, admitted: AdmittedCanary, now: Date): AgentBinding {
  return {
    ...binding,
    canaryVersionId: admitted.canaryVersionId,
    canaryPercent: admitted.canaryPercent,
    updatedAt: now,
  };
}

/**
 * Promote the canary to active, and clear the split.
 *
 * Refuses when there is nothing in canary rather than promoting the version that
 * is already active — which would mint an audit record saying a promotion
 * happened when nothing moved.
 */
export function promoteCanary(binding: AgentBinding, now: Date): Result<AgentBinding> {
  if (binding.canaryVersionId === null) return err(canaryAbsent(binding.agentId));
  return ok({
    ...binding,
    activeVersionId: binding.canaryVersionId,
    canaryVersionId: null,
    canaryPercent: MIN_CANARY_PERCENT,
    updatedAt: now,
  });
}

/** Move the binding onto a newly written version. The canary is untouched. */
export function activateVersion(
  binding: AgentBinding,
  versionId: AgentVersionId,
  now: Date,
): AgentBinding {
  return { ...binding, activeVersionId: versionId, updatedAt: now };
}

export function assignCluster(
  binding: AgentBinding,
  clusterId: AgentClusterId | null,
  now: Date,
): AgentBinding {
  return { ...binding, clusterId, updatedAt: now };
}

export interface SelectionInput {
  /** The version a sticky thread is already pinned to, if any. */
  readonly lockedVersionId: AgentVersionId | null;
  /** A draw in `[0, 1)`. Supplied by the caller; never read from a generator here. */
  readonly draw: number;
  /** Version ids the store could actually load. A pinned-but-missing id is not one. */
  readonly loadable: (versionId: AgentVersionId) => boolean;
}

/**
 * Which version answers this turn.
 *
 * The order is: an existing lock, then the split, then the active version as the
 * fallback for a canary that cannot be loaded. That last step is the one worth
 * stating — a canary version deleted underneath a live split must not fail the
 * turn, it must fall back to the version that is definitely there.
 *
 * Returns a refusal only when even the ACTIVE version cannot be loaded, which is
 * a broken binding rather than a routing outcome.
 */
export function chooseVersion(binding: AgentBinding, input: SelectionInput): Result<VersionChoice> {
  if (input.lockedVersionId !== null && input.loadable(input.lockedVersionId)) {
    return ok({ versionId: input.lockedVersionId, bucket: "locked" });
  }
  const percent = clampCanaryPercent(binding.canaryPercent);
  const takesCanary =
    binding.canaryVersionId !== null && percent > MIN_CANARY_PERCENT && input.draw * 100 < percent;
  if (takesCanary && binding.canaryVersionId !== null && input.loadable(binding.canaryVersionId)) {
    return ok({ versionId: binding.canaryVersionId, bucket: "canary" });
  }
  if (input.loadable(binding.activeVersionId)) {
    return ok({ versionId: binding.activeVersionId, bucket: "current" });
  }
  return err(
    versionInvalid("the binding's active version could not be loaded", {
      agentId: binding.agentId,
      activeVersionId: binding.activeVersionId,
    }),
  );
}

/**
 * What removing an agent from an environment does.
 *
 * The binding goes; the Agent row survives, because another environment may
 * still be serving it, and is deactivated only when this was the last binding.
 * Returning both facts is what stops a caller inferring the second from the
 * first — the inference is wrong exactly when it matters.
 */
export interface UnbindOutcome {
  readonly removedBindingId: AgentBindingId;
  readonly deactivatesAgent: boolean;
}

export function unbind(binding: AgentBinding, remainingBindings: number): UnbindOutcome {
  return {
    removedBindingId: binding.agentBindingId,
    deactivatesAgent: remainingBindings <= 0,
  };
}
