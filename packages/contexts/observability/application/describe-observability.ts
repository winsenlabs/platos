// Sink health plus queue depth, as one report.
//
// The two halves fail independently and the report says so. A store that is
// `ready` with eleven parked envelopes and a store that is `unreachable` with an
// unreadable queue are different situations, and a report that folded either
// pair together would make one of them invisible.
//
// AN UNREADABLE QUEUE IS NOT AN EMPTY ONE. When the depth cannot be read it is
// reported as absent with the reason attached — never as zero. Zero reads as
// "nothing queued", which is the exact opposite of what an unreadable queue
// means, and it is the reading that lets a growing backlog look healthy.

import { ok, type Result } from "@platos/kernel";

import type { QueueDepth, SinkHealth } from "../domain/index.js";
import type { ObservabilityDependencies } from "./dependencies.js";
import { probeSink } from "./probe-sink.js";

export interface ObservabilityStatus {
  readonly sink: SinkHealth;
  /** Null when the queue could not be read. See this file's header. */
  readonly depth: QueueDepth | null;
  /** The error code that stopped the depth being read; null when it was read. */
  readonly depthErrorCode: string | null;
}

export interface DescribeObservabilityCommand {
  /**
   * A health already in hand, so the probe is not repeated.
   *
   * A caller that has just drained already made one, and a second network round
   * trip to report a depth it can read locally is a cost with no answer
   * attached. Supplying a health is the only way to skip the probe: there is no
   * "skip it and report ready anyway", because that would be a report of
   * something nobody checked.
   */
  readonly health?: SinkHealth;
}

export async function describeObservability(
  dependencies: ObservabilityDependencies,
  command: DescribeObservabilityCommand = {},
): Promise<Result<ObservabilityStatus>> {
  const sink = command.health ?? (await probeSink(dependencies));
  const depth = await dependencies.outbox.depth();
  return ok({
    sink,
    depth: depth.ok ? depth.value : null,
    depthErrorCode: depth.ok ? null : depth.error.code,
  });
}
