// Ask the sink what it is doing, and never let the asking be the failure.
//
// `ObservabilitySink.probe` is documented as never rejecting: every way a store
// can be broken is already a `SinkStatus`, so there is no failure left for a
// rejection to carry. This wrapper exists anyway, and the reason is worth
// stating: "the probe threw" and "the store is down" must be the same outcome to
// every caller, and only one of the two is the adapter behaving itself. Without
// the guard, an adapter defect would abort a drain instead of degrading it — and
// the drain is the thing whose whole job is to survive the store being broken.
//
// A THROWN PROBE IS `unreachable`, NEVER `disabled`. Reporting it as disabled
// would say an installation chose not to have an analytical store, when what
// actually happened is that we could not find out. That single substitution is
// the failure this context's vocabulary exists to prevent.

import { unreachableSink, type SinkHealth } from "../domain/index.js";
import type { ObservabilityDependencies } from "./dependencies.js";

/** The class of a thrown value, without its message. Messages quote payloads. */
export function errorClass(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.name;
  return typeof thrown;
}

export async function probeSink(dependencies: ObservabilityDependencies): Promise<SinkHealth> {
  try {
    return await dependencies.sink.probe();
  } catch (thrown) {
    return unreachableSink(errorClass(thrown));
  }
}
