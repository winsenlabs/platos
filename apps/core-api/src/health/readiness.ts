// Liveness and readiness, kept apart because they answer different questions.
//
// LIVENESS asks "is this process wedged?" — a false negative restarts a healthy
// container, so it must not depend on anything downstream. READINESS asks
// "should traffic come here?" and must go red the instant the answer is no,
// including during shutdown, so a load balancer stops sending work before the
// listener closes rather than after.
//
// Conflating them is how a dependency outage turns into a restart loop that
// takes down the healthy half of a fleet too.
//
// AT M2.1b READINESS IS HONESTLY RED. None of the twelve adapters has an
// implementation, so no binding is satisfied and this process cannot serve a
// business request. It says so — with the exact unsatisfied list — instead of
// reporting green and failing at the first call.

import type { AppModule } from "../app.module.js";
import { DECLARED_BINDING_COUNT } from "../app.module.js";

export type LifecyclePhase = "starting" | "serving" | "draining" | "stopped";

export interface ReadinessDetail {
  readonly satisfiedBindings: readonly string[];
  readonly unsatisfiedBindings: readonly string[];
  readonly declaredBindings: number;
  readonly composedContexts: readonly string[];
  readonly inFlight: number;
}

export interface ReadinessVerdict {
  readonly ready: boolean;
  readonly phase: LifecyclePhase;
  readonly reason: string;
  readonly detail: ReadinessDetail;
}

export interface LifecycleState {
  phase: LifecyclePhase;
}

export function evaluateReadiness(app: AppModule, state: LifecycleState): ReadinessVerdict {
  const detail: ReadinessDetail = {
    satisfiedBindings: app.bindings.satisfied,
    unsatisfiedBindings: app.bindings.unsatisfied,
    declaredBindings: DECLARED_BINDING_COUNT,
    composedContexts: Object.keys(app.contexts),
    inFlight: app.inFlight.count,
  };

  if (state.phase !== "serving") {
    return {
      ready: false,
      phase: state.phase,
      // "draining" is the load balancer's cue. It is a distinct reason from
      // "starting" because the operational response differs: one resolves by
      // waiting, the other by routing elsewhere permanently.
      reason: state.phase === "draining" ? "shutting down" : `process is ${state.phase}`,
      detail,
    };
  }

  if (app.bindings.unsatisfied.length > 0) {
    return {
      ready: false,
      phase: state.phase,
      reason: `${app.bindings.unsatisfied.length} of ${DECLARED_BINDING_COUNT} adapter bindings are unsatisfied`,
      detail,
    };
  }

  return { ready: true, phase: state.phase, reason: "all declared bindings satisfied", detail };
}

/**
 * The body an unauthenticated caller gets.
 *
 * A load balancer needs a status code and nothing else. The unsatisfied-binding
 * list is an inventory of what this install has not wired, which is
 * reconnaissance, so it is behind the admin token — see the `secret: true` field
 * in `config/schema.ts`.
 */
export function publicReadinessBody(verdict: ReadinessVerdict): Record<string, unknown> {
  return { status: verdict.ready ? "ready" : "not-ready", phase: verdict.phase };
}

export function detailedReadinessBody(verdict: ReadinessVerdict): Record<string, unknown> {
  return { ...publicReadinessBody(verdict), reason: verdict.reason, detail: verdict.detail };
}
