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
