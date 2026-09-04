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
//   * every failure path here resolves rather than rejects — a malformed
//     observation, an unknown detector, a store that is down, and a bug in this
//     module itself all end at the same `catch`;
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

export function createGovernanceSafetyEventSink(dependencies: GovernanceDependencies): SafetyEventSink {
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
  dependencies: GovernanceDependencies,
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
