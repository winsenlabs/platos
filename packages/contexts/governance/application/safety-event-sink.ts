// This context's implementation of the kernel `SafetyEventSink`.
//
// ADR M0.3 §3, the `auth -> monitoring` row: the enforcement layer's rate-limit
// guard used to import `SafetyEventService` directly. It now publishes a
// `SafetyObservation` through this kernel port, `governance` implements the port
// and stays the sole writer of `SafetyEvent`, and the composition root binds the
// two. There is no identity-access -> governance code edge, and boundary rule
// (g) `identity-isolation` keeps it that way.
//
// THE PORT'S CONTRACT IS THE HARD PART, AND IT IS HONOURED LITERALLY. It says
// `record` "must not throw and must not block the caller's decision: a safety
// sink that can fail a request has inverted the control it was added to
// provide." So:
//
//   * every failure path here resolves rather than rejects. A malformed
//     observation, an unknown detector and a store that is down all end at the
//     same `drop`, inside the `try`; only a thrown defect reaches the `catch`,
//     which routes to that same `drop`. Four different failures, one exit;
//   * nothing is retried and nothing is awaited beyond the single append, so a
//     slow ledger cannot become a slow rate-limit decision;
//   * and NOTHING IS SILENT. Every drop is logged through the kernel `Logger`
//     with the rule that produced it and the code that refused it. A sink that
//     swallowed events without a trace would be indistinguishable from one that
//     was never wired, which is precisely the failure that lets a safety control
//     rot unnoticed.
//
// ONLY AN ENVIRONMENT-SCOPED OBSERVATION IS RECORDED. `SafetyEvent` hangs off
// `Environment`; an observation addressed at an organization or a project has no
// row to be. Rather than inventing an environment, it is dropped and logged with
// the scope level that could not be used — which is a real gap, visible in the
// log, rather than an event filed against an arbitrary environment.

import type { SafetyEventSink, SafetyObservation } from "@platos/kernel";

import { draftFromObservation } from "../domain/index.js";
import type { GovernanceDependencies } from "./dependencies.js";
import { appendSafetyEvent } from "./record-safety-event.js";

/** The log message every drop carries. One string, so a query can count them. */
export const SAFETY_SINK_DROP_MESSAGE = "governance safety sink dropped an observation";

/**
 * THE SLICE OF `GovernanceDependencies` THIS SINK ACTUALLY READS, and the reason
 * it is declared rather than taken whole.
 *
 * WIN-267. `identity-access` already publishes this convention and states it
 * plainly: "Each use case declares the SLICE it needs --
 * `Pick<IdentityAccessPorts, "clock" | "hasher">` -- so a signature tells a
 * reader what the use case can reach, and a test supplies three fakes rather
 * than eleven." `agents` makes the same move at a context boundary with
 * `SkillsPeer`, and says why: "A handle typed as all fifteen makes every
 * in-memory double in this package a hostage to all fifteen."
 *
 * HERE IT IS LOAD-BEARING RATHER THAN TIDY, AND THIS IS THE MEASUREMENT. The
 * whole bundle is SEVENTEEN slots. This sink reaches THREE of them, and the
 * compiler is the join: `record` calls `draftFromObservation` (pure domain),
 * `appendSafetyEvent` (which reads `policy.safety` and calls `safety.append`)
 * and `drop` (which writes to `logger`). It never touches `ratings`,
 * `criteria`, `evals`, `goldenSets`, `ratingTargets`, `transcripts`,
 * `activity`, `judge`, `evalRuns`, `clock`, `ids`, `unitOfWork`, `tenancy` or
 * `agents`. Narrow the type by one more slot and this file stops compiling;
 * that is what makes the three a checked figure rather than a claim.
 *
 * WHAT IT UNBLOCKS, STATED SO NOBODY HAS TO INFER IT. `identity-access`'
 * `consume-rate-limit.ts` writes `identity.rate_limit.degraded` into the kernel
 * `SafetyEventSink`, whose ONLY implementation is this function. Taking the
 * whole bundle made the sink unbuildable until every one of the seventeen slots
 * could be filled -- including `agents`, a peer that needs two adapter
 * directories and a `skills` context that needs three more and an object store.
 * So `identity-access` was blocked on a `Judge`, an `EvalRunQueue` and an agent
 * version lock that its rate limiter has no use for and never calls.
 *
 * IT IS NOT A WEAKENING. `createGovernanceContract` still hands the whole bundle
 * in -- a `GovernanceDependencies` satisfies this type structurally, so that
 * call site is unchanged and the sink it mints is the same object it always was.
 * The narrowing says which slots a caller must have, not which it may have.
 */
export type GovernanceSafetySinkDependencies = Pick<
  GovernanceDependencies,
  "safety" | "policy" | "logger"
>;

export function createGovernanceSafetyEventSink(
  dependencies: GovernanceSafetySinkDependencies,
): SafetyEventSink {
  return {
    async record(observation: SafetyObservation): Promise<void> {
      try {
        if (observation.scope.level !== "environment") {
          drop(dependencies, observation, "SCOPE_NOT_ENVIRONMENT");
          return;
        }
        const draft = draftFromObservation(observation);
        if (!draft.ok) {
          drop(dependencies, observation, draft.error.code);
          return;
        }
        const appended = await appendSafetyEvent(
          dependencies,
          observation.scope,
          { ...draft.value, detail: null },
          null,
        );
        if (!appended.ok) drop(dependencies, observation, appended.error.code);
      } catch (thrown) {
        // The port forbids throwing, so a defect in this module must not become
        // the caller's problem either. It is logged as loudly as a refusal.
        drop(dependencies, observation, "SINK_THREW", thrown);
      }
    },
  };
}

function drop(
  dependencies: GovernanceSafetySinkDependencies,
  observation: SafetyObservation,
  reason: string,
  thrown?: unknown,
): void {
  dependencies.logger.log("warn", SAFETY_SINK_DROP_MESSAGE, {
    rule: readField(() => observation.rule),
    outcome: readField(() => observation.outcome),
    scopeLevel: readField(() => observation.scope.level),
    reason,
    ...(thrown === undefined ? {} : { thrown: describe(thrown) }),
  });
}

/**
 * Read one field for the log, or report that it could not be read.
 *
 * The catch-all path above exists because a producer's observation may itself
 * misbehave, and the fields this log line wants come from that same value — so
 * the reporting path must not be able to re-raise what it is reporting. This is
 * the one place in the package that swallows a throw and answers a placeholder,
 * and it is the difference between a dropped event that is logged and one that
 * takes the caller's request down with it.
 */
function readField(read: () => string): string {
  try {
    return read();
  } catch {
    return "<unreadable>";
  }
}

function describe(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  return String(thrown);
}
