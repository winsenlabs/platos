import { describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_CATALOGUE } from "./catalogue.js";
import {
  countCacheBreakpoints,
  DEFAULT_PROMPT_CACHE_POLICY,
  honoursExplicitCacheBreakpoints,
  placeCacheBreakpoints,
  selectCacheBreakpoints,
  withinCacheBudget,
  type PromptCachePolicy,
} from "./prompt-cache.js";
import { textPart, type ContentPart, type Prompt, type PromptMessage } from "./prompt.js";
import { planModelRoute, type ModelRoutePlan } from "./route.js";

function plan(model: string): ModelRoutePlan {
  const built = planModelRoute(DEFAULT_PROVIDER_CATALOGUE, model);
  if (!built.ok) throw new Error(`fixture does not route: ${built.error.code}`);
  return built.value;
}

const ANTHROPIC = plan("anthropic:claude-sonnet-4-6");
const OPENAI = plan("openai:gpt-4.1");
const VERTEX_GEMINI = plan("google-vertex:gemini-2.5-pro");

/** `parts` blocks in one message, so a test can make one message wide. */
function say(role: PromptMessage["role"], parts: number, cacheBreakpoint = false): PromptMessage {
  const content: ContentPart[] = [];
  for (let index = 0; index < parts; index += 1) content.push(textPart(`part-${index}`));
  return { role, content, cacheBreakpoint };
}

function marks(source: Prompt): readonly number[] {
  return source.messages.flatMap((message, index) => (message.cacheBreakpoint ? [index] : []));
}

describe("which routes honour an explicit breakpoint", () => {
  it("says yes for the native dialect", () => {
    expect(honoursExplicitCacheBreakpoints(ANTHROPIC)).toBe(true);
  });

  it("says yes for the same model family served through another gateway", () => {
    // The source matches the model string for exactly this case; dropping it
    // would un-cache every one of those routes while the dialect check passed.
    expect(honoursExplicitCacheBreakpoints(plan("google-vertex:claude-sonnet-4-6"))).toBe(true);
  });

  it("says no for a provider that caches an identical prefix on its own", () => {
    expect(honoursExplicitCacheBreakpoints(OPENAI)).toBe(false);
    expect(honoursExplicitCacheBreakpoints(VERTEX_GEMINI)).toBe(false);
  });
});

describe("choosing the indices", () => {
  const messages = [say("system", 1), say("user", 1)];

  it("always takes the last non-system message, and only it, when nothing else fits", () => {
    expect(selectCacheBreakpoints(messages)).toEqual([1]);
  });

  it("skips a system message even when it is the newest", () => {
    expect(selectCacheBreakpoints([say("user", 1), say("system", 1)])).toEqual([0]);
  });

  it("spends NO second breakpoint until a whole stride of blocks has passed", () => {
    // Ten single-block messages under the default stride of 15. The head is
    // cached; nothing else is, because nine blocks is not fifteen.
    const ten = Array.from({ length: 10 }, () => say("user", 1));
    expect(selectCacheBreakpoints(ten)).toEqual([9]);
  });

  it("spends the whole budget once the stride is short enough", () => {
    const ten = Array.from({ length: 10 }, () => say("user", 1));
    const policy: PromptCachePolicy = { maxBreakpoints: 4, messageBudget: 3, blockStride: 2 };
    expect(selectCacheBreakpoints(ten, policy)).toEqual([5, 7, 9]);
  });

  it("measures the stride in BLOCKS and not in messages", () => {
    // Three messages only, but the middle one is fifteen blocks wide. A rule
    // that counted messages would find one breakpoint here; the lookback is
    // measured in blocks, so it finds two.
    const wide = [say("user", 1), say("assistant", 15), say("user", 1)];
    expect(selectCacheBreakpoints(wide)).toEqual([1, 2]);
    expect(selectCacheBreakpoints([say("user", 1), say("assistant", 13), say("user", 1)])).toEqual([2]);
  });

  it("returns nothing when the message budget is zero", () => {
    expect(
      selectCacheBreakpoints([say("user", 1), say("user", 1)], {
        maxBreakpoints: 1,
        messageBudget: 0,
        blockStride: 15,
      }),
    ).toEqual([]);
  });

  it("returns nothing for a prompt of nothing but system messages", () => {
    expect(selectCacheBreakpoints([say("system", 1), say("system", 1)])).toEqual([]);
  });
});

describe("placing them", () => {
  it("marks exactly the chosen indices and leaves the system message alone", () => {
    const source: Prompt = { messages: [say("system", 1, true), say("user", 1), say("assistant", 1)] };
    const placed = placeCacheBreakpoints(source, ANTHROPIC);
    expect(marks(placed)).toEqual([0, 2]);
    expect(placed.messages[0]?.cacheBreakpoint).toBe(true);
  });

  it("CLEARS a stale mark left at a position that is no longer the head", () => {
    // The accumulation bug, in one assertion. Index 1 was the head on an earlier
    // step and still carries its mark; index 3 is the head now. An additive
    // implementation returns [1, 3] and, four steps later, more than the
    // provider will honour.
    const source: Prompt = {
      messages: [say("system", 1, true), say("user", 1, true), say("assistant", 1), say("user", 1)],
    };
    expect(marks(placeCacheBreakpoints(source, ANTHROPIC))).toEqual([0, 3]);
  });

  it("is idempotent: placing on its own output changes nothing", () => {
    const source: Prompt = { messages: [say("system", 1, true), say("user", 1), say("user", 1)] };
    const once = placeCacheBreakpoints(source, ANTHROPIC);
    const twice = placeCacheBreakpoints(once, ANTHROPIC);
    expect(marks(twice)).toEqual(marks(once));
    expect(marks(twice)).toEqual([0, 2]);
  });

  it("stays inside the budget as the message array grows across ten steps", () => {
    // The measured failure was 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 11 marks
    // against a hard limit of four. Growing the array one step at a time and
    // re-placing each time is the shape that produced it.
    let current: Prompt = { messages: [say("system", 1, true), say("user", 1)] };
    const counts: number[] = [];
    for (let step = 0; step < 10; step += 1) {
      current = placeCacheBreakpoints(current, ANTHROPIC);
      counts.push(countCacheBreakpoints(current));
      current = {
        messages: [...current.messages, say("assistant", 1), say("tool", 1)],
      };
    }
    // Eight steps at two marks, then a third once the array is long enough for
    // the stride to earn one -- and never a fourth, because the budget is the
    // budget. The bug produced eleven.
    expect(counts).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 3, 3]);
    expect(Math.max(...counts)).toBeLessThanOrEqual(DEFAULT_PROMPT_CACHE_POLICY.maxBreakpoints);
  });

  it("moves the head mark forward as the array grows", () => {
    const first = placeCacheBreakpoints({ messages: [say("system", 1, true), say("user", 1)] }, ANTHROPIC);
    const grown = placeCacheBreakpoints(
      { messages: [...first.messages, say("assistant", 1), say("tool", 1)] },
      ANTHROPIC,
    );
    expect(marks(first)).toEqual([0, 1]);
    expect(marks(grown)).toEqual([0, 3]);
  });

  it("clears every message-array mark for a route that honours none", () => {
    const source: Prompt = { messages: [say("system", 1, true), say("user", 1, true), say("user", 1, true)] };
    const placed = placeCacheBreakpoints(source, OPENAI);
    expect(marks(placed)).toEqual([0]);
    expect(countCacheBreakpoints(placed)).toBe(1);
  });
});

describe("the budget guard", () => {
  const overloaded: Prompt = {
    messages: [
      say("system", 1, true),
      say("user", 1, true),
      say("assistant", 1, true),
      say("user", 1, true),
      say("assistant", 1, true),
    ],
  };

  it("refuses a hand-assembled prompt carrying five marks against a limit of four", () => {
    const checked = withinCacheBudget(overloaded);
    expect(checked.ok).toBe(false);
    if (checked.ok) throw new Error("unreachable");
    expect(checked.error.code).toBe("PROVIDERS_CACHE_BUDGET_EXCEEDED");
    expect(checked.error.details).toEqual({ placed: 5, allowed: 4 });
  });

  it("accepts exactly the limit, so the guard is not off by one", () => {
    const atLimit: Prompt = { messages: overloaded.messages.slice(0, 4) };
    expect(countCacheBreakpoints(atLimit)).toBe(4);
    expect(withinCacheBudget(atLimit).ok).toBe(true);
  });

  it("cannot be provoked by the placement rule itself", () => {
    // Placement spends at most `messageBudget`, and the system message keeps the
    // remainder, so the two together are the limit by construction.
    const wide = Array.from({ length: 60 }, () => say("user", 1));
    const policy: PromptCachePolicy = { maxBreakpoints: 4, messageBudget: 3, blockStride: 2 };
    const placed = placeCacheBreakpoints({ messages: [say("system", 1, true), ...wide] }, ANTHROPIC, policy);
    expect(marks(placed)).toEqual([0, 56, 58, 60]);
    expect(countCacheBreakpoints(placed)).toBe(4);
    expect(withinCacheBudget(placed, policy).ok).toBe(true);
  });
});
