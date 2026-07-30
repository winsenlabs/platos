import { describe, it, expect } from "vitest";
import {
  countContentBlocks,
  selectBreakpointIndices,
  withAnthropicCacheBreakpoints,
  isAnthropicCacheablePath,
  MESSAGE_BREAKPOINT_BUDGET,
  BREAKPOINT_BLOCK_STRIDE,
  type CacheableMessage,
} from "./anthropic-cache-breakpoints";

const sys = (): CacheableMessage => ({ role: "system", content: "SYSTEM" });
const user = (t = "hi"): CacheableMessage => ({ role: "user", content: t });
/** One assistant tool_use block + one tool_result block == a normal step. */
const toolStep = (n: number): CacheableMessage[] => [
  { role: "assistant", content: [{ type: "tool-call", toolCallId: `c${n}` }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: `c${n}` }] },
];

const hasBp = (m: CacheableMessage) =>
  (m.providerOptions as any)?.anthropic?.cacheControl?.type === "ephemeral";

describe("countContentBlocks", () => {
  it("counts string content as one block and array content per part", () => {
    expect(countContentBlocks(user("x"))).toBe(1);
    expect(countContentBlocks({ role: "tool", content: [{}, {}, {}] })).toBe(3);
  });
  it("never returns 0 (undercounting would let a gap exceed the lookback)", () => {
    expect(countContentBlocks({ role: "user", content: [] })).toBe(1);
    expect(countContentBlocks({ role: "user", content: undefined })).toBe(1);
  });
});

describe("selectBreakpointIndices", () => {
  it("always marks the LAST non-system message (the moving head)", () => {
    const msgs = [sys(), user(), ...toolStep(1)];
    const idx = selectBreakpointIndices(msgs);
    expect(idx).toContain(msgs.length - 1);
  });

  it("never marks a system message (it carries its own breakpoint)", () => {
    const msgs = [sys(), user()];
    for (const i of selectBreakpointIndices(msgs)) {
      expect(msgs[i].role).not.toBe("system");
    }
  });

  it("respects the 3-breakpoint budget on a long tool-heavy turn", () => {
    const msgs: CacheableMessage[] = [sys(), user()];
    for (let n = 0; n < 40; n++) msgs.push(...toolStep(n)); // 80 blocks
    const idx = selectBreakpointIndices(msgs);
    expect(idx.length).toBeLessThanOrEqual(MESSAGE_BREAKPOINT_BUDGET);
    expect(idx.length).toBe(MESSAGE_BREAKPOINT_BUDGET);
  });

  it("keeps every gap under the 20-block lookback", () => {
    const msgs: CacheableMessage[] = [sys(), user()];
    for (let n = 0; n < 30; n++) msgs.push(...toolStep(n));
    const idx = selectBreakpointIndices(msgs);
    // Walk between consecutive breakpoints and confirm no gap >= 20 blocks.
    for (let k = 1; k < idx.length; k++) {
      let blocks = 0;
      for (let i = idx[k - 1] + 1; i <= idx[k]; i++) blocks += countContentBlocks(msgs[i]);
      expect(blocks).toBeLessThan(20);
      expect(blocks).toBeLessThanOrEqual(BREAKPOINT_BLOCK_STRIDE + 2);
    }
  });

  it("handles a single parallel step that adds many blocks at once", () => {
    // The exact case a lone trailing breakpoint would miss: 14 parallel calls.
    const parallel: CacheableMessage = {
      role: "assistant",
      content: Array.from({ length: 14 }, (_, i) => ({ type: "tool-call", toolCallId: `p${i}` })),
    };
    const msgs = [sys(), user(), parallel, { role: "tool", content: Array.from({ length: 14 }, () => ({})) }];
    const idx = selectBreakpointIndices(msgs);
    expect(idx).toContain(msgs.length - 1);
    expect(idx.length).toBeGreaterThanOrEqual(2); // head + insurance behind it
  });

  it("returns nothing for empty input or zero budget", () => {
    expect(selectBreakpointIndices([])).toEqual([]);
    expect(selectBreakpointIndices([sys(), user()], { budget: 0 })).toEqual([]);
  });
});

describe("withAnthropicCacheBreakpoints", () => {
  it("marks the head and leaves other messages untouched", () => {
    const msgs = [sys(), user("a"), user("b")];
    const out = withAnthropicCacheBreakpoints(msgs);
    expect(hasBp(out[out.length - 1])).toBe(true);
    expect(hasBp(out[0])).toBe(false); // system untouched here
  });

  it("PRESERVES existing providerOptions and other anthropic options", () => {
    const msgs: CacheableMessage[] = [
      sys(),
      { role: "user", content: "x", providerOptions: { openai: { foo: 1 }, anthropic: { bar: 2 } } },
    ];
    const out = withAnthropicCacheBreakpoints(msgs);
    const po = out[1].providerOptions as any;
    expect(po.openai).toEqual({ foo: 1 }); // untouched sibling provider
    expect(po.anthropic.bar).toBe(2); // untouched sibling option
    expect(po.anthropic.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("does not mutate the input array or its messages", () => {
    const msgs = [sys(), user("a")];
    const snapshot = JSON.stringify(msgs);
    withAnthropicCacheBreakpoints(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it("is idempotent — safe to call on every step", () => {
    const msgs = [sys(), user("a"), ...toolStep(1)];
    const once = withAnthropicCacheBreakpoints(msgs);
    const twice = withAnthropicCacheBreakpoints(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  /**
   * REGRESSION — marker accumulation across prepareStep calls.
   *
   * The original implementation was additive only. Because a `messages`
   * override returned from prepareStep carries forward, step N received the
   * markers placed on step N-1 and added more, measured 2 -> 3 -> 4 -> ... -> 11
   * markers over 8 tool steps against Anthropic's limit of 4. The overflow is
   * dropped in document order (or the request is rejected), which discards the
   * trailing head breakpoint — exactly the one that makes the next step a hit —
   * so history caching silently became a no-op from step 3 onward.
   *
   * The earlier "idempotent" test did not catch it: it re-applied to the SAME
   * array, where the chosen indices are identical. The bug only appears when the
   * array has GROWN, moving the head while the stale markers remain.
   */
  it("does NOT accumulate markers across simulated prepareStep steps", () => {
    let msgs: CacheableMessage[] = [
      { role: "system", content: "SYS", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      user("go"),
    ];
    msgs = withAnthropicCacheBreakpoints(msgs);
    const counts: number[] = [];
    for (let n = 1; n <= 10; n++) {
      msgs = [...msgs, ...toolStep(n)]; // the SDK appends the step's blocks
      msgs = withAnthropicCacheBreakpoints(msgs); // prepareStep re-applies
      counts.push(msgs.filter(hasBp).length);
    }
    // Never exceed Anthropic's 4 (3 message breakpoints + the system one).
    for (const c of counts) {
      expect(c).toBeLessThanOrEqual(MESSAGE_BREAKPOINT_BUDGET + 1);
    }
    // And it must stabilise, not creep upward.
    expect(counts[counts.length - 1]).toBe(counts[counts.length - 2]);
    // The system breakpoint must survive every step.
    expect(hasBp(msgs[0])).toBe(true);
    // The head must still be marked on the final step.
    expect(hasBp(msgs[msgs.length - 1])).toBe(true);
  });

  it("strips a stale marker that is no longer at a chosen position", () => {
    // Head marker from a previous step, now mid-array after growth.
    const stale: CacheableMessage[] = [
      sys(),
      { role: "user", content: "old", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      ...toolStep(1),
    ];
    const out = withAnthropicCacheBreakpoints(stale, { budget: 1 });
    // With budget 1 only the head may carry a marker; the stale one is cleared.
    expect(out.filter(hasBp)).toHaveLength(1);
    expect(hasBp(out[out.length - 1])).toBe(true);
    expect(hasBp(out[1])).toBe(false);
  });

  it("stripping preserves sibling providerOptions and other anthropic options", () => {
    const msgs: CacheableMessage[] = [
      sys(),
      {
        role: "user",
        content: "old",
        providerOptions: { openai: { foo: 1 }, anthropic: { bar: 2, cacheControl: { type: "ephemeral" } } },
      },
      ...toolStep(1),
    ];
    const out = withAnthropicCacheBreakpoints(msgs, { budget: 1 });
    const po = out[1].providerOptions as any;
    expect(po.openai).toEqual({ foo: 1 });
    expect(po.anthropic).toEqual({ bar: 2 }); // cacheControl gone, bar kept
  });

  it("moves the head forward as the conversation grows (the per-step behaviour)", () => {
    const step1 = withAnthropicCacheBreakpoints([sys(), user(), ...toolStep(1)]);
    const step2 = withAnthropicCacheBreakpoints([sys(), user(), ...toolStep(1), ...toolStep(2)]);
    // head marked in both, and step2's head is later than step1's
    expect(hasBp(step1[step1.length - 1])).toBe(true);
    expect(hasBp(step2[step2.length - 1])).toBe(true);
    expect(step2.length).toBeGreaterThan(step1.length);
  });
});

describe("isAnthropicCacheablePath", () => {
  it("matches anthropic direct and Claude via Vertex, not other providers", () => {
    expect(isAnthropicCacheablePath("anthropic:claude-sonnet-5")).toBe(true);
    expect(isAnthropicCacheablePath("vertex:claude-sonnet-5@20260101")).toBe(true);
    expect(isAnthropicCacheablePath("together:moonshotai/Kimi-K3")).toBe(false);
    expect(isAnthropicCacheablePath("openai:gpt-5")).toBe(false);
    expect(isAnthropicCacheablePath(undefined)).toBe(false);
  });
});
