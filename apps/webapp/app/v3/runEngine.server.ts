import type { RunEngine } from "@internal/run-engine";
import { ExternalTriggerOnlyError } from "./externalTriggerBoundary.server";

/**
 * Compatibility type boundary for read-only dashboard modules that still
 * describe historical run-engine data. Platos no longer constructs or owns a
 * local RunEngine; all mutating method access fails closed.
 */
export const engine = new Proxy({} as RunEngine, {
  get() {
    throw new ExternalTriggerOnlyError();
  },
});

export type { RunEngine };
