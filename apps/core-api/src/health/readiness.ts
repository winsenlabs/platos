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
// READINESS IS STILL RED, AND FOR THE FIRST TIME IT IS RED ABOUT SOMETHING
// (WIN-267 T3). It used to read "AT M2.1b READINESS IS HONESTLY RED. None of the
// twelve adapters has an implementation, so no binding is satisfied" — which had
// stopped being why. Five of the thirteen directories now have real
// constructors, `main.ts` calls them from the validated configuration, and the
// satisfied count moves with what an install actually wired: a process with a
// database URL satisfies thirty-four bindings, one with the four store and
// security groups declared satisfies forty-one.
//
// GREEN STILL REQUIRES ALL FORTY-NINE, and that is deliberate rather than
// unfinished. Eight directories are WIN-251's generated interfaces, so eight
// bindings cannot be satisfied by any configuration; a readiness rule that went
// green on "everything this install COULD wire" would be comparing the supply to
// itself, which is the assertion that cannot fail. The count is therefore
// measured against the DECLARED table, and the reason names both halves so an
// operator reads a number that moves rather than a constant.

import type { AppModule } from "../app.module.js";
import { DECLARED_BINDING_COUNT } from "../app.module.js";
import type { UnwiredAdapter } from "../composition/adapter-bindings.js";

export type LifecyclePhase = "starting" | "serving" | "draining" | "stopped";

export interface ReadinessDetail {
  readonly satisfiedBindings: readonly string[];
  readonly unsatisfiedBindings: readonly string[];
  readonly declaredBindings: number;
  /**
   * WIN-267 T3. One row per adapter directory that holds no object, each saying
   * whether an operator can fix it (`configuration`) or cannot (`implementation`).
   *
   * The unsatisfied-binding list alone cannot answer that: thirty-three of the
   * forty-nine bindings sit on ONE directory, so "unsatisfied" reads identically
   * whether the database URL is missing or the package was never written.
   */
  readonly unwiredAdapters: readonly UnwiredAdapter[];
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
    unwiredAdapters: app.unwired,
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
      // BOTH HALVES, AND BOTH COUNTED OFF THE SAME REPORT. The satisfied figure
      // is what an operator watches move as they wire an install; without it the
      // line said only how far there was left to go, which read the same at
      // 0/49 as at 41/49 to anyone skimming a log.
      reason:
        `${app.bindings.satisfied.length} of ${DECLARED_BINDING_COUNT} adapter bindings are satisfied;` +
        ` ${app.bindings.unsatisfied.length} are not`,
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
