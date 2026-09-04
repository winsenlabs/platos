// Where the cache breakpoints go, and why the placement is arithmetic rather
// than a constant.
//
// WHY THIS IS IN THE DOMAIN AND NOT IN THE ADAPTER. It is the one piece of the
// inference surface that is worth real money and is pure. The extraction source
// carries the same algorithm beside the SDK call, where it can only be tested
// through a fake HTTP endpoint; here it is a function over a `Prompt` that a
// unit test can inspect index by index. The adapter's job shrinks to mapping a
// marked message onto its provider's marker.
//
// THE PRODUCTION EVIDENCE THIS PRESERVES. One user turn on a Claude model ran
// twelve sequential steps and billed 1,684,498 input tokens against 198,224
// cache reads — about 1.47M tokens paid at full price that should have been
// read at a tenth of it, 300.85 cents for a single turn. The cause was that
// only the SYSTEM message carried a breakpoint, and by step twelve the message
// array was most of the context. The three rules below are the fix.
//
//   1. A BREAKPOINT COVERS THE WHOLE PREFIX BEFORE IT. The cache key is the
//      exact bytes up to the marked position, so what is needed is not one
//      marker per message but one NEAR THE END. Hence the walk backwards.
//
//   2. THE LOOKBACK IS FINITE. A marker searches only about twenty content
//      blocks backwards for an existing entry, so a step that adds more than
//      that between two markers misses and the turn quietly reverts to full
//      price. A normal step adds about two blocks; a step with many parallel
//      tool calls adds far more. Hence the intermediate markers at a stride
//      safely below the lookback.
//
//   3. THE BUDGET IS FOUR. The system message keeps one — it is the most
//      valuable single marker and it is stable across every turn — leaving
//      three for the message array. Exceeding four is not an error the provider
//      raises; it drops the overflow IN DOCUMENT ORDER, which discards the
//      newest marker: exactly the one the next step needs.
//
// STRIP BEFORE PLACE, BY CONSTRUCTION. `placeCacheBreakpoints` rebuilds the
// whole marker set from scratch on every call, clearing every non-system
// message first. The source had to be taught this the expensive way: because
// its per-step hook's message override carries forward, an additive
// implementation accumulated markers 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 11
// over eight steps against a hard limit of four, so history caching became a
// no-op from step three onward. A function that assigns rather than adds cannot
// have that bug.

import { err, ok, type Result } from "@platos/kernel";

import { cacheBudgetExceeded } from "./errors.js";
import { countContentBlocks, type Prompt, type PromptMessage } from "./prompt.js";
import type { ModelRoutePlan } from "./route.js";

/**
 * The three numbers that decide placement.
 *
 * Policy and not constants, so an installation whose provider raises the limit
 * does not need a code change, and so a test can exercise the stride rule on a
 * five-message prompt instead of a hundred-message one.
 */
export interface PromptCachePolicy {
  /** The provider's hard per-request marker limit. */
  readonly maxBreakpoints: number;
  /** How many of those the message array may use; the rest is the system's. */
  readonly messageBudget: number;
  /** Content blocks between consecutive markers. Must stay under the lookback. */
  readonly blockStride: number;
}

export const DEFAULT_PROMPT_CACHE_POLICY: PromptCachePolicy = Object.freeze({
  maxBreakpoints: 4,
  messageBudget: 3,
  blockStride: 15,
});

/**
 * Does this route honour an EXPLICIT breakpoint?
 *
 * Transcribed from the source's `isAnthropicCacheablePath`, structurally rather
 * than by provider name where it can be: the dialect already records which wire
 * format is in play, and the dialect is what decides whether a marker means
 * anything. The second clause catches the same family served through another
 * provider's gateway, where the dialect is that gateway's but the wire format
 * for markers is unchanged — the source matches the model string for exactly
 * this case and dropping it would un-cache every one of those routes.
 *
 * Everywhere else the answer is false, and that is not a gap. Those providers
 * cache an identical prefix automatically or not at all, so a marker is either
 * redundant or ignored, and placing one would only spend budget.
 */
export function honoursExplicitCacheBreakpoints(plan: ModelRoutePlan): boolean {
  if (plan.dialect === "anthropic-native") return true;
  return plan.reference.modelString.toLowerCase().includes("claude");
}

/**
 * The message indices that should carry a marker, ascending.
 *
 * Walks BACKWARDS: the newest position is the one that has to be cached for the
 * NEXT step to read, so it is chosen first and unconditionally — it is the
 * moving head. Later picks are spaced by content blocks, not by message count,
 * because it is blocks the lookback is measured in and one message can be
 * several.
 *
 * System messages are skipped. Theirs is applied once where the prompt is
 * assembled and must survive every step, so this function neither places nor
 * removes it.
 */
export function selectCacheBreakpoints(
  messages: readonly PromptMessage[],
  policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY,
): readonly number[] {
  const budget = Math.max(0, policy.messageBudget);
  const stride = Math.max(1, policy.blockStride);
  if (budget === 0) return [];

  const chosen: number[] = [];
  let blocksSinceLast = 0;

  for (let index = messages.length - 1; index >= 0 && chosen.length < budget; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role === "system") continue;
    if (chosen.length === 0) {
      chosen.push(index);
      blocksSinceLast = 0;
      continue;
    }
    blocksSinceLast += countContentBlocks(message);
    if (blocksSinceLast >= stride) {
      chosen.push(index);
      blocksSinceLast = 0;
    }
  }
  return chosen.sort((left, right) => left - right);
}

/**
 * Return the prompt with its message-array markers assigned afresh.
 *
 * Total: every non-system message comes back with `cacheBreakpoint` set to
 * exactly whether this call chose it, so calling twice on the same prompt gives
 * the same answer and calling it on its own output is a no-op. That is the
 * whole defence against the accumulation bug in the note above.
 *
 * A route that honours no explicit marker gets every message-array marker
 * CLEARED rather than left alone, so a prompt assembled for one provider and
 * re-routed to another does not carry a marker the new provider will count
 * against a budget it never agreed to.
 */
export function placeCacheBreakpoints(
  source: Prompt,
  plan: ModelRoutePlan,
  policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY,
): Prompt {
  const honoured = honoursExplicitCacheBreakpoints(plan);
  const targets = honoured ? new Set(selectCacheBreakpoints(source.messages, policy)) : new Set<number>();
  return {
    messages: source.messages.map((message, index) =>
      message.role === "system" ? message : { ...message, cacheBreakpoint: targets.has(index) },
    ),
  };
}

/** Every marker in the prompt, system message included. */
export function countCacheBreakpoints(source: Prompt): number {
  return source.messages.filter((message) => message.cacheBreakpoint).length;
}

/**
 * Refuse a prompt carrying more markers than the provider will honour.
 *
 * `placeCacheBreakpoints` cannot produce one — its budget is the message budget
 * and the system keeps the remainder — so this guard exists for the prompt a
 * caller assembled by hand, which is the only way the count can run away. It is
 * checked at the use case, where refusing costs nothing, rather than at the
 * provider, where finding out costs a round trip and the caching that round
 * trip was supposed to buy.
 */
export function withinCacheBudget(
  source: Prompt,
  policy: PromptCachePolicy = DEFAULT_PROMPT_CACHE_POLICY,
): Result<Prompt> {
  const placed = countCacheBreakpoints(source);
  if (placed > policy.maxBreakpoints) return err(cacheBudgetExceeded(placed, policy.maxBreakpoints));
  return ok(source);
}
