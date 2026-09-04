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

/**
 * Keep the system prompt INSIDE the message array.
 *
 * `ai@7` defaults this off and insists a system message be passed as a separate
 * `instructions` option. This system cannot do that: `domain/prompt.ts` carries
 * the system prompt as a MESSAGE precisely because a message can carry a cache
 * breakpoint and a bare string field cannot, and `prompt-cache.ts` calls that
 * marker the most valuable single one in a turn — it is stable across every turn
 * and it covers the whole system prompt. Splitting it out would also make the
 * per-step `prepareStep` rewrite operate on a different array from the one the
 * placement rule indexes into.
 *
 * So the option is turned back on, in one place, for every call this package
 * makes. The framework still honours the message's `providerOptions`, which is
 * the only thing the marker needs.
 */
export const PROMPT_SHAPE_OPTIONS = Object.freeze({ allowSystemInMessages: true });

/**
 * ONE retry policy, not two stacked on each other.
 *
 * The framework retries a failed call itself, twice by default, with its own
 * exponential wait — and it does that ON TOP OF the transport, which is already
 * applying this installation's policy. Left alone the two multiply: a policy
 * that says "three passes" becomes nine calls to a provider that is already
 * struggling, waiting a schedule nobody configured, and the seam in
 * `transport.ts` would describe a policy that is not the one in force.
 *
 * So the framework's layer is switched off and the transport's is the whole of
 * it. That is what makes the retry policy configurable rather than merely
 * present, and it is why the numbers a test asserts in `transport.test.ts` are
 * the numbers a provider actually sees.
 */
export const SINGLE_RETRY_LAYER = Object.freeze({ maxRetries: 0 });

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
