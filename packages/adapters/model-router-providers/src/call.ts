// The options both entry points build, built once so they cannot drift.
//
// `generate` and `stream` differ in DELIVERY and in nothing else — same tools,
// same step budget, same per-step cache placement, same abort. The use case
// above the port already keeps its two entry points from diverging in what they
// ADMIT, for the same reason; this is the same discipline one layer down, where
// the divergence would show up as one path caching and the other not.

import type {
  ModelRoutePlan,
  Prompt,
  SamplingLimits,
} from "@platos/context-providers/application/ports/index.js";
import type { ModelMessage } from "ai";

import { rewriteWireMessages } from "./messages.js";

/**
 * The caller's deadline, joined to one this package can pull itself.
 *
 * Two things can end a generation: the caller hanging up, and the caller's own
 * tool executor breaking its contract. The framework understands exactly one
 * signal, so they are joined here. `release` detaches the listener, because a
 * caller signal that outlives one generation — a per-turn timeout used for
 * several — would otherwise accumulate one listener per call.
 */
export interface LinkedAbort {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly release: () => void;
}

export function linkAbort(caller: AbortSignal | null): LinkedAbort {
  const controller = new AbortController();
  if (caller === null) {
    return { signal: controller.signal, abort: () => controller.abort(), release: () => undefined };
  }
  if (caller.aborted) {
    controller.abort(caller.reason);
    return { signal: controller.signal, abort: () => controller.abort(), release: () => undefined };
  }
  const forward = () => controller.abort(caller.reason);
  caller.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    release: () => caller.removeEventListener("abort", forward),
  };
}

/** The sampling controls, with "the provider's default" expressed as absence. */
export function samplingOptions(sampling: SamplingLimits): {
  maxOutputTokens?: number;
  temperature?: number;
} {
  // Null is NOT zero. A temperature of zero is a real, deliberate setting, and a
  // default invented here would silently override an operator's provider-side
  // configuration.
  return {
    ...(sampling.maxOutputTokens === null ? {} : { maxOutputTokens: sampling.maxOutputTokens }),
    ...(sampling.temperature === null ? {} : { temperature: sampling.temperature }),
  };
}

/**
 * The per-step hook that moves the cache breakpoints forward.
 *
 * Returning an empty object leaves the framework's own message array in place,
 * which is what happens when the array could not be read back into this
 * system's vocabulary. See `messages.ts` for why refusing beats approximating.
 */
export function prepareStepFor(
  plan: ModelRoutePlan,
  rewritePrompt: (prompt: Prompt) => Prompt,
): (options: { messages: ModelMessage[] }) => { messages?: ModelMessage[] } {
  return ({ messages }) => {
    const rewritten = rewriteWireMessages(messages, plan, rewritePrompt);
    return rewritten === null ? {} : { messages: rewritten };
  };
}
